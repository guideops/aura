import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Board } from "./board.js";
import {
  reconcile,
  SyncEngine,
  type GitHubProjectClient,
  type RemoteItem,
  type SyncState,
} from "./github-sync.js";
import type { Card, CardStatus } from "@aura/core";

function card(over: Partial<Card>): Card {
  return {
    id: "c1", key: "AURA-201", title: "t", body: "", status: "backlog",
    tags: [], assignee: null, progress: 0, externalId: null, rev: 0,
    updatedAt: 0, ...over,
  };
}

describe("reconcile (pure conflict logic)", () => {
  it("creates a remote for a new local card with no externalId", () => {
    const { ops } = reconcile([card({ id: "c1" })], [], []);
    expect(ops).toEqual([{ type: "create-remote", cardId: "c1", title: "t", status: "backlog" }]);
  });

  it("imports a remote item with no local card", () => {
    const remote: RemoteItem = { externalId: "PVTI_1", title: "remote task", status: "in_progress" };
    const { ops } = reconcile([], [remote], []);
    expect(ops).toEqual([{ type: "create-local", externalId: "PVTI_1", title: "remote task", status: "in_progress" }]);
  });

  it("pushes when only local changed", () => {
    const c = card({ id: "c1", externalId: "PVTI_1", status: "done", rev: 3 });
    const remote: RemoteItem = { externalId: "PVTI_1", title: "t", status: "in_progress" };
    const state: SyncState = { cardId: "c1", externalId: "PVTI_1", lastSyncedRev: 2, lastRemoteStatus: "in_progress" };
    const { ops, conflicts } = reconcile([c], [remote], [state]);
    expect(conflicts).toHaveLength(0);
    expect(ops).toEqual([{ type: "push", cardId: "c1", externalId: "PVTI_1", status: "done" }]);
  });

  it("pulls when only remote changed", () => {
    const c = card({ id: "c1", externalId: "PVTI_1", status: "in_progress", rev: 2 });
    const remote: RemoteItem = { externalId: "PVTI_1", title: "t", status: "done" };
    const state: SyncState = { cardId: "c1", externalId: "PVTI_1", lastSyncedRev: 2, lastRemoteStatus: "in_progress" };
    const { ops, conflicts } = reconcile([c], [remote], [state]);
    expect(conflicts).toHaveLength(0);
    expect(ops).toEqual([{ type: "pull", cardId: "c1", status: "done" }]);
  });

  it("GitHub wins on true conflict and escalates to review", () => {
    // both sides moved the card to different columns since last sync
    const c = card({ id: "c1", externalId: "PVTI_1", status: "done", rev: 5 });
    const remote: RemoteItem = { externalId: "PVTI_1", title: "t", status: "review" };
    const state: SyncState = { cardId: "c1", externalId: "PVTI_1", lastSyncedRev: 4, lastRemoteStatus: "in_progress" };
    const { ops, conflicts } = reconcile([c], [remote], [state]);
    expect(conflicts).toEqual([
      { cardId: "c1", externalId: "PVTI_1", localStatus: "done", remoteStatus: "review", resolution: "remote-wins" },
    ]);
    expect(ops).toEqual([{ type: "pull", cardId: "c1", status: "review" }]);
  });

  it("no-ops when in sync, refreshing the baseline", () => {
    const c = card({ id: "c1", externalId: "PVTI_1", status: "done", rev: 2 });
    const remote: RemoteItem = { externalId: "PVTI_1", title: "t", status: "done" };
    const state: SyncState = { cardId: "c1", externalId: "PVTI_1", lastSyncedRev: 2, lastRemoteStatus: "done" };
    const { ops, conflicts, nextStates } = reconcile([c], [remote], [state]);
    expect(ops).toHaveLength(0);
    expect(conflicts).toHaveLength(0);
    expect(nextStates[0]).toMatchObject({ cardId: "c1", lastSyncedRev: 2, lastRemoteStatus: "done" });
  });

  it("re-creates a remote that was deleted on GitHub", () => {
    const c = card({ id: "c1", externalId: "PVTI_gone", status: "backlog", rev: 1 });
    const state: SyncState = { cardId: "c1", externalId: "PVTI_gone", lastSyncedRev: 1, lastRemoteStatus: "backlog" };
    const { ops } = reconcile([c], [], [state]);
    expect(ops).toEqual([{ type: "create-remote", cardId: "c1", title: "t", status: "backlog" }]);
  });
});

