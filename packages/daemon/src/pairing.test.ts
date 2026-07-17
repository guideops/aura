import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PairingManager } from "./pairing.js";
import { createDaemon, type Daemon } from "./server.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-pair-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("PairingManager", () => {
  it("mints, claims once, verifies, persists across restarts, revokes", () => {
    const file = path.join(dir, "peers.json");
    const pm = new PairingManager(file);
    const { code } = pm.startPairing();
    expect(code).toMatch(/^\d{6}$/);

    const claimed = pm.claim(code, "agentic-workspace")!;
    expect(claimed.peer.name).toBe("agentic-workspace");
    expect(pm.claim(code, "again")).toBeNull(); // single use

    expect(pm.verify(claimed.token)!.id).toBe(claimed.peer.id);
    expect(pm.verify("wrong")).toBeNull();

    // Restart: token still valid (hash persisted), raw token absent from disk.
    const pm2 = new PairingManager(file);
    expect(pm2.verify(claimed.token)!.name).toBe("agentic-workspace");
    expect(fs.readFileSync(file, "utf8")).not.toContain(claimed.token);

    expect(pm2.revoke(claimed.peer.id)).toBe(true);
    expect(pm2.verify(claimed.token)).toBeNull();
  });

  it("expires pending codes", () => {
    vi.useFakeTimers();
    const pm = new PairingManager(path.join(dir, "peers.json"));
    const { code } = pm.startPairing();
    vi.advanceTimersByTime(120_000);
    expect(pm.claim(code, "late")).toBeNull();
    vi.useRealTimers();
  });
});

describe("pairing + peer endpoints", () => {
  let daemon: Daemon;
  beforeEach(async () => {
    daemon = createDaemon({
      dbPath: ":memory:",
      vaultDir: path.join(dir, "vault"),
      skillsDir: path.join(dir, "skills"),
      spaceFile: path.join(dir, "office.space.json"),
      peersFile: path.join(dir, "peers.json"),
      configFile: path.join(dir, "aura.config.json"),
      hermesClient: null,
    });
    await daemon.app.ready();
  });
  afterEach(async () => daemon.app.close());

  async function pairPeer(): Promise<string> {
    const { code } = (await daemon.app.inject({ method: "POST", url: "/api/pair/start" })).json();
    const res = await daemon.app.inject({
      method: "POST", url: "/api/pair/claim", payload: { code, name: "aw" },
    });
    return res.json().token;
  }

  it("pairs, heartbeats with vault path, revokes", async () => {
    const token = await pairPeer();
    const hb = await daemon.app.inject({
      method: "POST", url: "/api/peer/heartbeat",
      headers: { authorization: `Bearer ${token}` },
      payload: { vaultPath: "C:/aw/vault" },
    });
    expect(hb.statusCode).toBe(200);
    const status = (await daemon.app.inject({ url: "/api/pair/status" })).json();
    expect(status.peers[0].vaultPath).toBe("C:/aw/vault");

    const peerId = status.peers[0].id;
    await daemon.app.inject({ method: "POST", url: "/api/pair/revoke", payload: { peerId } });
    const after = (await daemon.app.inject({ url: "/api/pair/status" })).json();
    expect(after.peers).toHaveLength(0);
  });

  it("rejects peer routes without a valid token", async () => {
    const res = await daemon.app.inject({
      method: "POST", url: "/api/peer/events", payload: { events: [] },
    });
    expect(res.statusCode).toBe(401);
    const bad = await daemon.app.inject({
      method: "POST", url: "/api/peer/events",
      headers: { authorization: "Bearer nope" },
      payload: { events: [{}] },
    });
    expect(bad.statusCode).toBe(401);
  });

  it("bulk-ingests peer events into the bus", async () => {
    const token = await pairPeer();
    const ev = (agentId: string) => ({
      provider: "hermes", sessionId: "s1", agentId,
      type: "agent.status", summary: "working", data: { status: "active" },
    });
    const res = await daemon.app.inject({
      method: "POST", url: "/api/peer/events",
      headers: { authorization: `Bearer ${token}` },
      payload: { events: [ev("aw-agent"), { junk: true }, ev("aw-agent")] },
    });
    expect(res.json()).toMatchObject({ ok: true, accepted: 2, rejected: 1 });
    const { agents } = (await daemon.app.inject({ url: "/api/agents" })).json();
    expect(agents.some((a: { agentId: string }) => a.agentId === "aw-agent")).toBe(true);
  });

  it("claims fail with wrong or reused codes", async () => {
    const bad = await daemon.app.inject({
      method: "POST", url: "/api/pair/claim", payload: { code: "000000" },
    });
    expect(bad.statusCode).toBe(403);
  });

  it("swaps the vault dir at runtime and persists the choice", async () => {
    const newDir = path.join(dir, "aw-vault");
    fs.mkdirSync(newDir, { recursive: true });
    fs.writeFileSync(path.join(newDir, "Hello.md"), "# Hello from AW");
    const res = await daemon.app.inject({ method: "POST", url: "/api/vault/dir", payload: { dir: newDir } });
    expect(res.json()).toMatchObject({ ok: true, noteCount: 1 });
    expect((await daemon.app.inject({ url: "/api/vault/dir" })).json().dir).toBe(newDir);
    const { notes } = (await daemon.app.inject({ url: "/api/vault/notes" })).json();
    expect(notes[0].slug).toBe("Hello");
    // Choice persisted for next boot.
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, "aura.config.json"), "utf8"));
    expect(cfg.vaultDir).toBe(newDir);
    // Rejects non-directories.
    const bad = await daemon.app.inject({ method: "POST", url: "/api/vault/dir", payload: { dir: path.join(dir, "nope") } });
    expect(bad.statusCode).toBe(400);
  });
});
