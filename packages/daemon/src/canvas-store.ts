import Database from "better-sqlite3";
import { ulid } from "ulid";
import {
  CanvasNode,
  CanvasEdge,
  CanvasMeta,
  type CanvasBoard,
  type CanvasActivity,
  type CanvasNodeExtras,
} from "@aura/core";

export interface CreateNodeInput {
  id?: string;
  type: "text" | "file" | "link" | "group";
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  text?: string;
  file?: string;
  url?: string;
  label?: string;
  extras?: CanvasNodeExtras;
}

/**
 * Whiteboard store: SQLite is the source of truth for boards. The sync module
 * (canvas-sync.ts) materializes each board into a spec-pure .canvas file in
 * the vault and imports external (Obsidian) edits back — spec fields only.
 * AURA extras live here, joined by node id, out of Obsidian's reach.
 */
export class CanvasStore {
  private db: Database.Database;

  constructor(dbPath = ":memory:") {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS canvases (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        rev INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS canvas_nodes (
        canvas_id TEXT NOT NULL,
        id TEXT NOT NULL,
        type TEXT NOT NULL,
        x REAL NOT NULL, y REAL NOT NULL,
        width REAL NOT NULL, height REAL NOT NULL,
        color TEXT, text TEXT, file TEXT, url TEXT, label TEXT,
        extras TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (canvas_id, id)
      );
      CREATE TABLE IF NOT EXISTS canvas_edges (
        canvas_id TEXT NOT NULL,
        id TEXT NOT NULL,
        from_node TEXT NOT NULL, from_side TEXT,
        to_node TEXT NOT NULL, to_side TEXT,
        color TEXT, label TEXT,
        PRIMARY KEY (canvas_id, id)
      );
      CREATE TABLE IF NOT EXISTS canvas_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        canvas_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_canvas_activity ON canvas_activity(canvas_id, ts DESC);
    `);
  }

  list(): CanvasMeta[] {
    return (this.db.prepare("SELECT * FROM canvases ORDER BY updated_at DESC").all() as RawCanvas[])
      .map(hydrateMeta);
  }

  get(id: string): CanvasMeta | undefined {
    const row = this.db.prepare("SELECT * FROM canvases WHERE id = ?").get(id) as RawCanvas | undefined;
    return row ? hydrateMeta(row) : undefined;
  }

  getBySlug(slug: string): CanvasMeta | undefined {
    const row = this.db.prepare("SELECT * FROM canvases WHERE slug = ?").get(slug) as RawCanvas | undefined;
    return row ? hydrateMeta(row) : undefined;
  }

  create(name: string, slug?: string): CanvasMeta {
    const id = ulid();
    const s = slug ?? `boards/${slugify(name)}`;
    const meta = CanvasMeta.parse({ id, slug: uniqueSlug(this.db, s), name, rev: 0, updatedAt: Date.now() });
    this.db
      .prepare("INSERT INTO canvases (id, slug, name, rev, updated_at) VALUES (?, ?, ?, 0, ?)")
      .run(meta.id, meta.slug, meta.name, meta.updatedAt);
    return meta;
  }

  remove(id: string): CanvasMeta | undefined {
    const meta = this.get(id);
    if (!meta) return undefined;
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM canvases WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM canvas_nodes WHERE canvas_id = ?").run(id);
      this.db.prepare("DELETE FROM canvas_edges WHERE canvas_id = ?").run(id);
      this.db.prepare("DELETE FROM canvas_activity WHERE canvas_id = ?").run(id);
    });
    tx();
    return meta;
  }

  board(id: string): CanvasBoard | undefined {
    const canvas = this.get(id);
    if (!canvas) return undefined;
    const nodes = (this.db.prepare("SELECT * FROM canvas_nodes WHERE canvas_id = ?").all(id) as RawNode[])
      .map(hydrateNode);
    const edges = (this.db.prepare("SELECT * FROM canvas_edges WHERE canvas_id = ?").all(id) as RawEdge[])
      .map(hydrateEdge);
    return { canvas, nodes, edges };
  }

  /** Upsert one node; missing fields on update keep their current value. */
  upsertNode(canvasId: string, input: CreateNodeInput & { id?: string }): CanvasNode | undefined {
    if (!this.get(canvasId)) return undefined;
    const existing = input.id ? this.node(canvasId, input.id) : undefined;
    const node = CanvasNode.parse({
      ...(existing ?? {}),
      ...stripUndefined(input),
      id: input.id ?? ulid(),
      extras: { ...(existing?.extras ?? {}), ...(input.extras ?? {}) },
    });
    this.writeNode(canvasId, node);
    this.bump(canvasId);
    return node;
  }

  node(canvasId: string, id: string): CanvasNode | undefined {
    const row = this.db
      .prepare("SELECT * FROM canvas_nodes WHERE canvas_id = ? AND id = ?")
      .get(canvasId, id) as RawNode | undefined;
    return row ? hydrateNode(row) : undefined;
  }

  removeNode(canvasId: string, id: string): boolean {
    const n = this.db.prepare("DELETE FROM canvas_nodes WHERE canvas_id = ? AND id = ?").run(canvasId, id);
    this.db
      .prepare("DELETE FROM canvas_edges WHERE canvas_id = ? AND (from_node = ? OR to_node = ?)")
      .run(canvasId, id, id);
    if (n.changes > 0) this.bump(canvasId);
    return n.changes > 0;
  }

  upsertEdge(canvasId: string, input: Partial<CanvasEdge> & { fromNode: string; toNode: string }): CanvasEdge | undefined {
    if (!this.get(canvasId)) return undefined;
    const existing = input.id
      ? (this.db.prepare("SELECT * FROM canvas_edges WHERE canvas_id = ? AND id = ?")
          .get(canvasId, input.id) as RawEdge | undefined)
      : undefined;
    const edge = CanvasEdge.parse({
      ...(existing ? hydrateEdge(existing) : {}),
      ...stripUndefined(input),
      id: input.id ?? ulid(),
    });
    this.writeEdge(canvasId, edge);
    this.bump(canvasId);
    return edge;
  }

  removeEdge(canvasId: string, id: string): boolean {
    const n = this.db.prepare("DELETE FROM canvas_edges WHERE canvas_id = ? AND id = ?").run(canvasId, id);
    if (n.changes > 0) this.bump(canvasId);
    return n.changes > 0;
  }

  /**
   * Bulk apply from the shell autosave or the .canvas importer: upsert the
   * given nodes/edges and delete the listed ids, in one transaction, one rev
   * bump. `replaceSpec` mode (importer) treats the node/edge sets as the
   * complete new spec state: DB rows absent from the payload are deleted —
   * that's how Obsidian-side deletions propagate — while extras of surviving
   * nodes are preserved by id.
   */
  bulk(
    canvasId: string,
    input: {
      nodes?: CreateNodeInput[];
      edges?: (Partial<CanvasEdge> & { fromNode: string; toNode: string })[];
      removeNodes?: string[];
      removeEdges?: string[];
      replaceSpec?: boolean;
    },
  ): CanvasBoard | undefined {
    const before = this.board(canvasId);
    if (!before) return undefined;
    const tx = this.db.transaction(() => {
      const keepNodes = new Set<string>();
      const keepEdges = new Set<string>();
      for (const raw of input.nodes ?? []) {
        const existing = raw.id ? before.nodes.find((n) => n.id === raw.id) : undefined;
        const node = CanvasNode.parse({
          ...(existing ?? {}),
          ...stripUndefined(raw),
          id: raw.id ?? ulid(),
          extras: { ...(existing?.extras ?? {}), ...(raw.extras ?? {}) },
        });
        this.writeNode(canvasId, node);
        keepNodes.add(node.id);
      }
      for (const raw of input.edges ?? []) {
        const existing = raw.id ? before.edges.find((e) => e.id === raw.id) : undefined;
        const edge = CanvasEdge.parse({ ...(existing ?? {}), ...stripUndefined(raw), id: raw.id ?? ulid() });
        this.writeEdge(canvasId, edge);
        keepEdges.add(edge.id);
      }
      if (input.replaceSpec) {
        for (const n of before.nodes) {
          if (!keepNodes.has(n.id)) this.db.prepare("DELETE FROM canvas_nodes WHERE canvas_id = ? AND id = ?").run(canvasId, n.id);
        }
        for (const e of before.edges) {
          if (!keepEdges.has(e.id)) this.db.prepare("DELETE FROM canvas_edges WHERE canvas_id = ? AND id = ?").run(canvasId, e.id);
        }
      }
      for (const id of input.removeNodes ?? []) {
        this.db.prepare("DELETE FROM canvas_nodes WHERE canvas_id = ? AND id = ?").run(canvasId, id);
        this.db.prepare("DELETE FROM canvas_edges WHERE canvas_id = ? AND (from_node = ? OR to_node = ?)").run(canvasId, id, id);
      }
      for (const id of input.removeEdges ?? []) {
        this.db.prepare("DELETE FROM canvas_edges WHERE canvas_id = ? AND id = ?").run(canvasId, id);
      }
    });
    tx();
    this.bump(canvasId);
    return this.board(canvasId);
  }

  logActivity(canvasId: string, actor: string, action: string, detail = ""): void {
    this.db
      .prepare("INSERT INTO canvas_activity (canvas_id, ts, actor, action, detail) VALUES (?, ?, ?, ?, ?)")
      .run(canvasId, Date.now(), actor, action, detail.slice(0, 500));
  }

  activity(canvasId: string, limit = 50): CanvasActivity[] {
    return this.db
      .prepare("SELECT id, canvas_id as canvasId, ts, actor, action, detail FROM canvas_activity WHERE canvas_id = ? ORDER BY ts DESC, id DESC LIMIT ?")
      .all(canvasId, limit) as CanvasActivity[];
  }

  close(): void { this.db.close(); }

  private bump(canvasId: string): void {
    this.db
      .prepare("UPDATE canvases SET rev = rev + 1, updated_at = ? WHERE id = ?")
      .run(Date.now(), canvasId);
  }

  private writeNode(canvasId: string, n: CanvasNode): void {
    this.db
      .prepare(
        `INSERT INTO canvas_nodes (canvas_id, id, type, x, y, width, height, color, text, file, url, label, extras)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(canvas_id, id) DO UPDATE SET
           type=excluded.type, x=excluded.x, y=excluded.y, width=excluded.width, height=excluded.height,
           color=excluded.color, text=excluded.text, file=excluded.file, url=excluded.url,
           label=excluded.label, extras=excluded.extras`,
      )
      .run(
        canvasId, n.id, n.type, n.x, n.y, n.width, n.height,
        n.color ?? null, n.text ?? null, n.file ?? null, n.url ?? null, n.label ?? null,
        JSON.stringify(n.extras),
      );
  }

  private writeEdge(canvasId: string, e: CanvasEdge): void {
    this.db
      .prepare(
        `INSERT INTO canvas_edges (canvas_id, id, from_node, from_side, to_node, to_side, color, label)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(canvas_id, id) DO UPDATE SET
           from_node=excluded.from_node, from_side=excluded.from_side,
           to_node=excluded.to_node, to_side=excluded.to_side,
           color=excluded.color, label=excluded.label`,
      )
      .run(canvasId, e.id, e.fromNode, e.fromSide ?? null, e.toNode, e.toSide ?? null, e.color ?? null, e.label ?? null);
  }
}

interface RawCanvas { id: string; slug: string; name: string; rev: number; updated_at: number }
interface RawNode {
  canvas_id: string; id: string; type: string; x: number; y: number;
  width: number; height: number; color: string | null; text: string | null;
  file: string | null; url: string | null; label: string | null; extras: string;
}
interface RawEdge {
  canvas_id: string; id: string; from_node: string; from_side: string | null;
  to_node: string; to_side: string | null; color: string | null; label: string | null;
}

function hydrateMeta(r: RawCanvas): CanvasMeta {
  return CanvasMeta.parse({ id: r.id, slug: r.slug, name: r.name, rev: r.rev, updatedAt: r.updated_at });
}
function hydrateNode(r: RawNode): CanvasNode {
  return CanvasNode.parse({
    id: r.id, type: r.type, x: r.x, y: r.y, width: r.width, height: r.height,
    ...(r.color !== null ? { color: r.color } : {}),
    ...(r.text !== null ? { text: r.text } : {}),
    ...(r.file !== null ? { file: r.file } : {}),
    ...(r.url !== null ? { url: r.url } : {}),
    ...(r.label !== null ? { label: r.label } : {}),
    extras: JSON.parse(r.extras || "{}") as unknown,
  });
}
function hydrateEdge(r: RawEdge): CanvasEdge {
  return CanvasEdge.parse({
    id: r.id, fromNode: r.from_node, toNode: r.to_node,
    ...(r.from_side !== null ? { fromSide: r.from_side } : {}),
    ...(r.to_side !== null ? { toSide: r.to_side } : {}),
    ...(r.color !== null ? { color: r.color } : {}),
    ...(r.label !== null ? { label: r.label } : {}),
  });
}

function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  return s || "board";
}

function uniqueSlug(db: Database.Database, slug: string): string {
  let candidate = slug;
  for (let i = 2; ; i++) {
    const hit = db.prepare("SELECT 1 FROM canvases WHERE slug = ?").get(candidate);
    if (!hit) return candidate;
    candidate = `${slug}-${i}`;
  }
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}
