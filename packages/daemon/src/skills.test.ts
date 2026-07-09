import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillRegistry, SkillValidationError, parseSkill } from "./skills.js";

const SKILL = (name: string, extra = "") => `---
name: ${name}
description: Test skill ${name}
tags: [test]
${extra}---

# ${name}

## When to use
Whenever testing.
`;

let root: string;
let reg: SkillRegistry;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aura-skills-"));
  reg = new SkillRegistry(root);
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("SkillRegistry", () => {
  it("starts empty and creates the root dir", () => {
    expect(reg.list()).toEqual([]);
    expect(fs.existsSync(root)).toBe(true);
  });

  it("writes and reads a skill", () => {
    const entry = reg.write("greet", SKILL("greet"));
    expect(entry.meta.name).toBe("greet");
    expect(entry.meta.version).toBe("0.1.0"); // schema default
    expect(reg.read("greet")).toContain("## When to use");
    expect(fs.existsSync(path.join(root, "greet", "SKILL.md"))).toBe(true);
  });

  it("rejects bodies without valid frontmatter", () => {
    expect(() => reg.write("bad", "# no frontmatter")).toThrow(SkillValidationError);
    expect(() => reg.write("bad", "---\ndescription: no name\n---\nbody")).toThrow(
      SkillValidationError,
    );
  });

  it("rejects frontmatter name mismatching the skill id", () => {
    expect(() => reg.write("alpha", SKILL("beta"))).toThrow(/must match skill id/);
  });

  it("reindex picks up externally created skills and skips invalid ones", () => {
    fs.mkdirSync(path.join(root, "external"));
    fs.writeFileSync(path.join(root, "external", "SKILL.md"), SKILL("external"));
    fs.mkdirSync(path.join(root, "broken"));
    fs.writeFileSync(path.join(root, "broken", "SKILL.md"), "no frontmatter here");
    fs.mkdirSync(path.join(root, ".hidden"));
    expect(reg.reindex()).toBe(1);
    expect(reg.list().map((s) => s.dir)).toEqual(["external"]);
  });

  it("removes a skill directory", () => {
    reg.write("gone", SKILL("gone"));
    expect(reg.remove("gone")).toBe(true);
    expect(reg.remove("gone")).toBe(false);
    expect(fs.existsSync(path.join(root, "gone"))).toBe(false);
  });
});

describe("parseSkill", () => {
  it("applies schema defaults", () => {
    const meta = parseSkill(`---\nname: minimal\ndescription: d\n---\nbody`);
    expect(meta).toMatchObject({ name: "minimal", version: "0.1.0", tags: [] });
  });
  it("returns null on malformed yaml", () => {
    expect(parseSkill("---\n: : :\n---\nbody")).toBeNull();
  });
  it("enforces kebab-case names", () => {
    expect(parseSkill(`---\nname: Bad Name\ndescription: d\n---\n`)).toBeNull();
  });
});
