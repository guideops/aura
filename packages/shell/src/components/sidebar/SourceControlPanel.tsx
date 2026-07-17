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
        <div className="muted small-line">
          {gh?.linked
            ? `Linked · last sync ${gh.lastSync ? new Date(gh.lastSync).toLocaleTimeString() : "never"}`
            : "Not linked. Link via desktop Settings (token stays in OS keychain)."}
        </div>
        {gh?.linked && gh.reviewQueue.length > 0 && (
          <div className="muted small-line">⚠ {gh.reviewQueue.length} conflict(s) in review queue</div>
        )}
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
      </div>
    </aside>
  );
}
