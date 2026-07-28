import type { AgentEvent, AgentSnapshot, AgentStatus } from "@aura/core";

/**
 * In-memory source of truth for live agent state, mutated by AgentEvents.
 * Persistence of the raw event log is handled separately (SQLite); this
 * store is rebuildable by replaying events.
 *
 * One agent == one session. A session starting spawns a bot, the session
 * ending despawns it, so the office only ever shows work that is happening.
 * Identity is per session rather than per project because two sessions in the
 * same repo are two colleagues, not one.
 */
export class AgentStateStore {
  private agents = new Map<string, AgentSnapshot>();

  /** Display name per session: aura-1, aura-2, workspace-1, ... */
  private displayNames = new Map<string, string>();
  /** Highest suffix handed out per project, so names never collide. */
  private projectCursor = new Map<string, number>();

  list(): AgentSnapshot[] {
    return [...this.agents.values()];
  }

  get(agentId: string): AgentSnapshot | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Names a session after the project it runs in: aura-1, aura-2, …
   *
   * The suffix counts sessions per project and never rewinds — reusing a freed
   * number would let a new bot inherit a dead one's identity in the event log.
   * Memoised on first sight, so a session keeps its name even though later
   * events (PreToolUse and friends) may arrive without a cwd.
   */
  displayNameFor(sessionId: string, cwd?: string): string {
    const existing = this.displayNames.get(sessionId);
    if (existing) return existing;
    const project = projectSlug(cwd);
    const next = (this.projectCursor.get(project) ?? 0) + 1;
    this.projectCursor.set(project, next);
    const name = `${project}-${next}`;
    this.displayNames.set(sessionId, name);
    return name;
  }

  /** Despawns a bot. The session is over; its desk goes back in the pool. */
  remove(agentId: string): AgentSnapshot | undefined {
    const agent = this.agents.get(agentId);
    if (agent) this.agents.delete(agentId);
    return agent;
  }

  /** Applies an event; returns the updated snapshot when agent state changed. */
  apply(event: AgentEvent): AgentSnapshot | null {
    const existing = this.agents.get(event.agentId);
    const agent: AgentSnapshot =
      existing ??
      ({
        agentId: event.agentId,
        provider: event.provider,
        sessionId: event.sessionId,
        status: "idle",
        task: "",
        cwd: "",
        startedAt: null,
        lastEventAt: null,
        tokens: { input: 0, output: 0, cacheRead: 0, byModel: {} },
        pendingApprovalId: null,
        desk: null,
      } satisfies AgentSnapshot);

    // Synthetic events (staleness sweep) must not reset the quiet timer.
    if (event.data["synthetic"] !== true) agent.lastEventAt = event.ts;

    switch (event.type) {
      case "session.start": {
        agent.startedAt = event.ts;
        agent.status = "active";
        agent.cwd = typeof event.data["cwd"] === "string" ? (event.data["cwd"] as string) : agent.cwd;
        break;
      }
      case "session.end": {
        agent.status = "offline";
        break;
      }
      case "tool.use": {
        const tool = String(event.data["tool"] ?? "");
        agent.status = toolToStatus(tool);
        break;
      }
      case "tool.result": {
        if (agent.status !== "blocked") agent.status = "active";
        break;
      }
      case "tool.ask": {
        agent.status = "blocked";
        agent.pendingApprovalId = String(event.data["requestId"] ?? "");
        break;
      }
      case "tool.deny": {
        if (agent.status === "blocked") agent.status = "active";
        agent.pendingApprovalId = null;
        break;
      }
      case "task.claim": {
        agent.task = String(event.data["title"] ?? event.summary);
        agent.status = "active";
        break;
      }
      case "task.complete": {
        agent.status = "success";
        break;
      }
      case "usage.tokens": {
        const input = num(event.data["inputTokens"]);
        const output = num(event.data["outputTokens"]);
        const cacheRead = num(event.data["cacheReadTokens"]);
        const model = String(event.data["model"] ?? "unknown");
        agent.tokens.input += input;
        agent.tokens.output += output;
        agent.tokens.cacheRead += cacheRead;
        agent.tokens.byModel[model] = (agent.tokens.byModel[model] ?? 0) + input + output;
        break;
      }
      case "agent.status": {
        const status = event.data["status"];
        if (typeof status === "string") {
          agent.status = status as AgentStatus;
          // The gate id is only meaningful while blocked; leaving it set after
          // a resolution (operator click or mirrored outcome) points the UI at
          // a request that no longer exists.
          if (status !== "blocked") agent.pendingApprovalId = null;
        }
        break;
      }
      default:
        break;
    }

    this.agents.set(event.agentId, agent);
    return agent;
  }
}

/**
 * Last path segment of the session's cwd, as a name-safe slug: /root/aura →
 * "aura". Sessions whose first event carries no cwd fall back to "agent", so
 * they still get a usable name rather than an empty prefix.
 */
function projectSlug(cwd: string | undefined): string {
  const leaf = (cwd ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";
  const slug = leaf.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug || "agent";
}

function toolToStatus(tool: string): AgentStatus {
  if (/^(Grep|Glob|Read|WebSearch|WebFetch)/.test(tool)) return "researching";
  return "active";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}
