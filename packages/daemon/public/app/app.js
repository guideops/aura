// AURA Command Center shell — vanilla ES module, no build step.
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const AGENT_COLORS = { blue:"#3b82f6", green:"#22c55e", orange:"#f97316", purple:"#8b5cf6", red:"#ef4444", yellow:"#eab308" };
const agentColor = (id) => AGENT_COLORS[String(id).split("-")[0]] ?? "#64748b";
const MODEL_COLORS = ["#3b82f6", "#ef4444", "#eab308", "#22c55e", "#8b5cf6", "#f97316", "#14b8a6"];
const fmtK = (n) => n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(n);
const ts = (ms) => new Date(ms).toLocaleTimeString("en-GB", { hour12: false });

function toast(msg) {
  const t = el("div", "toast", msg);
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

// ---------- views ----------
const VIEWS = ["office", "board", "cad", "sessions", "source", "skills", "note"];
function showView(name) {
  for (const v of VIEWS) {
    const node = $(`#view-${v}`);
    if (!node) continue;
    const on = v === name;
    node.classList.toggle("active", on);
    if (on && node.tagName === "IFRAME" && !node.src && node.dataset.src) node.src = node.dataset.src;
  }
  for (const b of document.querySelectorAll(".rail-btn[data-view]")) {
    b.classList.toggle("active", b.dataset.view === name);
  }
  if (name === "sessions") loadSessions();
  if (name === "source") loadGithub();
}
for (const b of document.querySelectorAll(".rail-btn[data-view]")) {
  b.onclick = () => showView(b.dataset.view);
}
$("[data-action=palette]").onclick = () => openPalette();

// Zone clicks from office iframe.
const ZONE_VIEW = {
  kanban: () => showView("board"),
  vault: () => { toggleSection("vault", true); toast("Vault — pick a note in the explorer"); },
  skills: () => { toggleSection("skills", true); toast("Skill Library — pick a skill in the explorer"); },
  gate: () => selectDockTab("problems"),
  council: () => showView("sessions"),
  agenda: () => briefNow(),
  desk: () => showView("sessions"),
  whiteboard: () => toast("Design Board — coming soon"),
};
addEventListener("message", (e) => {
  if (e.data?.type === "aura:zone") ZONE_VIEW[e.data.zone]?.();
});
function toggleSection(name, open) {
  const caret = document.querySelector(`.tree-section[data-section="${name}"] > .tree-caret`);
  if (caret) caret.classList.toggle("open", open ?? !caret.classList.contains("open"));
}
for (const caret of document.querySelectorAll(".tree-caret")) {
  caret.addEventListener("click", () => caret.classList.toggle("open"));
}

// ---------- explorer ----------
async function loadAgents() {
  const { agents } = await fetch("/api/agents").then((r) => r.json());
  const host = $("#tree-agents");
  host.innerHTML = "";
  for (const a of agents) {
    const item = el("div", "tree-item");
    const dot = el("span", "dot");
    dot.style.background = agentColor(a.agentId);
    item.append(dot, el("span", "", a.agentId));
    const b = el("span", "badge-m", a.status === "active" ? "A" : a.status === "blocked" ? "B" : a.status[0].toUpperCase());
    b.title = a.status;
    item.appendChild(b);
    item.onclick = () => { showView("office"); };
    host.appendChild(item);
  }
  $("#sb-agents").textContent = `agents: ${agents.length}`;
  const filter = $("#dock-agent-filter");
  const cur = filter.value;
  filter.innerHTML = '<option value="">all agents</option>';
  for (const a of agents) {
    const o = el("option", "", a.agentId);
    o.value = a.agentId;
    filter.appendChild(o);
  }
  filter.value = cur;
}

function renderTree(nodes, host, onLeaf, icon) {
  host.innerHTML = "";
  const build = (list, parent) => {
    for (const n of list) {
      if (n.slug === undefined && n.children?.length) {
        const sec = el("div", "tree-section tree-folder");
        const caret = el("div", "tree-caret", n.name);
        caret.onclick = () => caret.classList.toggle("open");
        const body = el("div", "tree-body");
        sec.append(caret, body);
        parent.appendChild(sec);
        build(n.children, body);
      } else {
        const item = el("div", "tree-item");
        item.append(el("span", "ico", icon), el("span", "", n.name));
        item.onclick = () => onLeaf(n);
        parent.appendChild(item);
      }
    }
  };
  build(nodes, host);
}

async function loadVaultTree() {
  const { tree } = await fetch("/api/vault/tree").then((r) => r.json());
  renderTree(tree, $("#tree-vault"), (n) => openNote(n.slug), "▤");
}
async function loadSkills() {
  const { skills } = await fetch("/api/skills").then((r) => r.json());
  const host = $("#tree-skills");
  host.innerHTML = "";
  for (const s of skills) {
    const name = s.meta?.name ?? s.dir ?? s.name;
    const item = el("div", "tree-item");
    item.append(el("span", "ico", "◈"), el("span", "", name));
    item.onclick = () => openSkill(name);
    host.appendChild(item);
  }
}
async function loadSessionsTree() {
  const { sessions } = await fetch("/api/sessions").then((r) => r.json());
  const host = $("#tree-sessions");
  host.innerHTML = "";
  for (const s of sessions) {
    const item = el("div", "tree-item");
    item.append(el("span", "ico", s.status === "running" ? "▶" : "■"), el("span", "", `${s.id.slice(0, 8)} · ${s.status}`));
    item.onclick = () => showView("sessions");
    host.appendChild(item);
  }
}
// Outline: office layout zones from /api/space; click focuses the office view.
async function loadOutline() {
  const space = await fetch("/api/space").then((r) => r.json());
  const host = $("#tree-outline");
  host.innerHTML = "";
  for (const p of space.primitives) {
    const item = el("div", "tree-item");
    item.append(el("span", "ico", "▣"), el("span", "", p.label));
    item.title = `${p.id} — ${p.kind}`;
    item.onclick = () => showView("office");
    host.appendChild(item);
  }
}

// Timeline: newest-first condensed event feed.
const TIMELINE_MAX = 30;
function pushTimeline(ev) {
  const host = $("#tree-timeline");
  const item = el("div", "tl-item");
  const who = el("b", "", ev.agentId);
  who.style.color = agentColor(ev.agentId);
  item.append(el("span", "", `${ts(ev.ts)} `), who, el("span", "", ` ${ev.summary}`));
  host.prepend(item);
  while (host.childElementCount > TIMELINE_MAX) host.lastElementChild.remove();
}

function refreshExplorer() {
  loadAgents().catch(() => {});
  loadVaultTree().catch(() => {});
  loadSkills().catch(() => {});
  loadSessionsTree().catch(() => {});
  loadOutline().catch(() => {});
}
$("#explorer-refresh").onclick = refreshExplorer;

// ---------- note editor ----------
let currentNote = null;
async function openNote(slug) {
  const res = await fetch(`/api/vault/note?slug=${encodeURIComponent(slug)}`);
  if (!res.ok) return toast(`note ${slug} not found`);
  const { body } = await res.json();
  currentNote = slug;
  $("#note-title").textContent = slug;
  $("#note-body").value = body;
  showView("note");
}
$("#note-save").onclick = async () => {
  if (!currentNote) return;
  await fetch("/api/vault/note", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug: currentNote, body: $("#note-body").value }),
  });
  toast(`saved ${currentNote}`);
};

