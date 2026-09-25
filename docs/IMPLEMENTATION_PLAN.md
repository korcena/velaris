# Velaris — Implementation Plan

> Fantasy-inspired AI agent orchestration platform. Users create AI agents as "houses" in the city of Velaris, assign them tasks ("quests"), watch them work, and respond to messenger birds when agents need approval or clarification. Execution is real (OpenCode + Ollama), not simulated.

---

## 1. Executive Summary

Velaris is a full-stack local-first web application that turns AI agent orchestration into an
immersive experience:

- **Houses** = AI agents (or agent teams). User-created, unlimited, fully configurable
  (identity, system prompt, provider, model, workspace allowlist, tools, permissions,
  approval policy, concurrency). Enable / disable / archive.
- **High Lord** = the main orchestrator house that plans and delegates; users may also
  bypass it and assign quests directly to houses.
- **Quests (tasks)** = typed work items (extensible types: New Project, Bug Fix, Research,
  Documentation, Planning, Analysis, Creative, General…), assigned to a house or delegated.
- **Messenger birds** = approval/clarification requests surfaced when agents pause for
  file permissions, command approval, or ambiguous requirements. Central hub: the Messenger Roost.
- **Real execution**: OpenCode (v1.18.31, verified installed) is the execution engine;
  Ollama supplies models (via OpenCode's authenticated `ollama-cloud` provider, or a local/
  remote Ollama HTTP endpoint for direct agents).

**Development priority (user-stated):** a single house executing a real OpenCode task →
messenger-bird approvals → fireworks. High Lord and multi-house orchestration come after
that flow is reliable. This plan restructures the original phases to honor that priority
(see §4).

**Core technical decisions (verified against this machine):**
- SQLite (better-sqlite3) + Drizzle ORM — no PostgreSQL/Docker available; ideal for a
  local single-user app with background workers.
- Single Next.js 15 app + a separate Node.js engine process (`src/engine/main.ts`)
  sharing the same package — durable execution lives outside the frontend request lifecycle.
- SSE for all real-time streams — same mechanism OpenCode itself uses.

---

## 2. Environment & Tooling Findings (Verified)

Inspected on this machine (Linux):

| Fact | Detail | Consequence |
|---|---|---|
| Node / npm | Node v20.20.2, npm 10.8.2 | Next.js 15 + React 19 fine. No pnpm/bun/deno → use npm. |
| OpenCode | v1.18.31 at `~/.opencode/bin/opencode` | Real execution provider available. |
| OpenCode server | `opencode serve --port 4096` verified; OpenAPI 3 doc at `/doc`, 162 paths | Engine talks HTTP + SSE to `http://127.0.0.1:4096`. |
| OpenCode endpoints | `POST /session` `{directory?}`; `GET /session`; `GET /session/{id}`; `POST /session/{id}/init`; `POST /session/{id}/prompt` `{providerID, modelID, prompt, agentID?, messageID?, parts?}`; `POST /session/{id}/abort`; `GET /session/{id}/diff`; `GET /event?directory=...` (SSE); `POST /event` (filters); `GET /api/session/{sessionID}/event`; `GET /permission`; `POST /permission/{requestID}/reply`; `GET /question`; `POST /question/{requestID}/reply`; `POST /question/{requestID}/reject`; `POST /session/{id}/permissions/{permissionID}`; `GET /api/health`; `GET /api/provider`; `GET /api/model` | These are the only endpoints we build against. No invented endpoints. |
| OpenCode session fields | `id, title, cost, tokens{input,output,reasoning,cache}, model{id,providerID}, agent, time.created/updated` | Cost/token tracking is free — persist per session. |
| OpenCode limitations | **No pause/resume endpoints.** Abort is the only interruption primitive. `/experimental/worktree` and `/vcs/*` exist but are future options. | Pause = documented limitation; Velaris "paused" house status maps to aborted-with-resume-context (see AGENT_ORCHESTRATION §2). |
| Ollama | Client 0.31.1 at `/usr/bin/ollama`, **no local server running**. Ollama Cloud reachable via OpenCode's `ollama-cloud` provider (e.g. `glm-5.3`); many free `opencode` models also listed. | Phase 2 model access goes through OpenCode. Direct-Ollama adapter (Phase 5) targets the Ollama HTTP API (default `http://localhost:11434`, base URL configurable) and must degrade gracefully when no server is up. |
| Databases | No PostgreSQL, no Docker, no psql | **Justified deviation: SQLite** via better-sqlite3 (synchronous, fast, cross-process with WAL) + Drizzle ORM (migrations + type safety). |
| Everything else in suggested stack stands | Next.js App Router, React, TypeScript strict, Tailwind, shadcn/ui, Motion (framer-motion), Zod, Vitest, Playwright, SSE. | No relitigation. |

