import { z } from "zod";

/**
 * Kanban board model. Columns are the local workflow lanes; a card's `status`
 * is the canonical local state. When synced to GitHub Projects v2, `status`
 * maps to a Projects single-select option via a column↔status mapping, and
 * `externalId` links the card to its GitHub item.
 */
export const CardStatus = z.enum([
  "triage",
  "todo",
  "ready",
  "running",
  "review",
  "blocked",
  "scheduled",
  "done",
  "archived",
]);
export type CardStatus = z.infer<typeof CardStatus>;

export const CardPriority = z.enum(["low", "medium", "high", "urgent"]);
export type CardPriority = z.infer<typeof CardPriority>;

export const ChecklistItem = z.object({
  id: z.string(),
  text: z.string(),
  done: z.boolean().default(false),
});
export type ChecklistItem = z.infer<typeof ChecklistItem>;

export const CardComment = z.object({
  id: z.string(),
  author: z.string().nullable().default(null),
  text: z.string(),
  ts: z.number(),
});
export type CardComment = z.infer<typeof CardComment>;

export const CardLink = z.object({
  /** "parent" | "child" relative to this card. */
  rel: z.enum(["parent", "child"]),
  /** Peer task id of the other end, e.g. "t_795ad793". */
  ref: z.string(),
  title: z.string().default(""),
});
export type CardLink = z.infer<typeof CardLink>;

export const CardTimelineEntry = z.object({
  id: z.string(),
  ts: z.number(),
  kind: z.string(),
  summary: z.string().default(""),
});
export type CardTimelineEntry = z.infer<typeof CardTimelineEntry>;

export const Card = z.object({
  id: z.string(), // local id (ULID)
  key: z.string(), // human key, e.g. "AURA-201"
  title: z.string(),
  body: z.string().default(""),
  status: CardStatus,
  tags: z.array(z.string()).default([]),
  assignee: z.string().nullable().default(null), // agentId, e.g. "blue-agent"
  progress: z.number().min(0).max(100).default(0), // steps-completed, not confidence
  externalId: z.string().nullable().default(null), // GitHub Projects item id
  /** Peer task id (Agentic Workspace / Hermes run) for idempotent ingestion. */
  externalRef: z.string().nullable().default(null),
  priority: CardPriority.default("medium"),
  milestone: z.string().nullable().default(null),
  project: z.string().nullable().default(null),
  checklist: z.array(ChecklistItem).default([]),
  /** Comments mirrored from the source system. */
  comments: z.array(CardComment).default([]),
  /** Parent and child task links mirrored from the source system. */
  links: z.array(CardLink).default([]),
  /** Event history mirrored from the source system. */
  timeline: z.array(CardTimelineEntry).default([]),
  /** Operator-authored comment awaiting write-back to the source system. */
  pendingComment: z.string().nullable().default(null),
  blockKind: z.enum(["dependency", "needs_input", "capability", "transient"]).nullable().default(null),
  /** Provider session bound to this card (set when a spawned session starts). */
  sessionId: z.string().nullable().default(null),
  /** Monotonic local version; bumped on every local mutation for conflict detection. */
  rev: z.number().int().nonnegative().default(0),
  updatedAt: z.number(),
});
export type Card = z.infer<typeof Card>;

export const Column = z.object({
  status: CardStatus,
  title: z.string(),
});
export type Column = z.infer<typeof Column>;

export const DEFAULT_COLUMNS: Column[] = [
  { status: "triage", title: "Triage" },
  { status: "todo", title: "Todo" },
  { status: "ready", title: "Ready" },
  { status: "running", title: "Running" },
  { status: "review", title: "Review" },
  { status: "blocked", title: "Blocked" },
  { status: "scheduled", title: "Scheduled" },
  { status: "done", title: "Done" },
];

export const BoardMessage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("card.upsert"), card: Card }),
  z.object({ kind: z.literal("card.removed"), id: z.string() }),
  /** GitHub sync resolved conflicts remote-wins; review queue has entries. */
  z.object({ kind: z.literal("sync.conflicts"), count: z.number().int().nonnegative() }),
]);
export type BoardMessage = z.infer<typeof BoardMessage>;
