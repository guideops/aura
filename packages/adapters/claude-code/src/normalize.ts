import { ulid } from "ulid";
import { z } from "zod";
import type { AgentEvent } from "@bullpen/core";

/**
 * Claude Code hook payload (subset we consume). Schema is Anthropic-internal
 * and version-drifts; keep this loose and fail soft — an unknown payload
 * becomes a generic event, never a throw. See replay fixtures for the
 * observed shapes we guarantee support for.
 */
export const ClaudeHookPayload = z
  .object({
    hook_event_name: z.string(),
    session_id: z.string(),
    cwd: z.string().optional(),
    tool_name: z.string().optional(),
    tool_input: z.record(z.unknown()).optional(),
    tool_response: z.unknown().optional(),
    message: z.unknown().optional(),
  })
  .passthrough();
export type ClaudeHookPayload = z.infer<typeof ClaudeHookPayload>;

export interface NormalizeContext {
  /** Maps sessionId → stable display name (blue-agent, …). */
  displayNameFor(sessionId: string): string;
}

const PROVIDER = "claude-code";

export function normalizeHookEvent(
  raw: unknown,
  ctx: NormalizeContext,
): AgentEvent | null {
  const parsed = ClaudeHookPayload.safeParse(raw);
  if (!parsed.success) return null;
  const p = parsed.data;
  const agentId = ctx.displayNameFor(p.session_id);
  const base = {
    id: ulid(),
    ts: Date.now(),
    provider: PROVIDER,
    sessionId: p.session_id,
    agentId,
  };

  switch (p.hook_event_name) {
    case "SessionStart":
      return {
        ...base,
        type: "session.start",
        summary: `session start ${shortPath(p.cwd)}`,
        data: { cwd: p.cwd ?? "" },
      };
    case "SessionEnd":
    case "Stop":
      return {
        ...base,
        type: p.hook_event_name === "Stop" ? "agent.status" : "session.end",
        summary: p.hook_event_name === "Stop" ? "turn complete — awaiting input" : "session end",
        data: p.hook_event_name === "Stop" ? { status: "idle" } : {},
      };
    case "PreToolUse":
      return {
        ...base,
        type: "tool.use",
        summary: `${p.tool_name ?? "tool"} ${previewInput(p.tool_input)}`,
        data: { tool: p.tool_name ?? "", inputPreview: previewInput(p.tool_input) },
      };
    case "PostToolUse":
      return {
        ...base,
        type: "tool.result",
        summary: `${p.tool_name ?? "tool"} done`,
        data: { tool: p.tool_name ?? "" },
      };
    case "SubagentStop":
      return {
        ...base,
        type: "agent.status",
        summary: "subagent.return",
        data: { status: "active" },
      };
    case "PreCompact":
      return {
        ...base,
        type: "trajectory.compact",
        summary: "trajectory.compact — context summarization",
        data: {},
      };
    case "Notification":
      return {
        ...base,
        type: "context.warn",
        summary: typeof p.message === "string" ? p.message : "notification",
        data: {},
      };
    default:
      return {
        ...base,
        type: "agent.status",
        summary: p.hook_event_name,
        data: { status: "active", raw: p.hook_event_name },
      };
  }
}

function previewInput(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  const candidate =
    input["command"] ?? input["file_path"] ?? input["url"] ?? input["pattern"] ?? "";
  return String(candidate).slice(0, 120);
}

function shortPath(p: string | undefined): string {
  if (!p) return "";
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/");
}