---

## 3. Stack Decisions & Deviations

| Decision | Rationale |
|---|---|
| **SQLite + better-sqlite3 + Drizzle** | No Postgres/Docker on machine; single-user local app; synchronous driver is simple and fast; WAL mode + `busy_timeout` makes web↔engine cross-process access safe. Drizzle gives typed schema + generated migrations. Documented as the only deviation from the suggested stack. |
| **Single Next.js app + separate engine entry** | Pragmatic: one package, one tsconfig, shared zod/db modules. `src/engine/main.ts` is a plain Node process started by `npm run dev` via `concurrently`. Avoids monorepo overhead for a solo project. |
| **SSE everywhere** | Browser ⇄ web: `/api/stream`. Engine ⇄ OpenCode: `GET /event?directory=...`. Simpler than WebSockets, auto-reconnect semantics are well-understood, matches OpenCode's own transport. |
| **Execution outside the request lifecycle** | Next.js route handlers are not durable. All task execution, SSE ingestion, and approval replies happen in the engine process; the web process only reads/writes domain rows and streams them. |

---

## 4. Phase Plan (Restructured)

**Rationale for restructuring.** The original phases put the Velaris city in Phase 3 and
messenger birds in Phase 5. The user's stated priority is: real single-house execution
first, then messenger-bird approvals, then fireworks — High Lord only after that flow is
reliable. The MVP acceptance journey (create house → task → working → bird → approve →
complete → fireworks → results) cannot wait until Phase 5, so the **functional core of
messenger birds (ApprovalRequest rows, approve/reject/reply API, a minimal bird indicator
+ panel) moves into Phase 2**, alongside real OpenCode execution. Phase 3 keeps the
*visual* layer (city, animations including fireworks, Roost hub, workspace panels).
Phase 5 absorbs the Ollama-direct agent runtime (pulled forward in priority from the old
Phase 2 "Ollama integration" — through OpenCode it already works in Phase 2; only the
direct runtime needs its own phase). Phase gates are preserved: six phases, each with
tests that must pass before proceeding.

| # | Phase (restructured) | Original content mapping |
|---|---|---|
| 1 | **Foundation** — app bootstrap, DB, core entities, provider config, layout, house management | Original Phase 1 (unchanged) |
| 2 | **Real Execution & Approvals Core** — OpenCode adapter, engine, task queue, execution events, session persistence, basic agent chat, **functional messenger birds (approve/reject/reply)** | Original Phase 2 + functional core of original Phase 5 |
| 3 | **Velaris World & Messenger Roost** — interactive city, house visualizations, status animations incl. fireworks, workspace panels, Roost hub, real-time polish | Original Phase 3 + visual/UX half of original Phase 5 |
| 4 | **High Lord** — orchestrator house, planning, delegation, handoffs, DAG, loop safeguards | Original Phase 4 (unchanged) |
| 5 | **Ollama-Native Agent Runtime & Advanced Execution** — direct-Ollama adapter (tool loop, memory, permissions), pause/resume where natively possible, worktree isolation exploration | Pulled from original Phase 2/6 |
| 6 | **Advanced Platform** — multi-agent houses, full usage/cost dashboards, templates, history/archives, monitoring | Original Phase 6 |

> **Do not proceed to the next phase until the current phase is implemented and its tests pass.**

---

## 5. Phase 1 — Foundation (detailed, implement immediately)

### 5.1 Goals

Next.js 15 app with dark-fantasy Velaris design tokens, SQLite + Drizzle schema for all
Phase 1 entities, zod validation, REST API for houses / projects / provider configs /
task stubs, the 8-section layout, and a house management UI with the **full** configuration
property set. **No agent execution** (engine stub only), **no city visualization**
(house cards grid), **no approvals**.

### 5.2 File-by-File Breakdown

