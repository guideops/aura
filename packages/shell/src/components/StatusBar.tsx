import { useEffect, useState } from "react";
import { useShell } from "../lib/store";

export function StatusBar() {
  const connected = useShell((s) => s.connected);
  const events = useShell((s) => s.events);
  const agents = useShell((s) => s.agents);
  const errors = events.filter((e) => e.type === "system.error").length;
  const warns = events.filter((e) => e.type === "tool.deny" || e.type === "context.warn").length;
  const [branch, setBranch] = useState<string>("");

  useEffect(() => {
    fetch("/api/workspace/git")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { branch?: string; dirty?: boolean } | null) => {
        if (d?.branch) setBranch(d.branch + (d.dirty ? "*" : ""));
      })
      .catch(() => {});
  }, []);

  return (
    <footer className="status-bar">
      <div className="sb-left">
        {branch && <span className="sb-item">⎇ {branch}</span>}
        <span className="sb-item">ⓘ {agents.length}</span>
        <span className="sb-item">⚠ {warns}</span>
        <span className="sb-item">⊗ {errors}</span>
      </div>
      <div className="sb-right">
        <span className="sb-item">Spaces: 2</span>
        <span className="sb-item">UTF-8</span>
        <span className="sb-item">LF</span>
        <span className="sb-item">YAML</span>
        <span className={`sb-item sb-conn ${connected ? "on" : "off"}`}>
          ● AURA: {connected ? "Connected" : "Disconnected"}
        </span>
        <span className="sb-item">🔔</span>
      </div>
    </footer>
  );
}
