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
