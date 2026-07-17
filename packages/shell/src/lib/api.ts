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
  async status(): Promise<Record<string, unknown>> {
    return json(await fetch("/api/status"));
  },
  async githubStatus(): Promise<{ linked: boolean; repo?: string }> {
    return json(await fetch("/api/github/status"));
  },
};

export interface TreeNode {
  name: string;
  path: string;
  type: "dir" | "file";
  gitStatus?: "M" | "U" | "A" | "D";
  children?: TreeNode[];
}
