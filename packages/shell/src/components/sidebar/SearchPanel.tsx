import { useMemo, useState } from "react";
import { useShell, agentColor } from "../../lib/store";
import type { CenterTab } from "../CenterArea";

/** Unified search across cards, agents, and recent events. */
export function SearchPanel({
  onOpenTab,
  onSelectCard,
}: {
  onOpenTab: (t: CenterTab) => void;
  onSelectCard: (id: string | null) => void;
}) {
  const [q, setQ] = useState("");
  const cards = useShell((s) => s.cards);
  const agents = useShell((s) => s.agents);
  const events = useShell((s) => s.events);

  const query = q.trim().toLowerCase();
  const results = useMemo(() => {
    if (!query) return null;
    const cardHits = cards.filter(
      (c) =>
        c.title.toLowerCase().includes(query) ||
        c.key.toLowerCase().includes(query) ||
        c.body.toLowerCase().includes(query) ||
        c.tags.some((t) => t.toLowerCase().includes(query)),
    ).slice(0, 15);
    const agentHits = agents.filter((a) => a.agentId.toLowerCase().includes(query));
    const eventHits = events
      .filter((e) => e.summary.toLowerCase().includes(query) || e.type.includes(query))
      .slice(-15)
      .reverse();
    return { cardHits, agentHits, eventHits };
  }, [query, cards, agents, events]);

  return (
    <aside className="sidebar">
      <div className="panel-title">Search</div>
      <div className="sidebar-pad">
        <input
          autoFocus
          className="w-full"
          placeholder="Search cards, agents, events…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {!results && <div className="sidebar-empty">Type to search the workspace.</div>}
      {results && (
        <div className="search-results">
          {results.cardHits.length > 0 && <div className="tree-section">CARDS</div>}
          {results.cardHits.map((c) => (
            <div
              key={c.id}
              className="tree-item indent-1 clickable"
              onClick={() => {
                onOpenTab("kanban");
                onSelectCard(c.id);
              }}
            >
              <span className="mono-dim">{c.key}</span>
              <span className="tree-name">{c.title}</span>
            </div>
          ))}
          {results.agentHits.length > 0 && <div className="tree-section">AGENTS</div>}
          {results.agentHits.map((a) => (
            <div key={a.agentId} className="tree-item indent-1">
              <i className="avatar-dot" style={{ background: agentColor(a.agentId) }} />
              <span className="tree-name">{a.agentId}</span>
              <span className="muted">{a.status}</span>
            </div>
          ))}
          {results.eventHits.length > 0 && <div className="tree-section">EVENTS</div>}
          {results.eventHits.map((e) => (
            <div key={e.id} className="tree-item indent-1" title={e.summary}>
              <span className="mono-dim">{new Date(e.ts).toLocaleTimeString()}</span>
              <span className="tree-name">{e.summary || e.type}</span>
            </div>
          ))}
          {results.cardHits.length + results.agentHits.length + results.eventHits.length === 0 && (
            <div className="sidebar-empty">No matches.</div>
          )}
        </div>
      )}
    </aside>
  );
}
