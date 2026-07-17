import type { Card, CardStatus } from "@aura/core";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export const api = {
  async listCards(): Promise<Card[]> {
    return (await json<{ cards: Card[] }>(await fetch("/api/board/cards"))).cards;
  },
  async createCard(input: { title: string; body?: string; tags?: string[]; status?: CardStatus }): Promise<Card> {
    return (await json<{ card: Card }>(await fetch("/api/board/cards", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }))).card;
  },
  async patchCard(id: string, patch: Partial<Card>): Promise<Card> {
    return (await json<{ card: Card }>(await fetch(`/api/board/cards/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }))).card;
  },
  async deleteCard(id: string): Promise<void> {
    await fetch(`/api/board/cards/${id}`, { method: "DELETE" });
  },
  async assignCard(id: string, agentId: string | null): Promise<Card> {
    return (await json<{ card: Card }>(await fetch(`/api/board/cards/${id}/assign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId }),
    }))).card;
  },
  async resolveApproval(id: string, approved: boolean): Promise<void> {
    await fetch(`/api/approvals/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved }),
    });
  },
  async workspaceTree(): Promise<TreeNode[]> {
    return (await json<{ tree: TreeNode[] }>(await fetch("/api/workspace/tree"))).tree;
  },
  async status(): Promise<DaemonStatus> {
    return json(await fetch("/api/status"));
  },
  async usage(): Promise<UsageReport> {
    return json(await fetch("/api/usage"));
  },
  async githubStatus(): Promise<GithubStatus> {
    return json(await fetch("/api/github/status"));
  },
  async githubSync(): Promise<void> {
    await fetch("/api/github/sync", { method: "POST" });
  },
  async githubUnlink(): Promise<void> {
    await fetch("/api/github/unlink", { method: "POST" });
  },
  async sessions(): Promise<SessionInfo[]> {
    return (await json<{ sessions: SessionInfo[] }>(await fetch("/api/sessions"))).sessions;
  },
  async spawnSession(input: { provider: string; prompt: string; model?: string; cwd?: string }): Promise<Response> {
    return fetch("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  },
  async killSession(id: string): Promise<void> {
    await fetch(`/api/sessions/${id}`, { method: "DELETE" });
  },
  async pairStart(): Promise<{ code: string; expiresAt: number }> {
    return json(await fetch("/api/pair/start", { method: "POST" }));
  },
  async pairStatus(): Promise<{ peers: PeerInfo[]; pending: boolean }> {
    return json(await fetch("/api/pair/status"));
  },
  async pairRevoke(peerId: string): Promise<void> {
    await fetch("/api/pair/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ peerId }),
    });
  },
  async vaultDir(): Promise<{ dir: string }> {
    return json(await fetch("/api/vault/dir"));
  },
  async setVaultDir(dir: string): Promise<Response> {
    return fetch("/api/vault/dir", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir }),
    });
  },
  async vaultSearch(q: string): Promise<{ name: string; path: string; snippet?: string }[]> {
    const r = await fetch(`/api/vault/search?q=${encodeURIComponent(q)}`);
    if (!r.ok) return [];
    const d = (await r.json()) as { results?: { name: string; path: string; snippet?: string }[]; notes?: { name: string; path: string }[] };
    return d.results ?? d.notes ?? [];
  },
  async hermesStatus(): Promise<{ enabled: boolean }> {
    return json(await fetch("/api/hermes/status"));
  },
};

export interface UsageReport {
  models: { model: string; tokens: number; agents: number }[];
  total: number;
}

export interface GithubStatus {
  linked: boolean;
  lastSync: number | null;
  intervalMs: number;
  reviewQueue: unknown[];
}

export interface SessionInfo {
  id: string;
  provider?: string;
  status?: string;
  model?: string;
  cwd?: string;
  prompt?: string;
  [k: string]: unknown;
}

export interface PeerInfo {
  id: string;
  name: string;
  pairedAt: number;
  lastSeenAt: number;
  vaultPath?: string;
}

export interface DaemonStatus {
  orchestration: {
    heartbeatMs: number;
    uptimeMs: number;
    agentsOnline: number;
    agentsTotal: number;
    tasksPending: number;
    tasksTotal: number;
    eventsLogged: number;
    sessionsRunning: number;
    approvalsPending: number;
  };
  services: {
    daemon: { ok: boolean; version: string };
    vault: { ok: boolean; notes: number };
    board: { ok: boolean; cards: number };
    github: { ok: boolean; linked: boolean; lastSync: number | null };
    sessions: { ok: boolean; running: number };
    workspace?: { ok: boolean; peers: number };
    hermes?: { ok: boolean; enabled: boolean };
  };
  git: { branch: string | null };
  problems: number;
}

export interface TreeNode {
  name: string;
  path: string;
  type: "dir" | "file";
  gitStatus?: "M" | "U" | "A" | "D";
  children?: TreeNode[];
}
