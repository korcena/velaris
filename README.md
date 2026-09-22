# Velaris

Velaris is a fantasy-inspired AI agent orchestration platform — a full-stack local-first web
app where you create AI agents as "houses" in a night-lit city, send them quests, watch them
work in real time, and respond to messenger birds when they need your approval. Execution is
real: agents run through [OpenCode](https://opencode.ai) (execution engine) with models
supplied by Ollama (via OpenCode's authenticated `ollama-cloud` provider, or any Ollama HTTP
endpoint).

## Status

Phases 1–3 are implemented and tested:

| Phase | Scope | Status |
|---|---|---|
| 1 — Foundation | App bootstrap, SQLite/Drizzle schema, houses/projects/tasks/provider-config CRUD, 8-section layout, dark Velaris theme, reduced-motion support | ✅ Done |
| 2 — Real Execution & Approvals Core | Velaris Engine (task queue, OpenCode server lifecycle, SSE ingestion), real task execution, session persistence, structured events, cost/token tracking, functional messenger-bird approvals (approve/reject/reply), live agent chat, model picker, `/api/stream` SSE | ✅ Done |
| 3 — Velaris World & Messenger Roost | Interactive SVG city skyline with per-house status animations (chimney smoke, messenger birds, once-per-task fireworks), full house workspace panel (Overview / Activity / Agent Chat / Task Results with diff viewer / Approvals), Roost hub with filters + resolved-approval history, read-only artifacts API | ✅ Done |
| 4 — High Lord | Orchestrator house, planning, delegation, DAG scheduling, handoffs | ⏳ Planned |
| 5 — Ollama-Native Agent Runtime | Direct-Ollama adapter, tool loop, native pause/resume, worktree isolation | ⏳ Planned |
| 6 — Advanced Platform | Multi-agent houses, usage dashboards, templates, archives, monitoring | ⏳ Planned |

See the [implementation plan](./docs/IMPLEMENTATION_PLAN.md) for the full phase breakdown
and MVP acceptance journey.

## What you can do today

- **Found houses** — create AI agents with full configuration: identity, system prompt,
  execution provider, model, workspace allowlist, tools, permissions, approval policy,
  concurrency. Enable, disable, or archive them.
- **Post quests** — register project directories (git info auto-detected), create typed
  tasks, and assign them directly to a house.
- **Watch real execution** — the engine process claims queued tasks, runs them through a
  real OpenCode server, and streams every event (messages, tool calls, usage) to the
  browser live.
- **Answer messenger birds** — when an agent requests a file/command permission or asks a
  clarifying question, a gold bird indicator appears on its house and in the Messenger
  Roost. Approve, reject, or reply; execution resumes immediately.
- **See the city** — the dashboard plots every house as a lit building on a night skyline:
  pulsing windows while planning, chimney smoke while working, a wing-flapping bird while
  awaiting your answer, and a fireworks burst when a quest completes.
- **Inspect results** — each house has a workspace panel with live usage stats, a
  structured activity timeline, agent chat, and per-quest results including rendered diffs
  of the files the agent changed.

## Setup

Requirements: Node 20+ and [`opencode`](https://opencode.ai) on your `PATH`. SQLite is the
only datastore — no PostgreSQL or Docker needed.

```bash
npm install
cp .env.example .env.local   # adjust paths/ports if needed
npm run dev                  # web (:3000) + Velaris Engine together
```

Both processes auto-apply migrations and seed default provider configs on boot, so
`db:migrate` is optional in development. Open the app at `http://localhost:3000`.

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
  state; writes only user-action rows (houses, projects, tasks) plus approval replies.
  Never runs agent tasks itself.
- **Velaris Engine** (`src/engine/main.ts`, plain Node) — task queue, OpenCode server
  lifecycle (spawns or adopts `opencode serve`, health-gated), SSE ingestion of agent
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
  OpenCode event mapping, queue/reconcile logic, city animation/layout logic, diff
  parsing. Integration tests invoke API route handlers directly against a temp database.
- **E2E (Playwright)** — full UI journeys (house lifecycle, quest board, roost approvals,
  city view, house panel). E2E boots web-only with a dedicated database and does **not**
  start the engine; external OpenCode/Ollama calls are mocked for determinism.