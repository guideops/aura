# AURA Shell Build Plan — SAMS-reference IDE UI

Target: rebuild AURA's frontend as an IDE-style shell matching the SAMS
reference design (VS Code-like layout: activity bar, explorer, kanban wall
center, system overview + card inspector right, terminal drawer bottom,
status bar). Backend largely exists; this is mostly a frontend program with
small daemon additions.

Decisions (locked with operator):

- **Stack: Vite + React + TypeScript** in a new `packages/shell` workspace
  package. Daemon serves `packages/shell/dist`; dev mode proxies `/api` + WS
  to the daemon (port 8311).
- **Explorer = real files.** Tree reflects the workspace directory
  (`agents.yaml`, `permissions.yaml`, `vault/`, plus new `*.flow`,
  `*.spatial` files). Badges come from `git status --porcelain`.
- **No PTY.** Bottom panel tabs are four projections of the one WS
  `AgentEvent` stream: Terminal (colorized tail), Output (session
  drill-down), Event Log (structured table), Problems (error aggregation).
- **Board = single source of truth** for tasks. Hermes/AW flow one-way into
  AURA via peer events + board REST; `externalId` (GitHub) and a new
  `externalRef` (peer task id) make ingestion idempotent.

## Phases

1. **Shell scaffold** — Vite/React package; IDE grid (activity bar,
   resizable sidebar / right stack / bottom drawer via
   `react-resizable-panels`); tab system; status bar shell; daemon static
   serving at `/shell/`; office + CAD embedded as iframes.
2. **Kanban Wall** — card schema extension (below); columns with counts;
   Filter / Group / Sort toolbar; New Card modal; drag-drop between
   columns; progress bars; Review badges; Done checks.
3. **Card inspector** — right panel: status, assignee, labels, milestone,
   priority, checklist with progress, description, activity feed (from
   card-related events).
4. **Bottom panel** — the four projections; Problems tab badge count.
5. **Explorer + status bar** — `GET /api/workspace/tree` (files + git
   badges), agent color dots joined live from `/api/agents` + WS,
   OUTLINE / TIMELINE sections, status bar (branch, error counts,
   connection state).
6. **System Overview minimap** — `office.html?mini=1` camera preset in an
   iframe card; active agent count; zoom; click-through to full office tab.
7. **Cutover** — new shell becomes `/app`; legacy vanilla UI removed;
   Electron deep links updated; build + tests green; commit.

## Schema diff (packages/core/src/board.ts)

`Card` gains:

```ts
priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
milestone: z.string().nullable().default(null),
checklist: z.array(z.object({
  id: z.string(),
  text: z.string(),
  done: z.boolean().default(false),
})).default([]),
externalRef: z.string().nullable().default(null), // peer (AW/Hermes) task id
```

`tags` doubles as labels (no rename — API stability). Existing `key`
("AURA-201") already covers card IDs.

## Daemon additions

- `GET /api/workspace/tree` — workspace file tree with git status per file
  (`M` modified, `U` untracked, `A` added), computed via
  `git status --porcelain` + directory walk; excludes node_modules, dist,
  .git, db files.
- `PATCH /api/board/cards/:id` — accept new fields (priority, milestone,
  checklist, externalRef).
- `GET /api/problems` — aggregated `system.error` events + guardrail
  denials since boot, with counts.
- Static serving of `packages/shell/dist` (copied into daemon `public/` at
  build, same pattern as existing assets).

## Non-goals

- No orchestration in AURA (AW owns processes).
- No PTY / shell access.
- No two-way sync into Hermes internals.
- Three.js office rewrite (stays vanilla, embedded via iframe).