async function openSkill(name) {
  const res = await fetch(`/api/skills/${encodeURIComponent(name)}`);
  if (!res.ok) return toast(`skill ${name} not found`);
  const { body } = await res.json();
  $("#skill-title").textContent = `Skill — ${name}`;
  $("#skill-body").textContent = body;
  showView("skills");
}

async function briefNow() {
  toast("generating brief…");
  const { slug } = await fetch("/api/vault/brief", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  }).then((r) => r.json());
  await loadVaultTree();
  openNote(slug);
}

// ---------- sessions & github views ----------
async function loadSessions() {
  const { sessions } = await fetch("/api/sessions").then((r) => r.json());
  const host = $("#sessions-list");
  host.innerHTML = "";
  if (!sessions.length) host.appendChild(el("div", "sub", "No sessions. Assign a board card to spawn one."));
  for (const s of sessions) {
    const item = el("div", "item");
    const left = el("div");
    left.appendChild(el("div", "", `${s.id.slice(0, 8)} — ${s.status}`));
    left.appendChild(el("div", "sub", `${s.cwd ?? ""} ${s.model ?? ""}`));
    item.appendChild(left);
    if (s.status === "running") {
      const stop = el("button", "btn", "Stop");
      stop.onclick = async () => {
        await fetch(`/api/sessions/${s.id}`, { method: "DELETE" });
        loadSessions();
      };
      item.appendChild(stop);
    }
    host.appendChild(item);
  }
}
async function loadGithub() {
  const st = await fetch("/api/github/status").then((r) => r.json());
  const host = $("#github-status");
  host.innerHTML = "";
  const rows = [
    ["Linked", st.linked ? "yes" : "no — link via desktop Settings"],
    ["Last sync", st.lastSync ? `${ts(st.lastSync.at)} · applied ${st.lastSync.applied} · conflicts ${st.lastSync.conflicts}` : "never"],
    ["Auto-sync", st.intervalMs ? `${Math.round(st.intervalMs / 1000)}s` : "manual"],
    ["Review queue", String(st.reviewQueue.length)],
  ];
  for (const [k, v] of rows) {
    const item = el("div", "item");
    item.appendChild(el("span", "sub", k));
    item.appendChild(el("span", "", v));
    host.appendChild(item);
  }
}
$("#gh-sync").onclick = async () => {
  const r = await fetch("/api/github/sync", { method: "POST" });
  toast(r.ok ? "sync complete" : `sync failed: ${(await r.json()).error}`);
  loadGithub();
};

