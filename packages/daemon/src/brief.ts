import type { AgentEvent } from "@aura/core";
import type { EventLog } from "./persistence.js";
import type { Vault } from "./vault.js";

/**
 * Composes a daily brief from recent event history and writes it to the vault
 * as a plain markdown note. This is the "memory compounds" loop made real:
 * every run leaves residue in the vault, and the brief surfaces it. Content is
 * derived from observed facts only — no model call, no invented numbers.
 */
export function generateBrief(log: EventLog, sinceMs: number): string {
  const cutoff = Date.now() - sinceMs;
  const events = log.recent(5000).filter((e) => e.ts >= cutoff);
  const date = new Date().toISOString().slice(0, 10);

  const perAgent = new Map<string, { tools: number; tokens: number; denies: number; tasks: Set<string>; models: Set<string> }>();
  for (const e of events) {
    const a = perAgent.get(e.agentId) ?? { tools: 0, tokens: 0, denies: 0, tasks: new Set(), models: new Set() };
    if (e.type === "tool.use") a.tools += 1;
    if (e.type === "tool.deny") a.denies += 1;
    if (e.type === "usage.tokens") {
      a.tokens += num(e.data["inputTokens"]) + num(e.data["outputTokens"]);
      // Skip synthetic markers (e.g. "<synthetic>") from transcript summary rows.
      if (typeof e.data["model"] === "string" && !e.data["model"].startsWith("<")) {
        a.models.add(e.data["model"]);
      }
    }
    if (e.type === "task.claim" && e.summary) a.tasks.add(String(e.data["title"] ?? e.summary));
    perAgent.set(e.agentId, a);
  }

  const totalTokens = [...perAgent.values()].reduce((s, a) => s + a.tokens, 0);
  const totalTools = [...perAgent.values()].reduce((s, a) => s + a.tools, 0);
  const totalDenies = [...perAgent.values()].reduce((s, a) => s + a.denies, 0);

  const lines: string[] = [];
  lines.push("---");
  lines.push(`title: Brief ${date}`);
  lines.push(`generated: ${new Date().toISOString()}`);
  lines.push("---");
  lines.push("");
  lines.push(`# Brief — ${date}`);
  lines.push("");
  lines.push(`Window: last ${Math.round(sinceMs / 3_600_000)}h · ${events.length} events · ${perAgent.size} agents active.`);
  lines.push("");
  lines.push("## Totals");
  lines.push(`- Tokens: ${totalTokens.toLocaleString()}`);
  lines.push(`- Tool calls: ${totalTools.toLocaleString()}`);
  lines.push(`- Guardrail denials: ${totalDenies}`);
  lines.push("");
  lines.push("## By agent");
  for (const [agentId, a] of [...perAgent.entries()].sort((x, y) => y[1].tokens - x[1].tokens)) {
    lines.push(`### [[${agentId}]]`);
    lines.push(`- Tokens: ${a.tokens.toLocaleString()}${a.models.size ? ` (${[...a.models].join(", ")})` : ""}`);
    lines.push(`- Tool calls: ${a.tools}${a.denies ? ` · ${a.denies} denied` : ""}`);
    if (a.tasks.size) lines.push(`- Tasks: ${[...a.tasks].map((t) => `"${t}"`).join(", ")}`);
    lines.push("");
  }
  lines.push("## Notes");
  lines.push("_This brief is generated from observed events. Add your own notes below; they persist across runs._");
  lines.push("");
  return lines.join("\n");
}

export function writeBrief(vault: Vault, log: EventLog, sinceMs = 24 * 3_600_000): string {
  const slug = `briefs/${new Date().toISOString().slice(0, 10)}`;
  vault.write(slug, generateBrief(log, sinceMs));
  return slug;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

export type { AgentEvent };
