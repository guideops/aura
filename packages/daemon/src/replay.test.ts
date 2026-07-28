import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDaemon, type Daemon } from "./server.js";

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "fixtures", "claude-code-session.json",
);

const PERMISSIONS_YAML = `
version: 1
default: allow
rules:
  - tool: Bash
    match: "rm -rf"
    action: deny
    reason: destructive delete blocked
`;

describe("replay: claude-code fixture through daemon", () => {
  let daemon: Daemon;

  beforeEach(async () => {
    daemon = createDaemon({ dbPath: ":memory:" });
    daemon.guardrails.loadYaml(PERMISSIONS_YAML);
    await daemon.app.ready();
  });

  afterEach(async () => {
    await daemon.app.close();
    daemon.log.close();
  });

  it("replays the full session and derives correct state", async () => {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      payloads: unknown[];
    };

    for (const payload of fixture.payloads) {
      const res = await daemon.app.inject({
        method: "POST",
        url: "/api/hooks/claude-code",
        payload: payload as Record<string, unknown>,
      });
      expect(res.statusCode).toBe(200);
    }

    // One bot per session, named after the project it runs in. sess-bbb22222
    // ends during the replay, and a finished session despawns rather than
    // lingering as an offline colleague — so only the live one is left.
    const agents = daemon.store.list();
    expect(agents).toHaveLength(1);

    const first = agents.find((a) => a.sessionId === "sess-aaa11111");
    expect(first?.agentId).toBe("aura-1"); // cwd C:\work\aura
    expect(agents.find((a) => a.sessionId === "sess-bbb22222")).toBeUndefined();

    // Stop → idle, and an idle agent holds no desk.
    expect(first?.status).toBe("idle");
    expect(first?.desk).toBeNull();

    // Event log persisted everything incl. the deny event
    const events = daemon.log.recent(100);
    const types = events.map((e) => e.type);
    expect(types).toContain("session.start");
    expect(types).toContain("tool.deny");
    expect(types).toContain("trajectory.compact");
  });

  it("denies rm -rf via guardrails with hook decision payload", async () => {
    const res = await daemon.app.inject({
      method: "POST",
      url: "/api/hooks/claude-code",
      payload: {
        hook_event_name: "PreToolUse",
        session_id: "sess-guard",
        tool_name: "Bash",
        tool_input: { command: "rm -rf node_modules" },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    expect(body.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(body.hookSpecificOutput?.permissionDecisionReason).toContain("destructive");
  });

  it("ask rule creates pending action request, resolvable via API", async () => {
    daemon.guardrails.loadYaml(`
version: 1
default: allow
rules:
  - tool: WebFetch
    action: ask
    reason: outbound fetch needs operator
`);
    const res = await daemon.app.inject({
      method: "POST",
      url: "/api/hooks/claude-code",
      payload: {
        hook_event_name: "PreToolUse",
        session_id: "sess-ask",
        tool_name: "WebFetch",
        tool_input: { url: "https://example.com" },
      },
    });
    expect((res.json() as any).hookSpecificOutput.permissionDecision).toBe("ask");

    const pendingRes = await daemon.app.inject({ method: "GET", url: "/api/approvals" });
    const pending = (pendingRes.json() as { pending: Array<{ id: string }> }).pending;
    expect(pending).toHaveLength(1);

    const firstPending = pending[0]!;
    const resolveRes = await daemon.app.inject({
      method: "POST",
      url: `/api/approvals/${firstPending.id}`,
      payload: { approved: true },
    });
    expect(resolveRes.statusCode).toBe(200);
    expect((resolveRes.json() as any).request.status).toBe("approved");

    const after = await daemon.app.inject({ method: "GET", url: "/api/approvals" });
    expect((after.json() as { pending: unknown[] }).pending).toHaveLength(0);
  });

  it("accumulates token usage via generic event ingress", async () => {
    const res = await daemon.app.inject({
      method: "POST",
      url: "/api/events",
      payload: {
        provider: "claude-code",
        sessionId: "sess-tok",
        agentId: "blue-agent",
        type: "usage.tokens",
        summary: "usage",
        data: { model: "claude-fable-5", inputTokens: 1200, outputTokens: 640 },
      },
    });
    expect(res.statusCode).toBe(200);
    const agent = daemon.store.get("blue-agent");
    expect(agent?.tokens.input).toBe(1200);
    expect(agent?.tokens.byModel["claude-fable-5"]).toBe(1840);
  });
});
