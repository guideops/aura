import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { ulid } from "ulid";
import type { WebSocket } from "ws";
import { AgentEvent, type ServerMessage, type Card, type CardStatus } from "@aura/core";
import { normalizeHookEvent } from "@aura/adapter-claude-code";
import { EventBus } from "./event-bus.js";
import { AgentStateStore } from "./state-store.js";
import { EventLog } from "./persistence.js";
import { GuardrailEngine } from "./guardrails.js";
import { SessionManager, type EquippedSkill } from "./session-manager.js";
import { Vault } from "./vault.js";
import { writeBrief } from "./brief.js";
import { Board } from "./board.js";
import { SkillRegistry, SkillValidationError } from "./skills.js";
import { BoardProgress } from "./board-progress.js";
import { SyncEngine, type ConflictReport, type GitHubProjectClient } from "./github-sync.js";
import { OctokitProjectClient } from "./github-client.js";
import type { BoardMessage } from "@aura/core";

const SERVER_VERSION = "0.1.0";

export interface DaemonOptions {
  dbPath?: string; // ":memory:" for tests
  publicDir?: string;
  daemonUrl?: string; // self URL injected into spawned sessions' hooks
  vaultDir?: string; // markdown vault root; defaults under cwd
  skillsDir?: string; // skills root (<dir>/<name>/SKILL.md); defaults under cwd
  /** Test seam: provides the GitHub client for /api/github/link. Defaults to Octokit. */
  githubClientFactory?: (cfg: { token: string; projectId: string }) => GitHubProjectClient;
}

export interface Daemon {
  app: FastifyInstance;
  bus: EventBus;
  store: AgentStateStore;
  log: EventLog;
  guardrails: GuardrailEngine;
  vault: Vault;
  board: Board;
  skills: SkillRegistry;
  /** Sessions currently streaming via hooks; transcript watcher defers to these. */
  hookSessions: Set<string>;
}

