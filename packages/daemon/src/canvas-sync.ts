import fs from "node:fs";
import path from "node:path";
import type { CanvasBoard, CanvasEdge, CanvasNode } from "@aura/core";
import type { CanvasStore, CreateNodeInput } from "./canvas-store.js";

/**
 * Two-way sync between the CanvasStore (truth) and spec-pure JSON Canvas 1.0
 * files in the vault. Export writes only spec fields, so Obsidian edits can
 * never strip AURA extras (those never leave the DB). Import applies external
 * edits back — spec fields only, extras preserved by node id, deletions
 * propagated via replaceSpec.
 */
export class CanvasSync {
  private watcher: fs.FSWatcher | null = null;
  private debounces = new Map<string, NodeJS.Timeout>();
  private suppress = new Map<string, number>(); // file path -> suppress-until epoch ms

  constructor(
    private store: CanvasStore,
    private vaultRoot: () => string,
    private onImported: (canvasId: string, rev: number) => void,
  ) {}

  filePath(slug: string): string {
    return path.join(this.vaultRoot(), ...slug.split("/")) + ".canvas";
  }

  /** Materialize a board into its .canvas file (spec fields only). */
  export(canvasId: string): void {
    const board = this.store.board(canvasId);
    if (!board) return;
    const file = this.filePath(board.canvas.slug);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Own writes must not bounce back through the watcher.
    this.suppress.set(file, Date.now() + 1000);
    fs.writeFileSync(file, JSON.stringify(toSpec(board), null, "\t"), "utf8");
  }

  /** Remove the materialized file when a board is deleted. */
  removeFile(slug: string): void {
    const file = this.filePath(slug);
    this.suppress.set(file, Date.now() + 1000);
    try { fs.rmSync(file); } catch { /* already gone */ }
  }

  /** Import one .canvas file's spec state into the DB (external edit). */
  import(file: string): boolean {
    const root = this.vaultRoot();
    const rel = path.relative(root, file).replace(/\\/g, "/");
    if (rel.startsWith("..")) return false;
    const slug = rel.replace(/\.canvas$/i, "");
    const meta = this.store.getBySlug(slug);
    let raw: string;
    try { raw = fs.readFileSync(file, "utf8"); } catch { return false; }
    let parsed: SpecFile;
    try { parsed = JSON.parse(raw) as SpecFile; } catch { return false; }
    const nodes = (parsed.nodes ?? []).filter(isSpecNode).map(fromSpecNode);
    const edges = (parsed.edges ?? []).filter(isSpecEdge).map(fromSpecEdge);
    // A .canvas created directly in Obsidian gets adopted as a new board.
    const id = meta?.id ?? this.store.create(titleFromSlug(slug), slug).id;
    const after = this.store.bulk(id, { nodes, edges, replaceSpec: true });
    if (!after) return false;
    this.store.logActivity(id, "obsidian", "imported", `external edit of ${slug}.canvas`);
    this.onImported(id, after.canvas.rev);
    return true;
  }

  /** Export every board (startup / vault swap). */
  exportAll(): void {
    for (const c of this.store.list()) this.export(c.id);
  }

  /** Adopt .canvas files that exist in the vault but not in the DB. */
  adoptExisting(): number {
    let adopted = 0;
    for (const file of walkCanvas(this.vaultRoot())) {
      const rel = path.relative(this.vaultRoot(), file).replace(/\\/g, "/");
      const slug = rel.replace(/\.canvas$/i, "");
      if (!this.store.getBySlug(slug)) {
        if (this.import(file)) adopted++;
      }
    }
    return adopted;
  }

  /** Watch the vault for external .canvas edits (Obsidian). */
  watch(debounceMs = 400): void {
    if (this.watcher) return;
    try {
      this.watcher = fs.watch(this.vaultRoot(), { recursive: true }, (_ev, file) => {
        if (!file || !String(file).toLowerCase().endsWith(".canvas")) return;
        const abs = path.join(this.vaultRoot(), String(file));
        const until = this.suppress.get(abs);
        if (until && Date.now() < until) return;
        const prev = this.debounces.get(abs);
        if (prev) clearTimeout(prev);
        const t = setTimeout(() => {
          this.debounces.delete(abs);
          if (fs.existsSync(abs)) this.import(abs);
        }, debounceMs);
        t.unref?.();
        this.debounces.set(abs, t);
      });
    } catch { /* vault dir may not exist yet; watch is best-effort */ }
  }

