import type { AgentEvent, Card } from "@aura/core";
import type { Board } from "./board.js";

/**
 * Drives card progress from the agent event stream. Cards link to agents via
 * `assignee`; while a card is running, its agent's activity animates the
 * progress bar (heuristic — real completion signal is session.end → review).
 */
export class BoardProgress {
  private toolUses = new Map<string, number>(); // agentId → count since claim
  /** Cards awaiting their spawned session's first event, keyed by cwd. */
  private pending = new Map<string, { cardId: string; expiresAt: number }>();

  constructor(private board: Board, private onCard: (card: Card) => void) {}

  /**
   * Registers a spawn: the next session.start reporting this cwd binds its
   * sessionId to the card. TTL guards against never-starting sessions.
   */
  expectSession(cardId: string, cwd: string, ttlMs = 10 * 60_000): void {
    this.pending.set(normCwd(cwd), { cardId, expiresAt: Date.now() + ttlMs });
  }

  apply(event: AgentEvent): void {
    if (event.type === "session.start") {
      this.tryBind(event);
      return;
    }
    if (event.type !== "tool.use" && event.type !== "task.progress" && event.type !== "session.end") {
      return;
    }
    // Hard binding via sessionId wins; assignee match is the fallback for
    // sessions not spawned through the board.
    const cards = this.board.list();
    const card =
      cards.find((c) => c.status === "running" && c.sessionId === event.sessionId) ??
      cards.find((c) => c.status === "running" && c.assignee === event.agentId);
    if (!card) return;

    if (event.type === "session.end") {
      this.toolUses.delete(event.agentId);
      const done = this.board.update(card.id, { status: "review", progress: 100 });
      if (done) this.onCard(done);
      return;
    }

    let progress: number;
    if (event.type === "task.progress" && typeof event.data["percent"] === "number") {
      // Explicit signal wins over the heuristic.
      progress = Math.max(0, Math.min(100, Math.round(event.data["percent"] as number)));
    } else {
      const uses = (this.toolUses.get(event.agentId) ?? 0) + 1;
      this.toolUses.set(event.agentId, uses);
      // Asymptotic creep: visible motion early, never claims completion.
      progress = Math.min(95, Math.round(100 * (1 - Math.exp(-uses / 12))));
    }
    if (progress > card.progress) {
      const updated = this.board.update(card.id, { progress });
      if (updated) this.onCard(updated);
    }
  }

  private tryBind(event: AgentEvent): void {
    const cwd = normCwd(String(event.data["cwd"] ?? ""));
    if (!cwd) return;
    const entry = this.pending.get(cwd);
    if (!entry) return;
    this.pending.delete(cwd);
    if (Date.now() > entry.expiresAt) return;
    const bound = this.board.update(entry.cardId, {
      sessionId: event.sessionId,
      assignee: event.agentId,
    });
    if (bound) this.onCard(bound);
  }
}

function normCwd(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
