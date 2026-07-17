import { useShell } from "../lib/store";

export function SystemOverview({ onOpenOffice }: { onOpenOffice: () => void }) {
  const agents = useShell((s) => s.agents);
  const active = agents.filter((a) => a.status !== "offline").length;
  return (
    <div className="overview">
      <div className="panel-title">
        System Overview
        <span className="panel-title-actions">⋯</span>
      </div>
      <div className="overview-frame" onDoubleClick={onOpenOffice} title="Double-click to open full office">
        <iframe className="embed-frame" src="/office.html?mini=1" title="System Overview" />
      </div>
      <div className="overview-foot">
        <span className="agents-active">● {active} Agents Active</span>
        <button className="icon-btn" onClick={onOpenOffice} title="Open full office">⤢</button>
      </div>
    </div>
  );
}