```
velaris/
├─ package.json                    # deps: next@15, react@19, drizzle-orm, better-sqlite3,
│                                  #      zod, framer-motion(motion), tailwindcss, shadcn deps,
│                                  #      concurrently, drizzle-kit, vitest, @playwright/test, tsx
├─ tsconfig.json                   # strict: true; paths @/* → src/*
├─ next.config.ts
├─ postcss.config.mjs               # tailwind
├─ drizzle.config.ts               # dialect sqlite, schema src/lib/db/schema.ts, out drizzle/
├─ vitest.config.ts
├─ playwright.config.ts            # webServer: npm run dev:web
├─ .env.local                      # VELARIS_DB_PATH=./db/velaris.db, OPENCODE_PORT=4096, PORT=3000
├─ .gitignore                      # db/, .next/, node_modules/, .env.local, playwright-report/
├─ scripts/
│  └─ dev.js                       # spawns `next dev` + `tsx src/engine/main.ts` (replaces direct concurrently)
├─ db/                             # SQLite file (gitignored)
├─ drizzle/                        # generated migrations (committed)
├─ docs/                           # (exists) this plan + ARCHITECTURE.md + AGENT_ORCHESTRATION.md
└─ src/
   ├─ shared/
   │  ├─ constants.ts              # NAV_SECTIONS[8], TASK_TYPES defaults, status enums, palettes refs
   │  ├─ types.ts                  # derived TS types (HouseWithConfig, ProjectDto, …)
   │  └─ schemas/
   │     ├─ common.ts              # uuid, trimmed-nonempty, jsonString helpers
   │     ├─ house.ts               # houseCreateSchema, houseUpdateSchema (+nested agent & configuration)
   │     ├─ project.ts             # projectCreateSchema, projectUpdateSchema
   │     ├─ provider-config.ts     # providerConfigCreateSchema, providerConfigUpdateSchema
   │     └─ task.ts                # taskCreateSchema, taskUpdateSchema
   ├─ lib/
   │  ├─ db/
   │  │  ├─ index.ts               # better-sqlite3 singleton: WAL, busy_timeout=5000, foreign_keys=ON
   │  │  ├─ schema.ts              # Phase 1 drizzle tables (§5.3)
   │  │  └─ migrate.ts             # runs drizzle migrations on boot (web + engine, idempotent)
   │  └─ paths.ts                  # resolveSafePath(): realpath + allowlist prefix check (unit-tested now, enforced P2+)
   ├─ server/
   │  ├─ repositories/
   │  │  ├─ house-repo.ts          # CRUD + embedded agent/config upsert + status transition guard
   │  │  ├─ project-repo.ts        # CRUD, unique directory check
   │  │  ├─ provider-config-repo.ts
   │  │  └─ task-repo.ts           # insert, list, get, update fields (no execution semantics)
   │  └─ services/
   │     └─ house-service.ts       # zod-validate → repo; status transition rules (§5.3)
   ├─ engine/
   │  └─ main.ts                   # STUB: migrate DB, heartbeat log every 10s, SIGINT/SIGTERM exit.
   │                                #      Comment header: Phase 2 adds task queue + OpenCode client.
   ├─ app/
   │  ├─ layout.tsx                # html dark, fonts, AppSidebar + AppTopbar, Toaster
   │  ├─ globals.css                # design tokens (ARCHITECTURE §10), starfield bg, reduced-motion
   │  ├─ page.tsx                  # "Velaris" dashboard placeholder: welcome, counts, quick links
   │  ├─ houses/
   │  │  ├─ page.tsx               # server component: house cards grid (name, agent, model, status badge)
   │  │  └─ house-form.tsx         # client component: create/edit dialog; tabs: Identity | Agent |
   │  │                            # Execution (provider, aiProvider, modelId, approvalPolicy, concurrency)
   │  │                            # | Workspace (allowlist dir picker, tools, permissions JSON editor)
   │  ├─ high-lords-court/page.tsx # placeholder
   │  ├─ quest-board/page.tsx      # task list (read) + create dialog (status locked to 'queued')
   │  ├─ messenger-roost/page.tsx  # placeholder ("the roost is quiet…")
   │  ├─ archives/page.tsx         # placeholder
   │  ├─ projects/page.tsx         # list + create/edit dialog (dir picker, git info auto-detect)
   │  ├─ settings/page.tsx         # provider configs CRUD form; task-type list (add custom type strings);
   │  │                            # appearance placeholder
   │  └─ api/
   │     ├─ health/route.ts            # GET  {status:'ok', migrations:'applied'}
   │     ├─ stream/route.ts            # SSE stub: heartbeat comment every 15s (wired in P2)
   │     ├─ houses/route.ts           # GET list, POST create
   │     ├─ houses/[id]/route.ts       # GET one, PATCH update, DELETE (archived-only)
   │     ├─ projects/route.ts          # GET list, POST create
   │     ├─ projects/[id]/route.ts     # GET one, PATCH, DELETE (no tasks)
   │     ├─ provider-configs/route.ts  # GET list, POST create
   │     ├─ provider-configs/[id]/route.ts # GET, PATCH, DELETE
   │     ├─ tasks/route.ts             # GET list (filters: houseId, projectId, status), POST create
   │     └─ tasks/[id]/route.ts        # GET one, PATCH (title/desc/priority/assignments; status→cancelled only)
   └─ components/
      ├─ layout/app-sidebar.tsx    # 8 sections w/ icons; active state
      ├─ layout/app-topbar.tsx     # breadcrumb, engine status pill (hits /api/health)
      ├─ layout/page-header.tsx
      ├─ houses/house-card.tsx     # status badge colors per status enum
      ├─ houses/status-badge.tsx
      └─ ui/…                      # shadcn: button, card, dialog, input, textarea, select, tabs,
                                   # badge, form, label, switch, sonner, tooltip, separator, scroll-area
```

