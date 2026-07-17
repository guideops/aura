import { useEffect, useState } from "react";
import { api, type TreeNode } from "../lib/api";
import { agentColor, useShell } from "../lib/store";
import type { ActivityView } from "./ActivityBar";
import type { CenterTab } from "./CenterArea";
import { SourceControlPanel } from "./sidebar/SourceControlPanel";
import { ExecutionsPanel } from "./sidebar/ExecutionsPanel";
import { ConnectPanel } from "./sidebar/ConnectPanel";

// Agent badge = first letter of live status (A active, I idle, O offline, …).
// Distinct from file git badges (M/U/A/D) elsewhere in the tree.
function statusInitial(status: string): string {
  return (status[0] ?? "?").toUpperCase();
}

export function Explorer({
  view,
  onOpenTab,
}: {
  view: ActivityView;
  onOpenTab: (t: CenterTab) => void;
  onSelectCard: (id: string | null) => void;
}) {
  switch (view) {
    case "scm":
      return <SourceControlPanel />;
    case "executions":
      return <ExecutionsPanel />;
    case "connect":
      return <ConnectPanel />;
    default:
      return <ExplorerTree onOpenTab={onOpenTab} />;
  }
}

function ExplorerTree({ onOpenTab }: { onOpenTab: (t: CenterTab) => void }) {
  const agents = useShell((s) => s.agents);
  const events = useShell((s) => s.events);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [root, setRoot] = useState<string>("");
  const [rootInput, setRootInput] = useState<string>("");
  const [editingRoot, setEditingRoot] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({ agents: true, workspace: true });

  const load = (r?: string) => {
    api
      .workspaceTree(r)
      .then((d) => {
        setTree(d.tree);
        setRoot(d.root);
        setRootInput(d.root);
      })
      .catch(() => setTree([]));
  };

  useEffect(() => {
    load();
    const onRefresh = () => load(root || undefined);
    window.addEventListener("aura:refresh-explorer", onRefresh);
    return () => window.removeEventListener("aura:refresh-explorer", onRefresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rootName = root.split(/[\\/]/).filter(Boolean).pop() ?? root;
  const parent = root.replace(/[\\/][^\\/]+[\\/]?$/, "");

  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));

  return (
    <aside className="sidebar">
      <div className="panel-title">
        EXPLORER
        <span className="insp-actions">
          <span className="clickable" title="Go up one directory" onClick={() => parent && load(parent)}>↑</span>
          <span className="clickable" title="Open folder…" onClick={() => setEditingRoot((e) => !e)}>📂</span>
          <span className="clickable" title="Refresh" onClick={() => load(root || undefined)}>↻</span>
        </span>
      </div>
      {editingRoot && (
        <div className="sidebar-pad">
          <input
            className="w-full"
            autoFocus
            placeholder="absolute folder path…"
            value={rootInput}
            onChange={(e) => setRootInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && rootInput.trim()) {
                load(rootInput.trim());
                setEditingRoot(false);
              }
              if (e.key === "Escape") setEditingRoot(false);
            }}
          />
        </div>
      )}
      <div className="tree">
        <div className="tree-section" onClick={() => toggle("workspace")} title={root}>
          <span className="twist">{open.workspace ? "▾" : "▸"}</span> {rootName.toUpperCase() || "WORKSPACE"}
        </div>
        {open.workspace && (
          <>
            <div className="tree-section sub" onClick={() => toggle("agents")}>
              <span className="twist">{open.agents ? "▾" : "▸"}</span> 📁 agents
            </div>
            {open.agents &&
              agents.map((a) => (
                <div key={a.agentId} className="tree-item indent-2" title={a.status}>
                  <i className="avatar-dot" style={{ background: agentColor(a.agentId) }} />
                  <span className="tree-name">{a.agentId}</span>
                  <span className={`git-badge status-${a.status}`} title={a.status}>
                    {statusInitial(a.status)}
                  </span>
                </div>
              ))}
            {open.agents && agents.length === 0 && (
              <div className="tree-item indent-2 muted">no agents yet</div>
            )}
            {tree.map((n) => (
              <TreeRow key={n.path} node={n} depth={1} open={open} toggle={toggle} />
            ))}
          </>
        )}
      </div>
      <div className="tree-footer">
        <div className="tree-section" onClick={() => toggle("outline")}>
          <span className="twist">{open.outline ? "▾" : "▸"}</span> OUTLINE
        </div>
        {open.outline && (
          <div className="tree-item indent-1 muted">
            {events.length} events this session
          </div>
        )}
        <div className="tree-section" onClick={() => toggle("timeline")}>
          <span className="twist">{open.timeline ? "▾" : "▸"}</span> TIMELINE
        </div>
        {open.timeline && (
          <>
            {events.slice(-5).reverse().map((e) => (
              <div key={e.id} className="tree-item indent-1 muted" title={e.summary}>
                {new Date(e.ts).toLocaleTimeString()} {e.type}
              </div>
            ))}
            {events.length === 0 && <div className="tree-item indent-1 muted">quiet</div>}
          </>
        )}
      </div>
    </aside>
  );
}

function TreeRow({
  node,
  depth,
  open,
  toggle,
}: {
  node: TreeNode;
  depth: number;
  open: Record<string, boolean>;
  toggle: (k: string) => void;
}) {
  if (node.type === "dir") {
    const isOpen = open[node.path] ?? false;
    return (
      <>
        <div
          className={`tree-section sub indent-${depth}`}
          onClick={() => toggle(node.path)}
        >
          <span className="twist">{isOpen ? "▾" : "▸"}</span> 📁 {node.name}
        </div>
        {isOpen &&
          (node.children ?? []).map((c) => (
            <TreeRow key={c.path} node={c} depth={depth + 1} open={open} toggle={toggle} />
          ))}
      </>
    );
  }
  return (
    <div className={`tree-item indent-${depth + 1}`}>
      <span className="file-icon">📄</span>
      <span className="tree-name">{node.name}</span>
      {node.gitStatus && <span className={`git-badge git-${node.gitStatus}`}>{node.gitStatus}</span>}
    </div>
  );
}
