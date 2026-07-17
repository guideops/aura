import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent } from "@aura/core";
import { api } from "../lib/api";
import { usePoll } from "../lib/poll";
import { agentColor, useShell } from "../lib/store";

type BottomTab = "terminal" | "output" | "eventlog" | "problems";

const LEVEL_BY_TYPE: Record<string, { label: string; cls: string }> = {
  "session.start": { label: "INFO", cls: "lv-info" },
  "session.end": { label: "INFO", cls: "lv-info" },
  "tool.use": { label: "INFO", cls: "lv-info" },
  "tool.result": { label: "SUCCESS", cls: "lv-success" },
  "tool.deny": { label: "WARN", cls: "lv-warn" },
  "tool.ask": { label: "WARN", cls: "lv-warn" },
  "task.claim": { label: "INFO", cls: "lv-info" },
  "task.progress": { label: "INFO", cls: "lv-info" },
  "task.complete": { label: "SUCCESS", cls: "lv-success" },
  "usage.tokens": { label: "INFO", cls: "lv-dim" },
  "agent.status": { label: "IDLE", cls: "lv-dim" },
  "system.error": { label: "ERROR", cls: "lv-error" },
  "context.warn": { label: "WARN", cls: "lv-warn" },
};

export function BottomPanel() {
  const [tab, setTab] = useState<BottomTab>("terminal");
  const events = useShell((s) => s.events);
  const approvals = useShell((s) => s.approvals);
  const problems = useMemo(
    () => events.filter((e) => e.type === "system.error" || e.type === "tool.deny"),
    [events],
  );

  return (
    <section className="bottom-panel">
      <div className="bottom-tabs">
        {(
          [
            ["terminal", "TERMINAL"],
            ["output", "OUTPUT"],
            ["eventlog", "EVENT LOG"],
            ["problems", "PROBLEMS"],
          ] as [BottomTab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            className={`bottom-tab ${tab === id ? "active" : ""}`}
            onClick={() => setTab(id)}
          >
            {label}
            {id === "problems" && problems.length + approvals.length > 0 && (
              <span className="problem-badge">{problems.length + approvals.length}</span>
            )}
          </button>
        ))}
      </div>
      <div className="bottom-body">
        <div className="bottom-tab-content">
          {tab === "terminal" && <TerminalView events={events} />}
          {tab === "output" && <OutputView />}
          {tab === "eventlog" && <EventLogView events={events} />}
          {tab === "problems" && <ProblemsView problems={problems} />}
        </div>
        <DockSide />
      </div>
    </section>
  );
}