// ---- mock client for engine-level soak/chaos ----
class MockClient implements GitHubProjectClient {
  items = new Map<string, RemoteItem>();
  failNext = 0;
  private seq = 0;
  constructor(seed: RemoteItem[] = []) { for (const i of seed) this.items.set(i.externalId, i); }
  async listItems(): Promise<RemoteItem[]> { return [...this.items.values()]; }
  async updateItemStatus(externalId: string, status: CardStatus): Promise<void> {
    if (this.failNext > 0) { this.failNext--; throw new Error("500"); }
    const it = this.items.get(externalId); if (it) it.status = status;
  }
  async createItem(title: string, status: CardStatus): Promise<RemoteItem> {
    if (this.failNext > 0) { this.failNext--; throw new Error("500"); }
    const item: RemoteItem = { externalId: `PVTI_${++this.seq}`, title, status };
    this.items.set(item.externalId, item);
    return item;
  }
}

describe("SyncEngine (stateful, mocked transport)", () => {
  let board: Board;
  afterEach(() => board.close());
  beforeEach(() => { board = new Board(":memory:"); });

  it("pushes a new local card to GitHub and links it", async () => {
    const c = board.create({ title: "Ship sync", status: "in_progress" });
    const client = new MockClient();
    const engine = new SyncEngine(board, client, ":memory:");
    const r = await engine.syncOnce();
    expect(r.applied).toBe(1);
    const linked = board.get(c.id)!;
    expect(linked.externalId).toMatch(/^PVTI_/);
    expect((await client.listItems())[0]).toMatchObject({ title: "Ship sync", status: "in_progress" });
    engine.close();
  });

  it("imports remote-only items into the local board", async () => {
    const client = new MockClient([{ externalId: "PVTI_x", title: "From GitHub", status: "review" }]);
    const engine = new SyncEngine(board, client, ":memory:");
    await engine.syncOnce();
    const imported = board.list().find((c) => c.title === "From GitHub");
    expect(imported?.status).toBe("review");
    expect(imported?.externalId).toBe("PVTI_x");
    engine.close();
  });

  it("resumes after an API failure with no duplicate items (chaos)", async () => {
    board.create({ title: "A", status: "backlog" });
    board.create({ title: "B", status: "backlog" });
    const client = new MockClient();
    client.failNext = 1; // first createItem throws
    const engine = new SyncEngine(board, client, ":memory:");

    const first = await engine.syncOnce();
    expect(first.failed).toBe(1); // stopped on first failure

    const second = await engine.syncOnce(); // retry
    const remote = await client.listItems();
    expect(remote).toHaveLength(2); // both created, none duplicated
    expect(second.failed).toBe(0);
    engine.close();
  });

  it("converges over a 2-way soak without dupes or losses", async () => {
    // seed 3 local + 2 remote
    const locals = ["L1", "L2", "L3"].map((t) => board.create({ title: t, status: "backlog" }));
    const client = new MockClient([
      { externalId: "PVTI_r1", title: "R1", status: "in_progress" },
      { externalId: "PVTI_r2", title: "R2", status: "done" },
    ]);
    const engine = new SyncEngine(board, client, ":memory:");

    await engine.syncOnce(); // push locals, import remotes
    // mutate both sides
    board.update(locals[0]!.id, { status: "done" }); // local move
    const r1 = (await client.listItems()).find((i) => i.title === "R1")!;
    r1.status = "review"; // remote move
    const pass2 = await engine.syncOnce();

    const finalRemote = await client.listItems();
    const finalLocal = board.list();
    // 5 distinct cards on both sides
    expect(finalRemote).toHaveLength(5);
    expect(finalLocal).toHaveLength(5);
    // local L1 pushed to done
    expect(finalRemote.find((i) => i.title === "L1")?.status).toBe("done");
    // remote R1 pulled to review locally
    expect(finalLocal.find((c) => c.title === "R1")?.status).toBe("review");
    expect(pass2.failed).toBe(0);
    engine.close();
  });
});
