import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ulid } from "ulid";
import { hooksConfig } from "@aura/adapter-claude-code";

export interface ManagedSession {
  id: string;
  pid: number | null;
  cwd: string;
  prompt: string;
  status: "running" | "exited" | "failed";
  exitCode: number | null;
  startedAt: number;
}

/**
 * Spawns headless Claude Code sessions (`claude -p`) with AURA hooks injected
 * via --settings, so spawned sessions stream events to the daemon without
 * touching the project's own .claude/settings.json.
 */
export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private procs = new Map<string, ChildProcess>();
  private settingsFile: string | null = null;

  constructor(private daemonUrl: string) {}

  list(): ManagedSession[] {
    return [...this.sessions.values()];
  }

  spawn(input: { cwd: string; prompt: string; model?: string }): ManagedSession {
    const id = ulid();
    const session: ManagedSession = {
      id,
      pid: null,
      cwd: input.cwd,
      prompt: input.prompt,
      status: "running",
      exitCode: null,
      startedAt: Date.now(),
    };

    const args = ["-p", input.prompt, "--settings", this.ensureSettingsFile()];
    if (input.model) args.push("--model", input.model);

    // shell:true so Windows resolves claude.cmd from PATH.
    const child = spawn("claude", args, {
      cwd: input.cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    session.pid = child.pid ?? null;
    child.on("exit", (code) => {
      session.status = code === 0 ? "exited" : "failed";
      session.exitCode = code;
      this.procs.delete(id);
    });
    child.on("error", () => {
      session.status = "failed";
      this.procs.delete(id);
    });

    this.sessions.set(id, session);
    this.procs.set(id, child);
    return session;
  }

  stop(id: string): boolean {
    const child = this.procs.get(id);
    if (!child) return false;
    if (process.platform === "win32" && child.pid) {
      // taskkill tree-kills the cmd shell wrapper + claude child.
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { shell: true });
    } else {
      child.kill("SIGTERM");
    }
    return true;
  }

  private ensureSettingsFile(): string {
    if (this.settingsFile && fs.existsSync(this.settingsFile)) return this.settingsFile;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-hooks-"));
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, JSON.stringify(hooksConfig(this.daemonUrl), null, 2));
    this.settingsFile = file;
    return file;
  }
}