// ---------- usage / status panels ----------
async function loadUsage() {
  const { models, total } = await fetch("/api/usage").then((r) => r.json());
  const host = $("#usage-rows");
  host.innerHTML = "";
  if (!models.length) host.appendChild(el("div", "dim", "No token data yet"));
  models.forEach((m, i) => {
    const row = el("div", "usage-row");
    const dot = el("span", "dot");
    dot.style.background = MODEL_COLORS[i % MODEL_COLORS.length];
    const used = m.tokens;
    const pct = total ? Math.round((used / total) * 100) : 0;
    row.append(dot, el("span", "", m.model), el("span", "pct", `${pct}%`), el("span", "amt", fmtK(used)));
    host.appendChild(row);
  });
  $("#usage-total").textContent = total ? `${fmtK(total)} total` : "";
}

async function loadStatus() {
  const st = await fetch("/api/status").then((r) => r.json());
  const o = st.orchestration;
  const orch = $("#orch-rows");
  orch.innerHTML = "";
  const orows = [
    ["Heartbeat", `Every ${Math.round(o.heartbeatMs / 1000)}s`],
    ["Uptime", `${Math.floor(o.uptimeMs / 60000)}m`],
    ["Tasks", `${o.tasksPending} pending`],
    ["Events", String(o.eventsLogged)],
    ["Sessions", String(o.sessionsRunning)],
    ["Agents online", `${o.agentsOnline} / ${o.agentsTotal}`],
  ];
  for (const [k, v] of orows) {
    const row = el("div", "row");
    row.append(el("span", "", k), el("span", "", v));
    orch.appendChild(row);
  }
  $("#orch-bar").style.width = o.agentsTotal ? `${Math.round((o.agentsOnline / o.agentsTotal) * 100)}%` : "0%";

  const svc = $("#svc-rows");
  svc.innerHTML = "";
  const smap = [
    ["Daemon", st.services.daemon.ok, `v${st.services.daemon.version}`],
    ["Obsidian Vault", st.services.vault.ok, `${st.services.vault.notes} notes`],
    ["Board", st.services.board.ok, `${st.services.board.cards} cards`],
    ["GitHub Sync", st.services.github.linked, st.services.github.linked ? "Linked" : "Not linked"],
    ["Sessions", st.services.sessions.ok, `${st.services.sessions.running} running`],
  ];
  for (const [name, ok, label] of smap) {
    const row = el("div", "row");
    row.append(el("span", "", name), el("span", ok ? "ok" : "bad", label));
    svc.appendChild(row);
  }

  $("#sb-branch").textContent = `⎇ ${st.git.branch ?? "—"}`;
  $("#sb-problems").textContent = `⚠ ${st.problems}`;
  const pc = $("#problems-count");
  pc.hidden = st.problems === 0;
  pc.textContent = String(st.problems);
}

