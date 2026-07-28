import { ulid } from "ulid";
import { parse as parseYaml } from "yaml";
import { PermissionsFile, type ActionRequest, type RuleAction } from "@aura/core";

export interface GuardrailDecision {
  action: RuleAction;
  reason: string;
  request?: ActionRequest;
}

/**
 * Evaluates PreToolUse events against permissions rules.
 * First matching rule wins. "ask" creates a pending ActionRequest that an
 * operator resolves via the HTTP API; the hook response blocks until then
 * (Claude Code hook contract: exit decision returned synchronously, so
 * "ask" maps to deny-with-reason now + approve-to-retry, v1 semantics).
 */
export class GuardrailEngine {
  private config: PermissionsFile = { version: 1, default: "allow", rules: [] };
  private pending = new Map<string, ActionRequest>();

  loadYaml(text: string): void {
    this.config = PermissionsFile.parse(parseYaml(text));
  }

  get pendingRequests(): ActionRequest[] {
    return [...this.pending.values()].filter((r) => r.status === "pending");
  }

  /**
   * Requests that actually block someone. Hook-origin requests never do —
   * Claude Code already asked the operator directly — so only peer-origin
   * requests raise the security gate in the UI.
   */
  get blockingRequests(): ActionRequest[] {
    return this.pendingRequests.filter((r) => r.origin === "peer");
  }

  evaluate(input: {
    agentId: string;
    sessionId: string;
    tool: string;
    inputPreview: string;
  }): GuardrailDecision {
    for (const rule of this.config.rules) {
      if (!globMatch(rule.tool, input.tool)) continue;
      if (rule.match !== undefined && !safeRegexTest(rule.match, input.inputPreview)) continue;
      if (rule.action === "ask") {
        const request: ActionRequest = {
          id: ulid(),
          ts: Date.now(),
          agentId: input.agentId,
          sessionId: input.sessionId,
          tool: input.tool,
          inputPreview: input.inputPreview.slice(0, 500),
          reason: rule.reason ?? "operator approval required",
          impact: "medium",
          origin: "hook",
          status: "pending",
          resolvedBy: null,
          resolvedAt: null,
        };
        this.pending.set(request.id, request);
        return { action: "ask", reason: request.reason, request };
      }
      return { action: rule.action, reason: rule.reason ?? "" };
    }
    return { action: this.config.default, reason: "default policy" };
  }

  /**
   * Peer-submitted approval request (Agentic Workspace integration, step D).
   * Parks the request exactly like an "ask" rule hit; the operator resolves it
   * via the same POST /api/approvals/:id surface, and the peer polls get().
   */
  request(input: {
    agentId: string;
    sessionId: string;
    tool: string;
    inputPreview: string;
    reason?: string;
  }): ActionRequest {
    const request: ActionRequest = {
      id: ulid(),
      ts: Date.now(),
      agentId: input.agentId,
      sessionId: input.sessionId,
      tool: input.tool,
      inputPreview: input.inputPreview.slice(0, 500),
      reason: input.reason ?? "operator approval required",
      impact: "medium",
      origin: "peer",
      status: "pending",
      resolvedBy: null,
      resolvedAt: null,
    };
    this.pending.set(request.id, request);
    return request;
  }

  /**
   * Mirror a real outcome back onto an observed request.
   *
   * A PostToolUse event means the tool actually ran, which means the operator
   * approved it at Claude Code's own prompt. Rather than leave a phantom card
   * asking a question that was already answered, adopt the answer.
   *
   * Matched on session + tool + input preview so two concurrent asks in one
   * session don't resolve each other; oldest match wins. Peer requests are
   * never mirrored — nothing outside AURA can answer those.
   */
  mirror(input: { sessionId: string; tool: string; inputPreview: string }): ActionRequest | undefined {
    const match = this.pendingRequests
      .filter(
        (r) =>
          r.origin === "hook" &&
          r.sessionId === input.sessionId &&
          r.tool === input.tool &&
          // PostToolUse carries the input for an exact match, but older hook
          // payloads omit it; fall back to session+tool rather than stall.
          (input.inputPreview === "" || r.inputPreview === input.inputPreview.slice(0, 500)),
      )
      .sort((a, b) => a.ts - b.ts)[0];
    if (!match) return undefined;
    match.status = "approved";
    match.resolvedBy = "mirror";
    match.resolvedAt = Date.now();
    return match;
  }

  /**
   * The session ended and the tool never ran, so no outcome is coming. That is
   * "unanswered", not "denied" — the operator may well have said no at the
   * terminal, but we never observed it, and guessing would put a wrong verdict
   * in the timeline. Peer requests survive: their caller is still polling.
   */
  abandonSession(sessionId: string): ActionRequest[] {
    const stale = this.pendingRequests.filter((r) => r.origin === "hook" && r.sessionId === sessionId);
    for (const request of stale) {
      request.status = "expired";
      request.resolvedBy = "mirror";
      request.resolvedAt = Date.now();
    }
    return stale;
  }

  /**
   * Backstop for sessions that never emit an end event (crash, kill -9).
   * Observed requests only — an owned request waits for a human however long
   * that takes, because expiring it would silently deny a live caller.
   */
  sweepStale(ttlMs: number, now = Date.now()): ActionRequest[] {
    const stale = this.pendingRequests.filter(
      (r) => r.origin === "hook" && now - r.ts >= ttlMs,
    );
    for (const request of stale) {
      request.status = "expired";
      request.resolvedBy = "mirror";
      request.resolvedAt = now;
    }
    return stale;
  }

  get(requestId: string): ActionRequest | undefined {
    return this.pending.get(requestId);
  }

  resolve(requestId: string, approved: boolean): ActionRequest | undefined {
    const request = this.pending.get(requestId);
    if (!request || request.status !== "pending") return undefined;
    request.status = approved ? "approved" : "denied";
    request.resolvedBy = "operator";
    request.resolvedAt = Date.now();
    return request;
  }
}

function globMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  const re = new RegExp(
    `^${pattern.split("*").map(escapeRegex).join(".*")}$`,
  );
  return re.test(value);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeRegexTest(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}
