import { KanbanWall } from "./KanbanWall";
import { Whiteboard } from "./Whiteboard";

export type CenterTab = "kanban" | "office" | "cad" | "whiteboard";

const TABS: { id: CenterTab; label: string }[] = [
  { id: "office", label: "Office" },
  { id: "kanban", label: "Kanban Wall" },
  { id: "whiteboard", label: "Whiteboard" },
  { id: "cad", label: "Space CAD" },
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
        {tab === "whiteboard" && <Whiteboard />}
        {tab === "office" && (
          <iframe className="embed-frame" src="/office.html?embed=1" title="Office" />
        )}
        {tab === "cad" && (
          <iframe className="embed-frame" src="/office.html?embed=1&cad=1" title="Space CAD" />
        )}
      </div>
    </section>
  );
}