// ---------- dock ----------
function selectDockTab(name) {
  for (const t of document.querySelectorAll(".dock-tab")) t.classList.toggle("active", t.dataset.tab === name);
  $("#dock-events").hidden = name !== "events";
  $("#dock-terminal").hidden = name !== "terminal";
  $("#dock-problems").hidden = name !== "problems";
  $("#dock-output").hidden = name !== "output";
  $("#dock-session-select").hidden = name !== "terminal";
  $("#dock-agent-filter").hidden = name === "terminal";
  if (name === "terminal") refreshTerminalSessions();
}
for (const t of document.querySelectorAll(".dock-tab")) t.onclick = () => selectDockTab(t.dataset.tab);

const MAX_LOG = 400;
function logLine(host, when, who, lvl, msg, color) {
  const line = el("div", "log-line");
  if (who) line.dataset.agent = who;
  line.appendChild(el("span", "ts", ts(when)));
  if (who) {
    const w = el("span", "who", who);
    w.style.color = color ?? agentColor(who);
    line.appendChild(w);
  }
  line.appendChild(el("span", "lvl", `[${lvl}]`));
  line.appendChild(el("span", "msg", msg));
  const stick = host.scrollTop + host.clientHeight >= host.scrollHeight - 6;
  host.appendChild(line);
  while (host.childElementCount > MAX_LOG) host.firstElementChild.remove();
  if (stick) host.scrollTop = host.scrollHeight;
  applyAgentFilter();
}
function applyAgentFilter() {
  const who = $("#dock-agent-filter").value;
  for (const line of $("#dock-events").children) {
    line.style.display = !who || line.dataset.agent === who ? "" : "none";
  }
}
$("#dock-agent-filter").onchange = applyAgentFilter;

const LVL = (type) => type.startsWith("tool.deny") ? "DENY" : type.startsWith("tool") ? "TOOL"
  : type.includes("error") || type.includes("fail") ? "ERROR" : type === "agent.status" ? "STATUS" : "INFO";
function pushEvent(ev) {
  logLine($("#dock-events"), ev.ts, ev.agentId, LVL(ev.type), ev.summary);
}

// ---------- terminal (per-session output streaming) ----------
let terminalSession = "";
async function refreshTerminalSessions() {
  const { sessions } = await fetch("/api/sessions").then((r) => r.json()).catch(() => ({ sessions: [] }));
  const sel = $("#dock-session-select");
  const cur = sel.value;
  sel.innerHTML = '<option value="">select session…</option>';
  for (const s of sessions) {
    const o = el("option", "", `${s.id.slice(0, 8)} · ${s.status}`);
    o.value = s.id;
    sel.appendChild(o);
  }
  // Keep the current choice; otherwise auto-select the newest running session.
  const runner = sessions.filter((s) => s.status === "running").at(-1) ?? sessions.at(-1);
  sel.value = sessions.some((s) => s.id === cur) ? cur : (runner?.id ?? "");
  if (sel.value !== terminalSession || !$("#dock-terminal").childElementCount) loadTerminal(sel.value);
}
async function loadTerminal(sessionId) {
  terminalSession = sessionId;
  const host = $("#dock-terminal");
  host.innerHTML = "";
  if (!sessionId) {
    host.appendChild(el("div", "dim", "No session selected. Spawn one from the board or executions."));
    return;
  }
  const res = await fetch(`/api/sessions/${sessionId}/output`);
  if (!res.ok) return;
  const { lines } = await res.json();
  for (const line of lines) appendTerminalLine(line);
}
function appendTerminalLine(text) {
  const host = $("#dock-terminal");
  const stick = host.scrollTop + host.clientHeight >= host.scrollHeight - 6;
  host.appendChild(el("div", "log-line", text));
  while (host.childElementCount > 1000) host.firstElementChild.remove();
  if (stick) host.scrollTop = host.scrollHeight;
}
$("#dock-session-select").onchange = (e) => loadTerminal(e.target.value);

