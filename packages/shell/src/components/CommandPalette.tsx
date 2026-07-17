import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { useShell } from "../lib/store";
import type { ActivityView } from "./ActivityBar";
import type { CenterTab } from "./CenterArea";

export interface PaletteCtx {
  setTab: (t: CenterTab) => void;
  setView: (v: ActivityView) => void;
  setBottomTab: (t: string) => void;
  selectCard: (id: string) => void;
  close: () => void;
}

interface ActionItem {
  kind: "action";
  label: string;
  run: (ctx: PaletteCtx) => void | Promise<void>;
}
interface CardItem { kind: "card"; id: string; label: string; key: string }
interface NoteItem { kind: "note"; label: string; path: string }
type Item = ActionItem | CardItem | NoteItem;

const ACTIONS: ActionItem[] = [
  { kind: "action", label: "Go to Office", run: (c) => c.setTab("office") },
  { kind: "action", label: "Go to Board", run: (c) => c.setTab("kanban") },
  { kind: "action", label: "Go to Executions", run: (c) => c.setView("executions") },
  { kind: "action", label: "Open Space CAD (edit office layout)", run: (c) => c.setTab("cad") },
  { kind: "action", label: "Open Connections (pair apps, vault)", run: (c) => c.setView("connect") },
  { kind: "action", label: "Show terminal", run: (c) => c.setBottomTab("terminal") },
  { kind: "action", label: "Go to Source Control", run: (c) => c.setView("scm") },
  {
    kind: "action",
    label: "Brief now (write agenda note)",
    run: async () => { await api.brief(); },
  },
  {
    kind: "action",
    label: "Refresh explorer",
    run: () => window.dispatchEvent(new CustomEvent("aura:refresh-explorer")),
  },
  { kind: "action", label: "Show problems", run: (c) => c.setBottomTab("problems") },
  { kind: "action", label: "GitHub: sync now", run: () => void api.githubSync() },
];

export function CommandPalette({ open, ctx }: { open: boolean; ctx: PaletteCtx }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const cards = useShell((s) => s.cards);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  // Vault search rides along with typed queries (debounced).
  useEffect(() => {
    if (!open || !q.trim()) return setNotes([]);
    const t = setTimeout(() => {
      api.vaultSearch(q.trim()).then((r) =>
        setNotes(r.slice(0, 6).map((n) => ({ kind: "note", label: n.title, path: n.slug }))),
      ).catch(() => setNotes([]));
    }, 150);
    return () => clearTimeout(t);
  }, [q, open]);

  const items = useMemo<Item[]>(() => {
    const query = q.trim().toLowerCase();
    const actions = query
      ? ACTIONS.filter((a) => a.label.toLowerCase().includes(query))
      : ACTIONS;
    const cardItems: CardItem[] = query
      ? cards
          .filter((c) => c.title.toLowerCase().includes(query) || c.key.toLowerCase().includes(query))
          .slice(0, 6)
          .map((c) => ({ kind: "card", id: c.id, key: c.key, label: c.title }))
      : [];
    return [...actions, ...cardItems, ...notes];
  }, [q, cards, notes]);

  useEffect(() => {
    if (sel >= items.length) setSel(Math.max(0, items.length - 1));
  }, [items.length, sel]);

  if (!open) return null;

  const runItem = (it: Item) => {
    if (it.kind === "action") void it.run(ctx);
    if (it.kind === "card") {
      ctx.setTab("kanban");
      ctx.selectCard(it.id);
    }
    // notes: no note viewer tab yet — jump to explorer where the vault lives
    if (it.kind === "note") ctx.setView("explorer");
    ctx.close();
  };

  return (
    <div className="modal-backdrop palette-backdrop" onClick={ctx.close}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          placeholder="Type a command or search vault…"
          value={q}
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === "Escape") ctx.close();
            if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, items.length - 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            if (e.key === "Enter" && items[sel]) runItem(items[sel]);
          }}
        />
        <div className="palette-results">
          {items.map((it, i) => (
            <div
              key={`${it.kind}-${it.label}-${i}`}
              className={`palette-row ${i === sel ? "selected" : ""}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => runItem(it)}
            >
              <span className="palette-kind">
                {it.kind === "action" ? "ACTION" : it.kind === "card" ? "CARD" : "NOTE"}
              </span>
              <span className="palette-label">
                {it.kind === "card" && <span className="mono-dim">{it.key} </span>}
                {it.label}
              </span>
            </div>
          ))}
          {items.length === 0 && <div className="palette-row muted">No matches</div>}
        </div>
      </div>
    </div>
  );
}
