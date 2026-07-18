import { z } from "zod";

/**
 * Whiteboard data model. The daemon's SQLite store is the source of truth;
 * a spec-pure JSON Canvas 1.0 file (https://jsoncanvas.org) is materialized
 * into the vault so Obsidian can view and edit the same board. AURA-only
 * metadata (agent attribution, node kind, comments) lives in `extras`, which
 * never enters the .canvas file — so Obsidian can't strip it.
 */

export const CanvasNodeType = z.enum(["text", "file", "link", "group"]);
export type CanvasNodeType = z.infer<typeof CanvasNodeType>;

/** AURA-side metadata joined to a node by id. Never serialized to .canvas. */
export const CanvasNodeExtras = z.object({
  /** Render hint beyond the spec type: sticky note, agent comment pin, ... */
  kind: z.enum(["note", "sticky", "comment", "frame", "shape"]).optional(),
  /** Agent that created/last touched the node (attribution pin). */
  agent: z.string().optional(),
  /** Creation timestamp for comments/attribution. */
  ts: z.number().optional(),
  /** Shape variant when kind === "shape" (rect, ellipse, diamond). */
  shape: z.enum(["rect", "ellipse", "diamond"]).optional(),
});
export type CanvasNodeExtras = z.infer<typeof CanvasNodeExtras>;

export const CanvasNode = z.object({
  id: z.string(),
  type: CanvasNodeType,
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  /** JSON Canvas color: "1".."6" preset or "#rrggbb". */
  color: z.string().optional(),
  /** type === "text": markdown content. */
  text: z.string().optional(),
  /** type === "file": vault-relative path. */
  file: z.string().optional(),
  /** type === "link": URL. */
  url: z.string().optional(),
  /** type === "group": frame label. */
  label: z.string().optional(),
  extras: CanvasNodeExtras.default({}),
});
export type CanvasNode = z.infer<typeof CanvasNode>;

export const CanvasEdgeEnd = z.enum(["top", "right", "bottom", "left"]);

export const CanvasEdge = z.object({
  id: z.string(),
  fromNode: z.string(),
  fromSide: CanvasEdgeEnd.optional(),
  toNode: z.string(),
  toSide: CanvasEdgeEnd.optional(),
  color: z.string().optional(),
  label: z.string().optional(),
});
export type CanvasEdge = z.infer<typeof CanvasEdge>;

export const CanvasMeta = z.object({
  id: z.string(),
  /** Vault-relative slug; file materialized at `<slug>.canvas`. */
  slug: z.string(),
  name: z.string(),
  rev: z.number().int(),
  updatedAt: z.number(),
});
export type CanvasMeta = z.infer<typeof CanvasMeta>;

export const CanvasBoard = z.object({
  canvas: CanvasMeta,
  nodes: z.array(CanvasNode),
  edges: z.array(CanvasEdge),
});
export type CanvasBoard = z.infer<typeof CanvasBoard>;

export const CanvasActivity = z.object({
  id: z.number().int(),
  canvasId: z.string(),
  ts: z.number(),
  actor: z.string(),
  action: z.string(),
  detail: z.string(),
});
export type CanvasActivity = z.infer<typeof CanvasActivity>;

/** Broadcast when a board changes; clients refetch the board by id. */
export const CanvasMessage = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("canvas.updated"),
    canvasId: z.string(),
    rev: z.number().int(),
    origin: z.enum(["ui", "agent", "external"]),
  }),
  z.object({ kind: z.literal("canvas.removed"), canvasId: z.string() }),
  z.object({ kind: z.literal("canvas.created"), canvas: CanvasMeta }),
]);
export type CanvasMessage = z.infer<typeof CanvasMessage>;
