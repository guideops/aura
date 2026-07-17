import { useCallback, useEffect, useState } from "react";
import { api, type GithubStatus, type PeerInfo } from "../../lib/api";
import { useShell } from "../../lib/store";

export function ConnectPanel() {
  const wsPeers = useShell((s) => s.peers);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [code, setCode] = useState<string | null>(null);
  const [ttl, setTtl] = useState(0);
  const [vaultDir, setVaultDir] = useState("");
  const [newDir, setNewDir] = useState("");
  const [gh, setGh] = useState<GithubStatus | null>(null);
  const [hermes, setHermes] = useState(false);

  const refresh = useCallback(() => {
    api.pairStatus().then((d) => setPeers(d.peers)).catch(() => {});
    api.vaultDir().then((d) => setVaultDir(d.dir)).catch(() => {});
    api.githubStatus().then(setGh).catch(() => {});
    api.hermesStatus().then((d) => setHermes(d.enabled)).catch(() => {});
  }, []);

  useEffect(() => refresh(), [refresh]);
  useEffect(() => {
    if (wsPeers.length) setPeers(wsPeers as PeerInfo[]);
  }, [wsPeers]);

  useEffect(() => {
    if (ttl <= 0) return;
    const t = setTimeout(() => setTtl((s) => s - 1), 1000);
    if (ttl === 1) setCode(null);
    return () => clearTimeout(t);
  }, [ttl]);

  const adoptable = peers.find((p) => p.vaultPath && p.vaultPath !== vaultDir);

  return (
    <aside className="sidebar">
      <div className="panel-title">
        Connect
        <span className="panel-title-actions clickable" onClick={refresh} title="Refresh">↻</span>
      </div>

      <div className="conn-card">
        <div className="conn-head">
          <span>Agentic Workspace</span>
          <span className={`conn-state ${peers.length ? "on" : ""}`}>
            {peers.length ? "Paired" : "Not linked"}
          </span>
        </div>
        {peers.map((p) => (
          <div key={p.id} className="peer-row">
            <div>
              <div className="tree-name">{p.name}</div>
              <div className="muted small-line">
                last seen {new Date(p.lastSeenAt).toLocaleTimeString()}
              </div>
            </div>
            <button className="btn-secondary" onClick={async () => { await api.pairRevoke(p.id); refresh(); }}>
              Revoke
            </button>
          </div>
        ))}
        {code && (
          <div className="pair-code-wrap">
            <div className="pair-code">{code}</div>
            <div className="muted small-line">
              Enter in Agentic Workspace → Connect AURA. Expires in {ttl}s.
            </div>
          </div>
        )}
        <button
          className="btn-primary"
          onClick={async () => {
            const d = await api.pairStart();
            setCode(d.code);
            setTtl(Math.max(1, Math.round((d.expiresAt - Date.now()) / 1000)));
          }}
        >
          Generate pairing code
        </button>
      </div>

      <div className="conn-card">
        <div className="conn-head">
          <span>Obsidian Vault</span>
          <span className="conn-state on">Connected</span>
        </div>
        <code className="conn-path" title={vaultDir}>{vaultDir || "—"}</code>
        <div className="row-gap">
          <input placeholder="new folder path…" value={newDir} onChange={(e) => setNewDir(e.target.value)} />
          <button
            className="btn-secondary"
            onClick={async () => {
              if (!newDir.trim()) return;
              await api.setVaultDir(newDir.trim());
              setNewDir("");
              refresh();
            }}
          >
            Change
          </button>
        </div>
        {adoptable && (
          <button
            className="btn-primary"
            onClick={async () => {
              await api.setVaultDir(adoptable.vaultPath!);
              refresh();
            }}
          >
            Adopt {adoptable.name}'s vault
          </button>
        )}
      </div>

      <div className="conn-card">
        <div className="conn-head">
          <span>GitHub Projects</span>
          <span className={`conn-state ${gh?.linked ? "on" : ""}`}>{gh?.linked ? "Linked" : "Not linked"}</span>
        </div>
        <div className="muted small-line">Link via desktop Settings (token stays in OS keychain).</div>
        <div className="row-gap">
          <button className="btn-secondary" disabled={!gh?.linked} onClick={() => void api.githubSync()}>Sync now</button>
          {gh?.linked && (
            <button className="btn-secondary" onClick={async () => { await api.githubUnlink(); refresh(); }}>Unlink</button>
          )}
        </div>
      </div>

      <div className="conn-card">
        <div className="conn-head">
          <span>Hermes API (fallback)</span>
          <span className={`conn-state ${hermes ? "on" : ""}`}>{hermes ? "On" : "Off"}</span>
        </div>
        <div className="muted small-line">
          Direct one-off runs. Orchestration belongs to Agentic Workspace. Enable with <code>AURA_HERMES_KEY</code>.
        </div>
      </div>
    </aside>
  );
}
