import { useMemo, useState } from "react";
import type { Card, CardStatus } from "@aura/core";
import { api } from "../lib/api";
import { agentColor, useShell } from "../lib/store";

const STATUS_LABEL: Record<CardStatus, string> = {
  triage: "Triage",
  todo: "Todo",
  ready: "Ready",
  running: "Running",
  review: "Review",
  blocked: "Blocked",
  scheduled: "Scheduled",
  done: "Done",
  archived: "Archived",
};

type CardExt = Card & {
  priority?: "low" | "medium" | "high" | "urgent";
  milestone?: string | null;
  checklist?: { id: string; text: string; done: boolean }[];
};

function relTime(ts: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

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
  const [commentText, setCommentText] = useState("");
  const [commentSubmitting, setCommentSubmitting] = useState(false);
  const [commentError, setCommentError] = useState("");

  if (!card) {
    return (
      <div className="inspector">
        <div className="panel-title">Inspector</div>
        <div className="sidebar-empty">Select a card on the Kanban Wall</div>
      </div>
    );
  }

  const checklist = card.checklist ?? [];
  const timeline = [...(card.timeline ?? [])].sort((a, b) => b.ts - a.ts);
  const visibleTimeline = timeline.slice(0, 20);
  const links = card.links ?? [];
  const parentLinks = links.filter((link) => link.rel === "parent");
  const childLinks = links.filter((link) => link.rel === "child");
  const comments = [...(card.comments ?? [])].sort((a, b) => a.ts - b.ts);
  const pendingComment = card.pendingComment?.trim() ?? "";
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

  const submitComment = async () => {
    const text = commentText.trim();
    if (!text || pendingComment || commentSubmitting) return;
    setCommentSubmitting(true);
    setCommentError("");
    try {
      await api.patchCard(card.id, { pendingComment: text });
      setCommentText("");
    } catch {
      setCommentError("Comment could not be queued for Hermes sync.");
    } finally {
      setCommentSubmitting(false);
    }
  };

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
          <dt>Progress</dt>
          <dd>{card.progress}%</dd>
          <dt>Project</dt>
          <dd>
            <input
              key={`${card.id}-${card.project ?? ""}`}
              type="text"
              defaultValue={card.project ?? ""}
              placeholder="No project"
              onBlur={(e) => {
                const project = e.target.value.trim() || null;
                if (project !== card.project) void api.patchCard(card.id, { project });
              }}
            />
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

        {timeline.length > 0 && (
          <>
            <div className="checklist-head"><span>Timeline</span></div>
            {visibleTimeline.map((entry) => (
              <div key={entry.id} className="activity-row">
                <span className="activity-time">{relTime(entry.ts)}</span>
                <span className="activity-text"><b>{entry.kind}</b> {entry.summary}</span>
              </div>
            ))}
            {timeline.length > visibleTimeline.length && (
              <div className="muted small">+{timeline.length - visibleTimeline.length} earlier</div>
            )}
          </>
        )}

        {links.length > 0 && (
          <>
            <div className="checklist-head"><span>Links</span></div>
            {parentLinks.length > 0 && (
              <>
                <div className="muted small">Parents</div>
                {parentLinks.map((link) => (
                  <div key={`parent-${link.ref}`} className="activity-row">
                    <span className="activity-text">{link.title || link.ref}</span>
                    <span className="activity-time"><code>{link.ref}</code></span>
                  </div>
                ))}
              </>
            )}
            {childLinks.length > 0 && (
              <>
                <div className="muted small">Children</div>
                {childLinks.map((link) => (
                  <div key={`child-${link.ref}`} className="activity-row">
                    <span className="activity-text">{link.title || link.ref}</span>
                    <span className="activity-time"><code>{link.ref}</code></span>
                  </div>
                ))}
              </>
            )}
          </>
        )}

        <div className="checklist-head"><span>Comments</span></div>
        {comments.map((comment) => (
          <div key={comment.id} className="activity-row">
            <span className="activity-text" style={{ whiteSpace: "pre-wrap" }}>
              <b>{comment.author ?? "agent"}</b> {comment.text}
            </span>
            <span className="activity-time">{relTime(comment.ts)}</span>
          </div>
        ))}
        <form
          className="check-add"
          onSubmit={(e) => {
            e.preventDefault();
            void submitComment();
          }}
        >
          <textarea
            placeholder="Add a comment"
            value={commentText}
            disabled={Boolean(pendingComment) || commentSubmitting}
            onChange={(e) => setCommentText(e.target.value)}
          />
          <button type="submit" disabled={Boolean(pendingComment) || commentSubmitting}>Comment</button>
        </form>
        {pendingComment && <div className="muted small">Pending sync to Hermes…</div>}
        {commentError && <div className="muted small">{commentError}</div>}

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
