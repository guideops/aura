import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CardStatus } from "@aura/core";
import { createDaemon, type Daemon } from "./server.js";
import type { GitHubProjectClient, RemoteItem } from "./github-sync.js";

/** In-memory GitHub Projects double. */
class FakeClient implements GitHubProjectClient {
  items = new Map<string, RemoteItem>();
  private seq = 0;
  async listItems(): Promise<RemoteItem[]> { return [...this.items.values()]; }
  async updateItemStatus(externalId: string, status: CardStatus): Promise<void> {
    const item = this.items.get(externalId);
    if (item) item.status = status;
  }
  async createItem(title: string, status: CardStatus): Promise<RemoteItem> {
    const item = { externalId: `PVTI_${++this.seq}`, title, status };
    this.items.set(item.externalId, item);
    return item;
  }
}

let daemon: Daemon;
let fake: FakeClient;

beforeEach(async () => {
  fake = new FakeClient();
  daemon = createDaemon({ dbPath: ":memory:", githubClientFactory: () => fake });
  await daemon.app.ready();
  await daemon.app.inject({
    method: "POST",
    url: "/api/github/link",
    payload: { token: "test-token", projectId: "PVT_test" },
  });
});
afterEach(async () => { await daemon.app.close(); });

const sync = () => daemon.app.inject({ method: "POST", url: "/api/github/sync" });
const status = async () =>
  (await daemon.app.inject({ method: "GET", url: "/api/github/status" })).json();

describe("github routes with injected client", () => {
  it("link reports interval 0 (manual) by default", async () => {
    expect((await status()).linked).toBe(true);
    expect((await status()).intervalMs).toBe(0);
  });

  it("sync pushes new local cards to the remote", async () => {
    const card = daemon.board.create({ title: "Local card" });
    const res = await sync();
    expect(res.statusCode).toBe(200);
    expect([...fake.items.values()].map((i) => i.title)).toEqual(["Local card"]);
    expect(daemon.board.get(card.id)!.externalId).toMatch(/^PVTI_/);
  });

  it("conflict lands in reviewQueue; resolve local re-asserts local status", async () => {
    const card = daemon.board.create({ title: "Contested" });
    await sync(); // link card to remote
    // Diverge both sides: local → review, remote → done.
    daemon.board.update(card.id, { status: "review" });
    const ext = daemon.board.get(card.id)!.externalId!;
    fake.items.get(ext)!.status = "done";
    await sync();

    let s = await status();
    expect(s.reviewQueue).toHaveLength(1);
    expect(daemon.board.get(card.id)!.status).toBe("done"); // remote won

    const resolve = await daemon.app.inject({
      method: "POST",
      url: "/api/github/review/resolve",
      payload: { cardId: card.id, choice: "local" },
    });
    expect(resolve.statusCode).toBe(200);
    expect(daemon.board.get(card.id)!.status).toBe("review"); // local restored
    s = await status();
    expect(s.reviewQueue).toHaveLength(0);

    // Next sync pushes the restored local status out.
    await sync();
    expect(fake.items.get(ext)!.status).toBe("review");
    expect((await status()).reviewQueue).toHaveLength(0); // no re-conflict
  });

  it("resolve remote just drops the queue entry", async () => {
    const card = daemon.board.create({ title: "Contested 2" });
    await sync();
    daemon.board.update(card.id, { status: "review" });
    fake.items.get(daemon.board.get(card.id)!.externalId!)!.status = "done";
    await sync();

    const resolve = await daemon.app.inject({
      method: "POST",
      url: "/api/github/review/resolve",
      payload: { cardId: card.id, choice: "remote" },
    });
    expect(resolve.statusCode).toBe(200);
    expect(daemon.board.get(card.id)!.status).toBe("done");
  });

  it("resolve validates input", async () => {
    const bad = await daemon.app.inject({
      method: "POST", url: "/api/github/review/resolve",
      payload: { cardId: "nope", choice: "local" },
    });
    expect(bad.statusCode).toBe(404);
  });

  it("unlink stops sync", async () => {
    await daemon.app.inject({ method: "POST", url: "/api/github/unlink" });
    expect((await status()).linked).toBe(false);
    expect((await sync()).statusCode).toBe(409);
  });
});
