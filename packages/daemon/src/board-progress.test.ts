import { describe, expect, it } from "vitest";
import type { AgentEvent, Card } from "@aura/core";
import { Board } from "./board.js";
import { BoardProgress } from "./board-progress.js";

const ev = (over: Partial<AgentEvent>): AgentEvent => ({
  id: Math.random().toString(36).slice(2),
  ts: Date.now(),
  provider: "claude-code",
  sessionId: "s1",
  agentId: "blue-1",
  type: "tool.use",
  summary: "",
  data: {},
  ...over,
});

function setup() {
  const board = new Board(":memory:");
  const emitted: Card[] = [];
  const bp = new BoardProgress(board, (c) => emitted.push(c));
  const card = board.create({ title: "Ship it", status: "running" });
  board.update(card.id, { assignee: "blue-1" });
  return { board, bp, card, emitted };
}

describe("BoardProgress", () => {
  it("tool.use creeps progress on the assigned running card", () => {
    const { board, bp, card, emitted } = setup();
    for (let i = 0; i < 5; i++) bp.apply(ev({ type: "tool.use" }));
    const now = board.get(card.id)!;
    expect(now.progress).toBeGreaterThan(0);
    expect(now.progress).toBeLessThanOrEqual(95);
    expect(emitted.length).toBeGreaterThan(0);
  });

  it("never exceeds 95 from the heuristic alone", () => {
    const { board, bp, card } = setup();
    for (let i = 0; i < 200; i++) bp.apply(ev({ type: "tool.use" }));
    expect(board.get(card.id)!.progress).toBe(95);
  });

  it("explicit task.progress percent overrides the heuristic", () => {
    const { board, bp, card } = setup();
    bp.apply(ev({ type: "task.progress", data: { percent: 60 } }));
    expect(board.get(card.id)!.progress).toBe(60);
    // heuristic below the explicit value does not regress it
    bp.apply(ev({ type: "tool.use" }));
    expect(board.get(card.id)!.progress).toBe(60);
  });

  it("session.end moves the card to review at 100%", () => {
    const { board, bp, card } = setup();
    bp.apply(ev({ type: "tool.use" }));
    bp.apply(ev({ type: "session.end" }));
    const done = board.get(card.id)!;
    expect(done.status).toBe("review");
    expect(done.progress).toBe(100);
  });

  it("binds sessionId from session.start cwd and prefers it over assignee", () => {
    const { board, bp, card } = setup();
    bp.expectSession(card.id, "C:\\work\\Repo");
    bp.apply(ev({
      type: "session.start",
      sessionId: "claude-sess-9",
      agentId: "green-7",
      data: { cwd: "c:/work/repo/" }, // separators + trailing slash + case normalize
    }));
    const bound = board.get(card.id)!;
    expect(bound.sessionId).toBe("claude-sess-9");
    expect(bound.assignee).toBe("green-7");

    // Progress now keys on sessionId even though agentId differs from setup's.
    bp.apply(ev({ type: "tool.use", sessionId: "claude-sess-9", agentId: "green-7" }));
    expect(board.get(card.id)!.progress).toBeGreaterThan(0);
    // Different session, different agent → no match, no movement.
    const before = board.get(card.id)!.progress;
    bp.apply(ev({ type: "tool.use", sessionId: "other", agentId: "stranger" }));
    expect(board.get(card.id)!.progress).toBe(before);
  });

  it("expired expectSession does not bind", () => {
    const { board, bp, card } = setup();
    bp.expectSession(card.id, "/tmp/x", -1); // already expired
    bp.apply(ev({ type: "session.start", sessionId: "late", data: { cwd: "/tmp/x" } }));
    expect(board.get(card.id)!.sessionId).toBeNull();
  });

  it("ignores agents with no assigned card and cards not running", () => {
    const { board, bp, emitted } = setup();
    const todo = board.create({ title: "Later" });
    board.update(todo.id, { assignee: "green-2" });
    bp.apply(ev({ agentId: "green-2" })); // card is todo, not running
    bp.apply(ev({ agentId: "nobody" }));
    expect(board.get(todo.id)!.progress).toBe(0);
    expect(emitted.every((c) => c.assignee === "blue-1")).toBe(true);
    board.close();
  });
});
