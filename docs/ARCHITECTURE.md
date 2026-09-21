# Velaris — Architecture

Companion documents: [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) (phases, scope, risks)
and [AGENT_ORCHESTRATION.md](./AGENT_ORCHESTRATION.md) (execution lifecycle, adapter, events, status machine).

---

## 1. High-Level System Diagram

```
                                   Velaris — System Overview
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ BROWSER (React / Next.js UI)                                                │
 │  City view · House panels · Quest Board · Messenger Roost · Court chat       │
 └───────────────┬─────────────────────────────────────────────────────────────┘
                 │  REST (fetch)                    SSE (EventSource)
                 ▼                                          ▲
 ┌─────────────────────────────────────────────────────────┴──────────────────┐
 │ WEB PROCESS — Next.js 15 (App Router, :3000)                              │
 │  /api/houses /api/projects /api/provider-configs /api/tasks (CRUD)         │
 │  /api/notifications /api/approvals (reply)      /api/stream (SSE hub)      │
 │  Change feed: poll execution_events WHERE id > lastSeenId (500ms)          │
 └───────────────┬─────────────────────────────────────────────────────────────┘
                 │  shared SQLite file (WAL mode)
                 ▼
 ┌───────────────────────────────────────────────────────────────────────────┐
 │ SQLITE (better-sqlite3 + Drizzle)      db/velaris.db                       │
 │  houses · agents · agent_configurations · projects · provider_configs       │
 │  tasks · subtasks · execution_sessions · execution_events                   │
 │  approval_requests · notifications · agent_messages · artifacts            │
 │  usage_records · handoffs · audit_log · engine_state                        │
 └───────────────┬─────────────────────────────────────────────────────────────┘
                 │  shared SQLite file (WAL mode) — engine is the primary writer
                 ▼
 ┌───────────────────────────────────────────────────────────────────────────┐
 │ ENGINE PROCESS — "Velaris Engine" (src/engine/main.ts, plain Node)         │
 │  task queue loop · OpenCode adapter · Ollama adapter (P5)                   │
 │  SSE ingestion → event mapping → execution_events rows                     │
 │  permission/question events → approval_requests + notifications           │
 │  approval replies → forwarded to provider · status transitions            │
 └───────────────┬─────────────────────────────────────────────────────────────┘
                 │  HTTP + SSE                            HTTP (P5, configurable)
                 ▼                                        ▼
 ┌──────────────────────────────────────┐   ┌──────────────────────────────┐
 │ OPENCODE SERVER (v1.18.31)           │   │ OLLAMA HTTP API              │
 │ opencode serve --port 4096           │   │ http://localhost:11434       │
 │ /session /prompt /abort /diff         │   │ (no local server on dev box │
 │ /event (SSE) /permission /question    │   │  → mocked in tests; Ollama  │
 │ /api/health /api/model /api/provider  │   │  Cloud reached via OpenCode)│
 │ models via authenticated providers    │   └──────────────────────────────┘
 │ (ollama-cloud, opencode)              │
 └──────────────────────────────────────┘

 Messenger Roost flow (dotted path): OpenCode permission/question SSE event
   → engine writes approval_requests + notifications rows
   → web change feed notices rows → /api/stream pushes to browser
   → bird appears + unread badge → user replies POST /api/approvals/{id}/reply
   → web writes reply row → engine sees replied status → engine calls
   → POST /permission/{requestID}/reply | POST /question/{requestID}/reply|/reject
   → OpenCode resumes agent → session.updated events flow back.
```

---

## 2. Technology Stack

