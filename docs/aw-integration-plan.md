# AURA ↔ Agentic Workspace Integration Plan

> Hand this file to the Agentic Workspace (AW) project. It contains everything
> needed to build AW's side of the link. AURA's side is **already built and
> committed** — nothing here requires touching the AURA repo unless marked.

## 1. Context & intent

Three layers, strict roles:

| Layer | Project | Role | Never does |
|---|---|---|---|
| Runtime | **Hermes agent** (Nous Research) | Tool calling, MCP connectors, channels (Telegram/Discord/CLI), memory | — |
| Brain | **Agentic Workspace** (AW) | Orchestration: decides what runs, when, with which tools | Visualization, kanban |
| Eyes + handbrake | **AURA** | Office 3D viz, kanban board, approvals/guardrails, vault UI, usage tracking | Orchestration |

Decisions already made (do not relitigate):

- **Transport = plain HTTP + WS**, daemon-to-daemon. Each UI talks only to its
  own backend. No CORS holes, no tokens in browser JS.
- **MCP is NOT the sync transport** (token cost, model round-trips). Optional
  later: tiny MCP surface (3–4 read tools) so the Hermes agent itself can query
  AURA mid-task. That is step 5, not now.
- **One kanban board: AURA's.** AW's board gets retired. AURA board already has
  persistence, revisions, progress animation, GitHub Projects sync.
- **Shared Obsidian vault folder = the memory bus.** Filesystem, no protocol.
  AW writes its subfolders (`aw/`, `memory/`), AURA writes `briefs/`.
  Never co-write the same note (last-write-wins at file level).
- **AURA's direct Hermes client is frozen** — emergency one-off runs only.
  All orchestration goes through AW.
- Contract = the zod `AgentEvent` schema in `@aura/core`
  (`packages/core/src/events.ts`). Transport is dumb; schema is versioned truth.

Architecture diagram: `~/Documents/Hermes/aura-agentic-workspace-architecture.html`

## 2. What AURA already exposes (built, tested, committed)

Daemon default port **8311** (`AURA_PORT` env). All routes localhost HTTP.

### Pairing (connection UX)
| Route | Auth | Purpose |
|---|---|---|
| `POST /api/pair/start` | none (local UI) | AURA UI mints 6-digit single-use code, 90s TTL |
| `POST /api/pair/claim` `{code, name}` | none (one-shot) | Redeem code → `{token, peer}`. Token is long-lived bearer; store it server-side (keychain/config). AURA keeps only its sha256 |
| `GET /api/pair/status` | none | `{peers:[{id,name,pairedAt,lastSeenAt,vaultPath?}], pending}` |
| `POST /api/pair/revoke` `{peerId}` | none (local UI) | Disconnect; token dead immediately |

### Authenticated peer surface (requires `Authorization: Bearer <token>`)
| Route | Purpose |
|---|---|
| `POST /api/peer/events` `{events:[AgentEvent...]}` | Bulk ingest, 1–500 per batch. Per-event validation; response `{accepted, rejected}`. Invalid events skipped, not fatal |
| `POST /api/peer/heartbeat` `{name?, vaultPath?}` | Liveness + report AW's vault path (powers AURA's one-click "Adopt vault" button) |

### Open local routes AW may also use (no auth yet — localhost trust)
- Board CRUD: `GET/POST /api/board/cards`, `PATCH/DELETE /api/board/cards/:id`,
  `POST /api/board/cards/:id/assign`
- Approvals: `GET /api/approvals`, `POST /api/approvals/:id {approved:bool}`
- Vault: `GET /api/vault/notes|search|note`, `POST /api/vault/note`
- Health probe: `GET /api/health` → `{ok, version}`

### Events AW should emit (provider: `"hermes"`)
Types (subset that lights up AURA features): `session.start`, `tool.use`,
`tool.result`, `task.claim`, `task.progress`, `task.complete`, `usage.tokens`
(`data: {model, inputTokens, outputTokens}` → Usage Tracking panel),
`agent.status` (`data: {status}` — moves the office robot), `session.end`,
`system.error`.

Shape (zod `AgentEvent`, id/ts optional — AURA fills them):
```json
{
  "provider": "hermes",
  "sessionId": "run-abc",
  "agentId": "aw-researcher",
  "type": "task.progress",
  "summary": "scraping source 3/7",
  "data": { "progress": 40 }
}
```
`agentId` is the stable office identity. Prefix color mapping exists for
blue/green/orange/purple/red/yellow (`blue-agent` → blue robot); other names
get slate gray.

## 3. Build steps — AW side

### Step A. AURA connector card (UI + backend)
1. Backend: probe `http://127.0.0.1:8311/api/health` on interval → "AURA
   detected" state in AW's existing connector UI (same pattern as Telegram
   connector).
