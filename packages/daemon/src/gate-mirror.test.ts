import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDaemon, type Daemon } from "./server.js";

const ASK_FORCE_PUSH = `
version: 1
default: allow
rules:
  - tool: Bash
    match: "git push --force"
    action: ask
    reason: force push needs operator approval
`;

const pending = async (daemon: Daemon) => {
  const res = await daemon.app.inject({ method: "GET", url: "/api/approvals" });
  return (res.json() as { pending: Array<Record<string, unknown>> }).pending;
};

const preToolUse = (daemon: Daemon, sessionId: string, command: string) =>
  daemon.app.inject({
    method: "POST",
    url: "/api/hooks/claude-code",
    payload: {
      hook_event_name: "PreToolUse",
      session_id: sessionId,
      tool_name: "Bash",
      tool_input: { command },
    },
  });

const postToolUse = (daemon: Daemon, sessionId: string, command: string) =>
  daemon.app.inject({
    method: "POST",
    url: "/api/hooks/claude-code",
    payload: {
      hook_event_name: "PostToolUse",
      session_id: sessionId,
      tool_name: "Bash",
      tool_input: { command },
    },
  });

describe("security gate: observed vs owned requests", () => {
  let daemon: Daemon;

  beforeEach(async () => {
    daemon = createDaemon({ dbPath: ":memory:" });
    daemon.guardrails.loadYaml(ASK_FORCE_PUSH);
    await daemon.app.ready();
  });

  afterEach(async () => {
    await daemon.app.close();
    daemon.log.close();
  });

  it("mirrors an approval granted at the terminal when the tool actually runs", async () => {
    await preToolUse(daemon, "sess-1", "git push --force origin main");
    expect(await pending(daemon)).toHaveLength(1);

    // Operator said yes at Claude Code's own prompt, so the call went through.
    await postToolUse(daemon, "sess-1", "git push --force origin main");

    expect(await pending(daemon)).toHaveLength(0);
    // The agent is released rather than left parked at the gate.
    const agents = daemon.store.list();
    expect(agents.every((a) => a.status !== "blocked")).toBe(true);
    expect(agents.every((a) => a.pendingApprovalId === null)).toBe(true);
  });

  it("records the mirrored outcome as approved-by-mirror, not by the operator", async () => {
    await preToolUse(daemon, "sess-2", "git push --force");
    const [before] = await pending(daemon);
    const id = String(before!["id"]);
    expect(before!["origin"]).toBe("hook");

    await postToolUse(daemon, "sess-2", "git push --force");

    const request = daemon.guardrails.get(id);
    expect(request?.status).toBe("approved");
    expect(request?.resolvedBy).toBe("mirror");
  });

  it("matches the exact call, leaving a second concurrent ask open", async () => {
    await preToolUse(daemon, "sess-3", "git push --force origin main");
    await preToolUse(daemon, "sess-3", "git push --force origin release");
    expect(await pending(daemon)).toHaveLength(2);

    await postToolUse(daemon, "sess-3", "git push --force origin main");

    const still = await pending(daemon);
    expect(still).toHaveLength(1);
    expect(still[0]!["inputPreview"]).toContain("release");
  });

  it("expires — never denies — an ask whose session ends with the tool unrun", async () => {
    await preToolUse(daemon, "sess-4", "git push --force");
    const [before] = await pending(daemon);
    const id = String(before!["id"]);

    await daemon.app.inject({
      method: "POST",
      url: "/api/hooks/claude-code",
      payload: { hook_event_name: "SessionEnd", session_id: "sess-4" },
    });

    expect(await pending(daemon)).toHaveLength(0);
    // "expired" = outcome never observed. Calling it "denied" would put a
    // verdict in the timeline that nobody actually gave.
    expect(daemon.guardrails.get(id)?.status).toBe("expired");
  });

  it("never raises a blocking gate for an observed request", async () => {
    await preToolUse(daemon, "sess-5", "git push --force");

    expect(daemon.guardrails.pendingRequests).toHaveLength(1);
    expect(daemon.guardrails.blockingRequests).toHaveLength(0);

    const status = await daemon.app.inject({ method: "GET", url: "/api/status" });
    const body = status.json() as { orchestration: Record<string, number>; problems: number };
    expect(body.orchestration["approvalsPending"]).toBe(0);
    expect(body.orchestration["approvalsObserved"]).toBe(1);
    expect(body.problems).toBe(0);
  });

  it("keeps a peer request blocking, and immune to session and TTL sweeps", async () => {
    const request = daemon.guardrails.request({
      agentId: "agentic-workspace",
      sessionId: "sess-6",
      tool: "Bash",
      inputPreview: "rm -rf ./build",
    });
    expect(request.origin).toBe("peer");
    expect(daemon.guardrails.blockingRequests).toHaveLength(1);

    // A same-session end and an aggressive sweep must both leave it alone:
    // its caller is still polling for an answer only AURA can give.
    daemon.guardrails.abandonSession("sess-6");
    daemon.guardrails.sweepStale(0);

    expect(daemon.guardrails.blockingRequests).toHaveLength(1);
    expect(daemon.guardrails.get(request.id)?.status).toBe("pending");
  });

  it("still lets the operator resolve an owned request by hand", async () => {
    const request = daemon.guardrails.request({
      agentId: "agentic-workspace",
      sessionId: "sess-7",
      tool: "Bash",
      inputPreview: "git push --force",
    });

    const res = await daemon.app.inject({
      method: "POST",
      url: `/api/approvals/${request.id}`,
      payload: { approved: true },
    });

    expect(res.statusCode).toBe(200);
    expect(daemon.guardrails.get(request.id)?.resolvedBy).toBe("operator");
    expect(daemon.guardrails.blockingRequests).toHaveLength(0);
  });

  it("sweeps an observed request whose session never reported an end", async () => {
    await preToolUse(daemon, "sess-8", "git push --force");

    const swept = daemon.guardrails.sweepStale(0);

    expect(swept).toHaveLength(1);
    expect(swept[0]!.status).toBe("expired");
    expect(daemon.guardrails.pendingRequests).toHaveLength(0);
  });
});