// ---------- problems / approvals ----------
const approvals = new Map();
function renderProblems() {
  const host = $("#dock-problems");
  host.innerHTML = "";
  if (!approvals.size) host.appendChild(el("div", "dim", "No problems. Gate clear."));
  for (const r of approvals.values()) renderApprovalCard(host, r, false);
  renderApprovalOverlay();
}
function renderApprovalOverlay() {
  const host = $("#approvals");
  host.innerHTML = "";
  for (const r of approvals.values()) renderApprovalCard(host, r, true);
}
function renderApprovalCard(host, r, compact) {
  const card = el("div", "ar");
  const h = el("div", "h");
  h.append(el("span", "agent", r.agentId), el("span", "tool", r.tool));
  card.appendChild(h);
  card.appendChild(el("div", "tool", (r.inputPreview || "").slice(0, 90)));
  card.appendChild(el("div", "reason", `${r.reason} · impact: ${r.impact}`));
  const btns = el("div", "btns");
  const ok = el("button", "approve", "Approve & Execute");
  const no = el("button", "deny", "Deny");
  ok.onclick = () => resolveApproval(r.id, true);
  no.onclick = () => resolveApproval(r.id, false);
  btns.append(ok, no);
  card.appendChild(btns);
  host.appendChild(card);
}
async function resolveApproval(id, approved) {
  approvals.delete(id);
  renderProblems();
  await fetch(`/api/approvals/${id}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approved }),
  }).catch(() => {});
  loadStatus();
}

// ---------- palette ----------
const ACTIONS = [
  { label: "Go to Office", run: () => showView("office") },
  { label: "Go to Board", run: () => showView("board") },
  { label: "Go to Executions", run: () => showView("sessions") },
  { label: "Open Space CAD (edit office layout)", run: () => showView("cad") },
  { label: "Show terminal", run: () => selectDockTab("terminal") },
  { label: "Go to Source Control", run: () => showView("source") },
  { label: "Brief now (write agenda note)", run: () => briefNow() },
  { label: "Refresh explorer", run: () => refreshExplorer() },
  { label: "Show problems", run: () => selectDockTab("problems") },
  { label: "GitHub: sync now", run: () => $("#gh-sync").click() },
];
let palSel = 0, palItems = [];
function openPalette() {
  $("#palette-overlay").hidden = false;
  const input = $("#palette-input");
  input.value = "";
  renderPalette("");
  input.focus();
}
function closePalette() { $("#palette-overlay").hidden = true; }
async function renderPalette(q) {
  const host = $("#palette-results");
  host.innerHTML = "";
  palItems = [];
  const ql = q.toLowerCase();
  for (const a of ACTIONS.filter((a) => a.label.toLowerCase().includes(ql))) {
    palItems.push({ kind: "ACTION", label: a.label, run: a.run });
  }
  if (q.length >= 2) {
    try {
      const { hits } = await fetch(`/api/vault/search?q=${encodeURIComponent(q)}`).then((r) => r.json());
      for (const h of hits.slice(0, 8)) {
        palItems.push({ kind: "NOTE", label: h.title, snippet: h.snippet?.replace(/<\/?b>/g, ""), run: () => openNote(h.slug) });
      }
    } catch { /* daemon offline */ }
  }
  palSel = 0;
  palItems.forEach((it, i) => {
    const item = el("div", "pal-item" + (i === palSel ? " sel" : ""));
    item.append(el("span", "kind", it.kind), el("span", "", it.label));
    if (it.snippet) item.appendChild(el("span", "snippet", it.snippet));
    item.onclick = () => { closePalette(); it.run(); };
    host.appendChild(item);
  });
}
$("#cmd-input").onclick = openPalette;
$("#palette-overlay").addEventListener("mousedown", (e) => { if (e.target.id === "palette-overlay") closePalette(); });
$("#palette-input").addEventListener("input", (e) => renderPalette(e.target.value));
addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); }
  if ($("#palette-overlay").hidden) return;
  const items = document.querySelectorAll(".pal-item");
  if (e.key === "Escape") closePalette();
  else if (e.key === "ArrowDown") { palSel = Math.min(palSel + 1, items.length - 1); }
  else if (e.key === "ArrowUp") { palSel = Math.max(palSel - 1, 0); }
  else if (e.key === "Enter") { items[palSel]?.click(); return; }
  else return;
  items.forEach((n, i) => n.classList.toggle("sel", i === palSel));
});

// ---------- websocket ----------
let statusTimer = null;
function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => {
    $("#sb-conn").textContent = "AURA: Connected";
    $("#sb-conn").classList.add("on");
    $("#rail-conn").classList.remove("off");
    $("#rail-conn-label").textContent = "Online";
  };
  ws.onclose = () => {
    $("#sb-conn").textContent = "AURA: Reconnecting…";
    $("#sb-conn").classList.remove("on");
    $("#rail-conn").classList.add("off");
    $("#rail-conn-label").textContent = "Offline";
    setTimeout(connect, 1500);
  };
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.kind === "hello") {
      approvals.clear();
      for (const r of msg.approvals ?? []) approvals.set(r.id, r);
      renderProblems();
      refreshExplorer();
      loadStatus();
      loadUsage();
    } else if (msg.kind === "event") {
      pushEvent(msg.event);
      pushTimeline(msg.event);
      scheduleStatus();
    } else if (msg.kind === "snapshot") {
      loadAgents();
    } else if (msg.kind === "approval.pending") {
      approvals.set(msg.request.id, msg.request);
      renderProblems();
      selectDockTab("problems");
      toast(`approval needed — ${msg.request.agentId}: ${msg.request.tool}`);
    } else if (msg.kind === "approval.resolved") {
      approvals.delete(msg.id);
      renderProblems();
    } else if (msg.kind === "session.output") {
      if (msg.sessionId === terminalSession) {
        for (const line of msg.lines) {
          appendTerminalLine(msg.stream === "stderr" ? `[stderr] ${line}` : line);
        }
      }
    } else if (msg.kind === "session.status") {
      logLine($("#dock-output"), Date.now(), null, "SESSION", `${msg.sessionId.slice(0, 8)} → ${msg.status}`);
      loadSessionsTree();
      if (!$("#dock-terminal").hidden) refreshTerminalSessions();
      if ($("#view-sessions").classList.contains("active")) loadSessions();
    } else if (msg.kind === "space.updated") {
      toast("office layout saved");
      loadOutline().catch(() => {});
    } else if (msg.kind === "vault.updated") {
      loadVaultTree();
      logLine($("#dock-output"), Date.now(), null, "VAULT", `vault reindexed — ${msg.noteCount} notes`);
    } else if (msg.kind === "sync.conflicts") {
      toast(`${msg.count} sync conflict(s) — see Source Control`);
      loadStatus();
    } else if (msg.kind === "card.upsert" || msg.kind === "card.removed") {
      scheduleStatus();
    }
  };
}
function scheduleStatus() {
  if (statusTimer) return;
  statusTimer = setTimeout(() => { statusTimer = null; loadStatus().catch(() => {}); }, 1200);
}

// ---------- boot ----------
async function boot() {
  try {
    const { events } = await fetch("/api/events/recent").then((r) => r.json());
    for (const ev of events.slice(-120)) pushEvent(ev);
    for (const ev of events.slice(-30)) pushTimeline(ev);
  } catch { /* offline */ }
  logLine($("#dock-output"), Date.now(), null, "INFO", "AURA command center shell started");
  refreshExplorer();
  loadStatus().catch(() => {});
  loadUsage().catch(() => {});
  connect();
  setInterval(() => { loadStatus().catch(() => {}); loadUsage().catch(() => {}); }, 15000);
}
boot();
