import { useEffect, useMemo, useState } from "react";
import type { Card, CardStatus } from "@aura/core";
import { api } from "../lib/api";
import { agentColor, setCards, useShell } from "../lib/store";

const COLUMNS: { status: CardStatus; title: string; tone: string }[] = [
  { status: "triage", title: "Triage", tone: "tone-slate" },
  { status: "todo", title: "Todo", tone: "tone-slate" },
  { status: "ready", title: "Ready", tone: "tone-blue" },
  { status: "running", title: "Running", tone: "tone-blue" },
  { status: "review", title: "Review", tone: "tone-amber" },
  { status: "blocked", title: "Blocked", tone: "tone-amber" },
  { status: "scheduled", title: "Scheduled", tone: "tone-slate" },
  { status: "done", title: "Done", tone: "tone-green" },
];

type SortMode = "manual" | "updated" | "title" | "progress";
type GroupMode = "status" | "assignee" | "tag" | "project";

const BLOCK_KIND_LABEL: Record<NonNullable<Card["blockKind"]>, string> = {
  needs_input: "needs you",
  dependency: "waiting on task",
  capability: "missing capability",
  transient: "transient",
};

export function isLegalMove(from: CardStatus, to: CardStatus): boolean {
  if (from === to) return false;
  if (to === "done") return from !== "done";
  if (to === "blocked") return from !== "blocked";
  if (from === "blocked" && (to === "todo" || to === "ready")) return true;
  if (from === "todo" && to === "ready") return true;
  return (from === "todo" || from === "ready") && to === "scheduled";
}

export function KanbanWall({
  selectedCard,
  onSelectCard,
}: {
  selectedCard: string | null;
  onSelectCard: (id: string | null) => void;
}) {
  const cards = useShell((s) => s.cards);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortMode>("updated");
  const [group, setGroup] = useState<GroupMode>("status");
  const [showNew, setShowNew] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [rejected, setRejected] = useState<{ id: string; hint: string } | null>(null);
  const [repo, setRepo] = useState<string | null>(null);

  useEffect(() => {
    api.listCards().then(setCards).catch(() => {});
    api.githubStatus().then((s) => setRepo(s.linked ? "linked" : null)).catch(() => {});
    const w = window as unknown as Record<string, unknown>;
    if (w.__auraNewCard) {
      w.__auraNewCard = false;
      setShowNew(true);
    }
    const onNew = () => {
      w.__auraNewCard = false;
      setShowNew(true);
    };
    window.addEventListener("aura:new-card", onNew);
    return () => window.removeEventListener("aura:new-card", onNew);
  }, []);

  const visible = useMemo(() => {
    let out = cards;
    const q = filter.trim().toLowerCase();
    if (q) {
      out = out.filter(
        (c) =>
          c.title.toLowerCase().includes(q) ||
          c.key.toLowerCase().includes(q) ||
          c.tags.some((t) => t.toLowerCase().includes(q)) ||
          (c.assignee ?? "").toLowerCase().includes(q),
      );
    }
    const sorted = [...out];
    if (sort === "updated") sorted.sort((a, b) => b.updatedAt - a.updatedAt);
    if (sort === "title") sorted.sort((a, b) => a.title.localeCompare(b.title));
    if (sort === "progress") sorted.sort((a, b) => b.progress - a.progress);
    return sorted;
  }, [cards, filter, sort]);

  const drop = (status: CardStatus) => {
    if (!dragId) return;
    const card = cards.find((c) => c.id === dragId);
    setDragId(null);
    if (!card || card.status === status) return;
    if (card.externalRef?.startsWith("hermes:") && !isLegalMove(card.status, status)) {
      const hint = `No Hermes verb for ${card.status} → ${status}`;
      setRejected({ id: card.id, hint });
      window.setTimeout(() => setRejected((current) => current?.id === card.id ? null : current), 600);
      return;
    }
    void api.patchCard(card.id, { status });
  };

  const draggedCard = dragId ? cards.find((card) => card.id === dragId) : undefined;

  return (
    <div className="kanban">
      <div className="kanban-toolbar">
        <div className="kanban-meta">
          <span className="meta-line">Repository: {repo ?? "not linked"}</span>
          <span className="meta-line">Project: AURA</span>
        </div>
        <div className="kanban-actions">
          <input
            className="filter-input"
            placeholder="Filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <select
            className="sort-select"
            value={group}
            onChange={(e) => setGroup(e.target.value as GroupMode)}
            title="Group"
          >
            <option value="status">Group: Status</option>
            <option value="assignee">Group: Assignee</option>
            <option value="tag">Group: Tag</option>
            <option value="project">Group: Project</option>
          </select>
          <select
            className="sort-select"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortMode)}
            title="Sort"
          >
            <option value="updated">Sort: Updated</option>
            <option value="title">Sort: Title</option>
            <option value="progress">Sort: Progress</option>
          </select>
          <button className="btn-primary" onClick={() => setShowNew(true)}>
            ＋ New Card
          </button>
        </div>
      </div>
      <div className="kanban-columns">
        {buildColumns(group, visible).map((col) => {
          const illegalTarget = Boolean(
            col.status && draggedCard?.externalRef?.startsWith("hermes:")
            && !isLegalMove(draggedCard.status, col.status),
          );
          const dragHint = illegalTarget && col.status
            ? `No Hermes verb for ${draggedCard!.status} → ${col.status}`
            : undefined;
          return (
          <div
            key={col.key}
            className={`kanban-col ${col.tone}`}
            style={illegalTarget ? { opacity: 0.48, filter: "grayscale(0.5)" } : undefined}
            title={dragHint}
            aria-disabled={illegalTarget || undefined}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => col.status && drop(col.status)}
          >
            <div className="col-head">
              <span className="col-title">{col.title}</span>
              <span className="col-count">{col.cards.length}</span>
            </div>
            <div className="col-cards">
              {col.cards.map((card) => (
                <CardTile
                  key={card.id}
                  card={card}
                  selected={card.id === selectedCard}
                  rejectedHint={rejected?.id === card.id ? rejected.hint : undefined}
                  onSelect={() => onSelectCard(card.id === selectedCard ? null : card.id)}
                  onDragStart={() => setDragId(card.id)}
                />
              ))}
              <button className="add-card" onClick={() => setShowNew(true)}>
                ＋ Add Card
              </button>
            </div>
          </div>
          );
        })}
      </div>
      {showNew && <NewCardModal onClose={() => setShowNew(false)} />}
    </div>
  );
}