### 5.3 Database Schema (Phase 1) — full column-level spec

Full DDL rationale, types, and all later-phase tables live in **ARCHITECTURE §6**. Summary:

| Table | Key columns |
|---|---|
| `houses` | `id` (text uuid pk), `name`, `description`, `status` ('active'\|'disabled'\|'archived', check), `created_at`, `updated_at` |
| `agents` | `id` pk, `house_id` fk→houses (cascade), `name`, `role`, timestamps |
| `agent_configurations` | `id` pk, `agent_id` fk→agents (cascade, unique — 1:1 for MVP), `system_prompt` text, `execution_provider` ('opencode'\|'ollama'), `ai_provider` text, `model_id` text, `workspace_allowlist` text(JSON array, default '[]'), `tools` text(JSON), `permissions` text(JSON), `approval_policy` ('never'\|'always'\|'risky_only', default 'always'), `concurrency` int default 1 (check ≥1), timestamps |
| `projects` | `id` pk, `name`, `description`, `directory` text **unique**, `git_info` text(JSON: branch, remote, dirty), `default_agent_id` fk→agents nullable, `default_model` text, `instructions` text, timestamps |
| `provider_configs` | `id` pk, `name`, `type` ('opencode'\|'ollama'), `base_url` (default per type), `is_default` int bool, `extra` text(JSON), `created_at`, `updated_at` |
| `tasks` (stub) | `id` pk, `title`, `description`, `type` text (extensible), `priority` ('low'\|'medium'\|'high'\|'urgent'), `status` ('queued'\|'cancelled' in P1; engine ignores rows), `house_id` fk nullable, `project_id` fk nullable, `working_directory` text, `execution_preferences` text(JSON), `attachments` text(JSON), `created_at`, `updated_at` |

Indexes: `houses(status)`, `agents(house_id)`, `agent_configurations(agent_id)`,
`projects(directory UNIQUE)`, `tasks(house_id)`, `tasks(status)`, `tasks(project_id)`.
Seed (migration or boot script): default provider configs — "OpenCode (local)"
type=opencode base_url=`http://127.0.0.1:4096`; "Ollama (local)" type=ollama
base_url=`http://localhost:11434` — both `is_default` for their type.

House status transition rules (enforced in `house-service`): `active ⇄ disabled`;
`active|disabled → archived`; `archived` is terminal; DELETE only when `archived`.

### 5.4 API Surface (Phase 1)

Detailed request/response shapes: **ARCHITECTURE §7**. Shape of the key call:

```http
POST /api/houses
{
  "name": "House of Shadows",
  "description": "Quiet, precise engineering work after dark",
  "agent": { "name": "Azriel", "role": "Shadow-singer · senior engineer" },
  "configuration": {
    "systemPrompt": "You are Azriel…",
    "executionProvider": "opencode",
    "aiProvider": "ollama-cloud",
    "modelId": "glm-5.3",
    "workspaceAllowlist": ["/home/kate/development/personal-projects/velaris"],
    "tools": ["fs", "shell", "git"],
    "permissions": { "fileSystem": "ask", "shell": "ask", "network": "deny", "git": "allow" },
    "approvalPolicy": "always",
    "concurrency": 1
  }
}
→ 201 { house: { id, name, description, status: "active", agent: {…}, configuration: {…}, createdAt, updatedAt } }
→ 400 { error: "ZodError", issues: [...] }   → 422 on invalid status transition
```

