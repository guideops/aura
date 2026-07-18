import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CanvasStore } from "./canvas-store.js";
import { CanvasSync } from "./canvas-sync.js";

let dir: string;
let store: CanvasStore;
let sync: CanvasSync;
let imported: Array<{ canvasId: string; rev: number }>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-canvas-"));
  store = new CanvasStore(":memory:");
  imported = [];
  sync = new CanvasSync(store, () => dir, (canvasId, rev) => imported.push({ canvasId, rev }));
});
afterEach(() => {
  sync.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("CanvasStore", () => {
  it("creates boards, upserts nodes/edges, bumps rev", () => {
    const meta = store.create("Launch Plan");
    expect(meta.slug).toBe("boards/launch-plan");
    const a = store.upsertNode(meta.id, { type: "text", text: "# Idea", x: 0, y: 0, width: 200, height: 100 })!;
    const b = store.upsertNode(meta.id, {
      type: "text", text: "sticky", x: 300, y: 0, width: 160, height: 160,
      color: "3", extras: { kind: "sticky" },
    })!;
    store.upsertEdge(meta.id, { fromNode: a.id, toNode: b.id, label: "then" });
    const board = store.board(meta.id)!;
    expect(board.nodes).toHaveLength(2);
    expect(board.edges[0]!.label).toBe("then");
    expect(board.canvas.rev).toBe(3);
    expect(board.nodes.find((n) => n.id === b.id)!.extras.kind).toBe("sticky");
  });

  it("removing a node removes its edges", () => {
    const meta = store.create("t");
    const a = store.upsertNode(meta.id, { type: "text", text: "a", x: 0, y: 0, width: 10, height: 10 })!;
    const b = store.upsertNode(meta.id, { type: "text", text: "b", x: 0, y: 0, width: 10, height: 10 })!;
    store.upsertEdge(meta.id, { fromNode: a.id, toNode: b.id });
    store.removeNode(meta.id, a.id);
    expect(store.board(meta.id)!.edges).toHaveLength(0);
  });

  it("slug collisions get suffixed", () => {
    store.create("Same Name");
    const second = store.create("Same Name");
    expect(second.slug).toBe("boards/same-name-2");
  });
});

describe("CanvasSync round-trip", () => {
  it("exports spec-pure .canvas (no extras leak)", () => {
    const meta = store.create("Board");
    store.upsertNode(meta.id, {
      type: "text", text: "note", x: 1, y: 2, width: 100, height: 50,
      extras: { kind: "comment", agent: "blue-agent", ts: 123 },
    });
    sync.export(meta.id);
    const file = path.join(dir, "boards", "board.canvas");
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { nodes: Record<string, unknown>[] };
    expect(raw.nodes).toHaveLength(1);
    expect(raw.nodes[0]!["text"]).toBe("note");
    expect(raw.nodes[0]!["extras"]).toBeUndefined();
    expect(JSON.stringify(raw)).not.toContain("blue-agent");
  });

  it("import merges spec fields, preserves extras, propagates deletions", () => {
    const meta = store.create("Board");
    const keep = store.upsertNode(meta.id, {
      type: "text", text: "keep me", x: 0, y: 0, width: 100, height: 50,
      extras: { agent: "blue-agent", kind: "comment" },
    })!;
    const gone = store.upsertNode(meta.id, { type: "text", text: "delete me", x: 0, y: 100, width: 100, height: 50 })!;
    sync.export(meta.id);

    // Simulate an Obsidian edit: move `keep`, delete `gone`, add a new node.
    const file = path.join(dir, "boards", "board.canvas");
    const spec = JSON.parse(fs.readFileSync(file, "utf8")) as { nodes: Record<string, unknown>[]; edges: unknown[] };
    spec.nodes = spec.nodes.filter((n) => n["id"] !== gone.id);
    spec.nodes.find((n) => n["id"] === keep.id)!["x"] = 500;
    spec.nodes.push({ id: "obsidian-new", type: "text", text: "made in obsidian", x: 9, y: 9, width: 80, height: 40 });
    fs.writeFileSync(file, JSON.stringify(spec));

    expect(sync.import(file)).toBe(true);
    const board = store.board(meta.id)!;
    expect(board.nodes).toHaveLength(2);
    const merged = board.nodes.find((n) => n.id === keep.id)!;
    expect(merged.x).toBe(500);
    expect(merged.extras.agent).toBe("blue-agent"); // extras survived the external edit
    expect(board.nodes.find((n) => n.id === "obsidian-new")!.text).toBe("made in obsidian");
    expect(board.nodes.find((n) => n.id === gone.id)).toBeUndefined();
    expect(imported).toHaveLength(1);
  });

  it("adopts a .canvas created directly in the vault", () => {
    const file = path.join(dir, "boards", "fresh.canvas");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      nodes: [{ id: "n1", type: "text", text: "hello", x: 0, y: 0, width: 100, height: 40 }],
      edges: [],
    }));
    expect(sync.adoptExisting()).toBe(1);
    const meta = store.getBySlug("boards/fresh")!;
    expect(meta.name).toBe("Fresh");
    expect(store.board(meta.id)!.nodes[0]!.text).toBe("hello");
  });
});
