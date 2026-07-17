import { useCallback, useEffect, useState } from "react";
import { api, type GithubStatus } from "../../lib/api";

interface GitChange {
  path: string;
  status: "M" | "U" | "A" | "D";
}

export function SourceControlPanel() {
  const [changes, setChanges] = useState<GitChange[]>([]);
  const [branch, setBranch] = useState<string>("");
  const [gh, setGh] = useState<GithubStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    fetch("/api/workspace/git")
      .then((r) => r.json())
      .then((d: { branch?: string; changes?: GitChange[] }) => {
        setBranch(d.branch ?? "");
        setChanges(d.changes ?? []);
      })
      .catch(() => {});
    api.githubStatus().then(setGh).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <aside className="sidebar">
      <div className="panel-title">
        Source Control
        <span className="panel-title-actions clickable" onClick={refresh} title="Refresh">↻</span>
      </div>
      <div className="sidebar-pad muted">⎇ {branch || "—"}</div>
      <div className="tree-section">CHANGES <span className="col-count">{changes.length}</span></div>
      {changes.length === 0 && <div className="sidebar-empty">Working tree clean.</div>}
      {changes.map((c) => (
        <div key={c.path} className="tree-item indent-1" title={c.path}>
          <span className="tree-name">{c.path}</span>
          <span className={`git-badge git-${c.status}`}>{c.status}</span>
        </div>
      ))}
      <div className="tree-section">GITHUB PROJECTS</div>
      <div className="sidebar-pad">
        <dl className="task-ctx">
          <dt>Linked</dt>
          <dd className={gh?.linked ? "svc-ok" : "muted"}>{gh?.linked ? "● Yes" : "○ No"}</dd>
          <dt>Last sync</dt>
          <dd>{gh?.lastSync ? new Date(gh.lastSync).toLocaleTimeString() : "never"}</dd>
          <dt>Auto-sync</dt>
          <dd>{gh?.intervalMs ? `every ${Math.round(gh.intervalMs / 1000)}s` : "off"}</dd>
          <dt>Review queue</dt>
          <dd>{gh?.reviewQueue.length ? `⚠ ${gh.reviewQueue.length} conflict(s)` : "empty"}</dd>
        </dl>
        <div className="row-gap">
          <button
            className="btn-secondary"
            disabled={busy || !gh?.linked}
            onClick={async () => {
              setBusy(true);
              await api.githubSync().catch(() => {});
              setBusy(false);
              refresh();
            }}
          >
            Sync now
          </button>
          {gh?.linked && (
            <button
              className="btn-secondary"
              onClick={async () => {
                await api.githubUnlink().catch(() => {});
                refresh();
              }}
            >
              Unlink
            </button>
          )}
        </div>
        {!gh?.linked && <GithubLinkForm onLinked={refresh} />}
      </div>
    </aside>
  );
}

/**
 * Inline connect flow. The preferred path is the desktop Settings dialog
 * (token encrypted in the OS keychain); this form talks straight to the
 * local daemon, which keeps the token server-side and never echoes it back.
 */
function GithubLinkForm({ onLinked }: { onLinked: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const [token, setToken] = useState("");
  const [projectId, setProjectId] = useState("");
  const [msg, setMsg] = useState("");

  if (!showForm) {
    return (
      <div className="row-gap">
        <button className="btn-primary" onClick={() => setShowForm(true)}>Connect GitHub…</button>
      </div>
    );
  }
  return (
    <div className="spawn-form" style={{ marginTop: 8 }}>
      <div className="muted small-line">
        Needs a fine-grained PAT with Projects read/write and the Projects v2 node id
        (<code>PVT_…</code>). Token is stored by the local daemon only. The desktop
        Settings dialog is the preferred path — it encrypts the token in the OS keychain.
      </div>
      <input
        type="password"
        placeholder="GitHub token (PAT)"
        value={token}
        onChange={(e) => setToken(e.target.value)}
      />
      <input
        placeholder="Project node id (PVT_…)"
        value={projectId}
        onChange={(e) => setProjectId(e.target.value)}
      />
      <div className="row-gap">
        <button
          className="btn-primary"
          disabled={!token.trim() || !projectId.trim()}
          onClick={async () => {
            setMsg("linking…");
            const res = await api.githubLink({ token: token.trim(), projectId: projectId.trim() });
            if (res.ok) {
              setMsg("linked ✓");
              setToken("");
              setShowForm(false);
              onLinked();
            } else {
              const body = (await res.json().catch(() => ({}))) as { error?: string };
              setMsg(`failed: ${body.error ?? res.status}`);
            }
          }}
        >
          Link
        </button>
        <button className="btn-secondary" onClick={() => { setShowForm(false); setToken(""); }}>Cancel</button>
        <span className="muted small-line">{msg}</span>
      </div>
    </div>
  );
}