| Layer | Choice | Justification |
|---|---|---|
| Framework | Next.js 15 (App Router) | Single-page + API routes in one app; RSC fits read-heavy dashboards; verified Node 20.20.2 compatible. |
| Language | TypeScript (strict) | Shared types across web/engine/shared; zod-first validation. |
| UI | React 19 + Tailwind CSS + shadcn/ui | Fast dark-theme development; shadcn gives accessible primitives we can theme with Velaris tokens. |
| Animation | Motion (framer-motion) | Declarative status animations, layout transitions, `useReducedMotion` support built in. |
| DB | SQLite + better-sqlite3 | **Justified deviation from PostgreSQL**: no Postgres/Docker/psql on this machine; local single-user app; synchronous driver keeps engine code simple; WAL enables safe cross-process access. |
| ORM | Drizzle (+ drizzle-kit) | Typed schema, generated migrations, column-level check constraints & enums; SQLite-first class support. |
| Validation | Zod | One schema source for API input, DB types (drizzle-zod where useful), and engine contracts. |
| Real-time | SSE (both hops) | Browser⇄web: `/api/stream`. Engine⇄OpenCode: `GET /event?directory=…`. Matches OpenCode's own transport; simpler than WebSockets; auto-reconnect semantics well-understood. |
| Ephemeral cache | node-cache (in web process) | Last-seen event id, engine heartbeat reads, Roost unread counters — anything not worth a DB round trip. |
| Tests | Vitest (unit/integration) + Playwright (E2E) | Fast, TS-native; Playwright infra introduced in Phase 1 to make the MVP journey a first-class test. |
| Process mgmt | `concurrently` via `scripts/dev.js` | `npm run dev` starts web + engine; `npm run dev:web` / `dev:engine` for focused work. |
| Runtime utils | tsx (engine execution), nanoid/uuid | No build step needed for engine; uuid strings as SQLite text PKs. |

---

## 3. Process Model

**Two processes, one package:**

- **Web process** (Next.js): renders UI, serves REST + SSE. **Never runs agent tasks.**
  Next route handlers are not durable — a refresh or deploy must not kill a running quest.
  The web process only *reads* execution state (and writes user-action rows: houses,
  projects, tasks, approval replies).
- **Engine process** (`src/engine/main.ts`, plain Node via tsx): owns the task queue,
  provider connections, SSE ingestion, and all execution-state writes
  (`execution_sessions`, `execution_events`, `approval_requests` transitions, `notifications`
  writes). It is the *single writer* for hot tables, which sidesteps SQLite write contention.

**How they share state:** the SQLite file. Engine polls `tasks` for `status='queued'`
(default 1s), executes, and writes events. Web reads those rows for UI and SSE streaming.
Approval replies are written by web into `approval_requests` (`status → 'approved' |
'rejected' | 'replied'` + `reply_message`); the engine polls replied rows (or is nudged by
a change-feed pass) and forwards them to OpenCode. This two-process design means any web
crash leaves execution untouched, and an engine restart requeues/reconciles on boot.

**Engine loop design (poll + event-driven hybrid):**
1. Poll `tasks WHERE status='queued'` every 1s → enqueue runnable tasks (respect per-house
   `concurrency`, house `status='active'`).
2. For each active task: ensure OpenCode server (probe `GET /api/health`; spawn
   `opencode serve --port <port>` if absent), `POST /session {directory}`, wait for
   `POST /session/{id}/init` then `POST /session/{id}/prompt`.
3. Event-driven: consume `GET /event?directory=<workdir>` SSE per directory; map events
   (AGENT_ORCHESTRATION §3) to `execution_events` rows + house/task status transitions.
4. Poll `approval_requests WHERE status='replied'|'approved'|'rejected'` → forward to
   OpenCode permission/question endpoints.
5. Heartbeat: upsert `engine_state.heartbeat_at` every 5s; web `/api/health` surfaces staleness.

---

## 4. Real-Time Update Design (Web → Browser)

**Chosen mechanism: DB polling with monotonically increasing ids.** The web process's SSE
endpoint (`/api/stream`) runs a loop per connected client:

```
let lastEventId = initial (max execution_events.id at connect, or Last-Event-ID header)
every 500ms:
  rows = SELECT * FROM execution_events WHERE id > lastEventId ORDER BY id ASC
        ∪ new/updated approval_requests, notifications, tasks, houses (updated_at > lastTick)
  emit each as SSE `data:` frames with id = row id; lastEventId = max seen
emit `: heartbeat` comment every 15s to keep proxies alive
```

