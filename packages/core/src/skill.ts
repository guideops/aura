import { z } from "zod";

/**
 * skill.md frontmatter — agentskills.io-compatible so skills interop with
 * Claude Code and Hermes Agent without conversion.
 */
export const SkillMeta = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string().min(1),
  version: z.string().default("0.1.0"),
  /** Sections expected in body: When to use / Inputs / Steps / Example / Output format */
  tags: z.array(z.string()).default([]),
});
export type SkillMeta = z.infer<typeof SkillMeta>;
