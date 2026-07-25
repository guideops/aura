import { useRef, useState } from "react";
import type { ActivityView } from "./ActivityBar";
import type { CenterTab } from "./CenterArea";
import { Explorer } from "./Explorer";
import { Inspector } from "./Inspector";
import { KanbanWall } from "./KanbanWall";
import { Whiteboard } from "./Whiteboard";

const VIEWS: { id: CenterTab; label: string; icon: string }[] = [
  { id: "office", label: "Office", icon: "🏢" },
  { id: "kanban", label: "Kanban", icon: "📋" },
  { id: "whiteboard", label: "Whiteboard", icon: "🖊️" },
  { id: "cad", label: "Space CAD", icon: "📐" },
];

const DRAWER_TABS: { id: ActivityView; label: string }[] = [
  { id: "explorer", label: "Files" },
  { id: "scm", label: "Git" },
  { id: "executions", label: "Runs" },
  { id: "connect", label: "Connect" },
];

export function MobileShell({
  tab,
  onSelectTab,
  selectedCard,
  onSelectCard,
  theme,
  onToggleTheme,
  onNewCard,
  onExitSimple,
}: {
  tab: CenterTab;
  onSelectTab: (t: CenterTab) => void;
  selectedCard: string | null;
  onSelectCard: (id: string | null) => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onNewCard: () => void;
  onExitSimple: () => void;
}) {
  const [fabOpen, setFabOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerView, setDrawerView] = useState<ActivityView>("explorer");
  const touchStart = useRef<number | null>(null);
  const sheetTouchStart = useRef<number | null>(null);

  const pick = (t: CenterTab) => {
    onSelectTab(t);
    setFabOpen(false);
  };

  // Swipe up on the handle opens the drawer, swipe down closes it; a plain
  // tap (no meaningful vertical travel) falls through to the click toggle.
  const onHandleTouchStart = (e: React.TouchEvent) => {
    touchStart.current = e.touches[0]?.clientY ?? null;
  };
  const onHandleTouchEnd = (e: React.TouchEvent) => {
    const start = touchStart.current;
    touchStart.current = null;
    const end = e.changedTouches[0]?.clientY;
    if (start == null || end == null) return;
    const dy = end - start;
    if (dy < -24) setDrawerOpen(true);
    else if (dy > 24) setDrawerOpen(false);
  };

  const label = VIEWS.find((v) => v.id === tab)?.label ?? "";

  return (
    <div className="m-shell">
      <header className="m-topbar">
        <span className="brand">AURA</span>
        <span className="m-view-label">{label}</span>
        <button className="icon-btn" onClick={onToggleTheme} title="Toggle theme">
          {theme === "dark" ? "☀️" : "🌙"}
        </button>
      </header>
      <main className="m-body">
        {tab === "kanban" && (
          <KanbanWall selectedCard={selectedCard} onSelectCard={onSelectCard} />
        )}
        {tab === "whiteboard" && <Whiteboard />}
        {tab === "office" && (
          <iframe className="embed-frame" src="/office.html?embed=1" title="Office" />
        )}
        {tab === "cad" && (
          <iframe className="embed-frame" src="/office.html?embed=1&cad=1" title="Space CAD" />
        )}
      </main>

      {fabOpen && <div className="m-fab-scrim" onClick={() => setFabOpen(false)} />}
      <div className={`m-fab-menu ${fabOpen ? "open" : ""}`}>
        {VIEWS.filter((v) => v.id !== tab).map((v) => (
          <button key={v.id} className="m-fab-item" onClick={() => pick(v.id)}>
            <span className="m-fab-icon">{v.icon}</span> {v.label}
          </button>
        ))}
        <button
          className="m-fab-item"
          onClick={() => {
            setFabOpen(false);
            onNewCard();
          }}
        >
          <span className="m-fab-icon">＋</span> New Card
        </button>
        <button className="m-fab-item m-fab-exit" onClick={onExitSimple}>
          <span className="m-fab-icon">🖥️</span> Full view
        </button>
      </div>
      <button
        className="m-fab"
        onClick={() => setFabOpen((o) => !o)}
        aria-label="Switch view"
        aria-expanded={fabOpen}
      >
        {fabOpen ? "✕" : "⊞"}
      </button>

      {selectedCard && (
        <>
          <div className="m-sheet-scrim" onClick={() => onSelectCard(null)} />
          <div className="m-card-sheet">
            <div
              className="m-drawer-handle"
              onClick={() => onSelectCard(null)}
              onTouchStart={(e) => {
                sheetTouchStart.current = e.touches[0]?.clientY ?? null;
              }}
              onTouchEnd={(e) => {
                const start = sheetTouchStart.current;
                sheetTouchStart.current = null;
                const end = e.changedTouches[0]?.clientY;
                if (start != null && end != null && end - start > 24) onSelectCard(null);
              }}
            >
              <span className="m-drawer-grip" />
            </div>
            <div className="m-card-sheet-body">
              <Inspector cardId={selectedCard} onClose={() => onSelectCard(null)} />
            </div>
          </div>
        </>
      )}

      <div className={`m-drawer ${drawerOpen ? "open" : ""}`}>
        <div
          className="m-drawer-handle"
          onClick={() => setDrawerOpen((o) => !o)}
          onTouchStart={onHandleTouchStart}
          onTouchEnd={onHandleTouchEnd}
        >
          <span className="m-drawer-grip" />
        </div>
        {drawerOpen && (
          <>
            <div className="m-drawer-tabs">
              {DRAWER_TABS.map((t) => (
                <button
                  key={t.id}
                  className={`m-drawer-tab ${drawerView === t.id ? "active" : ""}`}
                  onClick={() => setDrawerView(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="m-drawer-body">
              <Explorer
                view={drawerView}
                onOpenTab={(t) => {
                  onSelectTab(t);
                  setDrawerOpen(false);
                }}
                onSelectCard={onSelectCard}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