**Why polling over fancier alternatives:** SQLite has no LISTEN/NOTIFY; an extra
notification channel (file watchers, unix sockets) adds moving parts for a local app.
`execution_events.id` is INTEGER autoincrement (single writer = strictly increasing), so
`id > lastSeenId` is a lossless, reconnect-friendly cursor; a 500ms tick against a WAL-mode
SQLite file is sub-millisecond and trivially reliable. Client payloads are typed
(`RealtimeEvent` union in `src/shared/types.ts`). If latency ever matters, the swap point is
isolated in one module (`change-feed.ts`).

Browser reconnection: `EventSource` auto-reconnects; the server honors `Last-Event-ID` to
resume from the exact cursor. Refresh-persists-state (MVP step 14) falls out naturally —
state *lives in SQLite*, SSE is just a lens.

---

## 5. Directory Structure

**Decision: single Next.js app + separate engine entry sharing the same package.** A
monorepo (web/engine/shared workspaces) is overhead for a solo local project; the engine is
just a Node script importing the same `src/shared` and `src/lib/db` modules. One tsconfig,
one install, `concurrently` orchestrates. The only discipline required: nothing under
`src/app` may import from `src/engine`, and the engine must never import Next.js server
utilities — enforced by a lint rule / review convention.

```
velaris/
├─ docs/                          # these documents
├─ db/                            # SQLite file (gitignored)
├─ drizzle/                       # generated migrations (committed)
├─ scripts/dev.js                 # runs web + engine via concurrently
├─ src/
│  ├─ shared/                     # imported by BOTH web and engine (no Next/React deps)
│  │  ├─ constants.ts            # nav sections, task types, enums as const objects
│  │  ├─ types.ts                # DTOs, RealtimeEvent union, house status types
│  │  └─ schemas/                # zod: house.ts project.ts provider-config.ts task.ts common.ts
│  ├─ lib/
│  │  ├─ db/
│  │  │  ├─ index.ts             # better-sqlite3 singleton (WAL, busy_timeout, FK on)
│  │  │  ├─ schema.ts            # ALL drizzle tables
│  │  │  └─ migrate.ts           # idempotent boot migration
│  │  └─ paths.ts                # resolveSafePath() — allowlist enforcement
│  ├─ server/                     # web-process only: repositories + services + API helpers
│  ├─ engine/                     # engine-process only
│  │  ├─ main.ts                 # entry: migrate → heartbeat → queue loop
│  │  ├─ queue.ts                # task queue loop
│  │  ├─ adapters/               # opencode-adapter.ts, ollama-adapter.ts (P5), types.ts
│  │  ├─ sse/opencode-sse.ts     # EventSource client w/ backoff reconnect
│  │  ├─ events/mapper.ts        # OpenCode event → ExecutionEvent + status transitions
│  │  └─ approvals/relay.ts     # approval reply forwarding
│  ├─ app/                        # Next.js App Router (pages + api routes)
│  └─ components/                 # UI components (layout/, houses/, ui/)
├─ tests/                         # vitest unit/integration + playwright e2e/
├─ drizzle.config.ts
└─ package.json                   # scripts: dev, dev:web, dev:engine, db:generate, db:migrate,
                                  #          test, test:e2e, build, start:web, start:engine
```

---

## 6. Database Schema

SQLite via Drizzle. Conventions: text uuid PKs for domain tables; INTEGER autoincrement
PK for `execution_events` (needed as a stream cursor); timestamps as ISO-8601 text;
JSON stored as text with zod-validated read/write helpers. Enum-like values as TEXT with
CHECK constraints (portable, greppable).

### 6.1 Phase 1 Tables — complete definitions

