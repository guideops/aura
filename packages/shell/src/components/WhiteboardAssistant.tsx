import { useEffect, useState } from "react";
import type { CanvasActivity } from "@aura/core";
import { api } from "../lib/api";
import { agentColor, useShell } from "../lib/store";
import { useWb, wbRefresh } from "../lib/whiteboard-store";

const AI_ACTIONS: { key: string; label: string; sub: string; needsHermes: boolean }[] = [
  { key: "generate-diagram", label: "Generate Diagram", sub: "Create a flowchart from this content", needsHermes: true },
  { key: "expand", label: "Expand Notes", sub: "Elaborate and structure this section", needsHermes: true },
  { key: "summarize", label: "Summarize", sub: "Summarize key points", needsHermes: true },
  { key: "convert-to-prd", label: "Convert to PRD", sub: "Create a PRD note from this board", needsHermes: false },
  { key: "create-tasks", label: "Create Tasks", sub: "Break selection into kanban cards", needsHermes: false },
];

/**
 * Right-rail AI Assistant for the whiteboard tab (reference S1): context of
 * the open board + selection, Ask AI, AI actions, related agents, activity.
 */
export function WhiteboardAssistant() {
  const canvasId = useWb((s) => s.canvasId);
  const canvasName = useWb((s) => s.canvasName);
  const selection = useWb((s) => s.selection);
  const refreshTick = useWb((s) => s.refreshTick);
  const agents = useShell((s) => s.agents);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [activity, setActivity] = useState<CanvasActivity[]>([]);
  const [hermes, setHermes] = useState(false);

  useEffect(() => { api.hermesStatus().then((s) => setHermes(s.enabled)).catch(() => {}); }, []);
  useEffect(() => {
    if (!canvasId) { setActivity([]); return; }
    api.canvasActivity(canvasId).then(setActivity).catch(() => {});
  }, [canvasId, refreshTick, busy]);

  const run = async (action: string, withPrompt = false) => {
    if (!canvasId || busy) return;
    setBusy(action);
    setNote(null);
    try {
      const res = await api.canvasAi(canvasId, {
        action,
        ...(withPrompt && prompt.trim() ? { prompt: prompt.trim() } : {}),
        ...(selection.length ? { nodeIds: selection } : {}),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; cards?: unknown[]; slug?: string };
      if (!res.ok) setNote(body.error ?? `failed (${res.status})`);
      else if (action === "create-tasks") setNote(`Created ${body.cards?.length ?? 0} card(s) on the Kanban Wall.`);
      else if (action === "convert-to-prd") setNote(`PRD written to vault: ${body.slug}`);
      else setNote("Done — added to the board.");
      if (withPrompt) setPrompt("");
      wbRefresh();
    } catch {
      setNote("Daemon unreachable.");
    } finally {
      setBusy(null);
    }
  };

  if (!canvasId) {
    return (
      <div className="widget">
        <div className="panel-title">AI Assistant</div>
        <div className="widget-body muted">Open or create a whiteboard to use AI actions.</div>
      </div>
    );
  }

  return (
    <>
      <div className="widget">
        <div className="panel-title">AI Assistant</div>
        <div className="widget-body">
          <div className="wb-ctx">
            <div className="wb-ctx-row">🗂 {canvasName || "Whiteboard"}</div>
            <div className="wb-ctx-row muted">
              {selection.length ? `${selection.length} object(s) selected` : "Whole board as context"}
            </div>
          </div>
          <div className="wb-ask">
            <input
              placeholder="Ask anything about this board…"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void run("ask", true); }}
              disabled={!hermes || busy !== null}
            />
            <button className="wb-ask-send" onClick={() => void run("ask", true)} disabled={!hermes || busy !== null}>➤</button>
          </div>
          {!hermes && <div className="muted small-line">Hermes not configured — set AURA_HERMES_KEY for Ask AI / generation.</div>}
          {note && <div className="wb-ai-note">{note}</div>}
        </div>
      </div>

      <div className="widget">
        <div className="panel-title">AI Actions</div>
        <div className="zone-actions">
          {AI_ACTIONS.map((a) => (
            <button
              key={a.key}
              className="zone-action"
              disabled={busy !== null || (a.needsHermes && !hermes)}
              onClick={() => void run(a.key)}
            >
              <span className="zone-action-label">{busy === a.key ? "Working…" : a.label}</span>
              <span className="zone-action-sub">{a.sub}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="widget">
        <div className="panel-title">Related Agents</div>
        <div className="widget-body">
          {agents.length === 0 && <div className="muted small-line">No agents online.</div>}
          {agents.slice(0, 6).map((a) => (
            <div key={a.agentId} className="usage-row">
              <i className="avatar-dot" style={{ background: agentColor(a.agentId) }} />
              <span className="usage-model">{a.agentId}</span>
              <span className="usage-amt">{a.status}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="widget">
        <div className="panel-title">Activity</div>
        <div className="widget-body wb-activity">
          {activity.length === 0 && <div className="muted small-line">No activity yet.</div>}
          {activity.slice(0, 12).map((a) => (
            <div key={a.id} className="wb-activity-row">
              <i className="avatar-dot" style={{ background: agentColor(a.actor) }} />
              <span className="wb-activity-text">
                <b>{a.actor}</b> {a.action}{a.detail ? ` — ${a.detail}` : ""}
              </span>
              <span className="wb-activity-ts">
                {new Date(a.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
