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
          status: "pending",
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
      status: "pending",
      resolvedAt: null,
    };
    this.pending.set(request.id, request);
    return request;
  }

  get(requestId: string): ActionRequest | undefined {
    return this.pending.get(requestId);
  }

  resolve(requestId: string, approved: boolean): ActionRequest | undefined {
    const request = this.pending.get(requestId);
    if (!request || request.status !== "pending") return undefined;
    request.status = approved ? "approved" : "denied";
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
