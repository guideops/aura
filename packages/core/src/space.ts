import { z } from "zod";

/** `.space` layout file — CAD-ready from day 1 (rooms in meters, snap grid). */
export const Vec3 = z.tuple([z.number(), z.number(), z.number()]);

export const PrimitiveKind = z.enum([
  "desk",
  "vault",
  "whiteboard",
  "kanban-wall",
  "security-gate",
  "lounge",
  "skills-library",
  "design-board",
  "elevator",
  "decor",
]);
export type PrimitiveKind = z.infer<typeof PrimitiveKind>;

export const SpacePrimitive = z.object({
  id: z.string(), // e.g. "desk-01"
  kind: PrimitiveKind,
  label: z.string(), // e.g. "Desk 01 — Active Compute"
  position: Vec3,
  rotationY: z.number().default(0),
  scale: Vec3.default([1, 1, 1]),
  /** Functional binding: what this object is a window into. */
  binding: z
    .object({
      type: z.enum(["directory", "vault", "board", "gate", "skills", "none"]),
      target: z.string().default(""), // path, board id, etc.
    })
    .default({ type: "none", target: "" }),
});
export type SpacePrimitive = z.infer<typeof SpacePrimitive>;

export const SpaceFile = z.object({
  version: z.literal(1),
  name: z.string(),
  room: z.object({
    width: z.number().positive(), // meters
    depth: z.number().positive(),
    height: z.number().positive().default(3),
    gridSize: z.number().positive().default(0.5),
  }),
  primitives: z.array(SpacePrimitive),
});
export type SpaceFile = z.infer<typeof SpaceFile>;
