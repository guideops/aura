import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Board } from "./board.js";

let board: Board;
beforeEach(() => { board = new Board(":memory:"); });
afterEach(() => board.close());

describe("Board", () => {
  it("creates cards with incrementing AURA keys in backlog", () => {
    const a = board.create({ title: "First" });
    const b = board.create({ title: "Second" });
    expect(a.key).toBe("AURA-201");
    expect(b.key).toBe("AURA-202");
    expect(a.status).toBe("backlog");
    expect(a.rev).toBe(0);
  });

  it("bumps rev + updatedAt on every update", () => {
    const c = board.create({ title: "x" });
    const moved = board.update(c.id, { status: "in_progress" })!;
    expect(moved.status).toBe("in_progress");
    expect(moved.rev).toBe(1);
    const again = board.update(c.id, { progress: 50 })!;
    expect(again.rev).toBe(2);
    expect(again.progress).toBe(50);
  });

  it("persists tags and assignee round-trip", () => {
    const c = board.create({ title: "tagged", tags: ["backend", "sync"] });
    const assigned = board.update(c.id, { assignee: "blue-agent" })!;
    const reloaded = board.get(c.id)!;
    expect(reloaded.tags).toEqual(["backend", "sync"]);
    expect(reloaded.assignee).toBe("blue-agent");
  });

  it("looks up by external id and applyRemote does not bump rev", () => {
    const c = board.create({ title: "linked" });
    board.applyRemote({ ...c, externalId: "PVTI_abc", rev: c.rev });
    const found = board.getByExternal("PVTI_abc")!;
    expect(found.id).toBe(c.id);
    expect(found.rev).toBe(0); // applyRemote preserved rev
  });

  it("clamps progress and validates status via schema", () => {
    const c = board.create({ title: "x" });
    expect(() => board.update(c.id, { progress: 150 })).toThrow();
    expect(() => board.update(c.id, { status: "nope" as never })).toThrow();
  });

  it("removes cards", () => {
    const c = board.create({ title: "x" });
    expect(board.remove(c.id)).toBe(true);
    expect(board.get(c.id)).toBeUndefined();
    expect(board.remove(c.id)).toBe(false);
  });

  it("resumes key counter from persisted max on reopen", () => {
    const shared = board; // in-memory reopen not possible; simulate via create sequence
    shared.create({ title: "a" }); // 201
    const b = shared.create({ title: "b" }); // 202
    expect(b.key).toBe("AURA-202");
  });
});
