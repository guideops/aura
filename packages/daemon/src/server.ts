import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { ulid } from "ulid";
import type { WebSocket } from "ws";
import { AgentEvent, type ServerMessage } from "@aura/core";
import { normalizeHookEvent } from "@aura/adapter-claude-code";
import { EventBus } from "./event-bus.js";
import { AgentStateStore } from "./state-store.js";
import { EventLog } from "./persistence.js";
import { GuardrailEngine } from "./guardrails.js";

const SERVER_VERSION = "0.1.0";

export interface DaemonOptions {
  dbPath?: string; // ":memory:" for tests
  publicDir?: string;
}

export interface Daemon {
  app: FastifyInstance;
  bus: EventBus;
  store: AgentStateStore;
  log: EventLog;
  guardrails: GuardrailEngine;
  /** Sessions currently streaming via hooks; transcript watcher defers to these. */
  hookSessions: Set<string>;
}

export function createDaemon(options: DaemonOptions = {}): Daemon {
  const app = Fastify({ logger: false });
  const bus = new EventBus();
  const store = new AgentStateStore();
  const log = new EventLog(options.dbPath ?? "aura.db");
  const guardrails = new GuardrailEngine();
  const sockets = new Set<WebSocket>();
  const hookSessions = new Set<string>();

  const broadcast = (msg: ServerMessage) => {
    const text = JSON.stringify(msg);
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) ws.send(text);
    }
  };

  bus.subscribe((event) => {
    log.append(event);
    const snapshot = store.apply(event);
    broadcast({ kind: "event", event });
    if (snapshot) broadcast({ kind: "snapshot", agent: snapshot });
  });

  void app.register(websocket);
  void app.register(async (instance) => {
    instance.get("/ws", { websocket: true }, (socket) => {
      sockets.add(socket);
      socket.send(
        JSON.stringify({
          kind: "hello",
          agents: store.list(),
          serverVersion: SERVER_VERSION,
        } satisfies ServerMessage),
      );
      socket.on("close", () => sockets.delete(socket));
    });
  });

  if (options.publicDir) {
    void app.register(fastifyStatic, { root: options.publicDir });
  }

  // Claude Code hook ingress. Always 200 fast — hooks must never slow the agent.
  app.post("/api/hooks/:provider", async (req, reply) => {
    const { provider } = req.params as { provider: string };
    if (provider === "claude-code") {
      const event = normalizeHookEvent(req.body, store);
      if (event) {
        hookSessions.add(event.sessionId);
        // Guardrail check on tool.use
        if (event.type === "tool.use") {
          const decision = guardrails.evaluate({
            agentId: event.agentId,
            sessionId: event.sessionId,
            tool: String(event.data["tool"] ?? ""),
            inputPreview: String(event.data["inputPreview"] ?? ""),
          });
          if (decision.action !== "allow") {
            const gateEvent = AgentEvent.parse({
              id: ulid(),
              ts: Date.now(),
              provider: event.provider,
              sessionId: event.sessionId,
              agentId: event.agentId,
              type: decision.action === "deny" ? "tool.deny" : "tool.ask",
              summary:
                decision.action === "deny"
                  ? `tool.deny ${event.data["tool"]} — ${decision.reason}`
                  : `tool.ask ${event.data["tool"]} — awaiting operator`,
              data: {
                tool: event.data["tool"],
                requestId: decision.request?.id ?? "",
                reason: decision.reason,
              },
            });
            bus.emit(event);
            bus.emit(gateEvent);
            // Claude Code PreToolUse hook contract: non-empty JSON decision
            return reply.send({
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: decision.action === "deny" ? "deny" : "ask",
                permissionDecisionReason: decision.reason,
              },
            });
          }
        }
        bus.emit(event);
      }
      return reply.send({});
    }
    return reply.code(404).send({ error: `unknown provider ${provider}` });
  });

  // Simulated/generic event ingress (testing, future adapters).
  app.post("/api/events", async (req, reply) => {
    const parsed = AgentEvent.omit({ id: true, ts: true })
      .extend({ id: AgentEvent.shape.id.optional(), ts: AgentEvent.shape.ts.optional() })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { id, ts, ...rest } = parsed.data;
    bus.emit({ ...rest, id: id ?? ulid(), ts: ts ?? Date.now() });
    return reply.send({ ok: true });
  });

  app.get("/api/agents", async () => ({ agents: store.list() }));
  app.get("/api/events/recent", async () => ({ events: log.recent() }));
  app.get("/api/approvals", async () => ({ pending: guardrails.pendingRequests }));
  app.post("/api/approvals/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { approved } = (req.body ?? {}) as { approved?: boolean };
    const resolved = guardrails.resolve(id, approved === true);
    if (!resolved) return reply.code(404).send({ error: "not pending" });
    return reply.send({ request: resolved });
  });
  app.get("/api/health", async () => ({ ok: true, version: SERVER_VERSION }));

  return { app, bus, store, log, guardrails, hookSessions };
}

export function defaultPublicDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
}
