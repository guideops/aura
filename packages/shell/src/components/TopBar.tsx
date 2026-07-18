import { useState } from "react";
import { api } from "../lib/api";

function PanelToggleIcon({ side, on }: { side: "left" | "right"; on: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" />
      <rect
        x={side === "left" ? 2.5 : 8.5}
        y="3.5"
        width="5"
        height="9"
        rx="0.5"
        fill={on ? "currentColor" : "none"}
        opacity={on ? 0.5 : 0.25}
        stroke="currentColor"
        strokeWidth="0.75"
      />
    </svg>
  );
}

function ThemeIcon({ theme }: { theme: "light" | "dark" }) {
  return theme === "dark" ? (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  ) : (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
        <path d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M12.8 3.2l-1.1 1.1M4.3 11.7l-1.1 1.1" />
      </g>
    </svg>
  );
}

export function TopBar({
  onOpenPalette,
  onNewCard,
  onConnect,
  onProblems,
  leftOpen,
  rightOpen,
  onToggleLeft,
  onToggleRight,
  theme,
  onToggleTheme,
}: {
  onOpenPalette: () => void;
  onNewCard: () => void;
  onConnect: () => void;
  onProblems: () => void;
  leftOpen: boolean;
  rightOpen: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
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
        <button
          className="icon-btn"
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          onClick={onToggleTheme}
        >
          <ThemeIcon theme={theme} />
        </button>
        <span className="topbar-sep" />
        <button
          className={`icon-btn panel-toggle ${leftOpen ? "on" : ""}`}
          title="Toggle sidebar (Ctrl+B)"
          onClick={onToggleLeft}
        >
          <PanelToggleIcon side="left" on={leftOpen} />
        </button>
        <button
          className={`icon-btn panel-toggle ${rightOpen ? "on" : ""}`}
          title="Toggle right rail (Ctrl+Shift+B)"
          onClick={onToggleRight}
        >
          <PanelToggleIcon side="right" on={rightOpen} />
        </button>
      </div>
    </header>
  );
}
