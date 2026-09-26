# Velaris

Velaris is a fantasy-inspired AI agent orchestration platform — a full-stack local-first web
app where you create AI agents as "houses" in a night-lit city, send them quests, watch them
work in real time, answer messenger birds, and let the High Lord orchestrate multi-step plans.
Execution is real, with two first-class providers: OpenCode as the execution engine, or a
direct-Ollama tool loop for `executionProvider='ollama'` houses. Models are supplied by Ollama
(via OpenCode's authenticated `ollama-cloud` provider, or any Ollama HTTP endpoint).

## Status

Phases 1–5 and Phase 6 part 1 (6.1) are implemented and tested:

| Phase | Scope | Status |
|---|---|---|
| 1 — Foundation | App bootstrap, SQLite/Drizzle schema, houses/projects/tasks/provider-config CRUD, sectioned layout (now 9 sections), dark Velaris theme, reduced-motion support | ✅ Done |
| 2 — Real Execution & Approvals Core | Velaris Engine (task queue, OpenCode server lifecycle, SSE ingestion), real task execution, session persistence, structured events, cost/token tracking, functional messenger-bird approvals (approve/reject/reply), live agent chat, model picker, `/api/stream` SSE | ✅ Done |
| 3 — Velaris World & Messenger Roost | Interactive city view with per-house status animations (chimney smoke, messenger birds, once-per-task fireworks), full house workspace panel (Overview / Activity / Agent Chat / Task Results with diff viewer / Approvals), Roost hub with filters + resolved-approval history, read-only artifacts API | ✅ Done |
| 3.1 — Archipelago Map | Full-screen bird's-eye map at `/map`: houses as citadels on a seeded procedural archipelago, pan & zoom (wheel + buttons), real-time status effects, legend filter & deep-linking drawer | ✅ Done |
| 4 — High Lord | Orchestrator house, planning, delegation, DAG scheduling, handoffs, mid-plan steering, burning-castle abort | ✅ Done |
| 5 — Ollama-Native Agent Runtime | Direct-Ollama provider + tool loop, permission-gated fs/shell/git tools, native pause/resume, estimated cost tracking, flag-gated worktree scaffold | ✅ Done |
| 6 — Advanced Platform (6.1) | Audit log, multi-agent houses, house/project templates, archives search, usage/cost dashboards, monitoring panel | ✅ Done |
| 6.2 — Advanced Platform (deferred) | Real worktree isolation, FTS5 archives, per-agent cost rollups, audit retention/export | ⏳ Planned |

See the [implementation plan](./docs/IMPLEMENTATION_PLAN.md) for the full phase breakdown
and MVP acceptance journey.

## What you can do today

- **Found houses** — create AI agents with full configuration: identity, system prompt,
  execution provider, model, workspace allowlist, tools, permissions, approval policy,
  concurrency. Enable, disable, or archive them.
- **Meet the ten default houses** — the first boot seeds ten ACOTAR-named houses, one agent
  each, ready for the roles you need day to day:

  | House | Agent | Function |
  |---|---|---|
  | Day Court | Helion | Software developer |
  | House of Shadow | Azriel | Software tester |
  | Hewn City | Amren | Software reviewer |
  | The Library | Clotho | Documentation |
  | Court of Truth | Morrigan | Analysis |
  | The Townhouse | Nuala | Admin / secretary |
  | Summer Court | Tarquin | Finance / auditor |
  | Windhaven | Gwyn | Research |
  | The Crossing | Lucien | Communications |
  | Illyria | Cassian | Operations / DevOps |

  Each ships with a role-specific system prompt and a tuned permission posture (only the
  developer, tester, and operations houses may run shell commands). They all default to the
  **`deepseek-v4.1-flash`** model on the `ollama-cloud` provider, as do the High Lord and
  newly created houses and agents. Seeding is insert-only and idempotent, and never clobbers
  your edits: a house is only created when no house with that exact name exists, so
  reconfiguring a seeded house (or the High Lord) in place — including its model — is
  preserved on every later boot, and a house you have already changed keeps its current model
  until you edit it in the UI. Note that **renaming** a seeded house means its original
  default name becomes absent and is re-created on a later boot — your renamed house is
  preserved, and a fresh default is added alongside it. The same roster is also available as
  immutable house templates (10 house templates + the `Standard Repo` project template), so an
  accidental delete or a bad edit is recoverable.
  The superseded seeded house templates (`Research House`, `Engineering House`, `Docs House`)
  are cleaned up once on boot; user-created and project templates are never deleted.
- **Post quests** — register project directories (git info auto-detected), create typed
  tasks, and assign them directly to a house.
- **Watch real execution** — the engine process claims queued tasks and runs them through the
  house's provider: a real OpenCode server, or the direct-Ollama tool loop (permission-gated
  fs/shell/git tools, native pause/resume from the house panel). Every event (messages, tool
  calls, usage) streams to the browser live.
