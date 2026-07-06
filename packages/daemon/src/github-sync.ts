import Database from "better-sqlite3";
import type { Board } from "./board.js";
import type { Card, CardStatus } from "@aura/core";

/**
 * GitHub Projects v2 two-way sync.
 *
 * Design notes (this is the riskiest subsystem — read before editing):
 *  - The local board is authoritative *between* syncs. On conflict, GitHub
 *    wins (remote is shared truth across a team), but the card is escalated
 *    to a review queue so a human sees that their local change was overridden.
 *  - Per-card sync state records the local rev and remote status observed at
 *    the last successful reconcile. "Changed since last sync" is derived from
 *    those, not from wall-clock timestamps (clocks lie across machines).
 *  - reconcile() is a pure function of (locals, remotes, states, mapping) so
 *    it can be exhaustively tested without a network or a token.
 */

export interface ColumnMapping {
  /** local status -> GitHub Projects single-select option name */
  statusToOption: Record<CardStatus, string>;
  /** GitHub option name -> local status (may collapse several options) */
  optionToStatus: Record<string, CardStatus>;
}

export const DEFAULT_MAPPING: ColumnMapping = {
  statusToOption: {
    backlog: "Todo",
    in_progress: "In Progress",
    review: "In Review",
    done: "Done",
  },
  optionToStatus: {
    Todo: "backlog",
    "In Progress": "in_progress",
    "In Review": "review",
    Done: "done",
  },
};

/** A GitHub Projects item as we consume it (already reduced to what we need). */
export interface RemoteItem {
  externalId: string; // Projects item node id (PVTI_...)
  title: string;
  status: CardStatus; // already mapped from the option name via ColumnMapping
}

export interface SyncState {
  cardId: string;
  externalId: string;
  lastSyncedRev: number; // card.rev at last reconcile
  lastRemoteStatus: CardStatus; // remote status at last reconcile
}

export type SyncOp =
  | { type: "push"; cardId: string; externalId: string; status: CardStatus } // local -> remote
  | { type: "pull"; cardId: string; status: CardStatus } // remote -> local
  | { type: "create-remote"; cardId: string; title: string; status: CardStatus } // new local card
  | { type: "create-local"; externalId: string; title: string; status: CardStatus }; // new remote item

export interface ConflictReport {
  cardId: string;
  externalId: string;
  localStatus: CardStatus;
  remoteStatus: CardStatus;
  resolution: "remote-wins";
}

export interface ReconcileResult {
  ops: SyncOp[];
  conflicts: ConflictReport[];
  /** New sync states to persist after ops are applied. */
  nextStates: SyncState[];
}

/**
 * Pure reconciliation. Given the current local cards, the remote items, and
 * the sync state from the last run, produce the operations to converge and
 * the conflicts that were resolved in GitHub's favor.
 */
export function reconcile(
  locals: Card[],
  remotes: RemoteItem[],
  states: SyncState[],
): ReconcileResult {
  const stateByCard = new Map(states.map((s) => [s.cardId, s]));
  const remoteById = new Map(remotes.map((r) => [r.externalId, r]));
  const localByExternal = new Map(
    locals.filter((c) => c.externalId).map((c) => [c.externalId as string, c]),
  );

  const ops: SyncOp[] = [];
  const conflicts: ConflictReport[] = [];
  const nextStates: SyncState[] = [];
  const handledRemotes = new Set<string>();

  for (const card of locals) {
    if (!card.externalId) {
      // New local card never pushed → create remote.
      ops.push({ type: "create-remote", cardId: card.id, title: card.title, status: card.status });
      continue;
    }
    const remote = remoteById.get(card.externalId);
    handledRemotes.add(card.externalId);
    const prev = stateByCard.get(card.id);

    if (!remote) {
      // Linked remote vanished (deleted on GitHub). Re-create it from local.
      ops.push({ type: "create-remote", cardId: card.id, title: card.title, status: card.status });
      continue;
    }

    const localChanged = !prev || card.rev > prev.lastSyncedRev;
    const remoteChanged = !prev || remote.status !== prev.lastRemoteStatus;

    if (localChanged && remoteChanged && card.status !== remote.status) {
      // True conflict → GitHub wins, escalate to review.
      conflicts.push({
        cardId: card.id,
        externalId: card.externalId,
        localStatus: card.status,
        remoteStatus: remote.status,
        resolution: "remote-wins",
      });
      ops.push({ type: "pull", cardId: card.id, status: remote.status });
      nextStates.push(mkState(card, remote.status));
    } else if (localChanged && card.status !== remote.status) {
      ops.push({ type: "push", cardId: card.id, externalId: card.externalId, status: card.status });
      nextStates.push(mkState(card, card.status));
    } else if (remoteChanged && card.status !== remote.status) {
      ops.push({ type: "pull", cardId: card.id, status: remote.status });
      nextStates.push(mkState(card, remote.status));
    } else {
      // In sync; refresh the baseline so future diffs are correct.
      nextStates.push(mkState(card, remote.status));
    }
  }

  // Remote items with no local card → import them.
  for (const remote of remotes) {
    if (handledRemotes.has(remote.externalId)) continue;
    if (localByExternal.has(remote.externalId)) continue;
    ops.push({ type: "create-local", externalId: remote.externalId, title: remote.title, status: remote.status });
  }

  return { ops, conflicts, nextStates };
}

