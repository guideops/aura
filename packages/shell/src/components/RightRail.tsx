import { api } from "../lib/api";
import { fmtK, MODEL_COLORS, usePoll } from "../lib/poll";
import { useShell } from "../lib/store";
import { Inspector } from "./Inspector";
import { SystemOverview } from "./SystemOverview";
import type { CenterTab } from "./CenterArea";
import type { ZoneContext } from "../lib/zones";
import { ZONE_ACTIONS } from "../lib/zones";
import { WhiteboardAssistant } from "./WhiteboardAssistant";

/**
 * Contextual widget stack (reference S1/S2): System Overview pinned on top,
 * then widgets composed by context — zone actions when an office object is
 * clicked, the card inspector on the kanban tab, usage/security otherwise.
 */
export function RightRail({
  tab,
  selectedCard,
  onSelectCard,
  onOpenTab,
  zone,
  onCloseZone,
}: {
  tab: CenterTab;
  selectedCard: string | null;
  onSelectCard: (id: string | null) => void;
  onOpenTab: (t: CenterTab) => void;
  zone: ZoneContext | null;
  onCloseZone: () => void;
}) {
  const showInspector = tab === "kanban" || selectedCard !== null;
  return (
    <div className="right-stack">
      <SystemOverview onOpenOffice={() => onOpenTab("office")} />
      <div className="rail-widgets">
        {zone && <ZoneActionsWidget zone={zone} onOpenTab={onOpenTab} onClose={onCloseZone} />}
        {tab === "whiteboard" ? (
          <WhiteboardAssistant />
        ) : (
          <>
            {showInspector && <Inspector cardId={selectedCard} onClose={() => onSelectCard(null)} />}
            {!showInspector && (
              <>
                <UsageTracking />
                <SecurityOverview />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ZoneActionsWidget({
  zone,
  onOpenTab,
  onClose,
}: {
  zone: ZoneContext;
  onOpenTab: (t: CenterTab) => void;
  onClose: () => void;
}) {
  const actions = ZONE_ACTIONS[zone.zone] ?? [];
  return (
    <div className="widget">
      <div className="panel-title">
        {zone.label ?? zone.zone}
        <span className="panel-title-actions clickable" onClick={onClose}>✕</span>
      </div>
      <div className="zone-actions">
        {actions.map((a) => (
          <button
            key={a.label}
            className="zone-action"
            onClick={() => a.run({ onOpenTab })}
          >
            <span className="zone-action-label">{a.label}</span>
            <span className="zone-action-sub">{a.sub}</span>
          </button>
        ))}
        {actions.length === 0 && <div className="sidebar-empty">No actions for this object.</div>}
      </div>
    </div>
  );
}

export function UsageTracking() {
  const usage = usePoll(() => api.usage(), 10000);
  const models = (usage?.models ?? []).filter((m) => m.tokens > 0);
  return (
    <div className="widget">
      <div className="panel-title">Usage Tracking</div>
      <div className="widget-body">
        {models.length === 0 && <div className="muted small-line">No token data yet</div>}
        {models.map((m, i) => {
          const pct = usage?.total ? Math.round((m.tokens / usage.total) * 100) : 0;
          return (
            <div key={m.model} className="usage-row">
              <i className="avatar-dot" style={{ background: MODEL_COLORS[i % MODEL_COLORS.length] }} />
              <span className="usage-model" title={m.model}>{m.model}</span>
              <span className="usage-pct">{pct}%</span>
              <span className="usage-amt">{fmtK(m.tokens)}</span>
            </div>
          );
        })}
        {usage && usage.total > 0 && (
          <div className="usage-total">
            <span>Total Models {models.length}</span>
            <span>Total Usage {fmtK(usage.total)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function SecurityOverview() {
  const status = usePoll(() => api.status(), 10000);
  const approvals = useShell((s) => s.approvals);
  const events = useShell((s) => s.events);
  const denied = events.filter((e) => e.type === "tool.deny").length;
  const allowed = events.filter((e) => e.type === "tool.use").length;
  const errors = events.filter((e) => e.type === "system.error").length;
  return (
    <div className="widget">
      <div className="panel-title">Security Overview</div>
      <div className="widget-body kv">
        <div className="kv-row"><span>Tool calls allowed</span><b>{allowed}</b></div>
        <div className="kv-row"><span>Blocked</span><b>{denied}</b></div>
        <div className="kv-row">
          <span>Approvals pending</span>
          <b>{approvals.filter((a) => a.origin === "peer").length}</b>
        </div>
        <div className="kv-row"><span>Errors today</span><b>{errors}</b></div>
        <div className="kv-row"><span>Events logged</span><b>{status?.orchestration.eventsLogged ?? "—"}</b></div>
      </div>
    </div>
  );
}
