import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { SkillMeta } from "@aura/core";

export interface SkillEntry {
  meta: SkillMeta;
  /** Directory name under the skills root (canonical id; matches meta.name). */
  dir: string;
  path: string; // absolute path to SKILL.md
  updatedAt: number;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Skills registry. Files are the source of truth — one skill per directory
 * (`<root>/<name>/SKILL.md`, agentskills.io / Claude Code layout), frontmatter
 * validated against `SkillMeta`. The in-memory index is rebuilt by rescanning,
 * so external edits (git pull, hand-written skills) are picked up on reindex.
 */
export class SkillRegistry {
  private byName = new Map<string, SkillEntry>();

  constructor(private root: string) {
    fs.mkdirSync(this.root, { recursive: true });
    this.reindex();
  }

  /** Rescan the skills root. Returns count of valid skills; invalid files are skipped. */
  reindex(): number {
    this.byName.clear();
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const file = path.join(this.root, entry.name, "SKILL.md");
      if (!fs.existsSync(file)) continue;
      const parsed = parseSkill(fs.readFileSync(file, "utf8"));
      if (!parsed) continue;
      this.byName.set(entry.name, {
        meta: parsed,
        dir: entry.name,
        path: file,
        updatedAt: Math.round(fs.statSync(file).mtimeMs),
      });
    }
    return this.byName.size;
  }

  list(): SkillEntry[] {
    return [...this.byName.values()].sort((a, b) => a.dir.localeCompare(b.dir));
  }

  get(name: string): SkillEntry | undefined {
    return this.byName.get(name);
  }

  /** Full SKILL.md body (frontmatter included), or null if unknown. */
  read(name: string): string | null {
    const entry = this.byName.get(name);
    return entry ? fs.readFileSync(entry.path, "utf8") : null;
  }

  /**
   * Create or replace a skill. Body must carry valid frontmatter whose `name`
   * matches the directory — one canonical id, no aliasing.
   */
  write(name: string, body: string): SkillEntry {
    const meta = parseSkill(body);
    if (!meta) throw new SkillValidationError("SKILL.md frontmatter missing or invalid");
    if (meta.name !== name) {
      throw new SkillValidationError(`frontmatter name "${meta.name}" must match skill id "${name}"`);
    }
    const dir = path.join(this.root, name);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "SKILL.md");
    fs.writeFileSync(file, body, "utf8");
    const entry: SkillEntry = { meta, dir: name, path: file, updatedAt: Date.now() };
    this.byName.set(name, entry);
    return entry;
  }

  remove(name: string): boolean {
    const entry = this.byName.get(name);
    if (!entry) return false;
    fs.rmSync(path.join(this.root, name), { recursive: true, force: true });
    this.byName.delete(name);
    return true;
  }

  get rootDir(): string { return this.root; }
}

export class SkillValidationError extends Error {}

/** Parses + validates frontmatter; null when absent or failing SkillMeta. */
export function parseSkill(body: string): SkillMeta | null {
  const m = body.match(FRONTMATTER);
  if (!m) return null;
  let raw: unknown;
  try {
    raw = parseYaml(m[1]!);
  } catch {
    return null;
  }
  const parsed = SkillMeta.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
