import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDaemon, type Daemon } from "./server.js";

/**
 * A real temp path, not ":memory:" — SpaceStore is file-backed, and growing the
 * room to seat a third agent genuinely writes the layout back.
 */
let spaceFiles: string[] = [];
function tempSpaceFile(): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aura-space-")), "office.space.json");
  spaceFiles.push(file);
  return file;
}
function cleanupSpaceFiles(): void {
  for (const file of spaceFiles) fs.rmSync(path.dirname(file), { recursive: true, force: true });
  spaceFiles = [];
}

const hook = (daemon: Daemon, payload: Record<string, unknown>) =>
  daemon.app.inject({ method: "POST", url: "/api/hooks/claude-code", payload });

const start = (daemon: Daemon, sessionId: string, cwd: string) =>
  hook(daemon, { hook_event_name: "SessionStart", session_id: sessionId, cwd });

const names = (daemon: Daemon) => daemon.store.list().map((a) => a.agentId).sort();

describe("one bot per session", () => {
  let daemon: Daemon;

  beforeEach(async () => {
    daemon = createDaemon({ dbPath: ":memory:", spaceFile: tempSpaceFile() });
    await daemon.app.ready();
  });

  afterEach(async () => {
    await daemon.app.close();
    daemon.log.close();
    cleanupSpaceFiles();
  });

  it("spawns a bot per session, named after its project", async () => {
    await start(daemon, "s1", "/root/aura");
    await start(daemon, "s2", "/root/agentic-workspace");

    expect(names(daemon)).toEqual(["agentic-workspace-1", "aura-1"]);
  });

  it("spawns a second bot for a second session in the same project", async () => {
    await start(daemon, "s1", "/root/aura");
    await start(daemon, "s2", "/root/aura");

    // Two terminals in one repo are two colleagues, not one that got busier.
    expect(names(daemon)).toEqual(["aura-1", "aura-2"]);
  });

  it("does not reuse a freed number, so a new bot can't inherit a dead identity", async () => {
    await start(daemon, "s1", "/root/aura");
    await hook(daemon, { hook_event_name: "SessionEnd", session_id: "s1" });
    await start(daemon, "s2", "/root/aura");

    expect(names(daemon)).toEqual(["aura-2"]);
  });

  it("despawns on session end rather than parking an offline bot", async () => {
    await start(daemon, "s1", "/root/aura");
    expect(names(daemon)).toEqual(["aura-1"]);

    await hook(daemon, { hook_event_name: "SessionEnd", session_id: "s1" });

    expect(daemon.store.list()).toHaveLength(0);
  });

  it("keeps a session's name stable when later events carry no cwd", async () => {
    await start(daemon, "s1", "/root/aura");
    await hook(daemon, {
      hook_event_name: "PreToolUse",
      session_id: "s1",
      tool_name: "Read",
      tool_input: { file_path: "x.ts" },
    });

    expect(names(daemon)).toEqual(["aura-1"]);
  });

  it("falls back to a usable name when the first event has no cwd", async () => {
    await hook(daemon, {
      hook_event_name: "PreToolUse",
      session_id: "s-nocwd",
      tool_name: "Read",
      tool_input: { file_path: "x.ts" },
    });

    expect(names(daemon)).toEqual(["agent-1"]);
  });

  it("ignores automated session factories entirely", async () => {
    const quiet = createDaemon({
      dbPath: ":memory:",
      spaceFile: tempSpaceFile(),
      ignoreProjects: ["claude-mem-observer"],
    });
    await quiet.app.ready();
    try {
      await start(quiet, "obs", "/root/.claude-mem-observer-sessions");
      await start(quiet, "real", "/root/aura");

      expect(names(quiet)).toEqual(["aura-1"]);
    } finally {
      await quiet.app.close();
      quiet.log.close();
    }
  });
});

describe("desks are seats, not assignments", () => {
  let daemon: Daemon;

  beforeEach(async () => {
    daemon = createDaemon({ dbPath: ":memory:", spaceFile: tempSpaceFile() });
    await daemon.app.ready();
  });

  afterEach(async () => {
    await daemon.app.close();
    daemon.log.close();
    cleanupSpaceFiles();
  });

  const working = (daemon: Daemon, sessionId: string) =>
    hook(daemon, {
      hook_event_name: "PreToolUse",
      session_id: sessionId,
      tool_name: "Edit",
      tool_input: { file_path: "a.ts" },
    });

  it("claims a desk while working and gives it back when idle", async () => {
    await start(daemon, "s1", "/root/aura");
    await working(daemon, "s1");
    const busy = daemon.store.get("aura-1");
    expect(busy?.desk).toBe("desk-01");

    await hook(daemon, { hook_event_name: "Stop", session_id: "s1" });

    expect(daemon.store.get("aura-1")?.desk).toBeNull();
  });

  it("seats concurrent agents at different desks", async () => {
    await start(daemon, "s1", "/root/aura");
    await start(daemon, "s2", "/root/aura");
    await working(daemon, "s1");
    await working(daemon, "s2");

    const first = daemon.store.get("aura-1")?.desk;
    const second = daemon.store.get("aura-2")?.desk;
    expect(first).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it("grows the room rather than making a third agent queue", async () => {
    // The default layout ships two desks; a third worker gets a third desk.
    for (const s of ["s1", "s2", "s3"]) {
      await start(daemon, s, "/root/aura");
      await working(daemon, s);
    }

    const seats = daemon.store.list().map((a) => a.desk);
    expect(new Set(seats).size).toBe(3);
    expect(seats).toContain("desk-03");
  });

  it("frees the desk when the session ends", async () => {
    await start(daemon, "s1", "/root/aura");
    await working(daemon, "s1");
    await hook(daemon, { hook_event_name: "SessionEnd", session_id: "s1" });

    // desk-01 is free again, so the next worker sits there.
    await start(daemon, "s2", "/root/aura");
    await working(daemon, "s2");
    expect(daemon.store.get("aura-2")?.desk).toBe("desk-01");
  });
});