```ts
// src/lib/db/schema.ts  (Phase 1; tables for later phases appended in migrations)

houses {
  id             TEXT PK (uuid)
  name           TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80)
  description    TEXT
  kind           TEXT NOT NULL DEFAULT 'agent' CHECK (kind IN ('agent','high_lord'))
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','disabled','archived'))
  created_at     TEXT NOT NULL (ISO-8601)
  updated_at     TEXT NOT NULL
}
  INDEX idx_houses_status (status)
  -- transitions: active<->disabled; active|disabled->archived; archived terminal; DELETE only if archived

agents {
  id         TEXT PK (uuid)
  house_id   TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE
  name       TEXT NOT NULL
  role       TEXT NOT NULL            -- e.g. "Shadow-singer · senior engineer"
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
}
  INDEX idx_agents_house (house_id)

agent_configurations {
  id                  TEXT PK (uuid)
  agent_id            TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE
  system_prompt       TEXT NOT NULL
  execution_provider  TEXT NOT NULL CHECK (execution_provider IN ('opencode','ollama'))
  ai_provider         TEXT NOT NULL DEFAULT 'ollama-cloud'   -- OpenCode providerID
  model_id            TEXT NOT NULL DEFAULT ''               -- never hardcoded; picker hits /api/model
  workspace_allowlist TEXT NOT NULL DEFAULT '[]'   -- JSON: ["/abs/dir", ...]
  tools               TEXT NOT NULL DEFAULT '[]'   -- JSON: ["fs","shell","git"]
  permissions         TEXT NOT NULL DEFAULT '{}'   -- JSON: {fileSystem:"ask",shell:"ask",network:"deny",git:"allow"}
  approval_policy     TEXT NOT NULL DEFAULT 'always' CHECK (approval_policy IN ('never','always','risky_only'))
  concurrency         INTEGER NOT NULL DEFAULT 1 CHECK (concurrency >= 1)
  created_at          TEXT NOT NULL, updated_at TEXT NOT NULL
  UNIQUE (agent_id)   -- 1:1 in MVP; Phase 6 multi-agent drops this
}

projects {
  id               TEXT PK (uuid)
  name             TEXT NOT NULL
  description      TEXT
  directory        TEXT NOT NULL UNIQUE CHECK (directory LIKE '/%')  -- absolute path
  git_info         TEXT DEFAULT '{}'    -- JSON {branch, remote, dirty} auto-detected at registration
  default_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL
  default_model    TEXT
  instructions     TEXT
  created_at       TEXT NOT NULL, updated_at TEXT NOT NULL
}

provider_configs {
  id         TEXT PK (uuid)
  name       TEXT NOT NULL
  type       TEXT NOT NULL CHECK (type IN ('opencode','ollama'))
  base_url   TEXT NOT NULL  -- opencode default http://127.0.0.1:4096; ollama default http://localhost:11434
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1))
  extra      TEXT DEFAULT '{}'   -- JSON (e.g. {modelPricing:{...}} Phase 5)
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
}
  UNIQUE (type, is_default) enforced in service layer (one default per type)
  -- seeded: "OpenCode (local)" and "Ollama (local)"

tasks {   // Phase 1 stub — execution semantics land in Phase 2
  id                    TEXT PK (uuid)
  title                 TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200)
  description           TEXT NOT NULL DEFAULT ''
  type                  TEXT NOT NULL DEFAULT 'general'   -- extensible; Phase 1 defaults:
                        -- new_project, bug_fix, research, documentation, planning,
                        -- analysis, creative, general (+ user-added strings in Settings)
  priority              TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent'))
  status                TEXT NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','cancelled'))    -- Phase 2 extends enum
  house_id              TEXT REFERENCES houses(id) ON DELETE SET NULL
  project_id            TEXT REFERENCES projects(id) ON DELETE SET NULL
  working_directory     TEXT
  execution_preferences TEXT DEFAULT '{}'   -- JSON {model, timeoutMinutes, autoApproveRisky:false,...}
  attachments           TEXT DEFAULT '[]'   -- JSON [{name, path}]
  created_at            TEXT NOT NULL, updated_at TEXT NOT NULL
}
  INDEX idx_tasks_house (house_id), idx_tasks_status (status), idx_tasks_project (project_id)
```

### 6.2 Later-Phase Tables — purpose & key columns