### 5.5 Acceptance Criteria

- [ ] `npm run dev` starts web (:3000) and engine stub via `scripts/dev.js`; both log health.
- [ ] `npm run db:migrate && npm run db:generate` workflows work; SQLite in WAL mode; migrations auto-apply on boot.
- [ ] House create/edit form supports **all** config properties from the spec; validation errors render inline (sonner + field errors).
- [ ] Houses can be disabled/enabled/archived; archive hides from default list (filter tab); delete only from archived.
- [ ] Project registration validates a real, absolute, existing directory; duplicate directory rejected; git info auto-detected when dir is a repo.
- [ ] Provider config CRUD works; defaults seeded.
- [ ] Tasks can be created and listed on the Quest Board; status locked to `queued`/`cancelled`; no execution behavior.
- [ ] All 8 nav sections render placeholder pages; sidebar active states work.
- [ ] Dark Velaris theme applied (tokens from ARCHITECTURE §10); `prefers-reduced-motion` respected.
- [ ] All tests pass (§5.6).

### 5.6 Test Strategy

- **Unit (Vitest):** zod schemas (valid/invalid/edge cases per field); `resolveSafePath`
  allowlist logic; house status transition rules; repo CRUD against a temp SQLite file.
- **Integration (Vitest):** API route handlers invoked directly with `new Request(...)`
  against temp DB — happy path + 400/404/409/422 for each resource.
- **E2E (Playwright):** one smoke test: open `/`, navigate to Houses, create House of
  Shadows via the form, see it in the grid, edit it, disable it. (Playwright infra set up
  now so Phase 2 can extend.)

### 5.7 Risks (Phase 1)

- better-sqlite3 native build vs Node 20 → use current version, prebuilt binaries; fallback documented.
- shadcn/ui init churn → pin versions; record generated component list.
- Next 15 async `params`/`searchParams` breaking habits → use `await params` in route handlers/pages.

---

## 6. Phase 2 — Real Execution & Approvals Core

**Goals:** One house executes a real OpenCode task end-to-end; messenger-bird approvals
work functionally (badge + panel, minimal visuals); state survives browser refresh.

**Deliverables**
- Engine: task queue loop (poll `tasks` status='queued'), one OpenCode server lifecycle manager
  (spawn/attach `opencode serve --port 4096`, health via `GET /api/health`), session create
  (`POST /session {directory}`) + `POST /session/{id}/init` + prompt
  (`POST /session/{id}/prompt {providerID, modelID, prompt}`), SSE ingestion
  (`GET /event?directory=…` with reconnect), abort (`POST /session/{id}/abort`).
- OpenCode adapter implementing `AgentExecutionProvider` (AGENT_ORCHESTRATION §2).
- Event mapping → `execution_events` rows; house status transitions (AGENT_ORCHESTRATION §4).
- Approval pipeline: `permission.updated`/`question.updated` events → `approval_requests` +
  `notifications` rows → minimal bird indicator + panel on the house card → Approve/Reject/Reply
  → engine calls `POST /permission/{id}/reply` / `POST /question/{id}/reply` / `/reject` →
  execution resumes. Unread counts on Messenger Roost nav item.
- Session completion: persist `cost`, `tokens{input,output,reasoning,cache}`, diff fetch
  (`GET /session/{id}/diff`), artifacts, results snapshot; task → `completed`/`failed`.
- Basic agent chat: send message to the active session via the prompt endpoint; render replies from events.
- Model picker backed by `GET /api/model` (via engine proxy) for house configuration.
- `/api/stream` SSE pushes live events to the browser (ARCHITECTURE §4 mechanism).

**Acceptance criteria:** MVP journey steps 1–5, 8, 10, 11, 13(raw), 14, 15 (see §11) pass with
real OpenCode; a task that triggers a file-write permission shows a bird; approving resumes
execution; refresh preserves everything; kill-the-engine-mid-task leaves recoverable state
(requeue orphans on boot).

**Test strategy:** Vitest for adapter (mocked OpenCode HTTP), event mapper, status machine,
queue loop; Playwright happy-path with a scripted real OpenCode task (fast model) incl.
permission approval; SSE reconnect test (kill engine, restart, browser recovers).

