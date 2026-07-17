import { useCallback, useEffect, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { TopBar } from "./components/TopBar";
import { ActivityBar, type ActivityView } from "./components/ActivityBar";
import { Explorer } from "./components/Explorer";
import { CenterArea, type CenterTab } from "./components/CenterArea";
import { RightRail } from "./components/RightRail";
import { BottomPanel } from "./components/BottomPanel";
import { StatusBar } from "./components/StatusBar";
import { ActionRequestModal } from "./components/ActionRequestModal";
import { CommandPalette } from "./components/CommandPalette";
import { startWs } from "./lib/store";
import type { ZoneContext } from "./lib/zones";

export function App() {
  const [view, setView] = useState<ActivityView>("explorer");
  const [tab, setTab] = useState<CenterTab>("office");
  const [selectedCard, setSelectedCard] = useState<string | null>(null);
  const [zone, setZone] = useState<ZoneContext | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => startWs(), []);

  // Office objects clicked inside the embedded office.html arrive here.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; zone?: string; label?: string };
      if (d?.type === "aura:zone" && d.zone) {
        setZone({ zone: d.zone, ...(d.label ? { label: d.label } : {}) });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Ctrl/Cmd+K opens the command palette anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const setBottomTab = useCallback((t: string) => {
    window.dispatchEvent(new CustomEvent("aura:bottom-tab", { detail: t }));
  }, []);

  const newCard = useCallback(() => {
    setTab("kanban");
    // Flag survives the mount race when switching from another tab;
    // the event covers the already-mounted case.
    (window as unknown as Record<string, unknown>).__auraNewCard = true;
    window.dispatchEvent(new CustomEvent("aura:new-card"));
  }, []);

  return (
    <div className="shell">
      <TopBar
        onOpenPalette={() => setPaletteOpen(true)}
        onNewCard={newCard}
        onConnect={() => setView("connect")}
        onProblems={() => setBottomTab("problems")}
      />
      <div className="shell-main">
        <ActivityBar view={view} onSelect={setView} onOpenTab={setTab} onOpenPalette={() => setPaletteOpen(true)} />
        <PanelGroup direction="horizontal" className="shell-panels">
          <Panel defaultSize={16} minSize={10} collapsible>
            <Explorer view={view} onOpenTab={setTab} onSelectCard={setSelectedCard} />
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
            <RightRail
              tab={tab}
              selectedCard={selectedCard}
              onSelectCard={setSelectedCard}
              onOpenTab={setTab}
              zone={zone}
              onCloseZone={() => setZone(null)}
            />
          </Panel>
        </PanelGroup>
      </div>
      <StatusBar />
      <ActionRequestModal />
      <CommandPalette
        open={paletteOpen}
        ctx={{
          setTab,
          setView,
          setBottomTab,
          selectCard: setSelectedCard,
          close: () => setPaletteOpen(false),
        }}
      />
    </div>
  );
}
