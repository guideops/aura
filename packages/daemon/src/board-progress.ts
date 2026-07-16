import type { AgentEvent, Card } from "@aura/core";
import type { Board } from "./board.js";

/**
 * Drives card progress from the agent event stream. Cards link to agents via
 * `assignee`; while a card is in_progress, its agent's activity animates the
 * progress bar (heuristic — real completion signal is session.end → review).
 */
export class BoardProgress {
  private toolUses = new Map<string, number>(); // agentId → count since claim

  constructor(private board: Board, private onCard: (card: Card) => void) {}

  apply(event: AgentEvent): void {
    if (event.type !== "tool.use" && event.type !== "task.progress" && event.type !== "session.end") {
      return;
    }
    const card = this.board
      .list()
      .find((c) => c.status === "in_progress" && c.assignee === event.agentId);
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
}