**Risks:** OpenCode event schema drift → mapper tolerates unknown types, contract test pins
verified types; SSE dropped events → engine reconciles with `GET /session/{id}` on reconnect;
long prompts vs. engine liveness → heartbeat + restart policy.

---

## 7. Phase 3 — Velaris World & Messenger Roost

**Goals:** The city becomes the product; the acceptance journey is fully polished.

**Deliverables:** Interactive city view (SVG/canvas of Velaris at night, houses plotted per
house entity); house visualizations with the full animation set (idle, planning pulsing
lights, working chimney smoke/particles, waiting-approval/input messenger bird, blocked,
completed fireworks-once-per-task, failed, paused, offline dim) with a global
reduced-motion toggle; Messenger Roost hub (all notifications/approvals, unread counts,
filters); house workspace panel with 4 tabs (Overview, Activity timeline, Agent Chat,
Task Results with diffs); real-time updates over `/api/stream` driving animations.

**Acceptance criteria:** all 16 MVP journey steps pass end-to-end and *feel* like Velaris;
animations hold 60fps with ≤6 active houses (performance budget ARCHITECTURE §10);
reduced-motion mode replaces particle animations with static indicators.

**Test strategy:** Playwright journey test (full 16 steps); performance test measuring frame
budget via trace; unit tests for status→animation mapping and once-per-task fireworks guard.

**Risks:** animation perf → CSS transform/opacity only, particle caps, canvas offloading;
over-engineering the city → ship a static layout first, interactivity per house only.

---

## 8. Phase 4 — High Lord

**Goals:** Orchestrated multi-house execution.