| Table | Phase | Purpose / key columns |
|---|---|---|
| `execution_sessions` | 2 | One execution attempt. `id`, `task_id` FK, `house_id` FK, `opencode_session_id`, `working_directory`, `status ('pending'\|'running'\|'waiting_approval'\|'completed'\|'failed'\|'aborted'\|'interrupted')`, `provider`, `model_id`, `prompt_message_id`, `cost_total`, `tokens_*`, `diff_summary`, `result_json`, `started_at/completed_at`. Task↔session is 1:N (retries, resume-after-abort). |
| `execution_events` | 2 | Append-only stream. `id INTEGER PK autoincrement` (SSE cursor!), `session_id` FK, `task_id`, `house_id`, `event_type`, `payload TEXT(JSON)`, `opencode_event_id`, `created_at`. Index `(session_id)`, `(id)`. |
| `approval_requests` | 2 | `id`, `session_id` FK, `kind ('permission'\|'question')`, `provider_request_id` (OpenCode requestID), `title`, `details JSON` (type, path, command, options), `status ('pending'\|'approved'\|'rejected'\|'replied')`, `reply_message`, `timeout_at`, timestamps. UNIQUE `(provider_request_id)`. |
| `notifications` | 2 | Roost feed. `id`, `house_id`, `task_id`, `approval_request_id`, `kind ('approval'\|'clarification'\|'task_completed'\|'task_failed'\|'info')`, `title`, `body`, `read INTEGER`, `created_at`. |
| `agent_messages` | 2 | Chat memory for direct chat + Ollama runtime. `id`, `session_id`, `role ('user'\|'assistant'\|'tool')`, `content`, `created_at`. |
| `artifacts` | 2 | `id`, `session_id`, `kind ('file_modified'\|'file_created'\|'diff'\|'test_result'\|'error')`, `path`, `content TEXT`, `created_at`. |
| `usage_records` | 2/5 | `id`, `session_id`, `house_id`, `model_id`, `provider`, `input_tokens`, `output_tokens`, `reasoning_tokens`, `cache_tokens`, `cost`, `estimated INTEGER` (0 = provider-reported), `created_at`. |
| `subtasks` | 4 | High Lord plan decomposition. `id`, `parent_task_id` FK(tasks), `task_id` FK (each subtask is a task), `order_index`, `depends_on JSON` (subtask ids). |
| `handoffs` | 4 | `id`, `source_agent_id`, `destination_agent_id`, `task_id`, `instructions`, `context JSON`, `artifacts JSON`, `completion_requirements`, `created_at`. |
| `audit_log` | 1 (table) / 6 (UI) | `id`, `actor ('user'\|'engine'\|'agent:<id>')`, `action`, `entity_type`, `entity_id`, `payload JSON`, `created_at`. Written from Phase 1 (create/update/delete of all entities), surfaced in Phase 6. |
| `engine_state` | 2 | Singleton row: `heartbeat_at`, `opencode_server_pid`, `version`, `last_event_id_seen`. |
| `users` | future | `id`, `name`, `email UNIQUE`, `created_at`. Single-user MVP has no auth; table + `created_by` columns designed so multi-user is additive. |

### 6.3 Status enums (source of truth: `src/shared/constants.ts`)

| Enum | Values |
|---|---|
| house.status (config) | `active`, `disabled`, `archived` |
| house runtime status (derived, Phase 2) | `idle`, `planning`, `working`, `waiting_approval`, `waiting_input`, `blocked`, `completed`, `failed`, `paused`, `offline` — derived from active session/event state, not stored on the house row |
| task.status | P1: `queued`, `cancelled` · P2 adds: `planning`, `running`, `waiting_approval`, `waiting_input`, `blocked`, `paused`, `completed`, `failed`, `cancelled_by_agent` |
| execution_session.status | `pending`, `running`, `waiting_approval`, `completed`, `failed`, `aborted`, `interrupted` |
| execution_event.type | `session_started`, `message_part`, `message_updated`, `tool_call`, `tool_result`, `permission_request`, `question_request`, `status_change`, `error`, `completion`, `usage_update`, `unknown` |
| approval_request.status / kind | `pending`, `approved`, `rejected`, `replied` / `permission`, `question` |
| task.priority | `low`, `medium`, `high`, `urgent` |

