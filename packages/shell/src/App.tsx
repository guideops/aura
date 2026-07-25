import { useCallback, useEffect, useRef, useState } from "react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from "react-resizable-panels";
import { TopBar } from "./components/TopBar";
import { ActivityBar, type ActivityView } from "./components/ActivityBar";
import { Explorer } from "./components/Explorer";
import { CenterArea, type CenterTab } from "./components/CenterArea";
import { RightRail } from "./components/RightRail";
import { BottomPanel } from "./components/BottomPanel";
import { StatusBar } from "./components/StatusBar";
import { ActionRequestModal } from "./components/ActionRequestModal";
import { CommandPalette } from "./components/CommandPalette";
import { MobileShell } from "./components/MobileShell";
import { useMobileMode } from "./lib/mobile";
import { startWs } from "./lib/store";
import type { ZoneContext } from "./lib/zones";

export function App() {
  const [view, setView] = useState<ActivityView>("explorer");
  const [tab, setTab] = useState<CenterTab>("office");
  const [selectedCard, setSelectedCard] = useState<string | null>(null);
  const [zone, setZone] = useState<ZoneContext | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const leftPanel = useRef<ImperativePanelHandle>(null);
  const rightPanel = useRef<ImperativePanelHandle>(null);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    localStorage.getItem("aura-theme") === "dark" ? "dark" : "light",
  );
  const mobile = useMobileMode();

  // Writing localStorage also fires "storage" in the same-origin office
  // iframes, which restyle their 3D scene to match.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("aura-theme", theme);
  }, [theme]);
  const toggleTheme = useCallback(
    () => setTheme((t) => (t === "dark" ? "light" : "dark")),
    [],
  );

  const toggleLeft = useCallback(() => {
    const p = leftPanel.current;
    if (p) p.isCollapsed() ? p.expand() : p.collapse();
  }, []);
  const toggleRight = useCallback(() => {
    const p = rightPanel.current;
    if (p) p.isCollapsed() ? p.expand() : p.collapse();
  }, []);

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

  // Ctrl/Cmd+K palette · Ctrl/Cmd+B sidebar · Ctrl/Cmd+Shift+B right rail.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (k === "b") {
        e.preventDefault();
        if (e.shiftKey) toggleRight();
        else toggleLeft();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleLeft, toggleRight]);

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

  // Phone-sized viewports auto-start the simple view: full-screen content,
  // a FAB view switcher, and a swipe-up drawer instead of the desktop chrome.
  if (mobile.simple) {
    return (
      <>
        <MobileShell
          tab={tab}
          onSelectTab={setTab}
          selectedCard={selectedCard}
          onSelectCard={setSelectedCard}
          theme={theme}
          onToggleTheme={toggleTheme}
          onNewCard={newCard}
          onExitSimple={() => mobile.setMode("full")}
        />
        <ActionRequestModal />
      </>
    );
  }

  return (
    <div className="shell">
      <TopBar
        onOpenPalette={() => setPaletteOpen(true)}
        onNewCard={newCard}
        onConnect={() => setView("connect")}
        onProblems={() => setBottomTab("problems")}
        leftOpen={leftOpen}
        rightOpen={rightOpen}
        onToggleLeft={toggleLeft}
        onToggleRight={toggleRight}
        theme={theme}
        onToggleTheme={toggleTheme}
        onSimpleView={mobile.isNarrow ? () => mobile.setMode("simple") : undefined}
      />
      <div className="shell-main">
        <ActivityBar view={view} onSelect={setView} onOpenTab={setTab} onOpenPalette={() => setPaletteOpen(true)} />
        <PanelGroup direction="horizontal" className="shell-panels">
          <Panel
            ref={leftPanel}
            defaultSize={16}
            minSize={10}
            collapsible
            onCollapse={() => setLeftOpen(false)}
            onExpand={() => setLeftOpen(true)}
          >
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
          <Panel
            ref={rightPanel}
            defaultSize={22}
            minSize={14}
            collapsible
            onCollapse={() => setRightOpen(false)}
            onExpand={() => setRightOpen(true)}
          >
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