  /** Re-point at a new vault dir (vault swap): stop watch, re-export, re-watch. */
  rewire(): void {
    this.watcher?.close();
    this.watcher = null;
    for (const t of this.debounces.values()) clearTimeout(t);
    this.debounces.clear();
    this.exportAll();
    this.adoptExisting();
    this.watch();
  }

  close(): void {
    this.watcher?.close();
    for (const t of this.debounces.values()) clearTimeout(t);
  }
}

// ---- JSON Canvas 1.0 (de)serialization ----

interface SpecFile { nodes?: unknown[]; edges?: unknown[] }

function toSpec(board: CanvasBoard): { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] } {
  return {
    nodes: board.nodes.map((n) => strip({
      id: n.id, type: n.type,
      x: Math.round(n.x), y: Math.round(n.y),
      width: Math.round(n.width), height: Math.round(n.height),
      color: n.color, text: n.text, file: n.file, url: n.url, label: n.label,
    })),
    edges: board.edges.map((e) => strip({
      id: e.id, fromNode: e.fromNode, fromSide: e.fromSide,
      toNode: e.toNode, toSide: e.toSide, color: e.color, label: e.label,
    })),
  };
}

function isSpecNode(raw: unknown): raw is Record<string, unknown> {
  const n = raw as Record<string, unknown>;
  return !!n && typeof n["id"] === "string" &&
    ["text", "file", "link", "group"].includes(String(n["type"])) &&
    typeof n["x"] === "number" && typeof n["y"] === "number";
}
function isSpecEdge(raw: unknown): raw is Record<string, unknown> {
  const e = raw as Record<string, unknown>;
  return !!e && typeof e["id"] === "string" &&
    typeof e["fromNode"] === "string" && typeof e["toNode"] === "string";
}

function fromSpecNode(n: Record<string, unknown>): CreateNodeInput & { id: string } {
  const out: CreateNodeInput & { id: string } = {
    id: String(n["id"]),
    type: String(n["type"]) as CanvasNode["type"],
    x: Number(n["x"]), y: Number(n["y"]),
    width: Number(n["width"] ?? 200), height: Number(n["height"] ?? 100),
  };
  if (typeof n["color"] === "string") out.color = n["color"];
  if (typeof n["text"] === "string") out.text = n["text"];
  if (typeof n["file"] === "string") out.file = n["file"];
  if (typeof n["url"] === "string") out.url = n["url"];
  if (typeof n["label"] === "string") out.label = n["label"];
  return out;
}

function fromSpecEdge(e: Record<string, unknown>): Partial<CanvasEdge> & { fromNode: string; toNode: string } {
  const out: Partial<CanvasEdge> & { fromNode: string; toNode: string } = {
    id: String(e["id"]),
    fromNode: String(e["fromNode"]),
    toNode: String(e["toNode"]),
  };
  if (isSide(e["fromSide"])) out.fromSide = e["fromSide"];
  if (isSide(e["toSide"])) out.toSide = e["toSide"];
  if (typeof e["color"] === "string") out.color = e["color"];
  if (typeof e["label"] === "string") out.label = e["label"];
  return out;
}

function isSide(v: unknown): v is "top" | "right" | "bottom" | "left" {
  return v === "top" || v === "right" || v === "bottom" || v === "left";
}

function strip(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

function walkCanvas(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".")) continue;
      out.push(...walkCanvas(full));
    } else if (entry.name.toLowerCase().endsWith(".canvas")) out.push(full);
  }
  return out;
}

function titleFromSlug(slug: string): string {
  const tail = slug.split("/").pop() ?? slug;
  return tail.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
