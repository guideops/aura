import { describe, expect, it } from "vitest";
import { buildPrompt } from "./session-manager.js";

const SKILL_BODY = `---
name: summarize-pr
description: Summarize a PR
---

# summarize-pr

## Steps
1. Read the diff.
`;

describe("buildPrompt", () => {
  it("returns the prompt unchanged with no skills", () => {
    expect(buildPrompt("do the thing", [])).toBe("do the thing");
  });

  it("prepends skill sections with frontmatter stripped", () => {
    const out = buildPrompt("review PR 42", [{ name: "summarize-pr", body: SKILL_BODY }]);
    expect(out).toContain("### Skill: summarize-pr");
    expect(out).toContain("## Steps");
    expect(out).not.toContain("description: Summarize a PR");
    expect(out).toMatch(/Task:\nreview PR 42$/);
  });

  it("includes every equipped skill in order", () => {
    const out = buildPrompt("t", [
      { name: "a", body: "---\nname: a\ndescription: d\n---\nbody-a" },
      { name: "b", body: "---\nname: b\ndescription: d\n---\nbody-b" },
    ]);
    expect(out.indexOf("### Skill: a")).toBeLessThan(out.indexOf("### Skill: b"));
    expect(out).toContain("body-a");
    expect(out).toContain("body-b");
  });

  it("keeps bodies without frontmatter intact", () => {
    const out = buildPrompt("t", [{ name: "raw", body: "# raw\ncontent" }]);
    expect(out).toContain("# raw\ncontent");
  });
});
