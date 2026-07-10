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
export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private procs = new Map<string, ChildProcess>();
  private settingsFile: string | null = null;

  constructor(private daemonUrl: string) {}

  list(): ManagedSession[] {
    return [...this.sessions.values()];
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

    const args = ["-p", fullPrompt, "--settings", this.ensureSettingsFile()];
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
