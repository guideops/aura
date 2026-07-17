import { useSyncExternalStore } from "react";
import type { AgentEvent, AgentSnapshot, BoardMessage, Card, ServerMessage } from "@aura/core";

/** Pending guardrail approval as broadcast by the daemon. */
export interface PendingApproval {
  id: string;
  agentId?: string;
  summary?: string;
  [k: string]: unknown;
}

export interface Peer {
  id: string;
  name: string;
  pairedAt: number;
  lastSeenAt: number;
  vaultPath?: string | undefined;
}

export interface ShellState {
  connected: boolean;
  serverVersion: string;
  agents: AgentSnapshot[];
  events: AgentEvent[]; // newest last, capped
  approvals: PendingApproval[];
  peers: Peer[];
  /** session id -> output lines (capped) */
  sessionOutput: Record<string, string[]>;
  cards: Card[];
}

const EVENT_CAP = 2000;
const OUTPUT_CAP = 1000;

let state: ShellState = {
  connected: false,
  serverVersion: "",
  agents: [],
  events: [],
  approvals: [],
  peers: [],
  sessionOutput: {},
  cards: [],
};

/** Seed cards from the REST fetch; WS keeps them fresh afterwards. */
export function setCards(cards: Card[]) {
  emit({ cards });
}

const listeners = new Set<() => void>();

function emit(next: Partial<ShellState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function upsertAgent(agent: AgentSnapshot) {
  const rest = state.agents.filter((a) => a.agentId !== agent.agentId);
  emit({ agents: [...rest, agent].sort((a, b) => a.agentId.localeCompare(b.agentId)) });
}

function handleMessage(msg: ServerMessage | BoardMessage) {
  switch (msg.kind) {
    case "card.upsert":
      emit({ cards: [...state.cards.filter((c) => c.id !== msg.card.id), msg.card] });
      break;
    case "card.removed":
      emit({ cards: state.cards.filter((c) => c.id !== msg.id) });
      break;
    case "hello":
      emit({
        agents: [...msg.agents].sort((a, b) => a.agentId.localeCompare(b.agentId)),
        approvals: msg.approvals as unknown as PendingApproval[],
        serverVersion: msg.serverVersion,
      });
      break;
    case "event": {
      const events = [...state.events, msg.event];
      if (events.length > EVENT_CAP) events.splice(0, events.length - EVENT_CAP);
      emit({ events });
      break;
    }
    case "snapshot":
      upsertAgent(msg.agent);
      break;
    case "agent.removed":
      emit({ agents: state.agents.filter((a) => a.agentId !== msg.agentId) });
      break;
    case "approval.pending":
      emit({ approvals: [...state.approvals.filter((a) => a.id !== (msg.request as { id: string }).id), msg.request as unknown as PendingApproval] });
      break;
    case "approval.resolved":
      emit({ approvals: state.approvals.filter((a) => a.id !== msg.id) });
      break;
    case "peer.updated":
      emit({ peers: msg.peers });
      break;
    case "session.output": {
      const prev = state.sessionOutput[msg.sessionId] ?? [];
      const lines = [...prev, ...msg.lines];
      if (lines.length > OUTPUT_CAP) lines.splice(0, lines.length - OUTPUT_CAP);
      emit({ sessionOutput: { ...state.sessionOutput, [msg.sessionId]: lines } });
      break;
    }
    default:
      // vault.updated / space.updated / session.status handled by consumers polling
      break;
  }
}

let started = false;

export function startWs() {
  if (started) return;
  started = true;
  connect();
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => emit({ connected: true });
  ws.onclose = () => {
    emit({ connected: false });
    setTimeout(connect, 2000);
  };
  ws.onmessage = (e) => {
    try {
      handleMessage(JSON.parse(e.data as string) as ServerMessage);
    } catch {
      // malformed frame; ignore
    }
  };
}

export function useShell<T>(selector: (s: ShellState) => T): T {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => selector(state),
  );
}

/** Stable agent color mapping (matches the office robot palette). */
export const AGENT_COLORS: Record<string, string> = {
  blue: "#3b82f6",
  green: "#22c55e",
  orange: "#f59e0b",
  purple: "#a855f7",
  red: "#ef4444",
  yellow: "#eab308",
};

export function agentColor(agentId: string | null | undefined): string {
  if (!agentId) return "#64748b";
  const prefix = agentId.split("-")[0] ?? "";
  return AGENT_COLORS[prefix] ?? "#64748b";
}