interface ColumnDef {
  key: string;
  title: string;
  tone: string;
  /** Set when the column maps to a card status (enables drag-drop moves). */
  status?: CardStatus;
  cards: Card[];
}

function buildColumns(group: GroupMode, cards: Card[]): ColumnDef[] {
  if (group === "status") {
    return COLUMNS.map((c) => ({
      key: c.status,
      title: c.title,
      tone: c.tone,
      status: c.status,
      cards: cards.filter((x) => x.status === c.status),
    }));
  }
  const keyOf = (c: Card) => {
    if (group === "assignee") return c.assignee ?? "unassigned";
    if (group === "project") return c.project ?? "No project";
    return c.tags[0] ?? "untagged";
  };
  const keys = [...new Set(cards.map(keyOf))].sort();
  return keys.map((k) => ({
    key: k,
    title: k,
    tone: "tone-slate",
    cards: cards.filter((c) => keyOf(c) === k),
  }));
}

function CardTile({
  card,
  selected,
  rejectedHint,
  onSelect,
  onDragStart,
}: {
  card: Card;
  selected: boolean;
  rejectedHint: string | undefined;
  onSelect: () => void;
  onDragStart: () => void;
}) {
  const c = card as Card & { checklist?: { done: boolean }[] };
  const checklist = c.checklist ?? [];
  const done = card.status === "done";
  return (
    <div
      className={`card-tile ${selected ? "selected" : ""}`}
      style={rejectedHint ? {
        transform: "translateX(5px)",
        boxShadow: "0 0 0 2px var(--danger, #ef4444)",
        background: "color-mix(in srgb, var(--danger, #ef4444) 12%, transparent)",
        transition: "all 80ms ease",
      } : undefined}
      title={rejectedHint}
      aria-label={rejectedHint ? `${card.key}: ${rejectedHint}` : undefined}
      draggable
      onDragStart={onDragStart}
      onClick={onSelect}
    >
      <div className="card-key">{card.key}</div>
      <div className="card-title">{card.title}</div>
      {card.tags.length > 0 && (
        <div className="card-tags">
          {card.tags.map((t) => (
            <span key={t} className={`tag tag-${t}`}>{t}</span>
          ))}
        </div>
      )}
      <div className="card-foot">
        <span className="card-assignee">
          <i className="avatar-dot" style={{ background: agentColor(card.assignee) }} />
          {card.assignee ?? "unassigned"}
        </span>
        {card.status === "review" && <span className="badge-review">Review</span>}
        {card.status === "blocked" && card.blockKind && (
          <span className={card.blockKind === "needs_input" ? "badge-review" : "card-checks"}>
            {BLOCK_KIND_LABEL[card.blockKind]}
          </span>
        )}
        {done && <span className="badge-done">✓ Done</span>}
        {checklist.length > 0 && (
          <span className="card-checks">
            ☑ {checklist.filter((i) => i.done).length}/{checklist.length}
          </span>
        )}
      </div>
      {card.status === "running" && (
        <div className="card-progress">
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{ width: `${card.progress}%`, background: agentColor(card.assignee) }}
            />
          </div>
          <span className="progress-pct">{card.progress}%</span>
        </div>
      )}
    </div>
  );
}

function NewCardModal({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState("");

  const create = async () => {
    if (!title.trim()) return;
    await api.createCard({
      title: title.trim(),
      body,
      tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
    });
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>New Card</h3>
        <input
          autoFocus
          placeholder="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void create()}
        />
        <textarea
          placeholder="Description"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <input
          placeholder="Tags (comma-separated)"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={() => void create()}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
