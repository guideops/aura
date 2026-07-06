import { z } from "zod";

/**
 * Canonical event vocabulary. Names seeded from the reference product's
 * event log (tool.*, task.*, trajectory.*, session.*, occupancy.*, handoff)
 * so downstream UI copy maps 1:1.
 */
export const AgentEventType = z.enum([
  "session.start",
  "session.end",
  "session.recall",
  "tool.use",
  "tool.result",
  "tool.deny",
  "tool.ask", // guardrail: awaiting operator approval
  "task.claim",
  "task.progress",
  "task.complete",
  "handoff",
  "trajectory.compact",
  "context.warn",
  "usage.tokens",
  "occupancy.update",
  "agent.status",
  "system.error",
]);
export type AgentEventType = z.infer<typeof AgentEventType>;

export const AgentStatus = z.enum([
  // mirrors the 12-state character emote set, minus pure-cosmetic ones
  "idle",
  "active",
  "researching",
  "reading",
  "blocked", // waiting at the security gate
  "review",
  "error",
  "offline",
  "success",
]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const TokenUsage = z.object({
  model: z.string(), // e.g. "claude-fable-5"
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().default(0),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

export const AgentEvent = z.object({
  id: z.string(), // ulid/uuid assigned by ingress
  ts: z.number(), // epoch ms
  provider: z.string(), // "claude-code" | "hermes" | ...
  sessionId: z.string(),
  agentId: z.string(), // stable display identity, e.g. "blue-agent"
  type: AgentEventType,
  /** Human-readable one-liner for the event log pane. */
  summary: z.string().default(""),
  /** Type-specific payload; validated per-type at the edge, opaque after. */
  data: z.record(z.unknown()).default({}),
});
export type AgentEvent = z.infer<typeof AgentEvent>;

export const AgentSnapshot = z.object({
  agentId: z.string(),
  provider: z.string(),
  sessionId: z.string(),
  status: AgentStatus,
  /** Current task label, e.g. card title. */
  task: z.string().default(""),
  cwd: z.string().default(""),
  startedAt: z.number().nullable().default(null),
  lastEventAt: z.number().nullable().default(null),
  tokens: z.object({
    input: z.number().int().nonnegative().default(0),
    output: z.number().int().nonnegative().default(0),
    cacheRead: z.number().int().nonnegative().default(0),
    byModel: z.record(z.number().int().nonnegative()).default({}),
  }),
  /** Pending guardrail request id, when status === "blocked". */
  pendingApprovalId: z.string().nullable().default(null),
});
export type AgentSnapshot = z.infer<typeof AgentSnapshot>;

/** Messages the daemon broadcasts to renderers over WebSocket. */
export const ServerMessage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hello"), agents: z.array(AgentSnapshot), serverVersion: z.string() }),
  z.object({ kind: z.literal("event"), event: AgentEvent }),
  z.object({ kind: z.literal("snapshot"), agent: AgentSnapshot }),
  z.object({ kind: z.literal("agent.removed"), agentId: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
