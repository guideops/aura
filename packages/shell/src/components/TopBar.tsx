import { useState } from "react";
import { api } from "../lib/api";

export function TopBar({
  onOpenPalette,
  onNewCard,
  onConnect,
  onProblems,
}: {
  onOpenPalette: () => void;
  onNewCard: () => void;
  onConnect: () => void;
  onProblems: () => void;
}) {
  const [briefState, setBriefState] = useState<"idle" | "busy" | "done">("idle");

  const briefNow = async () => {
    setBriefState("busy");
    try {
      await api.brief();
      setBriefState("done");
    } catch {
      setBriefState("idle");
    }
    setTimeout(() => setBriefState("idle"), 2500);
  };

  return (
    <header className="topbar">
      <div className="topbar-left">
        <span className="traffic">
          <i className="dot dot-red" />
          <i className="dot dot-yellow" />
          <i className="dot dot-green" />
        </span>
        <span className="brand">AURA</span>
        <span className="brand-sub">Agentic Unified Resource Architecture</span>
      </div>
      <div className="topbar-center">
        <button className="cmd-input" onClick={onOpenPalette}>
          <span className="cmd-placeholder">Type a command or search…</span>
          <span className="cmd-hint">Ctrl K</span>
        </button>
      </div>
      <div className="topbar-right">
        <button className="icon-btn" title="New card" onClick={onNewCard}>＋</button>
        <button className="icon-btn" title="Brief now — write agenda note to vault" onClick={() => void briefNow()}>
          {briefState === "busy" ? "…" : briefState === "done" ? "✓" : "🗎"}
        </button>
        <button className="icon-btn" title="Connections" onClick={onConnect}>👤</button>
        <button className="icon-btn" title="Problems" onClick={onProblems}>🔔</button>
      </div>
    </header>
  );
}
