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
  skills: string[];
  status: "running" | "exited" | "failed";
  exitCode: number | null;
  startedAt: number;
}

export interface OutputChunk {
  sessionId: string;
  stream: "stdout" | "stderr";
  lines: string[];
}

/** Ring buffer cap per session — enough scrollback, bounded memory. */
const MAX_OUTPUT_LINES = 1000;

export interface EquippedSkill {
  name: string;
  body: string; // full SKILL.md content, frontmatter included
}

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/**
 * Prompt preamble for equipped skills. Skills travel inside the prompt (not
 * the target project's .claude/skills) so spawning never mutates the repo.
 */
export function buildPrompt(prompt: string, skills: EquippedSkill[]): string {
  if (!skills.length) return prompt;
  const sections = skills.map((s) => {
    const body = s.body.replace(FRONTMATTER, "").trim();
    return `### Skill: ${s.name}\n\n${body}`;
  });
  return [
    "You have the following skills equipped. Follow them when relevant to the task.",
    ...sections,
    "---",
    `Task:\n${prompt}`,
  ].join("\n\n");
}

/**
 * Spawns headless Claude Code sessions (`claude -p`) with AURA hooks injected
 * via --settings, so spawned sessions stream events to the daemon without
 * touching the project's own .claude/settings.json.
 */
export interface SessionManagerOptions {
  /** Called for every captured stdout/stderr chunk (line-split). */
  onOutput?: (chunk: OutputChunk) => void;
  /** Called when a session leaves "running". */
  onStatus?: (sessionId: string, status: ManagedSession["status"]) => void;
  /** Test seam: command to spawn instead of "claude". */
  command?: string;
  /** Test seam: replaces the standard claude args entirely. */
  rawArgs?: string[];
}

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private procs = new Map<string, ChildProcess>();
  private outputs = new Map<string, string[]>();
  private settingsFile: string | null = null;

  constructor(private daemonUrl: string, private options: SessionManagerOptions = {}) {}

  list(): ManagedSession[] {
    return [...this.sessions.values()];
  }

  /** Buffered scrollback for one session (last MAX_OUTPUT_LINES lines). */
  output(id: string): string[] | null {
    return this.outputs.get(id) ?? (this.sessions.has(id) ? [] : null);
  }

  private capture(id: string, stream: "stdout" | "stderr", data: Buffer): void {
    const lines = data.toString("utf8").split(/\r?\n/).filter((l) => l.length > 0);
    if (!lines.length) return;
    const buf = this.outputs.get(id) ?? [];
    const tagged = stream === "stderr" ? lines.map((l) => `[stderr] ${l}`) : lines;
    buf.push(...tagged);
    if (buf.length > MAX_OUTPUT_LINES) buf.splice(0, buf.length - MAX_OUTPUT_LINES);
    this.outputs.set(id, buf);
    this.options.onOutput?.({ sessionId: id, stream, lines });
  }

  spawn(input: { cwd: string; prompt: string; model?: string; skills?: EquippedSkill[] }): ManagedSession {
    const id = ulid();
    const equipped = input.skills ?? [];
    const fullPrompt = buildPrompt(input.prompt, equipped);
    const session: ManagedSession = {
      id,
      pid: null,
      cwd: input.cwd,
      prompt: input.prompt,
      skills: equipped.map((s) => s.name),
      status: "running",
      exitCode: null,
      startedAt: Date.now(),
    };

    const args = this.options.rawArgs ?? (() => {
      const a = ["-p", fullPrompt, "--settings", this.ensureSettingsFile()];
      if (input.model) a.push("--model", input.model);
      return a;
    })();

    // shell:true so Windows resolves claude.cmd from PATH.
    const child = spawn(this.options.command ?? "claude", args, {
      cwd: input.cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    session.pid = child.pid ?? null;
    child.stdout?.on("data", (d: Buffer) => this.capture(id, "stdout", d));
    child.stderr?.on("data", (d: Buffer) => this.capture(id, "stderr", d));
    child.on("exit", (code) => {
      session.status = code === 0 ? "exited" : "failed";
      session.exitCode = code;
      this.procs.delete(id);
      this.options.onStatus?.(id, session.status);
    });
    child.on("error", () => {
      session.status = "failed";
      this.procs.delete(id);
      this.options.onStatus?.(id, session.status);
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
