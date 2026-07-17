import { useShell } from "../lib/store";
import type { CenterTab } from "./CenterArea";

export type ActivityView = "explorer" | "search" | "scm" | "cad" | "extensions";

const ITEMS: { id: ActivityView; label: string; icon: string; tab?: CenterTab }[] = [
  { id: "explorer", label: "Explorer", icon: "🗂" },
  { id: "search", label: "Search", icon: "🔍" },
  { id: "scm", label: "Source Control", icon: "⎇" },
  { id: "cad", label: "Spatial CAD", icon: "◈", tab: "cad" },
  { id: "extensions", label: "Extensions", icon: "▦" },
];

export function ActivityBar({
  view,
  onSelect,
  onOpenTab,
}: {
  view: ActivityView;
  onSelect: (v: ActivityView) => void;
  onOpenTab: (t: CenterTab) => void;
}) {
  const connected = useShell((s) => s.connected);
  return (
    <nav className="activity-bar">
      {ITEMS.map((it) => (
        <button
          key={it.id}
          className={`activity-item ${view === it.id ? "active" : ""}`}
          title={it.label}
          onClick={() => {
            onSelect(it.id);
            if (it.tab) onOpenTab(it.tab);
          }}
        >
          <span className="activity-icon">{it.icon}</span>
          <span className="activity-label">{it.label}</span>
        </button>
      ))}
      <div className="activity-spacer" />
      <div className="activity-me" title={connected ? "Online" : "Offline"}>
        <span className="me-avatar">🤖</span>
        <span className="me-name">AURA</span>
        <span className={`me-status ${connected ? "on" : "off"}`}>
          {connected ? "● Online" : "○ Offline"}
        </span>
      </div>
    </nav>
  );
}