- **Command the High Lord** — an auto-seeded **High Lord** orchestrator house. Send it a
  plain-language instruction on the **Court** page and it plans a multi-step quest,
  delegating subtasks to other houses as a dependency-aware DAG. The plan board shows live
  progress, supports mid-plan steering, rolls up cost, and aborts the whole plan (with a
  burning-castle visual) if a subtask keeps failing.
- **Answer messenger birds** — when an agent requests a file/command permission or asks a
  clarifying question, a gold bird indicator appears on its house and in the Messenger
  Roost. Approve, reject, or reply; execution resumes immediately.
- **Sail the archipelago** — the **Map** page renders the city as a top-down
  fantasy archipelago: every house is a citadel on its own seeded island, and
  the **High Lord** (gold-plated, and burning when its plan is aborted) holds
  the world heart while the other houses spread outward in founding order.
  Each house shows its state through top-down magic: a slow moonlit aura while
  idle, a calm rune ring while planning, counter-rotating starfire rings while
  working, a magenta lighthouse sweep and bobbing `!` when it needs you, and
  embers with drifting smoke when a run fails. A legend filters houses by
  state; a cartouche keeps a live summary. Drag to pan, wheel or buttons to
  zoom, and click a citadel to open a drawer with its current quest and a
  **Messenger Roost →** link when a bird is waiting — both links deep-link to
  the existing house and Roost pages rather than duplicating approval actions.
  A fireworks burst celebrates each completed quest.
- **Inspect results** — each house has a workspace panel with live usage stats, a
  structured activity timeline, agent chat, and per-quest results including rendered diffs
  of the files the agent changed.
- **Raise more than one banner** — a house can host several agents, each with its own
  provider, model, prompt, allowlist, tools, permissions, approval policy, and concurrency.
  Add agents from the house panel and point a quest at a specific one; single-agent houses
  behave exactly as before.
- **Build from templates** — conjure a fully configured house or project from a template:
  seeded defaults ship ready to use (models, prompts, policies and all), and you can save
  your own. Instantiate and edit normally; wrong-kind payloads are rejected, not silently
  zeroed.
- **Consult the archives** — search the city's history by text or house across past quests,
  sessions, artifacts, and messages, with pagination over the full record.
- **Read the ledgers** — usage and cost dashboards break spend down by house, model, and time,
  separating provider-reported cost from estimated (Ollama) cost. The home dashboard also
  shows engine health, queue depth, and error rate at a glance.
- **Keep the chronicle** — Settings shows an audit log of user actions (houses, agents,
  projects, provider configs, templates, and approval responses).

## Setup