/** Orchestration Status + System Services (reference S2/S4 dock panels). */
function DockSide() {
  const st = usePoll(() => api.status(), 10000);
  if (!st) return null;
  const o = st.orchestration;
  const svc: [string, boolean, string][] = [
    ["Daemon", st.services.daemon.ok, `v${st.services.daemon.version}`],
    ["Obsidian Vault", st.services.vault.ok, `${st.services.vault.notes} notes`],
    ["Board", st.services.board.ok, `${st.services.board.cards} cards`],
    ["GitHub Sync", st.services.github.linked, st.services.github.linked ? "Linked" : "Not linked"],
    ["Agentic Workspace", st.services.workspace?.ok ?? false,
      st.services.workspace?.peers ? `${st.services.workspace.peers} peer(s)` : "Not linked"],
    ["Hermes", st.services.hermes?.enabled ?? false, st.services.hermes?.enabled ? "Enabled" : "Off"],
  ];
  return (
    <div className="dock-side">
      <div className="dock-widget">
        <div className="dock-widget-title">Orchestration Status</div>
        <dl className="task-ctx">
          <dt>Heartbeat</dt><dd>Every {Math.round(o.heartbeatMs / 1000)}s</dd>
          <dt>Uptime</dt><dd>{Math.floor(o.uptimeMs / 60000)}m</dd>
          <dt>Tasks</dt><dd>{o.tasksPending} pending</dd>
          <dt>Sessions</dt><dd>{o.sessionsRunning} running</dd>
          <dt>Agents Online</dt><dd>{o.agentsOnline} / {o.agentsTotal}</dd>
        </dl>
        <div className="progress-track slim">
          <div
            className="progress-fill green"
            style={{ width: o.agentsTotal ? `${Math.round((o.agentsOnline / o.agentsTotal) * 100)}%` : "0%" }}
          />
        </div>
      </div>
      <div className="dock-widget">
        <div className="dock-widget-title">System Services</div>
        <dl className="task-ctx">
          {svc.map(([name, ok, label]) => (
            <div key={name} className="kv-line">
              <dt>{name}</dt>
              <dd className={ok ? "svc-ok" : "svc-bad"}>● {label}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

function useAutoScroll(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [dep]);
  return ref;
}

function TerminalView({ events }: { events: AgentEvent[] }) {
  const [agentFilter, setAgentFilter] = useState("all");
  const agents = useShell((s) => s.agents);
  const shown = events.filter((e) => agentFilter === "all" || e.agentId === agentFilter);
  const ref = useAutoScroll(shown.length);
  return (
    <div className="terminal-wrap">
      <div className="term-lines" ref={ref}>
        {shown.slice(-400).map((e) => {
          const lv = LEVEL_BY_TYPE[e.type] ?? { label: "INFO", cls: "lv-info" };
          return (
            <div key={e.id} className="term-line">
              <span className="term-ts">{new Date(e.ts).toLocaleTimeString("en-GB")}</span>
              <span className="term-agent" style={{ color: agentColor(e.agentId) }}>
                ● {e.agentId}
              </span>
              <span className={`term-level ${lv.cls}`}>[{lv.label}]</span>
              <span className="term-msg">{e.summary || e.type}</span>
            </div>
          );
        })}
        {shown.length === 0 && <div className="term-line muted">No activity yet — waiting for events…</div>}
      </div>
      <div className="term-side">
        <select value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)}>
          <option value="all">● all agents</option>
          {agents.map((a) => (
            <option key={a.agentId} value={a.agentId}>● {a.agentId}</option>
          ))}
        </select>
        <TaskContext agentId={agentFilter === "all" ? null : agentFilter} />
      </div>
    </div>
  );
}

function TaskContext({ agentId }: { agentId: string | null }) {
  const agents = useShell((s) => s.agents);
  const agent = agentId ? agents.find((a) => a.agentId === agentId) : agents.find((a) => a.status === "active") ?? agents[0];
  const cards = useShell((s) => s.cards);
  const card = agent ? cards.find((c) => c.sessionId === agent.sessionId || c.assignee === agent.agentId) : undefined;
  if (!agent) return null;
  return (
    <dl className="task-ctx">
      <dt>Task</dt><dd>{agent.task || card?.title || "—"}</dd>
      <dt>Status</dt><dd><span className={`status-chip status-${agent.status}`}>{agent.status}</span></dd>
      <dt>Progress</dt>
      <dd>
        <div className="progress-track slim">
          <div className="progress-fill" style={{ width: `${card?.progress ?? 0}%` }} />
        </div>
        {card?.progress ?? 0}%
      </dd>
    </dl>
  );
}

function OutputView() {
  const sessionOutput = useShell((s) => s.sessionOutput);
  const ids = Object.keys(sessionOutput);
  const [sel, setSel] = useState<string>("");
  const active = sel || ids[0] || "";
  const lines = sessionOutput[active] ?? [];
  const ref = useAutoScroll(lines.length);
  return (
    <div className="terminal-wrap">
      <div className="term-lines" ref={ref}>
        {lines.map((l, i) => (
          <div key={i} className="term-line mono">{l}</div>
        ))}
        {lines.length === 0 && <div className="term-line muted">No session output. Spawn a session to see its transcript here.</div>}
      </div>
      {ids.length > 0 && (
        <div className="term-side">
          <select value={active} onChange={(e) => setSel(e.target.value)}>
            {ids.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </div>
      )}
    </div>
  );
}

function EventLogView({ events }: { events: AgentEvent[] }) {
  const [typeFilter, setTypeFilter] = useState("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const types = useMemo(() => [...new Set(events.map((e) => e.type))].sort(), [events]);
  const shown = events.filter((e) => typeFilter === "all" || e.type === typeFilter);
  const ref = useAutoScroll(shown.length);
  return (
    <div className="terminal-wrap">
      <div className="term-lines" ref={ref}>
        <table className="event-table">
          <thead>
            <tr><th>time</th><th>agent</th><th>type</th><th>summary</th></tr>
          </thead>
          <tbody>
            {shown.slice(-300).map((e) => (
              <tr key={e.id} onClick={() => setExpanded(expanded === e.id ? null : e.id)}>
                <td>{new Date(e.ts).toLocaleTimeString("en-GB")}</td>
                <td style={{ color: agentColor(e.agentId) }}>{e.agentId}</td>
                <td>{e.type}</td>
                <td>
                  {e.summary}
                  {expanded === e.id && <pre className="event-json">{JSON.stringify(e, null, 2)}</pre>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && <div className="term-line muted">No events.</div>}
      </div>
      <div className="term-side">
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="all">all types</option>
          {types.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
    </div>
  );
}

function ProblemsView({ problems }: { problems: AgentEvent[] }) {
  const approvals = useShell((s) => s.approvals);
  return (
    <div className="term-lines">
      {approvals.map((a) => (
        <div key={a.id} className="term-line">
          <span className="term-level lv-warn">[APPROVAL]</span>
          <span className="term-msg">{a.agentId}: {a.tool} — {a.inputPreview.slice(0, 80)}</span>
        </div>
      ))}
      {problems.slice(-100).reverse().map((e) => (
        <div key={e.id} className="term-line">
          <span className="term-ts">{new Date(e.ts).toLocaleTimeString("en-GB")}</span>
          <span className="term-agent" style={{ color: agentColor(e.agentId) }}>● {e.agentId}</span>
          <span className={`term-level ${e.type === "system.error" ? "lv-error" : "lv-warn"}`}>
            [{e.type === "system.error" ? "ERROR" : "DENIED"}]
          </span>
          <span className="term-msg">{e.summary || e.type}</span>
        </div>
      ))}
      {problems.length === 0 && approvals.length === 0 && (
        <div className="term-line muted">No problems. 🎉</div>
      )}
    </div>
  );
}