2. Connect flow: user clicks Connect → input for the 6-digit code (user reads
   it from AURA → Connections → "Generate pairing code") → AW backend calls
   `/api/pair/claim {code, name:"agentic-workspace"}` → persist token.
3. Heartbeat every ~60s: `POST /api/peer/heartbeat {name, vaultPath}` with the
   absolute path of AW's Obsidian vault folder. This is what makes AURA's
   "Adopt agentic-workspace's vault" button appear.
4. Disconnect button → forget token locally. (AURA-side revoke also exists.)
5. On 401 anywhere → flip card to "re-pair needed", drop token.

### Step B. Event emitter (~100 lines)
- In-memory queue; flush to `POST /api/peer/events` every **250ms** or 100
  events, whichever first. Hermes agents are chatty — never send per-event.
- Map AW/Hermes lifecycle → `AgentEvent`s (table above). Minimum viable set:
  `session.start`, `agent.status(active)`, `task.progress`, `usage.tokens`,
  `task.complete`/`system.error`, `session.end`.
- Drop-on-failure with retry (keep last ~1000 queued; AURA down ≠ AW blocked).

### Step C. Retire AW kanban
- Replace AW board reads/writes with AURA board REST.
- Task created in AW → `POST /api/board/cards {title, body, tags}`.
- Status transitions → `PATCH /api/board/cards/:id {status}` (`backlog |
  in_progress | review | done`). `progress` 0–100 also patchable.
- Delete AW's board UI; deep-link to AURA (`http://127.0.0.1:8311/app/index.html`)
  from AW nav instead.

### Step D. Approval gating (the handbrake)
- Before any dangerous tool call (fs writes outside sandbox, shell, payments,
  outbound messages), AW asks AURA and **blocks**:
  emit `tool.ask` event, then poll `GET /api/approvals` / resolve via the
  answer the operator gives in AURA's UI (approve/deny buttons already exist).
- **[AURA-side gap]**: a synchronous `POST /api/peer/approvals/request` that
  parks the request and resolves on operator action would be cleaner than
  polling. Small addition — request it from the AURA project when needed.

### Step E. (Later, optional) MCP surface
- Only if the Hermes agent itself needs board/vault answers mid-reasoning.
- 3–4 read tools max: `board_query`, `vault_search`, `approval_request`.
- Lives in AURA as an MCP server; AW registers it as a Hermes connector.

## 4. Order of execution

```
A (pair) ──► B (events) ──► C (kill AW kanban) ──► D (approvals) ──► E (MCP, maybe never)
```
A+B give full visibility (office robots, event log, usage) — do them first,
they're independent of AW's internals. C is a deletion. D touches AW's tool
loop — do it once A+B are stable.

## 5. Rules that keep this sane

1. Orchestration through AW. Visualization through AURA. Never both directions.
2. One process owner per process — AURA renders AW's runs, never manages them.
3. UI → own backend only. Backends talk to each other.
4. Batch events (250ms). Never per-event HTTP.
5. Vault: separate subfolders per writer; never co-write one note.
6. `AgentEvent` schema is the versioned contract. Everything else may churn.
7. Bearer token lives server-side in AW. Never in browser JS, never in git.

## 6. Verification checklist (AW side done when…)

- [ ] AW connector card shows AURA detected/connected/disconnected states
- [ ] Pairing survives both apps restarting (token persisted, hashed in AURA)
- [ ] `aw-*` robots appear in AURA office while Hermes runs; go idle/offline after
- [ ] Usage Tracking shows Hermes model rows sourced from AW events
- [ ] AURA Connections shows "vault shared"; Adopt button offers AW's path
- [ ] Tasks created in AW appear on AURA kanban; status sync both ways
- [ ] AW kanban UI deleted
- [ ] Dangerous tool call in AW blocks until approved in AURA office

## 7. AURA repo state (for orientation when returning)

- Monorepo: pnpm + turbo. `packages/{core,daemon,desktop,adapters/{claude-code,hermes}}`
- 82 tests green as of commit `3cb72ec` + cleanup. `pnpm build && pnpm test`.
- Shell UI: `packages/daemon/public/app/` (vanilla ES modules, no bundler).
- Office 3D: `packages/daemon/public/office.html` (Three.js, layout-driven via
  `/api/space`, CAD editor at `?cad=1`).
- Daemon boots: `pnpm dev` (port 8311) or Electron shell in `packages/desktop`.
- Vault dir precedence: `AURA_VAULT` env / option > `aura.config.json` > `./vault`.
- AURA remaining backlog (separate from this integration): Design Board +
  Kanban Wall enhancements (user-directed), desktop installer/tray,
  synchronous peer approval endpoint (step D gap), optional MCP surface.
