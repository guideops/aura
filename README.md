# AURA — Agentic Unified Resource Architecture

Visual office for AI agents. Your coding agents become characters in an isometric office —
desks are running sessions, the kanban wall syncs GitHub Projects, the security gate is a real
permission boundary, and the vault is your markdown memory.

**Status: Phases 1–6 working** — core daemon, office scene, vault memory, kanban board,
GitHub Projects sync, skills registry, Electron shell.

## Layout

- `packages/core` — protocol types & zod schemas (`AgentEvent`, `.space`, `permissions.yaml`, `skill.md`, `Card`)
- `packages/daemon` — Fastify daemon: hook ingress, WebSocket broadcast, SQLite event log, guardrail engine, vault (markdown memory + FTS5 + live watch), kanban board, skills registry, GitHub Projects v2 sync, session spawner
- `packages/adapters/claude-code` — Claude Code hook normalizer + transcript watcher + settings installer
- `packages/desktop` — Electron shell: daemon child process, safeStorage-encrypted GitHub token, settings UI
- `fixtures/` — recorded hook payloads for deterministic replay tests
- `skills/` — example agent skills (`<name>/SKILL.md`, agentskills.io layout)
- `vault/` — dev vault (Obsidian-compatible markdown; graph view at `/graph.html`)

## UI pages

`/office.html` isometric office · `/board.html` kanban (dblclick card → assign + skill picker) ·
`/graph.html` live vault graph · `/index.html` debug console

## Run

```sh
pnpm install
pnpm build
node packages/daemon/dist/cli.js   # http://127.0.0.1:8311
```

Open `http://127.0.0.1:8311` for the live debug console. Point a Claude Code project at the
daemon by adding the hooks block from `@aura/adapter-claude-code` `hooksConfig()` to the
project's `.claude/settings.json`.

Guardrails: put a `permissions.yaml` next to the daemon working dir (see repo root example).
`deny` blocks the tool call; `ask` parks it as a pending Action Request (`GET /api/approvals`,
`POST /api/approvals/:id {"approved":true}`).

## Test

```sh
pnpm test
```
