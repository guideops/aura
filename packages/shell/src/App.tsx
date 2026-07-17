import { useEffect, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { TopBar } from "./components/TopBar";
import { ActivityBar, type ActivityView } from "./components/ActivityBar";
import { Explorer } from "./components/Explorer";
import { CenterArea, type CenterTab } from "./components/CenterArea";
import { SystemOverview } from "./components/SystemOverview";
import { Inspector } from "./components/Inspector";
import { BottomPanel } from "./components/BottomPanel";
import { StatusBar } from "./components/StatusBar";
import { startWs } from "./lib/store";

export function App() {
  const [view, setView] = useState<ActivityView>("explorer");
  const [tab, setTab] = useState<CenterTab>("kanban");
  const [selectedCard, setSelectedCard] = useState<string | null>(null);

  useEffect(() => startWs(), []);

  return (
    <div className="shell">
      <TopBar />
      <div className="shell-main">
        <ActivityBar view={view} onSelect={setView} onOpenTab={setTab} />
        <PanelGroup direction="horizontal" className="shell-panels">
          <Panel defaultSize={16} minSize={10} collapsible>
            <Explorer view={view} onOpenTab={setTab} />
          </Panel>
          <PanelResizeHandle className="rh rh-v" />
          <Panel defaultSize={62} minSize={30}>
            <PanelGroup direction="vertical">
              <Panel defaultSize={72} minSize={30}>
                <CenterArea
                  tab={tab}
                  onSelectTab={setTab}
                  selectedCard={selectedCard}
                  onSelectCard={setSelectedCard}
                />
              </Panel>
              <PanelResizeHandle className="rh rh-h" />
              <Panel defaultSize={28} minSize={10} collapsible>
                <BottomPanel />
              </Panel>
            </PanelGroup>
          </Panel>
          <PanelResizeHandle className="rh rh-v" />
          <Panel defaultSize={22} minSize={14} collapsible>
            <div className="right-stack">
              <SystemOverview onOpenOffice={() => setTab("office")} />
              <Inspector cardId={selectedCard} onClose={() => setSelectedCard(null)} />
            </div>
          </Panel>
        </PanelGroup>
      </div>
      <StatusBar />
    </div>
  );
}