function mkState(card: Card, remoteStatus: CardStatus): SyncState {
  return {
    cardId: card.id,
    externalId: card.externalId as string,
    lastSyncedRev: card.rev,
    lastRemoteStatus: remoteStatus,
  };
}

/** Transport the engine drives. Real impl uses Octokit GraphQL; tests use a mock. */
export interface GitHubProjectClient {
  listItems(): Promise<RemoteItem[]>;
  updateItemStatus(externalId: string, status: CardStatus): Promise<void>;
  createItem(title: string, status: CardStatus): Promise<RemoteItem>;
}

/**
 * Persists per-card sync state + an offline outbound queue so a sync that is
 * interrupted (API 500, offline) resumes without losing or duplicating work.
 */
export class SyncEngine {
  private db: Database.Database;

  constructor(
    private board: Board,
    private client: GitHubProjectClient,
    dbPath = ":memory:",
  ) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_state (
        card_id TEXT PRIMARY KEY, external_id TEXT NOT NULL,
        last_rev INTEGER NOT NULL, last_remote_status TEXT NOT NULL
      );
    `);
  }

  private loadStates(): SyncState[] {
    return (this.db.prepare("SELECT card_id as cardId, external_id as externalId, last_rev as lastSyncedRev, last_remote_status as lastRemoteStatus FROM sync_state").all() as SyncState[]);
  }
  private saveState(s: SyncState): void {
    this.db.prepare(
      `INSERT INTO sync_state (card_id, external_id, last_rev, last_remote_status)
       VALUES (@cardId, @externalId, @lastSyncedRev, @lastRemoteStatus)
       ON CONFLICT(card_id) DO UPDATE SET external_id=excluded.external_id,
         last_rev=excluded.last_rev, last_remote_status=excluded.last_remote_status`,
    ).run(s);
  }

  /**
   * One reconcile pass. Returns the conflicts (for the review queue) and a
   * summary. Ops are applied one at a time; a failure stops the pass, leaving
   * already-applied state persisted so the next pass resumes cleanly.
   */
  async syncOnce(): Promise<{ conflicts: ConflictReport[]; applied: number; failed: number }> {
    const remotes = await this.client.listItems();
    const locals = this.board.list();
    const { ops, conflicts, nextStates } = reconcile(locals, remotes, this.loadStates());

    let applied = 0, failed = 0;
    for (const op of ops) {
      try {
        await this.applyOp(op);
        applied += 1;
      } catch {
        failed += 1;
        // Stop on first failure; unapplied ops retried next pass (offline queue semantics).
        break;
      }
    }
    // Persist baselines only for cards whose op we didn't fail on. Simplest safe
    // rule: persist all nextStates when nothing failed; otherwise persist none
    // so the next pass recomputes from scratch.
    if (failed === 0) for (const s of nextStates) this.saveState(s);
    return { conflicts, applied, failed };
  }

  private async applyOp(op: SyncOp): Promise<void> {
    switch (op.type) {
      case "push":
        await this.client.updateItemStatus(op.externalId, op.status);
        break;
      case "pull":
        this.board.update(op.cardId, { status: op.status });
        break;
      case "create-remote": {
        // Network first: if createItem throws we haven't touched local state.
        const item = await this.client.createItem(op.title, op.status);
        const linked = this.board.update(op.cardId, { externalId: item.externalId });
        // Persist baseline now — the card's rev advanced from the link write,
        // and without a baseline the next pass would treat it as a conflict.
        if (linked) this.saveState(mkState(linked, op.status));
        break;
      }
      case "create-local": {
        const created = this.board.create({ title: op.title, status: op.status });
        const linked = this.board.update(created.id, { externalId: op.externalId });
        if (linked) this.saveState(mkState(linked, op.status));
        break;
      }
    }
  }

  close(): void { this.db.close(); }
}
