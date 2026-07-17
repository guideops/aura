import { useCallback, useEffect, useState } from "react";
import { api, type SessionInfo } from "../../lib/api";
import { useShell } from "../../lib/store";

export function ExecutionsPanel() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [provider, setProvider] = useState("claude-code");
  const [model, setModel] = useState("");
  const [cwd, setCwd] = useState("");
  const [prompt, setPrompt] = useState("");
  const [hint, setHint] = useState("");
  const events = useShell((s) => s.events);

  const refresh = useCallback(() => {
    api.sessions().then(setSessions).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);
  // session.start / session.end events are the fast refresh signal
  useEffect(() => {
    const last = events[events.length - 1];
    if (last && (last.type === "session.start" || last.type === "session.end")) refresh();
  }, [events, refresh]);

  const spawn = async () => {
    if (!prompt.trim()) return setHint("prompt required");
    if (provider !== "hermes" && !cwd.trim()) return setHint("cwd required for claude-code sessions");
    setHint("spawning…");
    const body: { provider: string; prompt: string; model?: string; cwd?: string } = {
      provider,
      prompt: prompt.trim(),
    };
    if (model.trim()) body.model = model.trim();
    if (provider !== "hermes") body.cwd = cwd.trim();
    const res = await api.spawnSession(body);
    setHint(res.ok ? "session started" : `failed: ${res.status}`);
    if (res.ok) setPrompt("");
    refresh();
  };

  return (
    <aside className="sidebar">
      <div className="panel-title">
        Executions
        <span className="panel-title-actions clickable" onClick={refresh} title="Refresh">↻</span>
      </div>
      <div className="sidebar-pad spawn-form">
        <div className="row-gap">
          <select value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="claude-code">claude-code</option>
            <option value="hermes">hermes</option>
          </select>
          <input placeholder="model (optional)" value={model} onChange={(e) => setModel(e.target.value)} />
        </div>
        {provider !== "hermes" && (
          <input placeholder="working directory" value={cwd} onChange={(e) => setCwd(e.target.value)} />
        )}
        <textarea
          placeholder="prompt…"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <div className="row-gap">
          <button className="btn-primary" onClick={() => void spawn()}>Spawn</button>
          <span className="muted small-line">{hint}</span>
        </div>
      </div>
      <div className="tree-section">SESSIONS <span className="col-count">{sessions.length}</span></div>
      {sessions.length === 0 && <div className="sidebar-empty">No sessions running.</div>}
      {sessions.map((s) => (
        <div key={s.id} className="session-row">
          <div className="session-head">
            <span className="mono-dim">{s.id.slice(0, 10)}</span>
            <span className={`status-chip status-${s.status ?? "active"}`}>{s.status ?? "running"}</span>
          </div>
          <div className="muted small-line">{s.provider ?? "claude-code"}{s.model ? ` · ${s.model}` : ""}</div>
          {typeof s.prompt === "string" && s.prompt && (
            <div className="muted small-line" title={s.prompt}>{s.prompt.slice(0, 60)}</div>
          )}
          <button className="btn-secondary" onClick={async () => { await api.killSession(s.id); refresh(); }}>
            Stop
          </button>
        </div>
      ))}
    </aside>
  );
}