---

## 7. API Surface (Phase 1)

All routes under `/api`. JSON in/out; errors as `{ error: string, issues?: ZodIssue[] }`
with proper status codes (400 validation, 404 missing, 409 conflict, 422 bad transition).

| Method & Path | Request → Response | Notes |
|---|---|---|
| `GET /api/health` | → `{ status:'ok', db:'ok', migrations:'applied', engineHeartbeatAt: string\|null }` | engine heartbeat row read; Phase 1: null |
| `GET /api/stream` | SSE: `data: {type:'hello', cursor}` then `{type:'event', event}` frames + `: heartbeat` comments every 15s | Phase 1 stub (hello + heartbeats only); Phase 2 wires change feed |
| `GET /api/houses` | `?status=active\|disabled\|archived&includeArchived=false` → `{ houses: HouseDto[] }` | HouseDto embeds agent + configuration |
| `POST /api/houses` | HouseCreateInput → `201 { house: HouseDto }` | zod `houseCreateSchema`; creates agent+config in one tx |
| `GET /api/houses/{id}` | → `{ house: HouseDto }` | |
| `PATCH /api/houses/{id}` | HouseUpdateInput (all optional, incl. nested agent/config) → `{ house: HouseDto }` | status transitions validated in service (§6.1) |
| `DELETE /api/houses/{id}` | → `204` | 409 unless `status='archived'` |
| `GET /api/projects` | → `{ projects: ProjectDto[] }` | |
| `POST /api/projects` | `{ name, description, directory, defaultModel?, instructions? }` → `201 { project }` | directory: must exist, absolute, unique; git_info auto-detected |
| `GET/PATCH/DELETE /api/projects/{id}` | → `{ project }` / `204` | delete blocked if tasks reference it (409) |
| `GET /api/provider-configs` | → `{ providerConfigs: [...] }` | seeded defaults included |
| `POST /api/provider-configs` | ProviderConfigInput → `201` | one `is_default` per type (service enforced) |
| `GET/PATCH/DELETE /api/provider-configs/{id}` | → `{ providerConfig }` / `204` | |
| `GET /api/tasks` | `?houseId&projectId&status` → `{ tasks: TaskDto[] }` | |
| `POST /api/tasks` | TaskCreateInput → `201 { task }` | status forced `queued`; working_directory defaults to project.directory if projectId given; must pass allowlist check vs assigned house |
| `GET/PATCH /api/tasks/{id}` | → `{ task }` | PATCH limited to mutable fields; status change only to `cancelled` in Phase 1 |
| `GET /api/models` | → `{ models: [{id, providerID}] }` | Phase 2: proxied from OpenCode `GET /api/model` via engine; Phase 1 returns 501 |

---

## 8. Security & Safety

- **Local-first, single user.** No auth in MVP. `users` table exists in the design so auth is
  additive. API binds to localhost (`next dev` default; document not to port-forward).
- **Workspace allowlist.** `resolveSafePath(candidate, allowlist)`: `path.resolve` →
  `fs.realpath` (defeats `../` and symlink escapes) → prefix match against an allowlist
  entry. Enforced at (1) task creation — `working_directory` must be inside the assigned
  house's allowlist (or project directory, which auto-prompts to add), (2) runtime —
  filesystem/shell tool calls and OpenCode permission requests are checked; out-of-allowlist
  access requires explicit user approval (Phase 2 runtime enforcement; logic unit-tested in
  Phase 1).
- **Approval policies.** `approval_policy` per house: `never` (auto-approve within
  allowlist only), `always` (every permission/question becomes a bird), `risky_only`
  (shell exec, network, out-of-allowlist writes prompt; in-allowlist edits auto-approve).
  Defaults are conservative (`always`).
- **Path validation.** All directory inputs validated (absolute, exists, readable). No path
  outside allowlist ever passed to an agent working directory.
