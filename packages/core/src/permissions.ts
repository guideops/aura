import { z } from "zod";

/**
 * permissions.yaml — guardrail rules evaluated on PreToolUse.
 * First matching rule wins; default action applies when nothing matches.
 * "ask" creates an Action Request and blocks the agent at the Security Gate.
 */
export const RuleAction = z.enum(["allow", "deny", "ask"]);
export type RuleAction = z.infer<typeof RuleAction>;

export const PermissionRule = z.object({
  /** Tool name glob, e.g. "Bash", "Write", "mcp__*" */
  tool: z.string(),
  /** Optional regex tested against the tool input (command, file_path, url…). */
  match: z.string().optional(),
  action: RuleAction,
  reason: z.string().optional(),
});
export type PermissionRule = z.infer<typeof PermissionRule>;

export const PermissionsFile = z.object({
  version: z.literal(1),
  default: RuleAction.default("allow"),
  rules: z.array(PermissionRule).default([]),
});
export type PermissionsFile = z.infer<typeof PermissionsFile>;

export const ActionRequest = z.object({
  id: z.string(),
  ts: z.number(),
  agentId: z.string(),
  sessionId: z.string(),
  tool: z.string(),
  inputPreview: z.string(), // truncated, human-readable
  reason: z.string().default(""),
  impact: z.enum(["low", "medium", "high"]).default("medium"),
  status: z.enum(["pending", "approved", "denied", "expired"]).default("pending"),
  resolvedAt: z.number().nullable().default(null),
});
export type ActionRequest = z.infer<typeof ActionRequest>;
