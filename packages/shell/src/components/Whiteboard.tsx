import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  MiniMap,
  Controls,
  Handle,
  Position,
  NodeResizer,
  useReactFlow,
  applyNodeChanges,
  applyEdgeChanges,
  type Node as RFNode,
  type Edge as RFEdge,
  type NodeChange,
  type EdgeChange,
  type Connection,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { CanvasBoard, CanvasMeta, CanvasNode } from "@aura/core";
import { api, type CanvasNodeInput } from "../lib/api";
import { agentColor } from "../lib/store";
import { useWb, wbOpen, wbSelect } from "../lib/whiteboard-store";

/** JSON Canvas preset colors (Obsidian's palette) + hex passthrough. */
const PRESET: Record<string, string> = {
  "1": "#fb464c", "2": "#e9973f", "3": "#e0de71", "4": "#44cf6e", "5": "#53dfdd", "6": "#a882ff",
};
function canvasColor(c: string | undefined, fallback: string): string {
  if (!c) return fallback;
  return PRESET[c] ?? (c.startsWith("#") ? c : fallback);
}

type WbData = {
  node: CanvasNode;
  editing: boolean;
  onEdit: (id: string, text: string) => void;
  onStartEdit: (id: string) => void;
};
type WbRFNode = RFNode<WbData>;

// ---- Custom node renderer: one component, styled by spec type + extras.kind ----

function sideHandles(idPrefix = "") {
  return (
    <>
      <Handle id={`${idPrefix}top`} type="source" position={Position.Top} className="wb-handle" />
      <Handle id={`${idPrefix}right`} type="source" position={Position.Right} className="wb-handle" />
      <Handle id={`${idPrefix}bottom`} type="source" position={Position.Bottom} className="wb-handle" />
      <Handle id={`${idPrefix}left`} type="source" position={Position.Left} className="wb-handle" />
      <Handle id="t-top" type="target" position={Position.Top} className="wb-handle wb-handle-target" />
      <Handle id="t-right" type="target" position={Position.Right} className="wb-handle wb-handle-target" />
      <Handle id="t-bottom" type="target" position={Position.Bottom} className="wb-handle wb-handle-target" />
      <Handle id="t-left" type="target" position={Position.Left} className="wb-handle wb-handle-target" />
    </>
  );
}

