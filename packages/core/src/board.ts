import { z } from "zod";

/**
 * Kanban board model. Columns are the local workflow lanes; a card's `status`
 * is the canonical local state. When synced to GitHub Projects v2, `status`
 * maps to a Projects single-select option via a column↔status mapping, and
 * `externalId` links the card to its GitHub item.
 */
export const CardStatus = z.enum(["backlog", "in_progress", "review", "done"]);
export type CardStatus = z.infer<typeof CardStatus>;

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
  { status: "backlog", title: "Backlog" },
  { status: "in_progress", title: "In Progress" },
  { status: "review", title: "Review" },
  { status: "done", title: "Done" },
];

export const BoardMessage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("card.upsert"), card: Card }),
  z.object({ kind: z.literal("card.removed"), id: z.string() }),
  /** GitHub sync resolved conflicts remote-wins; review queue has entries. */
  z.object({ kind: z.literal("sync.conflicts"), count: z.number().int().nonnegative() }),
]);
export type BoardMessage = z.infer<typeof BoardMessage>;
