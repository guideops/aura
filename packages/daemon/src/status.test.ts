import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDaemon, type Daemon } from "./server.js";

let dir: string;
let daemon: Daemon;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-status-"));
  daemon = createDaemon({
    dbPath: ":memory:",
    vaultDir: path.join(dir, "vault"),
    skillsDir: path.join(dir, "skills"),
  });
  await daemon.app.ready();
});
afterEach(async () => {
  await daemon.app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("shell data endpoints", () => {
  it("GET /api/status reports orchestration, services, git, problems", async () => {
    const res = await daemon.app.inject({ method: "GET", url: "/api/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.orchestration.agentsOnline).toBe(0);
    expect(body.orchestration.tasksPending).toBe(0);
    expect(body.services.daemon.ok).toBe(true);
    expect(body.services.vault.ok).toBe(true);
    expect(body.problems).toBe(0);
    expect("branch" in body.git).toBe(true);
  });

  it("GET /api/status counts pending cards", async () => {
    daemon.board.create({ title: "one" });
    const done = daemon.board.create({ title: "two" });
    daemon.board.update(done.id, { status: "done" });
    const body = (await daemon.app.inject({ url: "/api/status" })).json();
    expect(body.orchestration.tasksPending).toBe(1);
    expect(body.orchestration.tasksTotal).toBe(2);
  });

  it("GET /api/vault/tree nests folders and sorts folders first", async () => {
    daemon.vault.write("zeta", "# Zeta note");
    daemon.vault.write("docs/alpha", "# Alpha");
    daemon.vault.write("docs/deep/nested", "# Nested");
    const body = (await daemon.app.inject({ url: "/api/vault/tree" })).json();
    const names = body.tree.map((n: { name: string }) => n.name);
    expect(names[0]).toBe("docs"); // folder sorts before loose note
    const docs = body.tree[0];
    expect(docs.slug).toBeUndefined();
    expect(docs.children.some((c: { name: string }) => c.name === "deep")).toBe(true);
    expect(docs.children.some((c: { slug?: string }) => c.slug === "docs/alpha")).toBe(true);
    expect(body.tree.some((n: { slug?: string }) => n.slug === "zeta")).toBe(true);
  });

  it("GET /api/usage aggregates tokens per model", async () => {
    await daemon.app.inject({
      method: "POST",
      url: "/api/events",
      payload: {
        provider: "claude-code",
        sessionId: "s1",
        agentId: "blue-agent",
        type: "usage.tokens",
        summary: "tokens",
        data: { inputTokens: 1200, outputTokens: 300, model: "claude-fable-5" },
      },
    });
    const body = (await daemon.app.inject({ url: "/api/usage" })).json();
    expect(body.models).toEqual([{ model: "claude-fable-5", tokens: 1500, agents: 1 }]);
    expect(body.total).toBe(1500);
  });
});
