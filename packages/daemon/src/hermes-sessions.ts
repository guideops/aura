import { ulid } from "ulid";
import { HermesClient, type HermesResult } from "@aura/adapter-hermes";
import type { AgentEvent } from "@aura/core";
import type { ManagedSession, OutputChunk } from "./session-manager.js";

export interface HermesSessionOptions {
  /** Same sinks the child-process SessionManager uses — one terminal pipeline. */
  onOutput?: (chunk: OutputChunk) => void;
  onStatus?: (sessionId: string, status: ManagedSession["status"]) => void;
  /** Emits normalized agent events so Hermes runs appear in the office/log. */
  emit?: (event: AgentEvent) => void;
  agentId?: string; // office identity; default "hermes-agent"
}

const MAX_OUTPUT_LINES = 1000;

/**
 * Runs Hermes chat completions as managed sessions: same list/output/terminal
 * surface as spawned Claude Code sessions, but API-backed — no child process.
 */
export class HermesSessionManager {
  private sessions = new Map<string, ManagedSession>();
  private outputs = new Map<string, string[]>();

  constructor(private client: HermesClient | null, private options: HermesSessionOptions = {}) {}

  get enabled(): boolean {
    return this.client !== null;
  }

  list(): ManagedSession[] {
    return [...this.sessions.values()];
  }

  output(id: string): string[] | null {
    return this.outputs.get(id) ?? (this.sessions.has(id) ? [] : null);
  }

  private push(id: string, lines: string[]): void {
    const buf = this.outputs.get(id) ?? [];
    buf.push(...lines);
    if (buf.length > MAX_OUTPUT_LINES) buf.splice(0, buf.length - MAX_OUTPUT_LINES);
    this.outputs.set(id, buf);
    this.options.onOutput?.({ sessionId: id, stream: "stdout", lines });
  }

  private event(sessionId: string, type: AgentEvent["type"], summary: string, data: Record<string, unknown> = {}): AgentEvent {
    return {
      id: ulid(),
      ts: Date.now(),
      provider: "hermes",
      sessionId,
      agentId: this.options.agentId ?? "hermes-agent",
      type,
      summary,
      data,
    };
  }

  spawn(input: { prompt: string; model?: string; system?: string }): ManagedSession {
    if (!this.client) throw new Error("hermes not configured");
    const id = ulid();
    const session: ManagedSession = {
      id,
      pid: null,
      cwd: "(hermes)",
      prompt: input.prompt,
      skills: [],
      status: "running",
      exitCode: null,
      startedAt: Date.now(),
    };
    this.sessions.set(id, session);
    this.outputs.set(id, []);
    this.options.emit?.(this.event(id, "session.start", `hermes run — ${input.prompt.slice(0, 60)}`, {
      status: "active", task: input.prompt.slice(0, 80),
    }));

    // Stream deltas into the buffer line-wise: flush on newline, plus a final flush.
    let partial = "";
    const runInput: { prompt: string; model?: string; system?: string } = { prompt: input.prompt };
    if (input.model) runInput.model = input.model;
    if (input.system) runInput.system = input.system;
    this.client
      .run(runInput, (delta) => {
        partial += delta;
        const lines = partial.split("\n");
        partial = lines.pop() ?? "";
        if (lines.length) this.push(id, lines.filter((l) => l.length > 0));
      })
      .then((result: HermesResult) => {
        if (partial.trim().length) this.push(id, [partial]);
        session.status = "exited";
        session.exitCode = 0;
        this.options.emit?.(this.event(id, "usage.tokens", `usage ${result.usage.inputTokens}+${result.usage.outputTokens}`, {
          model: result.model,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
        }));
        this.options.emit?.(this.event(id, "task.complete", "hermes run complete", {}));
        this.options.onStatus?.(id, "exited");
      })
      .catch((err: Error) => {
        session.status = "failed";
        session.exitCode = 1;
        this.push(id, [`[stderr] ${err.message}`]);
        this.options.emit?.(this.event(id, "agent.status", `hermes run failed — ${err.message.slice(0, 80)}`, { status: "error" }));
        this.options.onStatus?.(id, "failed");
      });
    return session;
  }
}