- **OpenCode server lifecycle.** *Recommendation: shared per-directory server per task group,
  spawned and supervised by the engine.* `opencode serve` binds 127.0.0.1 by default,
  supports `--port` and a project-directory positional argument; sessions are directory-scoped
  and the `/event` SSE stream is filtered by `directory`. Tradeoffs:
  - *Shared one-port server* (chosen default, port 4096): one health probe, one SSE feed
    per directory, sessions per task; simplest lifecycle management.
  - *Per-task spawn*: stronger isolation (crash containment), but port allocation + slow
    startup per task; revisit if isolation becomes a problem (see `/experimental/worktree`).
  Engine probes `GET /api/health`; attaches to a running server (even user-started) before
  spawning; kills only the process it spawned; writes pid to `engine_state`.
- **No secrets in DB.** Provider configs hold base URLs only; OpenCode auth lives in
  `~/.opencode` (already configured on this machine) and is never copied.

---

## 9. Process Failure & Recovery

- WAL mode + `busy_timeout=5000` for cross-process safety (see risk register in
  IMPLEMENTATION_PLAN §12).
- Engine boot reconciliation: `queued` tasks picked up; `running` sessions whose heartbeat
  died → `interrupted`, surfaced on the task; user may resume (new session with context) or
  cancel.
- SSE reconnect: engine EventSource with exponential backoff; after reconnect, reconcile
  via `GET /session`, `GET /permission`, `GET /question` snapshots to rebuild pending state
  (permissions may have been granted while disconnected).

---

## 10. Design System Foundation

**Palette (CSS custom properties, `src/app/globals.css`):**

| Token | Value | Use |
|---|---|---|
| `--velaris-midnight` | `#0b1026` | Page background (midnight sky base) |
| `--velaris-night` | `#151b3d` | Cards, panels |
| `--velaris-purple` | `#7c6cf0` / deep `#4b3fa8` | Primary actions, High Lord accents |
| `--velaris-silver` | `#cdd3f0` / `#8b93b8` (muted) | Text, secondary strokes |
| `--velaris-gold` | `#e8c66b` | Highlights, completed/celebration, active states |
| `--velaris-crimson` | `#e36a6a` | Failed/blocked/warning indicators |
| `--velaris-teal` | `#5ecfb8` | Working/running indicators |

**Aesthetic:** cozy dark-fantasy night — layered starfield background (CSS radial gradients +
2–3 twinkle layers, no JS for the static part), soft glow shadows (`box-shadow: 0 0 24px
rgba(124,108,240,0.25)`), generous rounded corners, BookTok serif for headings (e.g.
`Cormorant Garamond`) with a clean sans (e.g. `Inter`) for UI text. Houses use the Night
Court visual language: pointed roofs, warm window light.

**Motion:** all status animations use transform/opacity only; Motion's `useReducedMotion`
drives a global toggle (Settings → Appearance, Phase 1 ships the toggle; Phase 3 honors it).
Reduced motion = static status indicators (color + icon), no particles.

**Performance budget (Phase 3):** 60fps with 6 animated houses on integrated graphics;
≤ 2 DOM layers per animated house; particle systems capped (e.g. ≤ 40 particles per house,
CSS/canvas, no per-frame React state); SSE-driven animation changes batched to one commit
per 500ms tick.

---

## 11. Testing Topology

| Layer | Tool | Location |
|---|---|---|
| Unit (schemas, paths, transitions, mappers) | Vitest | `tests/unit/**` |
| Integration (repos + API routes, temp SQLite) | Vitest | `tests/integration/**` |
| E2E (MVP journey) | Playwright (`webServer: dev:web`) | `tests/e2e/**` |
| Adapter contract tests (mocked OpenCode HTTP/SSE) | Vitest + fixture server | `tests/unit/adapters/**` |

Real OpenCode is used in a *manual* verification script (`scripts/smoke-opencode.ts`,
Phase 2) and in one opt-in Playwright run (`--grep @real`), so CI stays deterministic.