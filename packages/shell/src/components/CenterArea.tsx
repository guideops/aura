import { KanbanWall } from "./KanbanWall";

export type CenterTab = "kanban" | "office" | "cad";

const TABS: { id: CenterTab; label: string }[] = [
  { id: "kanban", label: "Kanban Wall" },
  { id: "office", label: "Office" },
  { id: "cad", label: "Spatial CAD" },
];

export function CenterArea({
  tab,
  onSelectTab,
  selectedCard,
  onSelectCard,
}: {
  tab: CenterTab;
  onSelectTab: (t: CenterTab) => void;
  selectedCard: string | null;
  onSelectCard: (id: string | null) => void;
}) {
  return (
    <section className="center-area">
      <div className="center-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`center-tab ${tab === t.id ? "active" : ""}`}
            onClick={() => onSelectTab(t.id)}
          >
            {t.label}
            {t.id === "kanban" && <span className="tab-live">● Active</span>}
          </button>
        ))}
      </div>
      <div className="center-body">
        {tab === "kanban" && (
          <KanbanWall selectedCard={selectedCard} onSelectCard={onSelectCard} />
        )}
        {tab === "office" && (
          <iframe className="embed-frame" src="/office.html" title="Office" />
        )}
        {tab === "cad" && (
          <iframe className="embed-frame" src="/office.html?cad=1" title="Spatial CAD" />
        )}
      </div>
    </section>
  );
}
