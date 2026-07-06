import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Vault } from "./vault.js";
import { EventLog } from "./persistence.js";
import { generateBrief } from "./brief.js";
import type { AgentEvent } from "@aura/core";

let dir: string;
let vault: Vault;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-vault-"));
  vault = new Vault(dir, ":memory:");
});
afterEach(() => {
  vault.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("Vault", () => {
  it("writes, reads, and FTS-searches notes", () => {
    vault.write("Decisions", "# Decisions\n\nWe chose SQLite FTS5 for portable search.");
    vault.write("People/alice", "# Alice\n\nOwns the retrieval pipeline.");
    expect(vault.read("Decisions")).toContain("FTS5");

    const hits = vault.search("portable search");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.slug).toBe("Decisions");

    const alice = vault.search("retrieval");
    expect(alice[0]!.slug).toBe("People/alice");
  });

  it("derives title from H1 or frontmatter", () => {
    vault.write("a", "---\ntitle: From Frontmatter\n---\nbody");
    vault.write("b", "# From Heading\nbody");
    const notes = vault.list();
    expect(notes.find((n) => n.slug === "a")?.title).toBe("From Frontmatter");
    expect(notes.find((n) => n.slug === "b")?.title).toBe("From Heading");
  });

  it("builds a backlink graph from wikilinks", () => {
    vault.write("Brief", "# Brief\nSee [[Decisions]] and [[People/alice]].");
    vault.write("Decisions", "# Decisions\ncontent");
    vault.write("People/alice", "# Alice\ncontent");
    const { nodes, edges } = vault.graph();
    expect(nodes.length).toBe(3);
    const fromBrief = edges.filter((e) => e.from === "Brief").map((e) => e.to).sort();
    expect(fromBrief).toEqual(["Decisions", "People/alice"]);
  });

  it("reindex picks up files written outside the API (Obsidian interop)", () => {
    fs.writeFileSync(path.join(dir, "External.md"), "# External\nwritten by Obsidian");
    const count = vault.reindex();
    expect(count).toBe(1);
    expect(vault.search("Obsidian")[0]!.slug).toBe("External");
  });

  it("fails soft on malformed FTS queries", () => {
    vault.write("x", "# X\nhello");
    expect(vault.search('"')).toEqual([]);
    expect(vault.search("hel")).toHaveLength(1); // prefix match
  });
});

describe("generateBrief", () => {
  it("summarizes recent events into markdown with wikilinks", () => {
    const log = new EventLog(":memory:");
    const now = Date.now();
    const ev = (over: Partial<AgentEvent>): AgentEvent => ({
      id: Math.random().toString(36).slice(2),
      ts: now,
      provider: "claude-code",
      sessionId: "s1",
      agentId: "blue-agent",
      type: "tool.use",
      summary: "",
      data: {},
      ...over,
    });
    log.append(ev({ type: "task.claim", summary: "task", data: { title: "Ship vault" } }));
    log.append(ev({ type: "tool.use", data: { tool: "Bash" } }));
    log.append(ev({ type: "tool.deny", data: { tool: "Bash" } }));
    log.append(ev({ type: "usage.tokens", data: { model: "claude-fable-5", inputTokens: 1000, outputTokens: 500 } }));

    const md = generateBrief(log, 3_600_000);
    expect(md).toContain("# Brief");
    expect(md).toContain("[[blue-agent]]");
    expect(md).toContain("1,500"); // total tokens
    expect(md).toContain("Ship vault");
    expect(md).toContain("1 denied");
    log.close();
  });
});
