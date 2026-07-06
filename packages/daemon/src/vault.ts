import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export interface VaultNote {
  slug: string; // relative path without extension, forward-slashed
  title: string;
  path: string; // absolute
  updatedAt: number;
}

export interface VaultSearchHit {
  slug: string;
  title: string;
  snippet: string;
}

export interface GraphNode { id: string; title: string; }
export interface GraphEdge { from: string; to: string; }

const WIKILINK = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

/**
 * Obsidian-compatible markdown vault. Plain .md files are the source of truth;
 * SQLite (FTS5 + a links table) is a derived index, rebuildable by rescanning.
 * No dependency on Obsidian — the daemon reads/writes the folder directly, so
 * a user can point Obsidian at the same folder and both see the same notes.
 */
export class Vault {
  private db: Database.Database;

  constructor(private root: string, dbPath = ":memory:") {
    fs.mkdirSync(this.root, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        slug UNINDEXED, title, body, tokenize = 'porter unicode61'
      );
      CREATE TABLE IF NOT EXISTS links (
        src TEXT NOT NULL, dst TEXT NOT NULL,
        PRIMARY KEY (src, dst)
      );
      CREATE TABLE IF NOT EXISTS meta (
        slug TEXT PRIMARY KEY, title TEXT, updated_at INTEGER
      );
    `);
  }

  /** Full rescan of the folder → rebuild FTS + links. Idempotent. */
  reindex(): number {
    const files = walk(this.root).filter((f) => f.endsWith(".md"));
    const wipe = this.db.transaction(() => {
      this.db.exec("DELETE FROM notes_fts; DELETE FROM links; DELETE FROM meta;");
      const insFts = this.db.prepare("INSERT INTO notes_fts (slug, title, body) VALUES (?, ?, ?)");
      const insMeta = this.db.prepare("INSERT INTO meta (slug, title, updated_at) VALUES (?, ?, ?)");
      const insLink = this.db.prepare("INSERT OR IGNORE INTO links (src, dst) VALUES (?, ?)");
      for (const file of files) {
        const slug = this.toSlug(file);
        const body = fs.readFileSync(file, "utf8");
        const title = titleOf(body, slug);
        const updated = fs.statSync(file).mtimeMs;
        insFts.run(slug, title, body);
        insMeta.run(slug, title, Math.round(updated));
        for (const dst of extractLinks(body)) insLink.run(slug, dst.toLowerCase());
      }
    });
    wipe();
    return files.length;
  }

  search(query: string, limit = 20): VaultSearchHit[] {
    if (!query.trim()) return [];
    try {
      return this.db
        .prepare(
          `SELECT slug, title, snippet(notes_fts, 2, '<b>', '</b>', '…', 12) AS snippet
           FROM notes_fts WHERE notes_fts MATCH ? ORDER BY rank LIMIT ?`,
        )
        .all(ftsQuery(query), limit) as VaultSearchHit[];
    } catch {
      return [];
    }
  }

  list(): VaultNote[] {
    const rows = this.db
      .prepare("SELECT slug, title, updated_at as updatedAt FROM meta ORDER BY updated_at DESC")
      .all() as Array<{ slug: string; title: string; updatedAt: number }>;
    return rows.map((r) => ({ ...r, path: this.pathFor(r.slug) }));
  }

  read(slug: string): string | null {
    const p = this.pathFor(slug);
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
  }

  /** Writes a note (creating parent dirs) and incrementally updates the index. */
  write(slug: string, body: string): void {
    const p = this.pathFor(slug);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body, "utf8");
    const title = titleOf(body, slug);
    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM notes_fts WHERE slug = ?").run(slug);
      this.db.prepare("INSERT INTO notes_fts (slug, title, body) VALUES (?, ?, ?)").run(slug, title, body);
      this.db.prepare(
        "INSERT INTO meta (slug, title, updated_at) VALUES (?, ?, ?) ON CONFLICT(slug) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at",
      ).run(slug, title, now);
      this.db.prepare("DELETE FROM links WHERE src = ?").run(slug);
      const insLink = this.db.prepare("INSERT OR IGNORE INTO links (src, dst) VALUES (?, ?)");
      for (const dst of extractLinks(body)) insLink.run(slug, dst.toLowerCase());
    });
    tx();
  }

  /** Backlink graph over the whole vault (nodes + directed wikilink edges). */
  graph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodes = this.db.prepare("SELECT slug as id, title FROM meta").all() as GraphNode[];
    // lowercase → canonical slug, resolvable by full slug or by filename tail.
    const byFull = new Map<string, string>();
    const byTail = new Map<string, string>();
    for (const n of nodes) {
      byFull.set(n.id.toLowerCase(), n.id);
      byTail.set(n.id.toLowerCase().split("/").pop()!, n.id);
    }
    const rawEdges = this.db.prepare("SELECT src as 'from', dst as 'to' FROM links").all() as GraphEdge[];
    const edges: GraphEdge[] = [];
    for (const e of rawEdges) {
      const target = byFull.get(e.to) ?? byTail.get(e.to);
      if (target) edges.push({ from: e.from, to: target });
    }
    return { nodes, edges };
  }

  get rootDir(): string { return this.root; }

  close(): void { this.db.close(); }

  private toSlug(absFile: string): string {
    return path.relative(this.root, absFile).replace(/\\/g, "/").replace(/\.md$/i, "");
  }
  private pathFor(slug: string): string {
    return path.join(this.root, ...slug.split("/")) + ".md";
  }
}

function walk(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".obsidian" || entry.name.startsWith(".")) continue;
      out.push(...walk(full));
    } else out.push(full);
  }
  return out;
}

function titleOf(body: string, slug: string): string {
  const h1 = body.match(/^#\s+(.+)$/m);
  if (h1) return h1[1]!.trim();
  const fm = body.match(/^---\n([\s\S]*?)\n---/);
  if (fm) {
    const t = fm[1]!.match(/^title:\s*(.+)$/m);
    if (t) return t[1]!.trim().replace(/^["']|["']$/g, "");
  }
  return slug.split("/").pop()!;
}

function extractLinks(body: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  WIKILINK.lastIndex = 0;
  while ((m = WIKILINK.exec(body)) !== null) out.push(m[1]!.trim());
  return out;
}

/** Sanitizes user text into a safe FTS5 prefix query (AND of prefix terms). */
function ftsQuery(input: string): string {
  const terms = input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `${t}*`);
  return terms.length ? terms.join(" AND ") : input;
}
