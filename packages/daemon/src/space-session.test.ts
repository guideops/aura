import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDaemon, type Daemon } from "./server.js";
import { SessionManager } from "./session-manager.js";
import { defaultSpace, SpaceStore } from "./space-store.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-space-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("SpaceStore", () => {
  it("returns the default layout when no file exists", () => {
    const store = new SpaceStore(path.join(dir, "office.space.json"));
    const space = store.load();
    expect(space.name).toBe("AURA HQ");
    expect(space.primitives.some((p) => p.kind === "council")).toBe(true);
  });

  it("round-trips a saved layout", () => {
    const file = path.join(dir, "office.space.json");
    const store = new SpaceStore(file);
    const space = defaultSpace();
    space.primitives[0]!.position = [3, 0, 3];
    store.save(space);
    expect(new SpaceStore(file).load().primitives[0]!.position).toEqual([3, 0, 3]);
  });
});

describe("space endpoints", () => {
  let daemon: Daemon;
  beforeEach(async () => {
    daemon = createDaemon({
      dbPath: ":memory:",
      vaultDir: path.join(dir, "vault"),
      skillsDir: path.join(dir, "skills"),
      spaceFile: path.join(dir, "office.space.json"),
    });
    await daemon.app.ready();
  });
  afterEach(async () => daemon.app.close());

  it("GET /api/space serves the layout; PUT persists edits", async () => {
    const space = (await daemon.app.inject({ url: "/api/space" })).json();
    expect(space.version).toBe(1);
    space.primitives[0].position = [5, 0, 5];
    const put = await daemon.app.inject({ method: "PUT", url: "/api/space", payload: space });
    expect(put.statusCode).toBe(200);
    const again = (await daemon.app.inject({ url: "/api/space" })).json();
    expect(again.primitives[0].position).toEqual([5, 0, 5]);
  });

  it("PUT /api/space rejects invalid layouts", async () => {
    const res = await daemon.app.inject({
      method: "PUT", url: "/api/space", payload: { version: 2, junk: true },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("SessionManager output streaming", () => {
  it("captures stdout/stderr into a ring buffer and emits chunks", async () => {
    const chunks: string[][] = [];
    const mgr = new SessionManager("http://localhost:0", {
      command: "node",
      rawArgs: ["-e", "console.log('L1');console.log('L2');console.error('E1')"],
      onOutput: (c) => chunks.push(c.lines),
    });
    const session = mgr.spawn({ cwd: dir, prompt: "test" });
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (mgr.list()[0]!.status !== "running") { clearInterval(t); resolve(); }
      }, 50);
    });
    const out = mgr.output(session.id)!;
    expect(out).toContain("L1");
    expect(out).toContain("L2");
    expect(out).toContain("[stderr] E1");
    expect(chunks.flat().length).toBeGreaterThanOrEqual(3);
    expect(mgr.output("nope")).toBeNull();
  }, 15000);
});