export function createDaemon(options: DaemonOptions = {}): Daemon {
  const app = Fastify({ logger: false });
  const bus = new EventBus();
  const store = new AgentStateStore();
  const log = new EventLog(options.dbPath ?? "aura.db");
  const guardrails = new GuardrailEngine();
  const vaultDbPath = options.dbPath && options.dbPath !== ":memory:"
    ? options.dbPath.replace(/\.db$/, "") + ".vault.db"
    : ":memory:";
  const vault = new Vault(
    options.vaultDir ?? path.join(process.cwd(), "vault"),
    vaultDbPath,
  );
  vault.reindex();
  const boardDbPath = options.dbPath && options.dbPath !== ":memory:"
    ? options.dbPath.replace(/\.db$/, "") + ".board.db"
    : ":memory:";
  const board = new Board(boardDbPath);
  const skills = new SkillRegistry(options.skillsDir ?? path.join(process.cwd(), "skills"));
  const sockets = new Set<WebSocket>();
  const hookSessions = new Set<string>();

  const broadcast = (msg: ServerMessage | BoardMessage) => {
    const text = JSON.stringify(msg);
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) ws.send(text);
    }
  };

  // External vault edits (Obsidian, editors) → reindex → live UI refresh.
  vault.watch((noteCount) => broadcast({ kind: "vault.updated", noteCount }));

  // Agent activity animates assigned cards (progress bar, session.end → review).
  const boardProgress = new BoardProgress(board, (card) =>
    broadcast({ kind: "card.upsert", card }),
  );

  bus.subscribe((event) => {
    log.append(event);
    const snapshot = store.apply(event);
    boardProgress.apply(event);
    broadcast({ kind: "event", event });
    if (snapshot) broadcast({ kind: "snapshot", agent: snapshot });
  });

  // Staleness sweep: transcripts replay history, so old sessions arrive
  // "active". Demote quiet agents: idle after 5 min, offline after 30.
  const IDLE_MS = 5 * 60_000;
  const OFFLINE_MS = 30 * 60_000;
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const agent of store.list()) {
      if (agent.lastEventAt === null || agent.status === "offline") continue;
      const quiet = now - agent.lastEventAt;
      const next = quiet > OFFLINE_MS ? "offline" : quiet > IDLE_MS ? "idle" : null;
      if (next && agent.status !== next && agent.status !== "blocked") {
        bus.emit({
          id: ulid(),
          ts: now,
          provider: agent.provider,
          sessionId: agent.sessionId,
          agentId: agent.agentId,
          type: "agent.status",
          summary: `agent.${next} — no activity ${Math.round(quiet / 60_000)}m`,
          data: { status: next, synthetic: true },
        });
      }
    }
  }, 30_000);
  sweep.unref?.();
  app.addHook("onClose", async () => clearInterval(sweep));

  void app.register(websocket);
  void app.register(async (instance) => {
    instance.get("/ws", { websocket: true }, (socket) => {
      sockets.add(socket);
      socket.send(
        JSON.stringify({
          kind: "hello",
          agents: store.list(),
          approvals: guardrails.pendingRequests,
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
            if (decision.action === "ask" && decision.request) {
              broadcast({ kind: "approval.pending", request: decision.request });
            }
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
    broadcast({ kind: "approval.resolved", id, status: resolved.status });
    // Unblock the agent in the visual layer (real retry happens agent-side).
    bus.emit({
      id: ulid(),
      ts: Date.now(),
      provider: "claude-code",
      sessionId: resolved.sessionId,
      agentId: resolved.agentId,
      type: "agent.status",
      summary: `gate ${resolved.status} — ${resolved.tool}`,
      data: { status: approved === true ? "active" : "idle" },
    });
    return reply.send({ request: resolved });
  });
  app.get("/api/health", async () => ({ ok: true, version: SERVER_VERSION }));

  // Vault (Obsidian-compatible markdown memory).
  app.get("/api/vault/notes", async () => ({ notes: vault.list() }));
  app.get("/api/vault/search", async (req) => {
    const { q } = req.query as { q?: string };
    return { hits: vault.search(q ?? "") };
  });
  app.get("/api/vault/graph", async () => vault.graph());
  app.get("/api/vault/note", async (req, reply) => {
    const { slug } = req.query as { slug?: string };
    if (!slug) return reply.code(400).send({ error: "slug required" });
    const body = vault.read(slug);
    if (body === null) return reply.code(404).send({ error: "not found" });
    return { slug, body };
  });
  app.post("/api/vault/note", async (req, reply) => {
    const { slug, body } = (req.body ?? {}) as { slug?: string; body?: string };
    if (!slug || typeof body !== "string") return reply.code(400).send({ error: "slug and body required" });
    vault.write(slug, body);
    return reply.send({ ok: true, slug });
  });
  app.post("/api/vault/brief", async (req) => {
    const { sinceHours } = (req.body ?? {}) as { sinceHours?: number };
    const slug = writeBrief(vault, log, (sinceHours ?? 24) * 3_600_000);
    return { ok: true, slug, body: vault.read(slug) };
  });

  // Skills registry (agentskills.io-compatible SKILL.md files are the truth).
  app.get("/api/skills", async () => ({ skills: skills.list() }));
  app.post("/api/skills/reindex", async () => ({ ok: true, count: skills.reindex() }));
  app.get("/api/skills/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    const entry = skills.get(name);
    if (!entry) return reply.code(404).send({ error: "not found" });
    return { skill: entry, body: skills.read(name) };
  });
  app.put("/api/skills/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    const { body } = (req.body ?? {}) as { body?: string };
    if (typeof body !== "string") return reply.code(400).send({ error: "body required" });
    try {
      return reply.send({ skill: skills.write(name, body) });
    } catch (err) {
      if (err instanceof SkillValidationError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });
  app.delete("/api/skills/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!skills.remove(name)) return reply.code(404).send({ error: "not found" });
    return reply.send({ ok: true });
  });

  // Managed sessions (assign-card → spawn flow lands on this).
  const sessions = new SessionManager(
    options.daemonUrl ?? `http://127.0.0.1:${process.env["AURA_PORT"] ?? 8311}`,
  );
  app.get("/api/sessions", async () => ({ sessions: sessions.list() }));
  // Resolves skill names → {name, body} for equipping; throws on unknown names.
  const resolveSkills = (names: string[]) =>
    names.map((name) => {
      const body = skills.read(name);
      if (body === null) throw new SkillValidationError(`unknown skill "${name}"`);
      return { name, body };
    });

  app.post("/api/sessions", async (req, reply) => {
    const body = (req.body ?? {}) as { cwd?: string; prompt?: string; model?: string; skills?: string[] };
    if (!body.cwd || !body.prompt) {
      return reply.code(400).send({ error: "cwd and prompt required" });
    }
    const spawnInput: { cwd: string; prompt: string; model?: string; skills?: EquippedSkill[] } = {
      cwd: body.cwd,
      prompt: body.prompt,
    };
    if (body.model) spawnInput.model = body.model;
    try {
      if (body.skills?.length) spawnInput.skills = resolveSkills(body.skills);
    } catch (err) {
      if (err instanceof SkillValidationError) return reply.code(400).send({ error: err.message });
      throw err;
    }
    return reply.send({ session: sessions.spawn(spawnInput) });
  });
  app.delete("/api/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!sessions.stop(id)) return reply.code(404).send({ error: "not running" });
    return reply.send({ ok: true });
  });

  // Kanban board.
  const emitCard = (card: Card) => broadcast({ kind: "card.upsert", card });
  app.get("/api/board/cards", async () => ({ cards: board.list() }));
  app.post("/api/board/cards", async (req, reply) => {
    const b = (req.body ?? {}) as { title?: string; body?: string; status?: CardStatus; tags?: string[] };
    if (!b.title) return reply.code(400).send({ error: "title required" });
    const created: { title: string; body?: string; status?: CardStatus; tags?: string[] } = { title: b.title };
    if (b.body !== undefined) created.body = b.body;
    if (b.status !== undefined) created.status = b.status;
    if (b.tags !== undefined) created.tags = b.tags;
    const card = board.create(created);
    emitCard(card);
    return reply.send({ card });
  });
  app.patch("/api/board/cards/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const patch = (req.body ?? {}) as Record<string, unknown>;
    const card = board.update(id, patch);
    if (!card) return reply.code(404).send({ error: "not found" });
    emitCard(card);
    return reply.send({ card });
  });
  app.delete("/api/board/cards/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!board.remove(id)) return reply.code(404).send({ error: "not found" });
    broadcast({ kind: "card.removed", id });
    return reply.send({ ok: true });
  });
  // Assign a card to an agent and spawn a session bound to it.
  app.post("/api/board/cards/:id/assign", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { agentId?: string; cwd?: string; model?: string; skills?: string[] };
    const card = board.get(id);
    if (!card) return reply.code(404).send({ error: "not found" });
    const updated = board.update(id, {
      assignee: b.agentId ?? card.assignee,
      status: card.status === "backlog" ? "in_progress" : card.status,
    });
    if (updated) emitCard(updated);
    let session = null;
    if (b.cwd) {
      const prompt = `Work on ${card.key}: ${card.title}\n\n${card.body}`.trim();
      const spawnInput: { cwd: string; prompt: string; model?: string; skills?: EquippedSkill[] } = { cwd: b.cwd, prompt };
      if (b.model) spawnInput.model = b.model;
      // Explicit skills win; otherwise card tags naming a registered skill auto-equip.
      const names = b.skills ?? card.tags.filter((t) => skills.get(t));
      try {
        if (names.length) spawnInput.skills = resolveSkills(names);
      } catch (err) {
        if (err instanceof SkillValidationError) return reply.code(400).send({ error: err.message });
        throw err;
      }
      session = sessions.spawn(spawnInput);
    }
    return reply.send({ card: updated, session });
  });

  // GitHub Projects v2 sync. Token held in memory only — NEVER persisted here;
  // Electron builds inject it via OS keychain (safeStorage) at Phase 6.
  let syncEngine: SyncEngine | null = null;
  let lastSync: { at: number; conflicts: number; applied: number } | null = null;
  let syncTimer: NodeJS.Timeout | null = null;
  let syncIntervalMs = 0; // 0 = manual only
  const reviewQueue: ConflictReport[] = [];

  const runSync = async () => {
    if (!syncEngine) throw new Error("not linked");
    const r = await syncEngine.syncOnce();
    lastSync = { at: Date.now(), conflicts: r.conflicts.length, applied: r.applied };
    for (const c of r.conflicts) reviewQueue.push(c);
    // Refresh board views for anything the sync changed.
    for (const card of board.list()) broadcast({ kind: "card.upsert", card });
    if (reviewQueue.length) broadcast({ kind: "sync.conflicts", count: reviewQueue.length });
    return r;
  };
  const stopSyncTimer = () => {
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = null;
    syncIntervalMs = 0;
  };

  app.get("/api/github/status", async () => ({
    linked: syncEngine !== null,
    lastSync,
    intervalMs: syncIntervalMs,
    reviewQueue,
  }));
  app.post("/api/github/link", async (req, reply) => {
    const { token, projectId, intervalMs } = (req.body ?? {}) as {
      token?: string; projectId?: string; intervalMs?: number;
    };
    if (!token || !projectId) return reply.code(400).send({ error: "token and projectId required" });
    syncEngine?.close();
    const makeClient = options.githubClientFactory
      ?? ((cfg: { token: string; projectId: string }) => new OctokitProjectClient(cfg));
    syncEngine = new SyncEngine(
      board,
      makeClient({ token, projectId }),
      boardDbPath === ":memory:" ? ":memory:" : boardDbPath.replace(/\.board\.db$/, ".sync.db"),
    );
    stopSyncTimer();
    // Auto-sync: floor 15s to stay far from GitHub secondary rate limits.
    if (typeof intervalMs === "number" && intervalMs > 0) {
      syncIntervalMs = Math.max(15_000, Math.round(intervalMs));
      syncTimer = setInterval(() => { runSync().catch(() => { /* surfaces via status */ }); }, syncIntervalMs);
      syncTimer.unref?.();
    }
    return reply.send({ ok: true, intervalMs: syncIntervalMs });
  });
  app.post("/api/github/unlink", async () => {
    stopSyncTimer();
    syncEngine?.close();
    syncEngine = null;
    return { ok: true };
  });
  app.post("/api/github/sync", async (_req, reply) => {
    if (!syncEngine) return reply.code(409).send({ error: "not linked" });
    try {
      return reply.send({ ...(await runSync()) });
    } catch (err) {
      return reply.code(502).send({ error: String((err as Error).message) });
    }
  });
  app.post("/api/github/review/clear", async () => {
    reviewQueue.length = 0;
    return { ok: true };
  });
  // Resolve one conflict: "remote" just acknowledges (remote already applied);
  // "local" re-asserts the local status — rev bump makes the next sync push it.
  app.post("/api/github/review/resolve", async (req, reply) => {
    const { cardId, choice } = (req.body ?? {}) as { cardId?: string; choice?: string };
    const idx = reviewQueue.findIndex((c) => c.cardId === cardId);
    if (idx === -1) return reply.code(404).send({ error: "no such conflict" });
    if (choice !== "local" && choice !== "remote") {
      return reply.code(400).send({ error: 'choice must be "local" or "remote"' });
    }
    const [conflict] = reviewQueue.splice(idx, 1);
    if (choice === "local") {
      const restored = board.update(conflict!.cardId, { status: conflict!.localStatus });
      if (restored) broadcast({ kind: "card.upsert", card: restored });
    }
    broadcast({ kind: "sync.conflicts", count: reviewQueue.length });
    return reply.send({ ok: true, remaining: reviewQueue.length });
  });

  app.addHook("onClose", async () => { stopSyncTimer(); vault.close(); board.close(); syncEngine?.close(); });

  return { app, bus, store, log, guardrails, vault, board, skills, hookSessions };
}

export function defaultPublicDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
}
