import fs from "node:fs";
import path from "node:path";
import { ulid } from "ulid";
import chokidar, { type FSWatcher } from "chokidar";
import type { AgentEvent } from "@aura/core";
import type { NormalizeContext } from "./normalize.js";

const PROVIDER = "claude-code";

/**
 * Fallback ingestion path: tails ~/.claude/projects/<hash>/<session>.jsonl.
 * Two jobs hooks can't do:
 *  1. observe sessions started outside AURA (no hooks installed), and
 *  2. token usage — hook payloads don't carry usage; transcripts do.
 * Hook-covered sessions still get usage events from here; the state store
 * treats usage.tokens as additive-only so there is no double counting of
 * status transitions (those are skipped when hooks are live).
 */
export interface TranscriptWatcherOptions {
  rootDir: string; // e.g. ~/.claude/projects
  emit: (event: AgentEvent) => void;
  ctx: NormalizeContext;
  /** Returns true when this session already streams via hooks. */
  isHookLive?: (sessionId: string) => boolean;
  /**
   * Path substrings whose transcripts are never ingested — automated session
   * factories (memory observers, cron agents) that would otherwise fill the
   * office with bots nobody is talking to.
   */
  ignore?: string[];
}

export class TranscriptWatcher {
  private watcher: FSWatcher | null = null;
  private offsets = new Map<string, number>();
  private started = new Set<string>(); // sessions we've emitted session.start for
  /** True until chokidar finishes its first pass over existing files. */
  private scanning = true;

  constructor(private options: TranscriptWatcherOptions) {}

  start(): void {
    this.watcher = chokidar.watch(this.options.rootDir, {
      ignored: (p, stats) => !!stats && stats.isFile() && !p.endsWith(".jsonl"),
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    });
    const onFile = (filePath: string) => this.consume(filePath);
    this.watcher
      .on("add", onFile)
      .on("change", onFile)
      .on("ready", () => { this.scanning = false; });
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
    this.watcher = null;
  }

  private consume(filePath: string): void {
    if (this.options.ignore?.some((needle) => filePath.includes(needle))) return;
    let fd: number;
    try {
      fd = fs.openSync(filePath, "r");
    } catch {
      return;
    }
    try {
      const size = fs.fstatSync(fd).size;
      // Files that already existed at startup are seeded to EOF instead of
      // replayed: their sessions are history, and history must not spawn bots.
      // A session still running gets a bot from its very next append; a session
      // started after boot is new, so it is read from the top.
      if (this.scanning && !this.offsets.has(filePath)) {
        this.offsets.set(filePath, size);
        return;
      }
      const from = this.offsets.get(filePath) ?? 0;
      if (size <= from) return;
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      // Only advance past the last complete line; partial tail re-read next change.
      const text = buf.toString("utf8");
      const lastNewline = text.lastIndexOf("\n");
      if (lastNewline === -1) return;
      this.offsets.set(filePath, from + Buffer.byteLength(text.slice(0, lastNewline + 1), "utf8"));
      const sessionId = path.basename(filePath, ".jsonl");
      for (const line of text.slice(0, lastNewline).split("\n")) {
        if (!line.trim()) continue;
        for (const event of parseTranscriptLine(line, sessionId, this.options.ctx)) {
          if (this.shouldEmit(event)) this.options.emit(event);
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  private shouldEmit(event: AgentEvent): boolean {
    const hookLive = this.options.isHookLive?.(event.sessionId) ?? false;
    if (event.type === "session.start") {
      if (this.started.has(event.sessionId)) return false;
      this.started.add(event.sessionId);
      return !hookLive;
    }
    // usage.tokens always flows from transcripts (hooks lack usage data);
    // everything else defers to hooks when they're live for the session.
    if (event.type === "usage.tokens") return true;
    return !hookLive;
  }
}

/** Parses one transcript JSONL line into zero or more AgentEvents. Fail-soft. */
export function parseTranscriptLine(
  line: string,
  sessionId: string,
  ctx: NormalizeContext,
): AgentEvent[] {
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  const events: AgentEvent[] = [];
  // Transcript lines carry the session's cwd, which names the bot after its
  // project on first sight.
  const cwd = typeof entry["cwd"] === "string" ? (entry["cwd"] as string) : undefined;
  const agentId = ctx.displayNameFor(sessionId, cwd);
  const ts = typeof entry["timestamp"] === "string" ? Date.parse(entry["timestamp"] as string) || Date.now() : Date.now();
  const base = { provider: PROVIDER, sessionId, agentId, ts };

  const type = entry["type"];
  if (type === "assistant") {
    const message = entry["message"] as Record<string, unknown> | undefined;
    const usage = message?.["usage"] as Record<string, unknown> | undefined;
    if (usage) {
      events.push({
        ...base,
        id: ulid(),
        type: "usage.tokens",
        summary: "usage",
        data: {
          model: String(message?.["model"] ?? "unknown"),
          inputTokens: asNum(usage["input_tokens"]),
          outputTokens: asNum(usage["output_tokens"]),
          cacheReadTokens: asNum(usage["cache_read_input_tokens"]),
        },
      });
    }
    const content = message?.["content"];
    if (Array.isArray(content)) {
      for (const block of content) {
        if (isRecord(block) && block["type"] === "tool_use") {
          events.push({
            ...base,
            id: ulid(),
            type: "tool.use",
            summary: `${String(block["name"] ?? "tool")} (transcript)`,
            data: { tool: String(block["name"] ?? ""), inputPreview: "" },
          });
        }
      }
    }
  } else if (type === "user" && !events.length && entry["cwd"] !== undefined) {
    events.push({
      ...base,
      id: ulid(),
      type: "session.start",
      summary: `session observed (transcript) ${String(entry["cwd"])}`,
      data: { cwd: String(entry["cwd"]) },
    });
  }
  return events;
}

function asNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
