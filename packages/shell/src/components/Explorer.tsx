import { useEffect, useState } from "react";
import { api, type TreeNode } from "../lib/api";
import { agentColor, useShell } from "../lib/store";
import type { ActivityView } from "./ActivityBar";
import type { CenterTab } from "./CenterArea";

export function Explorer({
  view,
  onOpenTab,
}: {
  view: ActivityView;
  onOpenTab: (t: CenterTab) => void;
}) {
  if (view !== "explorer") {
    return (
      <aside className="sidebar">
        <div className="panel-title">{view.toUpperCase()}</div>
        <div className="sidebar-empty">Coming soon</div>
      </aside>
    );
  }
  return <ExplorerTree onOpenTab={onOpenTab} />;
}

function ExplorerTree({ onOpenTab }: { onOpenTab: (t: CenterTab) => void }) {
  const agents = useShell((s) => s.agents);
  const events = useShell((s) => s.events);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [open, setOpen] = useState<Record<string, boolean>>({ agents: true, workspace: true });

  useEffect(() => {
    api.workspaceTree().then(setTree).catch(() => setTree([]));
  }, []);

  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));

  return (
    <aside className="sidebar">
      <div className="panel-title">
        EXPLORER
        <span className="panel-title-actions">⋯</span>
      </div>
      <div className="tree">
        <div className="tree-section" onClick={() => toggle("workspace")}>
          <span className="twist">{open.workspace ? "▾" : "▸"}</span> AURA-WORKSPACE
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
                  <span className={`git-badge status-${a.status}`}>
                    {a.status === "offline" ? "U" : "M"}
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
