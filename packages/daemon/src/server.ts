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
import { SessionManager, type EquippedSkill, type SessionManagerOptions } from "./session-manager.js";
import { SpaceStore } from "./space-store.js";
import { SpaceFile } from "@aura/core";
import { HermesSessionManager } from "./hermes-sessions.js";
import { HermesClient } from "@aura/adapter-hermes";
import { PairingManager } from "./pairing.js";
import fs from "node:fs";
import { Vault } from "./vault.js";
import { writeBrief } from "./brief.js";
import { Board } from "./board.js";
import { SkillRegistry, SkillValidationError } from "./skills.js";
import { gitBranch as workspaceGitBranch, workspaceTree } from "./workspace.js";
import { BoardProgress } from "./board-progress.js";
import { SyncEngine, type ConflictReport, type GitHubProjectClient } from "./github-sync.js";
import { OctokitProjectClient } from "./github-client.js";
import type { BoardMessage, CanvasMessage } from "@aura/core";
import { CanvasStore, type CreateNodeInput } from "./canvas-store.js";
import { CanvasSync } from "./canvas-sync.js";

const SERVER_VERSION = "0.1.0";

export interface DaemonOptions {
  dbPath?: string; // ":memory:" for tests
  publicDir?: string;
  daemonUrl?: string; // self URL injected into spawned sessions' hooks
  vaultDir?: string; // markdown vault root; defaults under cwd
  skillsDir?: string; // skills root (<dir>/<name>/SKILL.md); defaults under cwd
  /** Test seam: provides the GitHub client for /api/github/link. Defaults to Octokit. */
  githubClientFactory?: (cfg: { token: string; projectId: string }) => GitHubProjectClient;
  /** Space CAD layout file; defaults to <cwd>/office.space.json. */
  spaceFile?: string;
  /** Test seam: spawn command/args overrides for SessionManager. */
  sessionManagerOptions?: Pick<SessionManagerOptions, "command" | "rawArgs">;
  /** Test seam: injected Hermes client; defaults from AURA_HERMES_URL/KEY env. */
  hermesClient?: HermesClient | null;
  /** Paired-peer credential store; defaults to <cwd>/aura.peers.json. */
  peersFile?: string;
  /** Operator config (chosen vault dir, ...); defaults to <cwd>/aura.config.json. */
  configFile?: string;
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
  // Vault dir: explicit option (tests/env) > operator config file > default.
  const configFile = options.configFile ?? path.join(process.cwd(), "aura.config.json");
  const readConfig = (): { vaultDir?: string } => {
    try { return JSON.parse(fs.readFileSync(configFile, "utf8")); } catch { return {}; }
  };
  const writeConfig = (patch: Record<string, unknown>) => {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ ...readConfig(), ...patch }, null, 2));
  };
  let vault = new Vault(
    options.vaultDir ?? readConfig().vaultDir ?? path.join(process.cwd(), "vault"),
    vaultDbPath,
  );
  vault.reindex();
  const boardDbPath = options.dbPath && options.dbPath !== ":memory:"
    ? options.dbPath.replace(/\.db$/, "") + ".board.db"
    : ":memory:";
  const board = new Board(boardDbPath);
  const canvasDbPath = options.dbPath && options.dbPath !== ":memory:"
    ? options.dbPath.replace(/\.db$/, "") + ".canvas.db"
    : ":memory:";
  const canvases = new CanvasStore(canvasDbPath);
  const skills = new SkillRegistry(options.skillsDir ?? path.join(process.cwd(), "skills"));
  const sockets = new Set<WebSocket>();
  const hookSessions = new Set<string>();

  const broadcast = (msg: ServerMessage | BoardMessage | CanvasMessage) => {
    const text = JSON.stringify(msg);
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) ws.send(text);
    }
  };

  // External vault edits (Obsidian, editors) → reindex → live UI refresh.
  const wireVault = (v: Vault) => v.watch((noteCount) => broadcast({ kind: "vault.updated", noteCount }));
  wireVault(vault);

  // Whiteboards: SQLite truth, spec-pure .canvas files materialized into the
  // vault for Obsidian viewing/editing; external edits import back live.
  const canvasSync = new CanvasSync(
    canvases,
    () => vault.rootDir,
    (canvasId, rev) => broadcast({ kind: "canvas.updated", canvasId, rev, origin: "external" }),
  );
  canvasSync.exportAll();
  canvasSync.adoptExisting();
  canvasSync.watch();
  /** Hot-swap the vault folder (Connections panel / adopt-from-peer). */
  const swapVault = (dir: string): number => {
    vault.close();
    vault = new Vault(dir, vaultDbPath);
    const count = vault.reindex();
    wireVault(vault);
    canvasSync.rewire();
    writeConfig({ vaultDir: dir });
    broadcast({ kind: "vault.updated", noteCount: count });
    return count;
  };

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
    void app.register(fastifyStatic, { root: options.publicDir, index: false });
    // The React shell (/shell) is the one canonical UI. Root and the retired
    // static prototype route both redirect to it, so an old bookmark can't
    // land anyone on a dead page. Explicit routes win over the static wildcard.
    app.get("/", async (_req, reply) => reply.redirect("/shell/"));
    app.get("/app", async (_req, reply) => reply.redirect("/shell/"));
    app.get("/app/*", async (_req, reply) => reply.redirect("/shell/"));
    // fastify-static needs an explicit handler for the shell index since
    // index serving is disabled above.
    app.get("/shell", async (_req, reply) => reply.redirect("/shell/"));
    app.get("/shell/", async (_req, reply) => reply.sendFile("shell/index.html"));
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

  // ---- Workspace explorer (shell UI): file tree + git badges ----
  // Optional ?root= lets the operator browse outside the daemon cwd
  // (localhost trust model, same as vault dir selection).
  const resolveRoot = (raw: unknown): string | null => {
    if (typeof raw !== "string" || !raw.trim()) return process.cwd();
    const p = path.resolve(raw.trim());
    try {
      return fs.statSync(p).isDirectory() ? p : null;
    } catch {
      return null;
    }
  };
  app.get("/api/workspace/tree", async (req, reply) => {
    const root = resolveRoot((req.query as { root?: string }).root);
    if (!root) return reply.code(400).send({ error: "not a directory" });
    return { root, tree: await workspaceTree(root) };
  });
  app.get("/api/workspace/git", async (req, reply) => {
    const root = resolveRoot((req.query as { root?: string }).root);
    if (!root) return reply.code(400).send({ error: "not a directory" });
    return (await workspaceGitBranch(root)) ?? { branch: null, dirty: false, changes: [] };
  });

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
    {
      ...options.sessionManagerOptions,
      onOutput: (chunk) => broadcast({ kind: "session.output", ...chunk }),
      onStatus: (sessionId, status) => broadcast({ kind: "session.status", sessionId, status }),
    },
  );
  // Hermes provider: API-backed sessions sharing the terminal pipeline.
  const hermesClient = options.hermesClient !== undefined
    ? options.hermesClient
    : (process.env["AURA_HERMES_KEY"]
        ? new HermesClient({
            baseUrl: process.env["AURA_HERMES_URL"] ?? "https://inference-api.nousresearch.com/v1",
            apiKey: process.env["AURA_HERMES_KEY"],
            ...(process.env["AURA_HERMES_MODEL"] ? { model: process.env["AURA_HERMES_MODEL"] } : {}),
          })
        : null);
  const hermes = new HermesSessionManager(hermesClient, {
    onOutput: (chunk) => broadcast({ kind: "session.output", ...chunk }),
    onStatus: (sessionId, status) => broadcast({ kind: "session.status", sessionId, status }),
    emit: (event) => bus.emit(event),
  });
  app.get("/api/hermes/status", async () => ({ enabled: hermes.enabled }));

  app.get("/api/sessions", async () => ({
    sessions: [
      ...sessions.list().map((s) => ({ ...s, provider: "claude-code" })),
      ...hermes.list().map((s) => ({ ...s, provider: "hermes" })),
    ],
  }));
  app.get("/api/sessions/:id/output", async (req, reply) => {
    const { id } = req.params as { id: string };
    const lines = sessions.output(id) ?? hermes.output(id);
    if (lines === null) return reply.code(404).send({ error: "unknown session" });
    return { lines };
  });
  // Resolves skill names → {name, body} for equipping; throws on unknown names.
  const resolveSkills = (names: string[]) =>
    names.map((name) => {
      const body = skills.read(name);
      if (body === null) throw new SkillValidationError(`unknown skill "${name}"`);
      return { name, body };
    });

  app.post("/api/sessions", async (req, reply) => {
    const body = (req.body ?? {}) as {
      cwd?: string; prompt?: string; model?: string; skills?: string[]; provider?: string; system?: string;
    };
    if (body.provider === "hermes") {
      if (!body.prompt) return reply.code(400).send({ error: "prompt required" });
      if (!hermes.enabled) {
        return reply.code(409).send({ error: "hermes not configured — set AURA_HERMES_KEY" });
      }
      const input: { prompt: string; model?: string; system?: string } = { prompt: body.prompt };
      if (body.model) input.model = body.model;
      if (body.system) input.system = body.system;
      return reply.send({ session: { ...hermes.spawn(input), provider: "hermes" } });
    }
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
    const b = (req.body ?? {}) as {
      title?: string; body?: string; status?: CardStatus; tags?: string[];
      externalRef?: string; priority?: "low" | "medium" | "high" | "urgent"; milestone?: string; project?: string | null;
      comments?: Card["comments"]; links?: Card["links"]; timeline?: Card["timeline"]; pendingComment?: string | null; blockKind?: Card["blockKind"];
    };
    if (!b.title) return reply.code(400).send({ error: "title required" });
    // Idempotent peer ingestion: same externalRef updates rather than duplicates.
    if (b.externalRef) {
      const existing = board.getByRef(b.externalRef);
      if (existing) {
        const patch: Record<string, unknown> = { title: b.title };
        if (b.body !== undefined) patch.body = b.body;
        if (b.status !== undefined) patch.status = b.status;
        if (b.tags !== undefined) patch.tags = b.tags;
        if (b.project !== undefined) patch.project = b.project;
        if (b.comments !== undefined) patch.comments = b.comments;
        if (b.links !== undefined) patch.links = b.links;
        if (b.timeline !== undefined) patch.timeline = b.timeline;
        if (b.pendingComment !== undefined) patch.pendingComment = b.pendingComment;
        if (b.blockKind !== undefined) patch.blockKind = b.blockKind;
        const updated = board.update(existing.id, patch);
        if (updated) emitCard(updated);
        return reply.send({ card: updated });
      }
    }
    const created: {
      title: string; body?: string; status?: CardStatus; tags?: string[];
      externalRef?: string; priority?: "low" | "medium" | "high" | "urgent"; milestone?: string; project?: string | null;
      comments?: Card["comments"]; links?: Card["links"]; timeline?: Card["timeline"]; pendingComment?: string | null; blockKind?: Card["blockKind"];
    } = { title: b.title };
    if (b.body !== undefined) created.body = b.body;
    if (b.status !== undefined) created.status = b.status;
    if (b.tags !== undefined) created.tags = b.tags;
    if (b.externalRef !== undefined) created.externalRef = b.externalRef;
    if (b.priority !== undefined) created.priority = b.priority;
    if (b.milestone !== undefined) created.milestone = b.milestone;
    if (b.project !== undefined) created.project = b.project;
    if (b.comments !== undefined) created.comments = b.comments;
    if (b.links !== undefined) created.links = b.links;
    if (b.timeline !== undefined) created.timeline = b.timeline;
    if (b.pendingComment !== undefined) created.pendingComment = b.pendingComment;
    if (b.blockKind !== undefined) created.blockKind = b.blockKind;
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
      status: ["triage", "todo", "ready"].includes(card.status) ? "running" : card.status,
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
      // Bind the card to the claude session once it starts reporting from cwd.
      boardProgress.expectSession(card.id, b.cwd);
    }
    return reply.send({ card: updated, session });
  });

  // ---- Whiteboards (SQLite truth, .canvas materialized into the vault) ----
  const canvasChanged = (canvasId: string, origin: "ui" | "agent", actor: string, action: string, detail = "") => {
    canvasSync.export(canvasId);
    canvases.logActivity(canvasId, actor, action, detail);
    const meta = canvases.get(canvasId);
    broadcast({ kind: "canvas.updated", canvasId, rev: meta?.rev ?? 0, origin });
  };
  const actorOf = (body: { agent?: string }): { actor: string; origin: "ui" | "agent" } => {
    const agent = typeof body.agent === "string" && body.agent ? body.agent : null;
    return agent ? { actor: agent, origin: "agent" } : { actor: "operator", origin: "ui" };
  };

  app.get("/api/canvas", async () => ({ canvases: canvases.list() }));
  app.post("/api/canvas", async (req, reply) => {
    const { name, slug } = (req.body ?? {}) as { name?: string; slug?: string };
    if (!name) return reply.code(400).send({ error: "name required" });
    const meta = canvases.create(name, slug);
    canvases.logActivity(meta.id, "operator", "created", name);
    canvasSync.export(meta.id);
    broadcast({ kind: "canvas.created", canvas: meta });
    return reply.send({ canvas: meta });
  });
  app.get("/api/canvas/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = canvases.board(id);
    if (!b) return reply.code(404).send({ error: "not found" });
    return b;
  });
  app.delete("/api/canvas/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const meta = canvases.remove(id);
    if (!meta) return reply.code(404).send({ error: "not found" });
    canvasSync.removeFile(meta.slug);
    broadcast({ kind: "canvas.removed", canvasId: id });
    return reply.send({ ok: true });
  });

  // Bulk apply (shell autosave, agent batches): one rev bump, one export.
  app.post("/api/canvas/:id/bulk", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as {
      nodes?: CreateNodeInput[]; edges?: never[]; removeNodes?: string[]; removeEdges?: string[]; agent?: string;
    };
    const board2 = canvases.bulk(id, b);
    if (!board2) return reply.code(404).send({ error: "not found" });
    const { actor, origin } = actorOf(b);
    canvasChanged(id, origin, actor, "edited",
      `${b.nodes?.length ?? 0} node(s), ${b.edges?.length ?? 0} edge(s), removed ${(b.removeNodes?.length ?? 0) + (b.removeEdges?.length ?? 0)}`);
    return reply.send(board2);
  });

  app.post("/api/canvas/:id/nodes", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as CreateNodeInput & { agent?: string };
    const { actor, origin } = actorOf(b);
    if (origin === "agent") b.extras = { ...b.extras, agent: actor, ts: Date.now() };
    const node = canvases.upsertNode(id, b);
    if (!node) return reply.code(404).send({ error: "not found" });
    canvasChanged(id, origin, actor,
      b.extras?.kind === "comment" ? "commented" : "added node",
      (b.text ?? b.label ?? b.file ?? "").slice(0, 120));
    return reply.send({ node });
  });
  app.patch("/api/canvas/:id/nodes/:nodeId", async (req, reply) => {
    const { id, nodeId } = req.params as { id: string; nodeId: string };
    if (!canvases.node(id, nodeId)) return reply.code(404).send({ error: "not found" });
    const b = (req.body ?? {}) as Partial<CreateNodeInput> & { agent?: string };
    const node = canvases.upsertNode(id, { ...b, id: nodeId } as CreateNodeInput & { id: string });
    const { actor, origin } = actorOf(b);
    canvasChanged(id, origin, actor, "updated node", nodeId);
    return reply.send({ node });
  });
  app.delete("/api/canvas/:id/nodes/:nodeId", async (req, reply) => {
    const { id, nodeId } = req.params as { id: string; nodeId: string };
    if (!canvases.removeNode(id, nodeId)) return reply.code(404).send({ error: "not found" });
    canvasChanged(id, "ui", "operator", "removed node", nodeId);
    return reply.send({ ok: true });
  });

  app.post("/api/canvas/:id/edges", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { fromNode?: string; toNode?: string; label?: string; agent?: string };
    if (!b.fromNode || !b.toNode) return reply.code(400).send({ error: "fromNode and toNode required" });
    const edge = canvases.upsertEdge(id, b as { fromNode: string; toNode: string });
    if (!edge) return reply.code(404).send({ error: "not found" });
    const { actor, origin } = actorOf(b);
    canvasChanged(id, origin, actor, "connected", `${b.fromNode} → ${b.toNode}`);
    return reply.send({ edge });
  });
  app.delete("/api/canvas/:id/edges/:edgeId", async (req, reply) => {
    const { id, edgeId } = req.params as { id: string; edgeId: string };
    if (!canvases.removeEdge(id, edgeId)) return reply.code(404).send({ error: "not found" });
    canvasChanged(id, "ui", "operator", "removed edge", edgeId);
    return reply.send({ ok: true });
  });

  app.get("/api/canvas/:id/activity", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!canvases.get(id)) return reply.code(404).send({ error: "not found" });
    return { activity: canvases.activity(id) };
  });

  // AI actions. create-tasks / convert-to-prd are deterministic; the rest run
  // through Hermes when configured (409 otherwise).
  app.post("/api/canvas/:id/ai", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { action?: string; prompt?: string; nodeIds?: string[] };
    const boardState = canvases.board(id);
    if (!boardState) return reply.code(404).send({ error: "not found" });
    const selected = boardState.nodes.filter((n) =>
      b.nodeIds?.length ? b.nodeIds.includes(n.id) : true);
    const textOf = (n: (typeof selected)[number]) => n.text ?? n.label ?? n.file ?? "";
    const selectedText = selected.map(textOf).filter(Boolean).join("\n\n");
    const rightOf = () => Math.max(0, ...boardState.nodes.map((n) => n.x + n.width)) + 80;

    if (b.action === "create-tasks") {
      const sources = selected.filter((n) => (n.text ?? "").trim());
      if (!sources.length) return reply.code(400).send({ error: "no text nodes selected" });
      const created = sources.map((n) => {
        const lines = n.text!.trim().split("\n");
        const title = lines[0]!.replace(/^#+\s*/, "").slice(0, 120);
        const card = board.create({ title, body: lines.slice(1).join("\n").trim(), tags: ["whiteboard"] });
        emitCard(card);
        return card;
      });
      canvasChanged(id, "ui", "operator", "created tasks", `${created.length} card(s)`);
      return reply.send({ ok: true, cards: created });
    }

    if (b.action === "convert-to-prd") {
      if (!selectedText.trim()) return reply.code(400).send({ error: "no content selected" });
      const slug = `docs/prd-${boardState.canvas.slug.split("/").pop()}-${Date.now().toString(36)}`;
      const md = `# PRD — ${boardState.canvas.name}\n\n> Generated from whiteboard "${boardState.canvas.name}".\n\n${selectedText}\n`;
      vault.write(slug, md);
      const node = canvases.upsertNode(id, {
        type: "file", file: `${slug}.md`,
        x: rightOf(), y: 0, width: 320, height: 160,
      });
      canvasChanged(id, "ui", "operator", "converted to PRD", slug);
      return reply.send({ ok: true, slug, node });
    }

    // LLM-backed actions from here down.
    if (!hermesClient) return reply.code(409).send({ error: "hermes not configured — set AURA_HERMES_KEY" });
    const boardContext = boardState.nodes
      .map((n) => `- [${n.type}] ${textOf(n).slice(0, 200)}`).join("\n").slice(0, 6000);

    if (b.action === "generate-diagram") {
      const ask = b.prompt ?? selectedText ?? boardState.canvas.name;
      const res = await hermesClient.run({
        system:
          'You produce flowcharts as JSON. Reply with ONLY a JSON object: {"nodes":[{"text":string,"x":number,"y":number,"width":number,"height":number}],"edges":[{"from":number,"to":number,"label":string}]} where from/to are node array indices. Layout left-to-right starting at x=0,y=0, node size ~200x90, gaps of 80.',
        prompt: `Create a flowchart for: ${ask}\n\nExisting board context:\n${boardContext}`,
      });
      const json = res.text.match(/\{[\s\S]*\}/)?.[0];
      let spec: { nodes?: { text?: string; x?: number; y?: number; width?: number; height?: number }[]; edges?: { from?: number; to?: number; label?: string }[] };
      try { spec = JSON.parse(json ?? ""); } catch {
        return reply.code(502).send({ error: "hermes returned unparseable diagram", raw: res.text.slice(0, 500) });
      }
      const ox = rightOf(); const oy = 0;
      const made = (spec.nodes ?? []).map((n) =>
        canvases.upsertNode(id, {
          type: "text", text: n.text ?? "", x: ox + (n.x ?? 0), y: oy + (n.y ?? 0),
          width: n.width ?? 200, height: n.height ?? 90, color: "5",
          extras: { kind: "shape", shape: "rect", agent: "hermes", ts: Date.now() },
        })!);
      for (const e of spec.edges ?? []) {
        const from = made[e.from ?? -1]; const to = made[e.to ?? -1];
        if (from && to) canvases.upsertEdge(id, { fromNode: from.id, toNode: to.id, ...(e.label ? { label: e.label } : {}) });
      }
      canvasChanged(id, "agent", "hermes", "generated diagram", `${made.length} node(s)`);
      return reply.send({ ok: true, nodes: made.length, edges: (spec.edges ?? []).length });
    }

    if (b.action === "summarize" || b.action === "expand" || b.action === "ask") {
      const instruction =
        b.action === "summarize" ? "Summarize the key points concisely as markdown bullets."
        : b.action === "expand" ? "Elaborate and structure this content as markdown. Stay grounded in what's there."
        : (b.prompt ?? "Comment on this board.");
      const res = await hermesClient.run({
        system: "You are an assistant working on a shared whiteboard. Reply in concise markdown, no preamble.",
        prompt: `${instruction}\n\n${b.nodeIds?.length ? `Selection:\n${selectedText}\n\n` : ""}Board "${boardState.canvas.name}" contents:\n${boardContext}`,
      });
      const node = canvases.upsertNode(id, {
        type: "text", text: res.text.trim(),
        x: rightOf(), y: 0, width: 300, height: 200, color: "6",
        extras: { kind: "comment", agent: "hermes", ts: Date.now() },
      });
      canvasChanged(id, "agent", "hermes", b.action === "ask" ? "answered" : `${b.action}d`, res.text.slice(0, 120));
      return reply.send({ ok: true, node, text: res.text });
    }

    return reply.code(400).send({ error: `unknown action "${b.action}"` });
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

  // ---- App pairing (Agentic Workspace & friends) ----
  const pairing = new PairingManager(options.peersFile ?? path.join(process.cwd(), "aura.peers.json"));
  const broadcastPeers = () => broadcast({ kind: "peer.updated", peers: pairing.list() });
  const bearerPeer = (req: { headers: Record<string, unknown> }) => {
    const auth = String(req.headers["authorization"] ?? "");
    return pairing.verify(auth.startsWith("Bearer ") ? auth.slice(7) : undefined);
  };

  // Local UI mints a code; peer's backend redeems it once for a token.
  app.post("/api/pair/start", async () => pairing.startPairing());
  app.post("/api/pair/claim", async (req, reply) => {
    const { code, name } = (req.body ?? {}) as { code?: string; name?: string };
    if (!code) return reply.code(400).send({ error: "code required" });
    const claimed = pairing.claim(code, name ?? "peer");
    if (!claimed) return reply.code(403).send({ error: "invalid or expired code" });
    broadcastPeers();
    return reply.send(claimed);
  });
  app.get("/api/pair/status", async () => ({
    peers: pairing.list(),
    pending: pairing.pendingCode !== null,
  }));
  app.post("/api/pair/revoke", async (req, reply) => {
    const { peerId } = (req.body ?? {}) as { peerId?: string };
    if (!peerId || !pairing.revoke(peerId)) return reply.code(404).send({ error: "unknown peer" });
    broadcastPeers();
    return reply.send({ ok: true });
  });

  // Authenticated peer surface: bulk event ingest + liveness/info heartbeat.
  app.post("/api/peer/events", async (req, reply) => {
    const peer = bearerPeer(req);
    if (!peer) return reply.code(401).send({ error: "pairing token required" });
    const { events } = (req.body ?? {}) as { events?: unknown[] };
    if (!Array.isArray(events) || events.length === 0 || events.length > 500) {
      return reply.code(400).send({ error: "events: 1..500 required" });
    }
    let accepted = 0;
    for (const raw of events) {
      const parsed = AgentEvent.omit({ id: true, ts: true })
        .extend({ id: AgentEvent.shape.id.optional(), ts: AgentEvent.shape.ts.optional() })
        .safeParse(raw);
      if (!parsed.success) continue;
      const { id, ts, ...rest } = parsed.data;
      bus.emit({ ...rest, id: id ?? ulid(), ts: ts ?? Date.now() });
      accepted++;
    }
    return reply.send({ ok: true, accepted, rejected: events.length - accepted });
  });
  app.post("/api/peer/heartbeat", async (req, reply) => {
    const peer = bearerPeer(req);
    if (!peer) return reply.code(401).send({ error: "pairing token required" });
    const { name, vaultPath } = (req.body ?? {}) as { name?: string; vaultPath?: string };
    const hb: { name?: string; vaultPath?: string } = {};
    if (name !== undefined) hb.name = name;
    if (vaultPath !== undefined) hb.vaultPath = vaultPath;
    const info = pairing.heartbeat(peer.id, hb);
    broadcastPeers();
    return reply.send({ ok: true, peer: info });
  });

  // Peer approval handbrake (Agentic Workspace integration, step D): a paired
  // peer parks a dangerous tool call here, the operator approves/denies it in
  // the office UI (same POST /api/approvals/:id surface), and the peer polls
  // the request by id until it resolves.
  app.post("/api/peer/approvals/request", async (req, reply) => {
    const peer = bearerPeer(req);
    if (!peer) return reply.code(401).send({ error: "pairing token required" });
    const { agentId, sessionId, tool, inputPreview, reason } = (req.body ?? {}) as {
      agentId?: string;
      sessionId?: string;
      tool?: string;
      inputPreview?: string;
      reason?: string;
    };
    if (!tool) return reply.code(400).send({ error: "tool required" });
    const request = guardrails.request({
      agentId: agentId ?? peer.name,
      sessionId: sessionId ?? "",
      tool,
      inputPreview: inputPreview ?? "",
      ...(reason !== undefined ? { reason } : {}),
    });
    broadcast({ kind: "approval.pending", request });
    return reply.send({ id: request.id, request });
  });
  app.get("/api/peer/approvals/:id", async (req, reply) => {
    const peer = bearerPeer(req);
    if (!peer) return reply.code(401).send({ error: "pairing token required" });
    const { id } = req.params as { id: string };
    const request = guardrails.get(id);
    if (!request) return reply.code(404).send({ error: "unknown request" });
    return reply.send({ request });
  });

  // Vault folder management (Connections panel; "adopt peer's vault").
  app.get("/api/vault/dir", async () => ({ dir: vault.rootDir }));
  app.post("/api/vault/dir", async (req, reply) => {
    const { dir } = (req.body ?? {}) as { dir?: string };
    if (!dir) return reply.code(400).send({ error: "dir required" });
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return reply.code(400).send({ error: `not a directory: ${dir}` });
    }
    const noteCount = swapVault(dir);
    return reply.send({ ok: true, dir, noteCount });
  });

  // ---- Space CAD (office layout) ----
  const space = new SpaceStore(options.spaceFile ?? path.join(process.cwd(), "office.space.json"));
  app.get("/api/space", async () => space.load());
  app.put("/api/space", async (req, reply) => {
    const parsed = SpaceFile.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    space.save(parsed.data);
    broadcast({ kind: "space.updated" });
    return reply.send({ ok: true });
  });

  // ---- Shell (command-center UI) data endpoints ----

  // Vault folder tree: nested {name, slug?, children} built from note slugs.
  app.get("/api/vault/tree", async () => {
    interface TreeNode { name: string; slug?: string; children: TreeNode[] }
    const root: TreeNode = { name: "vault", children: [] };
    for (const note of vault.list()) {
      const parts = note.slug.split("/");
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        let child = node.children.find((c) => c.name === parts[i] && !c.slug);
        if (!child) { child = { name: parts[i]!, children: [] }; node.children.push(child); }
        node = child;
      }
      node.children.push({ name: note.title || parts.at(-1)!, slug: note.slug, children: [] });
    }
    const sort = (n: TreeNode) => {
      n.children.sort((a, b) =>
        Number(!!a.slug) - Number(!!b.slug) || a.name.localeCompare(b.name));
      n.children.forEach(sort);
    };
    sort(root);
    return { tree: root.children };
  });

  // Per-model token usage aggregated from live agent snapshots.
  app.get("/api/usage", async () => {
    const byModel = new Map<string, { model: string; tokens: number; agents: number }>();
    for (const a of store.list()) {
      for (const [model, tokens] of Object.entries(a.tokens.byModel)) {
        const row = byModel.get(model) ?? { model, tokens: 0, agents: 0 };
        row.tokens += tokens;
        row.agents += 1;
        byModel.set(model, row);
      }
    }
    const models = [...byModel.values()].sort((x, y) => y.tokens - x.tokens);
    const total = models.reduce((s, m) => s + m.tokens, 0);
    return { models, total };
  });

  const startedAt = Date.now();
  let gitCache: { at: number; branch: string | null } | null = null;
  const gitBranch = async (): Promise<string | null> => {
    if (gitCache && Date.now() - gitCache.at < 10_000) return gitCache.branch;
    const branch = await new Promise<string | null>((resolve) => {
      import("node:child_process").then(({ execFile }) => {
        execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { timeout: 2000 }, (err, out) =>
          resolve(err ? null : out.trim()));
      }).catch(() => resolve(null));
    });
    gitCache = { at: Date.now(), branch };
    return branch;
  };

  // One-shot status for right-hand panels + status bar.
  app.get("/api/status", async () => {
    const agents = store.list();
    const cards = board.list();
    return {
      orchestration: {
        heartbeatMs: 30_000,
        uptimeMs: Date.now() - startedAt,
        agentsOnline: agents.filter((a) => a.status !== "offline").length,
        agentsTotal: agents.length,
        tasksPending: cards.filter((c) => ["triage", "todo", "ready", "running"].includes(c.status)).length,
        tasksTotal: cards.length,
        eventsLogged: log.recent().length,
        sessionsRunning: sessions.list().filter((s) => s.status === "running").length,
        approvalsPending: guardrails.pendingRequests.length,
      },
      services: {
        daemon: { ok: true, version: SERVER_VERSION },
        vault: { ok: true, notes: vault.list().length },
        board: { ok: true, cards: cards.length },
        github: { ok: syncEngine !== null, linked: syncEngine !== null, lastSync },
        sessions: { ok: true, running: sessions.list().filter((s) => s.status === "running").length },
        workspace: (() => {
          const peers = pairing.list();
          const fresh = peers.some((p) => Date.now() - p.lastSeenAt < 120_000);
          return { ok: peers.length > 0 && fresh, peers: peers.length };
        })(),
        hermes: { ok: hermes.enabled, enabled: hermes.enabled },
      },
      git: { branch: await gitBranch() },
      problems: guardrails.pendingRequests.length + reviewQueue.length,
    };
  });

  app.addHook("onClose", async () => { stopSyncTimer(); canvasSync.close(); canvases.close(); vault.close(); board.close(); syncEngine?.close(); });

  return { app, bus, store, log, guardrails, get vault() { return vault; }, board, skills, hookSessions };
}

export function defaultPublicDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
}