Requirements: Node 20+, plus [`opencode`](https://opencode.ai) on your `PATH` for houses
using the OpenCode provider (the High Lord always does). Houses that use the direct-Ollama
provider instead only need an Ollama endpoint reachable at `OLLAMA_BASE_URL` — with no local
Ollama server they simply won't run, while the rest of the app keeps working. SQLite is the
only datastore — no PostgreSQL or Docker needed.

```bash
npm install
cp .env.example .env.local   # adjust paths/ports if needed
npm run dev                  # web (:3000) + Velaris Engine together
```

Both processes auto-apply migrations and seed defaults on boot — default provider configs,
the High Lord, the ten default houses, and the house/project templates — so `db:migrate` is
optional in development. Open the app at `http://localhost:3000`.

Key environment variables (see `.env.example`): `VELARIS_DB_PATH` (SQLite file, default
`./db/velaris.db`), `VELARIS_PORT`, `OPENCODE_BASE_URL` (default `http://127.0.0.1:4096`),
`OLLAMA_BASE_URL`.

### Commands

```bash
npm run dev           # web + engine together (scripts/dev.js spawner)
npm run dev:web       # web only (what Playwright e2e boots)
npm run dev:engine    # engine only

npx tsc --noEmit      # typecheck gate
npm test              # vitest (unit + integration)
npm run test:e2e      # playwright (boots its own dev:web on :3000)

npm run db:generate   # after editing src/lib/db/schema.ts → writes to drizzle/
npm run db:migrate    # apply migrations manually (also auto-runs on boot)
npm run db:studio     # browse the database with drizzle-kit studio
```

## Architecture

Two processes, one package, one SQLite file (WAL mode, `busy_timeout=5000`):

- **Web** (`src/app`) — Next.js 15 App Router. Pages + `/api/*` routes. Reads execution
  state; writes user-action rows (houses, projects, tasks), approval replies, and the
  pause/resume intent routes. Never runs agent tasks itself.
- **Velaris Engine** (`src/engine/main.ts`, plain Node) — task queue, OpenCode server
  lifecycle (spawns or adopts `opencode serve`, health-gated), the direct-Ollama tool loop,
  provider selection per house with independent health-gating, and SSE ingestion of agent
  events. Single writer for execution tables (sessions, events, approvals, notifications).

Real-time everywhere via SSE: the browser subscribes to `/api/stream` (event cursor =
autoincrement id, so refreshes resume cleanly); the engine consumes OpenCode's `/event`
stream with backoff reconnect and boot-time reconciliation of orphaned sessions.

## Documentation

- [Implementation Plan](./docs/IMPLEMENTATION_PLAN.md) — phased plan, environment findings, MVP acceptance journey, risk register
- [Architecture](./docs/ARCHITECTURE.md) — system diagram, stack, process model, database schema, API surface, design system
- [Agent Orchestration](./docs/AGENT_ORCHESTRATION.md) — execution lifecycle, provider adapter, event mapping, house status machine, messenger birds, High Lord design
- [AGENTS.md](./AGENTS.md) — engineering conventions for AI agents working in this repo (commands, gates, import boundaries, testing quirks)

> Note: the docs in `docs/` describe design intent; some content (phase status, status
> enums, tooling details) lags the code. Where they disagree, the code and this README win.

## Testing

- **Unit/integration (Vitest)** — schemas, repositories, the execution status machine,
  OpenCode event mapping, queue/reconcile logic, the Ollama tool loop, permission gating
  (path-escape/shell guards), the provider seam, migration data-preservation (including the
  Phase-1-head migration-chain safety test and seeded-real-DB guard), pause/resume,
  city-map camera/island-layout/terrain/status/palette logic, diff parsing, multi-agent routing, template
  instantiation, archive search, audit writes, usage reconciliation (estimated vs
  provider-reported, with a double-count guard), and monitoring queries. Integration tests
  invoke API route handlers directly against a temp database.
- **E2E (Playwright)** — full UI journeys (house lifecycle, quest board, roost approvals,
  city map, house panel, the High Lord Court, the Phase 5 Ollama UI surface, and the Phase 6
  surfaces: templates, archives, audit, multi-agent houses, and usage/monitoring dashboards).
  E2E boots web-only with a dedicated database and does **not** start the engine; external
  OpenCode/Ollama calls are mocked for determinism.
