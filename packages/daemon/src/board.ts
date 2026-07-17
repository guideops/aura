import Database from "better-sqlite3";
import { ulid } from "ulid";
import { Card, type CardPriority, type CardStatus } from "@aura/core";

export interface CreateCardInput {
  title: string;
  body?: string;
  status?: CardStatus;
  tags?: string[];
  key?: string;
  externalRef?: string;
  priority?: CardPriority;
  milestone?: string;
}

/**
 * Local kanban store. The board is authoritative for local state between
 * syncs; each mutation bumps `rev` so the GitHub sync engine can detect
 * whether the local or remote side changed since the last reconcile.
 */
export class Board {
  private db: Database.Database;
  private counter = 200; // AURA-201, 202, ...

  constructor(dbPath = ":memory:") {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        assignee TEXT,
        progress INTEGER NOT NULL DEFAULT 0,
        external_id TEXT,
        session_id TEXT,
        rev INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cards_status ON cards(status);
      CREATE INDEX IF NOT EXISTS idx_cards_external ON cards(external_id);
    `);
    // Migration for boards created before session binding existed.
    try { this.db.exec("ALTER TABLE cards ADD COLUMN session_id TEXT"); } catch { /* exists */ }
    // Migrations for the shell UI card metadata (priority/milestone/checklist/peer ref).
    try { this.db.exec("ALTER TABLE cards ADD COLUMN external_ref TEXT"); } catch { /* exists */ }
    try { this.db.exec("ALTER TABLE cards ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium'"); } catch { /* exists */ }
    try { this.db.exec("ALTER TABLE cards ADD COLUMN milestone TEXT"); } catch { /* exists */ }
    try { this.db.exec("ALTER TABLE cards ADD COLUMN checklist TEXT NOT NULL DEFAULT '[]'"); } catch { /* exists */ }
    const maxKey = this.db
      .prepare("SELECT key FROM cards WHERE key LIKE 'AURA-%' ORDER BY CAST(SUBSTR(key,6) AS INTEGER) DESC LIMIT 1")
      .get() as { key: string } | undefined;
    if (maxKey) this.counter = Number(maxKey.key.slice(5)) || this.counter;
  }

  list(): Card[] {
    return (this.db.prepare("SELECT * FROM cards ORDER BY updated_at DESC").all() as RawCard[]).map(hydrate);
  }
  get(id: string): Card | undefined {
    const row = this.db.prepare("SELECT * FROM cards WHERE id = ?").get(id) as RawCard | undefined;
    return row ? hydrate(row) : undefined;
  }
  /** Find a card by its peer (AW/Hermes) task id for idempotent ingestion. */
  getByRef(externalRef: string): Card | undefined {
    const row = this.db.prepare("SELECT * FROM cards WHERE external_ref = ?").get(externalRef) as RawCard | undefined;
    return row ? hydrate(row) : undefined;
  }
  getByExternal(externalId: string): Card | undefined {
    const row = this.db.prepare("SELECT * FROM cards WHERE external_id = ?").get(externalId) as RawCard | undefined;
    return row ? hydrate(row) : undefined;
  }

  create(input: CreateCardInput): Card {
    const card: Card = Card.parse({
      id: ulid(),
      key: input.key ?? `AURA-${++this.counter}`,
      title: input.title,
      body: input.body ?? "",
      status: input.status ?? "backlog",
      tags: input.tags ?? [],
      assignee: null,
      progress: 0,
      externalId: null,
      externalRef: input.externalRef ?? null,
      priority: input.priority ?? "medium",
      milestone: input.milestone ?? null,
      checklist: [],
      sessionId: null,
      rev: 0,
      updatedAt: Date.now(),
    });
    this.insert(card);
    return card;
  }

  /** Partial update; bumps rev + updatedAt. Returns the new card or undefined. */
  update(id: string, patch: Partial<Omit<Card, "id" | "rev">>): Card | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const next: Card = Card.parse({
      ...existing,
      ...patch,
      id: existing.id,
      rev: existing.rev + 1,
      updatedAt: Date.now(),
    });
    this.insert(next);
    return next;
  }

  /** Applies a remote change without bumping rev (used by sync to mark reconciled). */
  applyRemote(card: Card): void {
    this.insert(card);
  }

  remove(id: string): boolean {
    return this.db.prepare("DELETE FROM cards WHERE id = ?").run(id).changes > 0;
  }

  close(): void { this.db.close(); }

  private insert(card: Card): void {
    this.db
      .prepare(
        `INSERT INTO cards (id, key, title, body, status, tags, assignee, progress, external_id, external_ref, priority, milestone, checklist, session_id, rev, updated_at)
         VALUES (@id, @key, @title, @body, @status, @tags, @assignee, @progress, @externalId, @externalRef, @priority, @milestone, @checklist, @sessionId, @rev, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           key=excluded.key, title=excluded.title, body=excluded.body, status=excluded.status,
           tags=excluded.tags, assignee=excluded.assignee, progress=excluded.progress,
           external_id=excluded.external_id, external_ref=excluded.external_ref, priority=excluded.priority,
           milestone=excluded.milestone, checklist=excluded.checklist,
           session_id=excluded.session_id, rev=excluded.rev, updated_at=excluded.updated_at`,
      )
      .run({ ...card, tags: JSON.stringify(card.tags), checklist: JSON.stringify(card.checklist) });
  }
}

interface RawCard {
  id: string; key: string; title: string; body: string; status: string;
  tags: string; assignee: string | null; progress: number;
  external_id: string | null; external_ref: string | null; priority: string;
  milestone: string | null; checklist: string;
  session_id: string | null; rev: number; updated_at: number;
}

function hydrate(r: RawCard): Card {
  return Card.parse({
    id: r.id, key: r.key, title: r.title, body: r.body, status: r.status,
    tags: JSON.parse(r.tags) as string[], assignee: r.assignee, progress: r.progress,
    externalId: r.external_id, externalRef: r.external_ref, priority: r.priority,
    milestone: r.milestone, checklist: JSON.parse(r.checklist || "[]") as unknown[],
    sessionId: r.session_id, rev: r.rev, updatedAt: r.updated_at,
  });
}
