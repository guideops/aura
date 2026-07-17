import { useMemo, useState } from "react";
import type { Card, CardStatus } from "@aura/core";
import { api } from "../lib/api";
import { agentColor, useShell } from "../lib/store";

const STATUS_LABEL: Record<CardStatus, string> = {
  backlog: "To Do",
  in_progress: "In Progress",
  review: "In Review",
  done: "Done",
};

type CardExt = Card & {
  priority?: "low" | "medium" | "high" | "urgent";
  milestone?: string | null;
  checklist?: { id: string; text: string; done: boolean }[];
};

export function Inspector({
  cardId,
  onClose,
}: {
  cardId: string | null;
  onClose: () => void;
}) {
  const cards = useShell((s) => s.cards);
  const events = useShell((s) => s.events);
  const cardActivity = useShell((s) => s.cardActivity);
  const card = useMemo(
    () => (cardId ? (cards.find((c) => c.id === cardId) as CardExt | undefined) : undefined),
    [cards, cardId],
  );
  const [newItem, setNewItem] = useState("");

  if (!card) {
    return (
      <div className="inspector">
        <div className="panel-title">Inspector</div>
        <div className="sidebar-empty">Select a card on the Kanban Wall</div>
      </div>
    );
  }

  const checklist = card.checklist ?? [];
  const eventActivity = events
    .filter(
      (e) =>
        (card.sessionId && e.sessionId === card.sessionId) ||
        (card.assignee && e.agentId === card.assignee),
    )
    .slice(-4)
    .map((e) => ({ ts: e.ts, agentId: e.agentId, text: e.summary || e.type }));
  const boardActivity = (cardActivity[card.id] ?? []).map((a) => ({
    ts: a.ts,
    agentId: card.assignee ?? "operator",
    text: a.text,
  }));
  const activity = [...eventActivity, ...boardActivity].sort((a, b) => b.ts - a.ts).slice(0, 8);

  const patchChecklist = (items: { id: string; text: string; done: boolean }[]) =>
    void api.patchCard(card.id, { checklist: items } as Partial<Card>);

  return (
    <div className="inspector">
      <div className="panel-title">
        {card.key}
        <span className="insp-actions">
          <span className="clickable" title="Copy card key" onClick={() => void navigator.clipboard.writeText(card.key).catch(() => {})}>🔗</span>
          <span className="clickable" title="Delete card" onClick={() => { if (confirm(`Delete ${card.key}?`)) { void api.deleteCard(card.id); onClose(); } }}>🗑</span>
          <span className="clickable" title="Close" onClick={onClose}>✕</span>
        </span>
      </div>
      <div className="inspector-body">
        <h3 className="inspector-title">{card.title}</h3>
        <dl className="props">
          <dt>Status</dt>
          <dd>
            <select
              value={card.status}
              onChange={(e) => void api.patchCard(card.id, { status: e.target.value as CardStatus })}
            >
              {Object.entries(STATUS_LABEL).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </dd>
          <dt>Assignee</dt>
          <dd>
            <i className="avatar-dot" style={{ background: agentColor(card.assignee) }} />
            {card.assignee ?? "unassigned"}
          </dd>
          <dt>Labels</dt>
          <dd className="card-tags">
            {card.tags.length ? card.tags.map((t) => <span key={t} className={`tag tag-${t}`}>{t}</span>) : "—"}
          </dd>
          <dt>Milestone</dt>
          <dd>{card.milestone ?? "—"}</dd>
          <dt>Priority</dt>
          <dd>
            <select
              value={card.priority ?? "medium"}
              onChange={(e) => void api.patchCard(card.id, { priority: e.target.value } as Partial<Card>)}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">↑ High</option>
              <option value="urgent">‼ Urgent</option>
            </select>
          </dd>
          <dt>Description</dt>
          <dd className="desc">{card.body || "—"}</dd>
        </dl>

        <div className="checklist-head">
          <span>Checklist {checklist.length ? `${checklist.filter((i) => i.done).length} / ${checklist.length}` : ""}</span>
          {checklist.length > 0 && (
            <div className="progress-track slim">
              <div
                className="progress-fill"
                style={{ width: `${(checklist.filter((i) => i.done).length / checklist.length) * 100}%` }}
              />
            </div>
          )}
        </div>
        {checklist.map((item) => (
          <label key={item.id} className="check-item">
            <input
              type="checkbox"
              checked={item.done}
              onChange={() =>
                patchChecklist(checklist.map((i) => (i.id === item.id ? { ...i, done: !i.done } : i)))
              }
            />
            <span className={item.done ? "done" : ""}>{item.text}</span>
          </label>
        ))}
        <div className="check-add">
          <input
            placeholder="Add checklist item"
            value={newItem}
            onChange={(e) => setNewItem(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newItem.trim()) {
                patchChecklist([
                  ...checklist,
                  { id: crypto.randomUUID(), text: newItem.trim(), done: false },
                ]);
                setNewItem("");
              }
            }}
          />
        </div>

        <div className="checklist-head"><span>Activity</span></div>
        {activity.length === 0 && <div className="muted small">No recent activity</div>}
        {activity.map((e, i) => (
          <div key={`${e.ts}-${i}`} className="activity-row">
            <i className="avatar-dot" style={{ background: agentColor(e.agentId) }} />
            <span className="activity-text">
              <b>{e.agentId}</b> {e.text}
            </span>
            <span className="activity-time">{new Date(e.ts).toLocaleTimeString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