function AuraNode({ id, data, selected }: NodeProps<WbRFNode>) {
  const n = data.node;
  const kind = n.extras.kind ?? (n.type === "group" ? "frame" : n.type === "text" ? "note" : n.type);
  const [draft, setDraft] = useState(n.text ?? "");
  useEffect(() => { if (data.editing) setDraft(n.text ?? ""); }, [data.editing, n.text]);

  const commit = () => data.onEdit(id, draft);

  if (n.type === "group") {
    return (
      <div className={`wb-frame ${selected ? "selected" : ""}`}>
        <NodeResizer isVisible={selected} minWidth={120} minHeight={80} />
        <div className="wb-frame-label">{n.label ?? "Frame"}</div>
        {sideHandles()}
      </div>
    );
  }

  const editor = data.editing ? (
    <textarea
      className="wb-editor nodrag nowheel"
      value={draft}
      autoFocus
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) commit();
        if (e.key === "Escape") data.onEdit(id, n.text ?? "");
      }}
    />
  ) : null;

  if (kind === "sticky") {
    return (
      <div
        className={`wb-sticky ${selected ? "selected" : ""}`}
        style={{ background: canvasColor(n.color, "#e0de71") }}
        onDoubleClick={() => data.onStartEdit(id)}
      >
        <NodeResizer isVisible={selected} minWidth={80} minHeight={80} />
        {editor ?? <div className="wb-md">{n.text}</div>}
        {sideHandles()}
      </div>
    );
  }

  if (kind === "comment") {
    const agent = n.extras.agent ?? "agent";
    return (
      <div className={`wb-comment ${selected ? "selected" : ""}`} onDoubleClick={() => data.onStartEdit(id)}>
        <div className="wb-comment-head">
          <i className="avatar-dot" style={{ background: agentColor(agent) }} />
          <span className="wb-comment-agent">{agent}</span>
          {n.extras.ts && (
            <span className="wb-comment-ts">
              {new Date(n.extras.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
        </div>
        {editor ?? <div className="wb-md">{n.text}</div>}
        {sideHandles()}
      </div>
    );
  }

  if (kind === "shape") {
    const shape = n.extras.shape ?? "rect";
    return (
      <div
        className={`wb-shape wb-shape-${shape} ${selected ? "selected" : ""}`}
        style={{ borderColor: canvasColor(n.color, "var(--accent)") }}
        onDoubleClick={() => data.onStartEdit(id)}
      >
        <NodeResizer isVisible={selected} minWidth={60} minHeight={40} />
        {editor ?? <div className="wb-shape-text">{n.text}</div>}
        {sideHandles()}
      </div>
    );
  }

  if (n.type === "file") {
    return (
      <div className={`wb-file ${selected ? "selected" : ""}`}>
        <NodeResizer isVisible={selected} minWidth={120} minHeight={60} />
        <div className="wb-file-icon">📄</div>
        <div className="wb-file-name">{n.file}</div>
        {sideHandles()}
      </div>
    );
  }

  if (n.type === "link") {
    return (
      <div className={`wb-file ${selected ? "selected" : ""}`}>
        <div className="wb-file-icon">🔗</div>
        <a className="wb-file-name" href={n.url} target="_blank" rel="noreferrer">{n.url}</a>
        {sideHandles()}
      </div>
    );
  }

  // Default: text/doc card.
  return (
    <div
      className={`wb-note ${selected ? "selected" : ""}`}
      style={n.color ? { borderTop: `3px solid ${canvasColor(n.color, "transparent")}` } : undefined}
      onDoubleClick={() => data.onStartEdit(id)}
    >
      <NodeResizer isVisible={selected} minWidth={100} minHeight={60} />
      {editor ?? <div className="wb-md">{renderMd(n.text ?? "")}</div>}
      {sideHandles()}
    </div>
  );
}

/** Tiny markdown: headings + bullets + bold; enough for board cards. */
function renderMd(text: string) {
  return text.split("\n").map((line, i) => {
    if (line.startsWith("# ")) return <div key={i} className="wb-h1">{line.slice(2)}</div>;
    if (line.startsWith("## ")) return <div key={i} className="wb-h2">{line.slice(3)}</div>;
    if (line.startsWith("- ")) return <div key={i} className="wb-li">• {line.slice(2)}</div>;
    return <div key={i}>{line || " "}</div>;
  });
}

const nodeTypes = { aura: AuraNode };

// ---- Conversion between store shape and React Flow shape ----

const SIDE_TO_HANDLE: Record<string, string> = { top: "top", right: "right", bottom: "bottom", left: "left" };

function toFlow(board: CanvasBoard, cb: Pick<WbData, "onEdit" | "onStartEdit">, editingId: string | null): { nodes: WbRFNode[]; edges: RFEdge[] } {
  const nodes: WbRFNode[] = board.nodes.map((n) => ({
    id: n.id,
    type: "aura",
    position: { x: n.x, y: n.y },
    style: { width: n.width, height: n.height },
    zIndex: n.type === "group" ? -1 : 0,
    data: { node: n, editing: editingId === n.id, ...cb },
  }));
  const edges: RFEdge[] = board.edges.map((e) => ({
    id: e.id,
    source: e.fromNode,
    target: e.toNode,
    sourceHandle: e.fromSide ? SIDE_TO_HANDLE[e.fromSide]! : "right",
    targetHandle: e.toSide ? `t-${SIDE_TO_HANDLE[e.toSide]}` : "t-left",
    type: "smoothstep",
    ...(e.label !== undefined ? { label: e.label } : {}),
    ...(e.color ? { style: { stroke: canvasColor(e.color, "#94a3b8") } } : {}),
  }));
  return { nodes, edges };
}

function specOf(rf: WbRFNode): CanvasNodeInput {
  const n = rf.data.node;
  const width = Number(rf.style?.width ?? rf.width ?? n.width);
  const height = Number(rf.style?.height ?? rf.height ?? n.height);
  return {
    id: rf.id, type: n.type,
    x: rf.position.x, y: rf.position.y, width, height,
    ...(n.color ? { color: n.color } : {}),
    ...(n.text !== undefined ? { text: n.text } : {}),
    ...(n.file !== undefined ? { file: n.file } : {}),
    ...(n.url !== undefined ? { url: n.url } : {}),
    ...(n.label !== undefined ? { label: n.label } : {}),
  };
}

// ---- Main component ----

export function Whiteboard() {
  return (
    <ReactFlowProvider>
      <WhiteboardInner />
    </ReactFlowProvider>
  );
}

const TOOLS: { key: string; label: string; title: string }[] = [
  { key: "sticky", label: "▣", title: "Sticky note (S)" },
  { key: "note", label: "T", title: "Text card (N)" },
  { key: "frame", label: "▢", title: "Frame (F)" },
  { key: "shape", label: "◇", title: "Shape (D)" },
  { key: "comment", label: "💬", title: "Comment (C)" },
];

function WhiteboardInner() {
  const canvasId = useWb((s) => s.canvasId);
  const refreshTick = useWb((s) => s.refreshTick);
  const listTick = useWb((s) => s.listTick);
  const [boards, setBoards] = useState<CanvasMeta[]>([]);
  const [nodes, setNodes] = useState<WbRFNode[]>([]);
  const [edges, setEdges] = useState<RFEdge[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const boardRef = useRef<CanvasBoard | null>(null);
  const dirty = useRef<Set<string>>(new Set());
  const saveTimer = useRef<NodeJS.Timeout | null>(null);
  const flow = useReactFlow();

  // ---- board list ----
  useEffect(() => {
    api.listCanvases().then((list) => {
      setBoards(list);
      // Auto-open the most recent board on first visit.
      if (!canvasId && list[0]) wbOpen(list[0].id, list[0].name);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listTick]);

  const editCallbacks = useMemo(() => ({
    onEdit: (id: string, text: string) => {
      setEditingId(null);
      const b = boardRef.current;
      const n = b?.nodes.find((x) => x.id === id);
      if (!b || !n || n.text === text) return;
      n.text = text;
      setNodes((ns) => ns.map((rf) => rf.id === id
        ? { ...rf, data: { ...rf.data, node: { ...n }, editing: false } }
        : rf));
      dirty.current.add(id);
      scheduleSave();
    },
    onStartEdit: (id: string) => setEditingId(id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  // ---- load / refetch board ----
  const load = useCallback(async (id: string) => {
    try {
      const board = await api.canvasBoard(id);
      boardRef.current = board;
      const f = toFlow(board, editCallbacks, null);
      setNodes(f.nodes);
      setEdges(f.edges);
    } catch { /* board gone */ }
  }, [editCallbacks]);

  useEffect(() => {
    if (canvasId) void load(canvasId);
    else { setNodes([]); setEdges([]); boardRef.current = null; }
  }, [canvasId, refreshTick, load]);

  // Reflect editing flag into node data.
  useEffect(() => {
    setNodes((ns) => ns.map((rf) => ({ ...rf, data: { ...rf.data, editing: rf.id === editingId } })));
  }, [editingId]);

  // ---- autosave ----
  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      const id = boardRef.current?.canvas.id;
      if (!id || dirty.current.size === 0) return;
      const ids = [...dirty.current];
      dirty.current.clear();
      setNodes((current) => {
        const payload = current.filter((rf) => ids.includes(rf.id)).map(specOf);
        if (payload.length) void api.canvasBulk(id, { nodes: payload }).catch(() => {});
        return current;
      });
    }, 700);
  }, []);

  const onNodesChange = useCallback((changes: NodeChange<WbRFNode>[]) => {
    setNodes((ns) => applyNodeChanges(changes, ns));
    let touched = false;
    for (const ch of changes) {
      if (ch.type === "position" || ch.type === "dimensions") {
        if ("id" in ch) { dirty.current.add(ch.id); touched = true; }
      }
      if (ch.type === "remove") {
        const id = boardRef.current?.canvas.id;
        if (id) void api.canvasRemoveNode(id, ch.id).catch(() => {});
      }
    }
    if (touched) scheduleSave();
  }, [scheduleSave]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((es) => applyEdgeChanges(changes, es));
    const id = boardRef.current?.canvas.id;
    for (const ch of changes) {
      if (ch.type === "remove" && id) void api.canvasRemoveEdge(id, ch.id).catch(() => {});
    }
  }, []);

  const onConnect = useCallback((c: Connection) => {
    const id = boardRef.current?.canvas.id;
    if (!id || !c.source || !c.target) return;
    const fromSide = (c.sourceHandle ?? "right").replace(/^t-/, "") as "top" | "right" | "bottom" | "left";
    const toSide = (c.targetHandle ?? "t-left").replace(/^t-/, "") as "top" | "right" | "bottom" | "left";
    void api.canvasAddEdge(id, { fromNode: c.source, toNode: c.target, fromSide, toSide })
      .then((edge) => setEdges((es) => [...es, {
        id: edge.id, source: edge.fromNode, target: edge.toNode,
        sourceHandle: fromSide, targetHandle: `t-${toSide}`, type: "smoothstep",
      }]))
      .catch(() => {});
  }, []);

  const onSelectionChange = useCallback(({ nodes: sel }: { nodes: RFNode[] }) => {
    wbSelect(sel.map((n) => n.id));
  }, []);

  // ---- toolbar: create nodes at viewport center ----
  const addNode = useCallback(async (tool: string) => {
    const b = boardRef.current;
    if (!b) return;
    const wrapper = document.querySelector(".wb-canvas");
    const rect = wrapper?.getBoundingClientRect();
    const center = flow.screenToFlowPosition({
      x: (rect?.left ?? 0) + (rect?.width ?? 800) / 2,
      y: (rect?.top ?? 0) + (rect?.height ?? 600) / 2,
    });
    const base = { x: Math.round(center.x), y: Math.round(center.y) };
    const inputs: Record<string, CanvasNodeInput> = {
      sticky: { type: "text", text: "New sticky", color: "3", ...base, width: 180, height: 180, extras: { kind: "sticky" } },
      note: { type: "text", text: "# Title\n\nWrite here…", ...base, width: 280, height: 160, extras: { kind: "note" } },
      frame: { type: "group", label: "Frame", ...base, width: 480, height: 320 },
      shape: { type: "text", text: "Step", ...base, width: 180, height: 80, color: "5", extras: { kind: "shape", shape: "rect" } },
      comment: { type: "text", text: "Comment…", ...base, width: 220, height: 100, extras: { kind: "comment", agent: "operator", ts: Date.now() } },
    };
    const input = inputs[tool];
    if (!input) return;
    try {
      const node = await api.canvasAddNode(b.canvas.id, input);
      b.nodes.push(node);
      setNodes((ns) => [...ns, {
        id: node.id, type: "aura",
        position: { x: node.x, y: node.y },
        style: { width: node.width, height: node.height },
        zIndex: node.type === "group" ? -1 : 0,
        data: { node, editing: false, ...editCallbacks },
      }]);
      setEditingId(node.id);
    } catch { /* daemon down */ }
  }, [flow, editCallbacks]);

  const newBoard = useCallback(async () => {
    const name = window.prompt("Board name:", "New Board");
    if (!name) return;
    try {
      const meta = await api.createCanvas(name);
      setBoards((bs) => [meta, ...bs]);
      wbOpen(meta.id, meta.name);
    } catch { /* daemon down */ }
  }, []);

  const active = boards.find((b) => b.id === canvasId);

  return (
    <div className="wb-root">
      <div className="wb-toolbar">
        <select
          className="wb-board-select"
          value={canvasId ?? ""}
          onChange={(e) => {
            const m = boards.find((b) => b.id === e.target.value);
            wbOpen(m?.id ?? null, m?.name ?? "");
          }}
        >
          {!boards.length && <option value="">No boards</option>}
          {boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <button className="wb-tool" title="New board" onClick={() => void newBoard()}>＋ Board</button>
        <span className="wb-toolbar-sep" />
        {TOOLS.map((t) => (
          <button key={t.key} className="wb-tool" title={t.title} onClick={() => void addNode(t.key)} disabled={!canvasId}>
            {t.label}
          </button>
        ))}
        <span className="wb-toolbar-spacer" />
        {active && (
          <span className="wb-file-hint" title="Materialized JSON Canvas file — open it in Obsidian">
            {active.slug}.canvas
          </span>
        )}
      </div>
      <div className="wb-canvas">
        {canvasId ? (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onSelectionChange={onSelectionChange}
            deleteKeyCode={["Delete", "Backspace"]}
            fitView
            minZoom={0.1}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1.5} />
            <MiniMap pannable zoomable className="wb-minimap" />
            <Controls showInteractive={false} />
          </ReactFlow>
        ) : (
          <div className="wb-empty">
            <div className="wb-empty-title">No whiteboard open</div>
            <div className="muted">Create a board — it becomes a .canvas file in your vault, editable in Obsidian too.</div>
            <button className="wb-tool wb-empty-btn" onClick={() => void newBoard()}>＋ New board</button>
          </div>
        )}
      </div>
    </div>
  );
}
