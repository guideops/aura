import type { ReactElement } from "react";
import { Icons } from "../lib/icons";
import { useShell } from "../lib/store";
import type { CenterTab } from "./CenterArea";

export type ActivityView = "explorer" | "search" | "scm" | "executions" | "connect";

type RailItem =
  | { kind: "view"; id: ActivityView; label: string; icon: ReactElement }
  | { kind: "tab"; tab: CenterTab; label: string; icon: ReactElement };

const ITEMS: RailItem[] = [
  { kind: "view", id: "explorer", label: "Explorer", icon: Icons.explore },
  { kind: "view", id: "search", label: "Search", icon: Icons.search },
  { kind: "tab", tab: "kanban", label: "Board", icon: Icons.board },
  { kind: "view", id: "scm", label: "Source Control", icon: Icons.source },
  { kind: "view", id: "executions", label: "Executions", icon: Icons.executions },
  { kind: "tab", tab: "cad", label: "Space CAD", icon: Icons.cad },
  { kind: "view", id: "connect", label: "Connect", icon: Icons.connect },
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
      {ITEMS.map((it) =>
        it.kind === "view" ? (
          <button
            key={it.id}
            className={`activity-item ${view === it.id ? "active" : ""}`}
            title={it.label}
            onClick={() => onSelect(it.id)}
          >
            <span className="activity-icon">{it.icon}</span>
            <span className="activity-label">{it.label}</span>
          </button>
        ) : (
          <button
            key={it.tab}
            className="activity-item"
            title={it.label}
            onClick={() => onOpenTab(it.tab)}
          >
            <span className="activity-icon">{it.icon}</span>
            <span className="activity-label">{it.label}</span>
          </button>
        ),
      )}
      <div className="activity-spacer" />
      <div className="activity-me" title={connected ? "Online" : "Offline"}>
        <span className="me-avatar">◉‿◉</span>
        <span className="me-name">AURA</span>
        <span className={`me-status ${connected ? "on" : "off"}`}>
          {connected ? "● Online" : "○ Offline"}
        </span>
      </div>
    </nav>
  );
}