**Deliverables (implemented, 2026-09-24):** High Lord as special house (auto-created `kind='high_lord'`); Court chat (`/high-lord`) receives instructions and steers an active plan; planning prompt pattern produces structured plan JSON (zod-validated); subtasks created with parent task links; handoffs table keyed by house ids (not agent ids); sequential + parallel DAG scheduling with dependency tracking; loop safeguards (max delegation depth = 1, max subtasks = 8 default, token budget); retry-then-abort replaces the escalation bird (a failed subtask retries up to 3× then aborts the plan with an `abortReason` on the parent's `execution_preferences`); consolidated results on the parent task; usage rollup per task; map gold-plating (gold High Lord castle at the city heart + burning overlay while aborted).

**Acceptance criteria (ticked):** "Ask the High Lord to do X" produces a plan, delegates to ≥2 houses (one parallel pair), consolidates results. **Ticked 2026-09-24.** Delegation loop attempts are capped and surfaced; token budget enforced. Direct-to-house assignment still works (vitest + e2e regression green).

**Test strategy:** Vitest for planner parsing, DAG scheduler, safeguards, plan-service, plan-depth; court-routes integration; Playwright `phase4-court.spec.ts` for the Court journey, aborted visuals, map gold, and the direct-assignment regression.

**Risks:** plan JSON unreliability → strict zod + one repair retry + fallback to single-task; orchestrator runaway cost → max-subtask and token budgets per plan.

---

## 9. Phase 5 — Ollama-Native Agent Runtime & Advanced Execution

**Goals:** Houses with `executionProvider='ollama'` run as first-class Velaris agents, not
bare model calls.

**Deliverables:** Ollama adapter (HTTP API, configurable base_url, health check);
Velaris agent runtime = tool loop (model call → tool_use → permission-gated execute →
tool_result → repeat), tool set (fs read/write within allowlist, shell exec with approval,
web fetch off by default), conversation memory in `agent_messages`, per-agent task state
machine; **native pause/resume** for this provider (explicitly possible here, unlike OpenCode);
estimated cost tracking (pricing table, `estimated=true`); explore `/experimental/worktree`
for coding-task isolation as a flag-gated option.

**Acceptance criteria:** an ollama-direct house completes a research task using tools with
correct permission gating; pausing actually suspends the loop; costs marked as estimates.

**Test strategy:** Vitest tool-loop with mocked Ollama chat API (incl. tool_use fixtures);
permission gating matrix tests; pause/resume unit tests; Playwright smoke with local Ollama
if available (skipped otherwise — no local server on this machine, tests use mocks).

**Risks:** no local Ollama server → all tests mock the HTTP API; runtime complexity →
strictly reuse the same adapter interface and event model as OpenCode.

### Acceptance & Retro (2026-09-24)

**Acceptance checklist (mapped to the criteria above):**

- [x] **(a) An ollama-direct house completes a research task using tools with correct
      permission gating.** Proven by the deterministic **mocked** smoke
      `tests/unit/ollama-runtime.test.ts` (no local Ollama server on this machine; the loop
      executes `fs_read`/`fs_write` within the allowlist and feeds `tool_result`s back,
      including an approval round-trip). Supporting matrix: `ollama-permissions`,
      `ollama-approval`, `ollama-tools`.
- [x] **(b) Pausing actually suspends the loop.** `tests/unit/ollama-pause.test.ts` +
      `tests/integration/ollama-pause-routes.test.ts`; no model call or tool execution occurs
      while paused and resume continues in place from `agent_messages` memory. OpenCode houses
      correctly report that they cannot pause (409).
- [x] **(c) Costs are marked as estimates.** `tests/unit/ollama-pricing.test.ts` + usage
      aggregation: every Ollama `usage_records` row is `estimated=1`, surfaced with an
      "estimated" label on house overview, Court plan rollup and task results; provider-reported
      OpenCode rows stay `estimated=0`.

**Deliverables status (all landed):** Ollama adapter + `GET /api/version` health check
(configurable base_url); Velaris agent runtime tool loop (model call → tool_use →
permission-gated execute → tool_result → repeat); tool set (fs read/write within allowlist,
shell exec with approval, git; web-fetch absent unless the per-house network opt-in is set,
default `deny`); conversation memory in `agent_messages` (extended with
`tool_calls`/`tool_call_id` + role `'tool'`, no new table); native pause/resume for this
provider; estimated cost tracking (`provider_configs.extra.modelPricing`, missing price ⇒
cost 0 but `estimated=true`); flag-gated **inert** worktree scaffold
(`experimental.worktreeIsolation`, default OFF, OpenCode-only); UI surface (provider-aware
pause/resume controls, estimated labels, Settings pricing editor + worktree flag, Ollama
model picker via `/api/tags`, High Lord/ollama 422 guard).

**Deviations / notable decisions:** Q1–Q12 accepted defaults are recorded in
`docs/superpowers/plans/2026-09-24-phase5-ollama-runtime.md` §18 — that addendum is the
source of truth and supersedes the plan's own sections. Notable items: prompt-parsed
ReAct fallback **DEFERRED** (Q2; native `message.tool_calls` only); paused map animation
**DEFERRED** to Phase 5.1 (Q10; badge + runtime status only); High Lord + `ollama`
**disallowed with 422** (Q9); worktree is an **INERT scaffold**, `/experimental/worktree`
live behavior **UNVERIFIED** (Q7); the usage record is written **once at terminal** (not
per model call) to keep aggregation honest; `risky_only` treated as `always` for parity
with the OpenCode runner (Q11).

**Most significant defects found by independent testing/review and fixed during the phase:**

1. **Migration `0004` destroyed existing execution data via FK cascade.** Drizzle runs all
   migration statements in one transaction, so the in-file `PRAGMA foreign_keys=OFF` was a
   no-op; the CHECK-rebuild `DROP TABLE` cascaded into every child table. Fixed generally in
   `src/lib/db/migrate.ts` by disabling FKs on the raw connection *before* the migrator and
   running `foreign_key_check` after — this also protects the latent identical pattern in
   `0001`.
2. High Lord supervisor ran while OpenCode was unhealthy.
3. Resume stranded a queued-paused task.
4. Usage/token aggregation overcounted multi-step runs.
5. Tool args leaked into events (now redacted in the user-facing event; retained in model
   memory).
6. Shell interpreter code-string escapes (`bash -c`, combined `-lc`, absolute-path
   interpreters, `env`/`nice`/`timeout` wrappers, git `-c`) — hardened with residual risk
   documented (approval gating is the real control; the allowlist scopes cwd only).
7. `web_fetch` SSRF blocklist.
8. Ollama usage `modelId` was empty.

**Residual / known limitations:** no live Ollama server here, so the tool loop's real HTTP
contract is mock-verified only (an opt-in `@real` smoke is off the gate); non-interpreter
RCE programs (`awk` system, `find -exec`, etc.) remain reachable and OS-level isolation is
required for true containment.

---

## 10. Phase 6 — Advanced Platform

**Deliverables:** multi-agent houses (agents table 1:N activated); usage/cost dashboards
(per-house, per-task, per-model, estimated vs provider-reported); house & project templates;
workspace isolation (per-session git branches/worktrees where possible); Archives
(searchable history of sessions/events/results); monitoring dashboard (engine health,
queue depth, error rates); AuditLog surfaced in Settings.

**Acceptance criteria:** usage graphs reconcile with OpenCode-reported session cost
(±1% rounding); a template instantiates a fully configured house; archives search by
task/house/text over ≥100 historical sessions.

**Test strategy:** Vitest for aggregation queries (golden datasets); Playwright for
template instantiation and archives search; migration test from Phase 1 schema head.

**Risks:** schema migration drift → every phase ships drizzle migrations, tested against
a seeded copy of a real dev DB.

---

## 11. MVP Acceptance Journey — Phase Mapping

| # | Step | Phase |
|---|---|---|
| 1 | Create house (House of Shadows) | 1 |
| 2 | Configure OpenCode + Ollama model | 1 (config) · 2 (model picker via `/api/model`) |
| 3 | Register project | 1 |
| 4 | Create task | 1 |
| 5 | Assign to house (bypassing High Lord) | 1 (data) · 2 (execution) |
| 6 | House shows working | 2 (badge) · 3 (animation) |
| 7 | Click house → live activity | 2 (raw feed) · 3 (panel) |
| 8 | Approval needed | 2 |
| 9 | Messenger bird appears | 2 (indicator+panel) · 3 (bird animation) |
| 10 | Approve → agent resumes | 2 |
| 11 | Task completes | 2 |
| 12 | Fireworks (once per task) | 3 |
| 13 | View results (summary, files, diff, tests, errors) | 2 (raw) · 3 (results panel) |
| 14 | Browser refresh preserves state | 2 |
| 15 | Works with REAL execution provider | 2 |
| 16 | Direct-to-house assignment without High Lord | 2 (kept working in 4) |

**Definition of "MVP complete": steps 1–15 green in a single Playwright run against a real
OpenCode server after Phase 3.** Step 16 is a permanent regression test.

---

## 12. Risk Register & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| OpenCode version drift (v1.18.31 → future) | Adapter/event mapping breaks | Pin to verified endpoints (§2); engine tolerates unknown SSE event types (log + ignore); contract test re-validated on upgrade; `GET /api/health` gates execution |
| No pause/resume in OpenCode | UX promise vs. reality | Expose "pause" as explicit limitation; implement pause = `POST /session/{id}/abort` + persist conversation context + resume = new session re-prompted with context; `paused` status labeled honestly in UI |
| SSE reconnection (engine↔OpenCode, browser↔web) | Missed events, stale UI | Engine reconnect with backoff + reconcile via `GET /session/{id}` and `GET /permission`/`GET /question` snapshots; browser EventSource auto-reconnect + `Last-Event-ID`-style resume from last `execution_events.id` |
| SQLite concurrency (web + engine processes) | `SQLITE_BUSY` errors | WAL mode, `busy_timeout=5000`, short transactions, single-writer pattern for hot tables (engine writes events; web writes domain rows); INTEGER PK autoincrement for `execution_events` enables `id > lastSeenId` polling |
| No local Ollama server | Direct-Ollama features untestable live | Phase 2 model access via OpenCode's `ollama-cloud` provider; direct adapter (Phase 5) fully unit-tested against mocked HTTP API; base_url configurable |
| Cost estimation inaccuracy | Misleading dashboards | OpenCode houses: use provider-reported `cost`/`tokens` (verified fields); Ollama-direct: pricing table in settings, every row flagged `estimated=true` |
| Path safety (agents writing anywhere) | Data loss outside projects | `resolveSafePath` allowlist enforcement at task creation and runtime; approval gates for out-of-allowlist access; Phase 5+ explores worktrees/branches for isolation |
| Port conflicts (4096, 3000) | Engine can't start | Configurable via env; engine probes `GET /api/health` and attaches to an existing server before spawning |
| Engine crash mid-task | Orphaned sessions, stuck statuses | Heartbeat row; on boot, requeue `queued` tasks, mark in-flight sessions `interrupted` and reconcile against `GET /session`; task can be re-run (new session) |
| Animation performance | Janky city | Performance budget (ARCHITECTURE §10): transform/opacity only, particle caps, reduced-motion support from Phase 1 tokens |

---

## 13. Phase Gate Policy

> **Do not proceed to the next phase until the current phase is implemented and its tests pass.**

Each phase closes with: (1) all Vitest + Playwright tests green, (2) acceptance checklist
ticked in this document, (3) drizzle migrations committed, (4) a short retro appended to
this file's phase section listing deviations. No phase work begins while a previous gate is red.