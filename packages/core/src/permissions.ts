import { z } from "zod";

/**
 * permissions.yaml — guardrail rules evaluated on PreToolUse.
 * First matching rule wins; default action applies when nothing matches.
 * "ask" creates an Action Request and blocks the agent at the Security Gate.
 */
export const RuleAction = z.enum(["allow", "deny", "ask"]);
export type RuleAction = z.infer<typeof RuleAction>;

/**
 * Who owns the decision.
 *
 * "hook"  — observed. Claude Code runs its own permission prompt; the operator
 *           answers there and AURA only learns the outcome afterwards (see
 *           GuardrailEngine.mirror). Never raise a blocking gate for these:
 *           the question has already been asked somewhere else.
 * "peer"  — owned. A paired app parked the call here and polls until it
 *           resolves. AURA is the only place this decision exists, so it
 *           blocks until an operator acts.
 */
export const RequestOrigin = z.enum(["hook", "peer"]);
export type RequestOrigin = z.infer<typeof RequestOrigin>;

/** Who (or what) closed the request out. */
export const ResolvedBy = z.enum(["operator", "mirror"]);
export type ResolvedBy = z.infer<typeof ResolvedBy>;

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
  origin: RequestOrigin.default("hook"),
  /**
   * "expired" means the outcome was never observed — the session ended (or the
   * request aged out) without the tool ever running. It is not a denial; we
   * simply stopped waiting for an answer that was given elsewhere.
   */
  status: z.enum(["pending", "approved", "denied", "expired"]).default("pending"),
  resolvedBy: ResolvedBy.nullable().default(null),
  resolvedAt: z.number().nullable().default(null),
});
export type ActionRequest = z.infer<typeof ActionRequest>;
