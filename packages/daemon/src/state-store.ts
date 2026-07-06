import type { AgentEvent, AgentSnapshot, AgentStatus } from "@bullpen/core";

const AGENT_COLORS = ["blue", "green", "orange", "purple", "red", "yellow"] as const;

/**
 * In-memory source of truth for live agent state, mutated by AgentEvents.
 * Persistence of the raw event log is handled separately (SQLite); this
 * store is rebuildable by replaying events.
 */
export class AgentStateStore {
  private agents = new Map<string, AgentSnapshot>();
  private colorCursor = 0;

  /** Stable display name per session: blue-agent, green-agent, ... */
  private displayNames = new Map<string, string>();

  list(): AgentSnapshot[] {
    return [...this.agents.values()];
  }

  get(agentId: string): AgentSnapshot | undefined {
    return this.agents.get(agentId);
  }

  displayNameFor(sessionId: string): string {
    let name = this.displayNames.get(sessionId);
    if (!name) {
      const color = AGENT_COLORS[this.colorCursor % AGENT_COLORS.length];
      this.colorCursor += 1;
      name = `${color}-agent`;
      this.displayNames.set(sessionId, name);
    }
    return name;
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
      } satisfies AgentSnapshot);

    agent.lastEventAt = event.ts;

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
        if (typeof status === "string") agent.status = status as AgentStatus;
        break;
      }
      default:
        break;
    }

    this.agents.set(event.agentId, agent);
    return agent;
  }
}

function toolToStatus(tool: string): AgentStatus {
  if (/^(Grep|Glob|Read|WebSearch|WebFetch)/.test(tool)) return "researching";
  return "active";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}
