# Phase 6 — Advanced Platform Implementation Plan

**Date:** 2026-09-25
**Baseline:** HEAD `f0c847e` ("Phase 5: Ollama-native agent runtime"), Phases 1–5 complete.
Migration head `0004_swift_zarek`. Working tree clean. `npx tsc --noEmit` **0**.
**Author:** planning agent (no production code written)
**Source of truth for scope:** `docs/IMPLEMENTATION_PLAN.md` §10 (lines ~435–451);
risk register §12; MVP journey §11.

> **This phase is broad and partly open-ended.** The plan deliberately splits it into a
> **core 6.1** (six deliverables that are grounded, independently verifiable, and
> low-risk) and a **deferred 6.2** (real worktree isolation + optional FTS scale-up).
> The split is justified in §1 and per-stage. Everything below is verified against the
> code at HEAD, not the docs.

---

## 0. Codebase verification findings (read before implementing)

Everything below was verified against the code, not the docs. Doc/schema claims that did
NOT match code are flagged. These findings drive the plan.

### 0.1 Confirmed facts (answers to the required verification questions)

| Question | Answer (verified) |
|---|---|
| **Does an `agents` table exist?** | **YES.** `agents` (`src/lib/db/schema.ts:57-70`) has `house_id` FK → `houses` with `onDelete: cascade`, indexed by `idx_agents_house`. **The house→agent relationship is ALREADY 1:N at the schema level.** |
| **What is actually 1:1 today?** | `agent_configurations.agent_id` carries `uniqueIndex("idx_agent_configurations_agent")` (`schema.ts:98`) — i.e. **one configuration per agent**, which is *not* what blocks multi-agent. The real blocker is application-only: `createHouse()` inserts exactly one agent+config (`house-repo.ts:209-232`), `houseRowToDto()` reads `.limit(1)` (`house-repo.ts:78-92`), the UI edits a single `agent`/`configuration`, and **nothing ever writes `execution_sessions.agent_id` or a task-level agent**. |
| **Is the schema comment "Phase 6 multi-agent drops this" accurate?** | **NO — flag staleness.** Dropping `idx_agent_configurations_agent` is not required to have several agents under one house (each agent may keep one config). Multiple *configurations per agent* is not a Phase 6 requirement. Recommend keeping the unique index and correcting the comment. |
| **`tasks` → agent routing** | **No `tasks.agent_id` column exists.** Tasks reference `house_id`/`project_id` only (`schema.ts:158-187`). |
| **`execution_sessions.agent_id`** | Column exists (`schema.ts:216`, FK `agents(id) ON DELETE set null`) but **is never populated**: `runner.ts:101-107` and `ollama/runtime.ts:130-136` call `createExecutionSession` without `agentId`; `createExecutionSession` defaults it to null (`execution-repo.ts:77`). |
| **Existing usage/cost aggregation** | `getUsageSummaryForHouse` (`execution-repo.ts:856-901`) = SUM per house + `estimated`; `getUsageSummaryForTask` (`:913-966`) = SUM over parent + child subtasks. **No per-model, per-provider, per-time-bucket, or estimated-vs-reported breakdown query exists.** |
| **What does OpenCode report, and what do we store?** | OpenCode reports `cost` + `tokens{input,output,reasoning,cache}` via `GET /session/{id}` → `SessionInfo` (`src/server/opencode/types.ts:7-9`, normalized `client.ts:558-568`). The runner captures it in `lastCost` (`runner.ts:336-342`) and writes **exactly one** `usage_records` row at terminal with `estimated:false` (`runner.ts:557-577`), then mirrors the same values onto `execution_sessions.cost_total/tokens_*` (`runner.ts:604-611`). **Reconciliation is definitional** (we store the provider value once); the dashboard must not double-count. |
| **Ollama estimates** | `estimated:true` rows written once at terminal from `provider_configs.extra.modelPricing`; `estimated` surfaces additively on `CostSummary`/`HouseUsageSummary` (`types.ts:206-227`). |
| **Templates** | **No template mechanism exists.** Only seeds: `seedDefaultProviderConfigs` (`provider-config-repo.ts:60-90`) and `seedHighLordHouse` (`house-repo.ts:365-432`). House/project schemas in `src/shared/schemas/{house,project}.ts`; form `src/components/houses/house-form.tsx`. |
| **Workspace isolation scaffold** | Phase 5 `OpencodeClient.worktree(directory)` (`src/server/opencode/client.ts:340-346`) is **INERT and WRONG**: it issues `GET /experimental/worktree?directory=` and types the result `{ok?,isolated?}`. The real endpoint is **`POST /experimental/worktree`** with body `{name?,startCommand?}`, returning `{name, branch:"opencode/<name>", directory:"<opencodeStore>/worktree/<projectHash>/<name>"}`; listing is `GET` returning `string[]`; reset is `POST /experimental/worktree/reset {directory}`. Flag default: `experimental.worktreeIsolation` read from the default OpenCode config (`provider-config-repo.ts:198-214`), consumed **nowhere**. |
| **Is the endpoint live-verifiable on this machine?** | **YES — contrary to the Phase 5 docs.** `opencode` 1.18.32 is on PATH; the server at `http://127.0.0.1:4096` returns `{"healthy":true}`. `POST /experimental/worktree` was exercised and actually created a git worktree at `~/.local/share/opencode/worktree/<hash>/<name>` with branch `opencode/<name>`; `GET` listed it. This **supersedes** Phase 5's "unverifiable" claim (see §0.2.6). |
| **Archives** | No table. Candidate text sources: `tasks.title/description`, `execution_sessions`, `execution_events.payload`, `agent_messages.content`, `artifacts.content` (result/diff/file_list), `subtasks`. `/archives` is a placeholder (`src/app/archives/page.tsx`). Search/filter precedents: Quest Board table (`src/app/quests/page.tsx`), Roost type filter (`src/app/roost/page.tsx`). |
| **FTS5 availability** | **FTS5 IS available** in the bundled `better-sqlite3` (verified: `CREATE VIRTUAL TABLE … USING fts5` succeeds; external-content FTS5 over a text-PK table works via implicit rowid). Drizzle cannot model virtual tables in `schema.ts`; `drizzle-kit generate --custom` produces an empty migration file (verified), so FTS DDL/triggers can be committed as a custom migration. |
| **Monitoring** | `engine_state` holds `engine_heartbeat_at` + `engine_version` (`main.ts:37-38`), plus OpenCode `opencode_server_pid`/`opencode_server_started_at` (`opencode-server.ts`). `/api/health` reads only the heartbeat (`api/health/route.ts`). Queue depth: `listQueuedTaskIds(raw)` (`task-repo.ts:228`) returns ids. Error signals: `execution_events` types `error`/`task_failed` (`schema.ts:270`). No monitoring page; no count/bucket queries. |
| **AuditLog** | **Table does NOT exist.** `docs/ARCHITECTURE.md:297` claims `audit_log` is "written from Phase 1 … surfaced in Phase 6" — **false**; only `grep` hits are docs. `docs/IMPLEMENTATION_PLAN.md` §9 notes "Full `audit_log` is Phase 6" (line 881 of the Phase 5 plan). Settings page is `src/app/settings/page.tsx` (provider configs + pricing + worktree toggle + task types + appearance). |
| **Task types / reduced motion persistence** | localStorage-only (`settings/page.tsx:26-27`) — cannot be audited server-side. |
| **Web↔OpenCode read precedent** | `GET /api/models` proxies OpenCode from the web process via `src/server/services/model-service.ts`; so a web-side OpenCode health probe is consistent with existing convention. |
| **E2E / nav** | 9 `NAV_SECTIONS` (`constants.ts:38-93`); `tests/e2e/helpers.ts` is the source and `navigation.spec.ts` iterates it ("shows all 9 sections"). Adding a 10th nav item requires touching `constants.ts` + `helpers.ts` + the spec title. Archives already has a nav slot. |
| **Migration mechanism** | Drizzle migrator applies pending migrations by `folderMillis` inside **one** `BEGIN…COMMIT` (verified `node_modules/drizzle-orm/sqlite-core/dialect.cjs:663-685`), tracking `__drizzle_migrations(id, hash, created_at)`; `src/lib/db/migrate.ts` disables FKs before the migrator and runs `foreign_key_check` after. `0004` shows the CHECK-rebuild pattern. |

### 0.2 Contradictions / gotchas found (docs vs code)

1. **`audit_log` is vaporware.** ARCHITECTURE §6.2 documents it as Phase-1-written; the
   table has never existed. Phase 6 must *create* it and *retrofit* writes — this is net-new,
   not "surface an existing table".
2. **`agent_configurations` "1:1 … Phase 6 drops this" comment is misleading.** The unique
   index is per-agent, and agents are already 1:N under houses. Multi-agent does not need it
   dropped. The missing wiring is application-level (see §0.1).
3. **Phase 5's worktree client is functionally wrong**, not merely inert: wrong verb, wrong
   query, wrong return type. Any attempt to "make isolation real" must first fix the client.
4. **The worktree endpoint is live-verifiable here.** Phase 5 Q7/§Stage I and the
   IMPLEMENTATION_PLAN retro assert it is unverifiable. That is now stale: a live OpenCode
   server exists and the endpoint works. Verification is still environment-dependent (a
   Playwright/vitest gate must not require a running server), so the **live** assertion stays
   behind an opt-in `@real` tag, but it is no longer "impossible".
5. **`ARCHITECTURE.md` §3 says polling is 1s and §6.2 statuses differ from code.** Code:
   queue polls every 2s (`queue.ts:71`), `task.status` includes `paused`
   (`schema.ts:183`). Trust code/constants.
6. **`scripts/dev.js` is a custom spawner, not `concurrently`** (AGENTS.md; ARCHITECTURE §2
   stale).
7. **No `tasks.agent_id`** — "assign a quest to a specific agent" is impossible today. Multi-
   agent activation needs this column (additive `ALTER TABLE ADD COLUMN`, no rebuild).
8. **E2E never starts the engine and seeds rows directly** (`playwright.config.ts`; all specs).
   Any new server-owned derived table (e.g. an archive index) must be seedable by
   `better-sqlite3` or avoided; read-only archive queries over existing tables are therefore
   strongly preferred (see Stage D).

---

## 1. Objective

Advance Velaris from a single-agent-per-house platform to an **advanced platform** with:
multiple agents per house (activated end-to-end), usage/cost dashboards that reconcile with
provider-reported cost, reusable house/project templates, searchable archives, an engine/
queue/error monitoring surface, and an audit log surfaced in Settings. All reads stay
web-side; the engine remains the single writer for execution tables; new derived data is
attributed to exactly one writer.

**Core 6.1 (this plan's committed scope):** AuditLog foundation · multi-agent activation ·
usage/cost dashboards · house/project templates · archives search · monitoring surface ·
migration-safety harness (including the required Phase-1-head test).

**Deferred 6.2 (explicitly out of the core gate):** real per-session git-worktree isolation
(now live-verifiable, but engine- and OpenCode-path-risky and needs allowlist/cleanup design);
FTS5-backed archive indexing (LIKE satisfies the acceptance bar at MVP scale); per-agent
cost rollups; audit export/retention automation; any chart dependency; NAV/nav-section churn
for a dedicated monitoring page (a dashboard panel is sufficient).

**Non-goals that must not regress:** direct-to-house OpenCode execution, High Lord
orchestration + steering, Ollama native runtime + pause/resume, approvals round-trip, the 9
nav sections and their e2e empty-state assertions, engine single-writer discipline, and the
import boundaries in AGENTS.md.

---

## 2. What already exists vs. the delta (migration summary)

### 2.1 Tables that ALREADY suffice (no migration)

| Table | Why it's enough |
|---|---|
| `usage_records` | Has `model_id`, `provider`, `estimated`, `created_at`, `house_id`, `task_id` — every aggregate the dashboards need. |
| `execution_sessions` | Has `provider`, `model_id`, `agent_id`, cost/token columns. |
| `agents` | Already 1:N from houses. |
| `tasks` (mostly) | Needs one additive column (`agent_id`) — see 2.2. |
| `execution_events`, `agent_messages`, `artifacts` | All text the archives must search already lives here. |

### 2.2 Changes requiring a migration (`0005_*` and `0006_*`)

| Table | Change | Mechanics / risk |
|---|---|---|
| `audit_log` (NEW) | `id`, `actor`, `actor_agent_id?`, `action`, `entity_type`, `entity_id`, `payload` JSON, `created_at`. No CHECK on `action`/`entity_type` (extensible; avoids future rebuilds). | `CREATE TABLE` — additive. |
| `templates` (NEW) | `id`, `kind` CHECK `in ('house','project')`, `name`, `description`, `payload` JSON, `is_seeded`, `created_at`, `updated_at`; index `(kind)`, unique `(name, kind)`. | `CREATE TABLE` — additive. |
| `tasks.agent_id` | `TEXT REFERENCES agents(id) ON DELETE SET NULL`, nullable. | `ALTER TABLE … ADD COLUMN` — no rebuild. |
| `execution_sessions.agent_id` | **No schema change** (column exists); populate it at runtime. | Repo/runner change only. |
| `worktree_directory`, `worktree_branch` on `execution_sessions` | **(6.2 only)** nullable text. | `ALTER TABLE ADD COLUMN` — no rebuild. |
| FTS index (`archives_fts`) | **(optional, 6.2 only)** virtual table + triggers. | Custom migration; drizzle can't model it. |

**Deliberately avoided:** any CHECK-constraint alteration. `0004`'s table rebuild was the
Phase 5 incident; new columns/tables are the safe path (see §X).

### 2.3 Files that already implement part of a deliverable (scope the delta)

| Deliverable | Already present | Delta |
|---|---|---|
| Per-house usage | `getUsageSummaryForHouse` + house overview card (`house-overview.tsx:128-140`) | Add per-model/provider/time breakdowns + dashboard surface. |
| Per-task usage | `getUsageSummaryForTask` + Court plan cost line | Surface on a per-task view; add estimated-vs-reported split. |
| `estimated` flag | End-to-end | Nothing (already shipped in Phase 5). |
| Multi-agent | `agents` table, `execution_sessions.agent_id` column | Agent CRUD, DTO array, `tasks.agent_id`, runtime population, UI. |
| High Lord as a seeded singleton | `seedHighLordHouse` | Reuse the seed pattern for template defaults. |
| Archive data | All source tables + placeholder page | Query service + API + UI. |
| Audit | Nothing | Table + repo + write sites + Settings card. |

---

## 3. Deliverables — numbered stages

Ordered so the tree is always green. Each stage is independently verifiable and additive.

| Stage | Title | One-line deliverable | Size |
|---|---|---|---|
| **0** | Migration-safety harness + Phase-1-head test | Prove the full migration chain is non-destructive before adding any table | M |
| **A** | AuditLog foundation | New `audit_log` table + repo + writes at web CRUD/approval sites + Settings card | M |
| **B** | Multi-agent houses | Multiple agents per house: CRUD, DTO, routing, UI, per-agent config | L |
| **C** | House & project templates | `templates` table, seed defaults, instantiate API/UI | M |
| **D** | Archives | Read-only searchable history over tasks/sessions/artifacts/messages | L |
| **E** | Usage/cost dashboards | Aggregation queries + `/api/usage` + dashboard UI; ±1% reconciliation golden test | M |
| **F** | Monitoring surface | Engine health/queue depth/error-rate read API + dashboard panel | S–M |
| **G** | *(6.2, stretch)* Real worktree isolation | Fix the OpenCode client, wire per-session worktrees behind a flag, `@real`-verified | L |

**Recommended execution order:** 0 → A → B → C → D → E → F → (G). Stage 0 first because every
later stage adds a migration; A/B before C/D because audit and agent DTOs touch the same
service boundaries templates will use; E before F because F reuses E's aggregation helpers.

---

## 4. Stage 0 — Migration-safety harness + Phase-1-head test (M)

**Goal:** make every subsequent migration provably non-destructive, and satisfy §10's test
strategy ("migration test from Phase 1 schema head") **before** new DDL lands.

### 0.1 What to add

| File | Change |
|---|---|
| `tests/integration/migration-chain-head.test.ts` (NEW) | Build a temp DB at the **Phase 1 schema head**, seed Phase-1 + execution rows, run the real `migrate()`, assert rows survive + `foreign_key_check` empty + new columns/tables exist. |
| `tests/integration/migration-phase6-data-loss.test.ts` (NEW, mirror of `migration-0004-migrate-path.test.ts`) | Copy the real `db/velaris.db` (skip gracefully when absent), seed `audit_log`/`templates`/`tasks.agent_id`-adjacent rows, run `migrate()`, assert survival. |
| `src/lib/db/migrate.ts` | No change expected — its FK-off/`foreign_key_check` guard already generalises. Add a comment naming 0005/0006 as rebuild-free so future agents don't add in-file PRAGMAs. |

### 0.2 The Phase-1-head mechanism (precise)

There is **no committed Phase-1 snapshot**, so reconstruct it:

1. Create a temp DB, set `journal_mode=WAL`, `foreign_keys=ON`.
2. Read `drizzle/meta/_journal.json`; execute only the `0000_smiling_starbolt.sql` statements
   (split on `--> statement-breakpoint`).
3. Create `__drizzle_migrations` and insert `(hash, created_at)` using the migrator's own
   convention: `hash = sha256(sql)` of the 0000 file, `created_at = entries[0].when`
   (verified against `node_modules/drizzle-orm/migrator.cjs:56,722`).
4. Seed Phase-1 rows (a house via raw SQL, a project, a task) **plus** the execution rows a
   real pre-upgrade DB would have (mirror the existing 0004 test's seed story).
5. Call the real `migrate()` — the migrator applies 0001…head because their `folderMillis`
   exceeds the stored `created_at`.
6. Assert: seeded rows survive; `PRAGMA foreign_key_check` empty; `agent_messages.tool_calls`
   exists (0004), `audit_log`/`templates` exist, `tasks.agent_id` exists (0005+); a second
   `migrate()` is a no-op.

> This test is the enforceable interpretation of "from Phase 1 schema head". If the hash
> convention proves brittle across drizzle versions, seed `created_at = entries[0].when - 1`
> via a raw insert and document the fallback in the test header.

### 0.3 Gates

`npx tsc --noEmit` → `npm test`. No UI change; no e2e change.

---

## 5. Stage A — AuditLog foundation (M)

**Goal:** a real `audit_log` table, an append-only repo helper, writes at every **web**
user-action boundary, and a Settings surface. Engine writes are optional and minimal.

### A.1 Schema (`src/lib/db/schema.ts`) + migration `0005_*`

```ts
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    actor: text("actor").notNull(),              // 'user' | 'engine'
    actorAgentId: text("actor_agent_id"),        // optional agent:<id> attribution
    action: text("action").notNull(),            // 'create'|'update'|'delete'|'status'|'respond'|'instantiate'|…
    entityType: text("entity_type").notNull(),   // 'house'|'project'|'provider_config'|'task'|'approval'|'template'|'agent'
    entityId: text("entity_id"),
    payload: text("payload").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [
    index("idx_audit_created").on(t.createdAt),
    index("idx_audit_entity").on(t.entityType, t.entityId),
  ],
);
```

No CHECK on `action`/`entityType` so new audit verbs never force a table rebuild.

**Constants parity (same commit):** `AUDIT_ACTORS = ["user","engine"]`,
`AUDIT_ENTITY_TYPES = [...]` in `src/shared/constants.ts`; mirrored types in
`src/shared/types.ts` (`AuditActor`, `AuditEntityType`, `AuditLogDto`).

### A.2 Repo + service

New `src/server/repositories/audit-repo.ts`:

- `recordAudit(db, input)` → id (fire-and-forget, never throws into the request path;
  catch + `console.error` on failure so auditing can never break a user action).
- `listAuditLog(db, { limit?, entityType?, entityId?, actor?, from? })` → `AuditLogDto[]`.

New `src/shared/schemas/audit.ts`: `auditLogQuerySchema` (zod) — the single validation source
for `GET /api/audit-log`.

### A.3 Write sites (web services only)

Call `recordAudit` from the **service layer** (not routes), so every path is covered:

| File | Actions audited |
|---|---|
| `src/server/services/house-service.ts` | create, update (incl. config changes), status transition, delete |
| `src/server/repositories/project-repo.ts` callers / `src/app/api/projects/route.ts` + `[id]/route.ts` | create, update, delete |
| `src/app/api/provider-configs/route.ts` + `[id]/route.ts` | create, update (incl. pricing/worktree extra), delete |
| `src/app/api/approvals/[id]/respond/route.ts` | approval response (the only execution-adjacent web write) |
| Stage C instantiation | template instantiate |
| Stage B agent CRUD | agent create/update/delete |

**Engine-side (documented narrow set):** plan abort (`abortPlan`) and task terminalization
are **not** audited in core — `execution_events` + `notifications` already record them, and
duplicating execution writes in a second table risks drift. State this explicitly; if the
user wants engine audit, it is an additive follow-up.

### A.4 API + Settings surface

| File | Change |
|---|---|
| `src/app/api/audit-log/route.ts` (NEW) | `GET` with `auditLogQuerySchema`; `{ entries: AuditLogDto[] }`; `bootstrapDb()` first; `ok()`/`routeErrorOrMapped()`. |
| `src/app/settings/page.tsx` | New "Audit Log" card (client component `src/components/settings/audit-log-card.tsx`): recent N entries, entity-type filter, refresh. Read-only. |

### A.5 Tests

- `tests/unit/audit-repo.test.ts` (NEW): insert/list/filter; malformed payload tolerated;
  `recordAudit` swallows DB errors.
- `tests/integration/audit-log-routes.test.ts` (NEW, temp-DB contract): GET filters + default
  limit; house create/update/delete via the real routes writes audit rows.
- `tests/e2e` (extend `features.spec.ts` or new `phase6-audit.spec.ts`): create a house via
  the form → `/settings` Audit Log card shows the `create house` entry.
- `tests/unit/schemas.test.ts` (extend): `AUDIT_ACTORS`/`auditLogQuerySchema`.

---

## 6. Stage B — Multi-agent houses (L)

**Goal:** multiple agents per house, each independently configurable, routable, and visible;
one agent remains the house default so all existing behavior is preserved.

### B.1 Schema + migration (`0005_*`, same migration as A or its own `0006_*`)

- `tasks.agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL` (nullable).
- **Keep** `idx_agent_configurations_agent`; correct the misleading comment at `schema.ts:97`.
- Optionally add `agents.status TEXT NOT NULL DEFAULT 'active'` if per-agent disable is
  wanted — **recommend defer** (not required for activation; more CHECK-free text is safe
  but expands the surface).

### B.2 Constants/types

- `src/shared/types.ts`: `HouseDto` gains `agents: HouseAgentDto[]` (additive) while keeping
  `agent: HouseAgent` = the default/first agent (backward compatible); new
  `HouseAgentDto = { id, name, role, configuration: HouseConfiguration }`.
- `HouseAgent` stays for input.
- New zod schemas in `src/shared/schemas/house.ts`:
  - `houseAgentCreateSchema` (name, role, configuration) — reuses `houseConfigurationSchema`.
  - `houseAgentUpdateSchema = houseAgentCreateSchema.partial().strict()`.

### B.3 Repository

`src/server/repositories/house-repo.ts`:

- `houseRowToDto` loads **all** agents for the house (drop `.limit(1)`; join each config),
  returns `agents[]` + `agent` (first/oldest as default).
- `createHouse` unchanged for the default agent (existing API stays valid).
- New: `createAgent(db, houseId, input)`, `listAgentsForHouse(db, houseId)`,
  `getAgent(db, agentId)`, `updateAgent(db, agentId, patch)`, `deleteAgent(db, agentId)`
  (refuse delete when it is the house's last agent → new `LastAgentError` → 409; refuse for
  `high_lord` houses → 422, reusing the High Lord guard convention).
- `seedHighLordHouse` unchanged (one agent).

### B.4 Runtime routing (the behavioral core)

- New helper `resolveRuntimeAgent(db, house, task): { agent, configuration }`:
  - if `task.agentId` is set and belongs to the house → that agent + its config;
  - else the house's default agent (preserves all existing behavior).
- `src/engine/queue.ts` `runClaimedTask`: after loading `house`, resolve the runtime agent and
  pass it into the run context; the provider branch (`resolveProviderKind`) reads the
  **agent's** `executionProvider`, not just the house's.
- `RunContext` (`runner.ts`) gains optional `agentId`; `createExecutionSession` is called with
  `agentId` (populate at last!). `ollama/runtime.ts` likewise. When no agent id is resolvable,
  behavior is byte-identical to today (null).
- `resolveWorkspace` uses the **agent's** `workspaceAllowlist`.
- New `resolveProviderKindForAgent` (or extend the existing) in
  `src/engine/provider-factory.ts`.

**Blast-radius control:** multi-agent routing only branches when `task.agentId` is non-null.
A single-agent house behaves exactly as before, so the Phase 4/5 suites stay green.

### B.5 API + UI

| File | Change |
|---|---|
| `src/app/api/houses/[id]/agents/route.ts` (NEW) | `GET` list, `POST` create. |
| `src/app/api/houses/[id]/agents/[agentId]/route.ts` (NEW) | `PATCH`, `DELETE`. |
| `src/app/api/tasks/route.ts` + `src/shared/schemas/task.ts` | Accept optional `agentId` validated to belong to the selected house. |
| `src/components/houses/house-form.tsx` | New "Agents" tab / repeatable agent editor (or a dedicated agents management panel on `/houses/[id]`). Existing Agent tab stays for the default agent. |
| `src/components/houses/house-card.tsx` | Show agent count / default agent (additive). |
| `src/app/quests/page.tsx` | When a house has >1 agent, show an optional agent selector. |

### B.6 Tests

- `tests/unit/house-agents.test.ts` (NEW, temp DB): create/list/update/delete agents;
  last-agent delete refused; HL agent mutation refused; DTO returns `agents[]` + default.
- `tests/unit/queue-agents.test.ts` (NEW): a task with `agentId` routes to that agent's
  provider/config; a task without `agentId` is unchanged (regression).
- `tests/unit/execution-repo.test.ts` / `repositories.test.ts` (extend): session `agent_id`
  round-trips.
- `tests/integration/house-agents-routes.test.ts` (NEW): CRUD status codes; 404/409/422.
- `tests/e2e/phase6-multi-agent.spec.ts` (NEW, engine OFF): create a second agent via the UI,
  assert persistence via `GET /api/houses/{id}`; Quest Board offers the agent picker.
- Regression: `queue-loop`, `queue-ollama`, `queue-highlord`, `runner-status-machine`,
  `orchestrator` must stay green (single-agent path untouched).

---

## 7. Stage C — House & project templates (M)

**Goal:** a template instantiates a fully configured house (acceptance criterion), and
project templates seed directory/model/instructions. No engine involvement — templates are
user-action rows, so the web process owns writes (consistent with houses/projects).

### C.1 Storage decision (justified)

New `templates` table with a `payload` JSON column, **not** JSON files and not a
house-shaped table:

- JSON payload mirrors the established convention (`tasks.execution_preferences`,
  `provider_configs.extra`) and lets the configuration shape evolve without migrations.
- A `kind` discriminator gives one CRUD surface for house + project templates.
- Validated on write by reusing `houseCreateSchema`/`projectCreateSchema` (minus fields that
  only make sense at instantiation, e.g. `directory`).
- Seeded defaults reuse the same idempotent pattern as `seedDefaultProviderConfigs`.

```ts
export const templates = sqliteTable("templates", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),                 // 'house' | 'project'
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  payload: text("payload").notNull().default("{}"),
  isSeeded: integer("is_seeded", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(now()),
  updatedAt: text("updated_at").notNull().default(now()),
}, (t) => [
  index("idx_templates_kind").on(t.kind),
  uniqueIndex("idx_templates_name_kind").on(t.kind, t.name),
  check("ck_templates_kind", sql`kind in ('house','project')`),
]);
```

### C.2 Repo / schemas / seed

| File | Change |
|---|---|
| `src/server/repositories/template-repo.ts` (NEW) | CRUD (`listTemplates({kind})`, `getTemplate`, `createTemplate`, `updateTemplate`, `deleteTemplate` — seeded templates immutable), `seedDefaultTemplates()` idempotent by `(kind,name)`. |
| `src/server/repositories/house-repo.ts` | Reuse `createHouse` for instantiation (no new write path). |
| `src/shared/schemas/template.ts` (NEW) | `templateCreateSchema` discriminated on `kind`; `houseTemplatePayloadSchema` (reuse `houseCreateSchema` minus name optional), `projectTemplatePayloadSchema` (reuse `projectCreateSchema` with `directory` optional/instantiation-supplied). |
| `src/shared/constants.ts` | `DEFAULT_TEMPLATES` (e.g. "Research House", "Engineering House", "Docs House"; project "Standard Repo") + `TEMPLATE_KINDS`. |
| `src/server/bootstrap.ts` + `src/engine/main.ts` | Call `seedDefaultTemplates(raw)` (symmetric, idempotent). |

### C.3 Instantiation

New `src/server/services/template-service.ts`:
- `instantiateHouseTemplate(db, templateId, overrides)` → validates the merged payload with
  `houseCreateSchema`, calls `createHouse`, returns the `HouseDto`; records audit (Stage A).
- `instantiateProjectTemplate(db, templateId, overrides)` → `directory` must be supplied (or
  defaults to a project created with it) and validated by `createProject`'s existing
  `assertValidDirectory`/`assertDirectoryUnique`.

### C.4 API + UI

| File | Change |
|---|---|
| `src/app/api/templates/route.ts` (NEW) | `GET ?kind=` list; `POST` create. |
| `src/app/api/templates/[id]/route.ts` (NEW) | `GET`/`PATCH`/`DELETE` (seeded protected). |
| `src/app/api/templates/[id]/instantiate/route.ts` (NEW) | `POST` → 201 `{ house }` or `{ project }`. |
| `src/app/houses/page.tsx` | "New from template" affordance (opens the house form prefilled from the template). |
| `src/app/projects/page.tsx` | Same for projects. |
| `src/app/settings/page.tsx` | Optional template manager card (list/create/delete). |

### C.5 Tests

- `tests/unit/template-repo.test.ts` (NEW): CRUD; seeded immutability; idempotent seed.
- `tests/integration/template-routes.test.ts` (NEW): create template; instantiate house →
  assert the created house has the template's agent/config/allowlist; zod 400s; 404; 409 on
  duplicate name; audit row present.
- `tests/e2e/phase6-templates.spec.ts` (NEW, engine OFF): instantiate a seeded house template
  via the UI → `/houses/{id}` shows the configured model/allowlist; instantiate a project
  template → `/projects` shows it.

---

## 8. Stage D — Archives (L)

**Goal:** searchable history of sessions/events/results satisfying "search by task/house/text
over ≥100 historical sessions" with **no new writer and no engine coupling**.

### D.1 Storage/search decision (justified, honest)

**Recommended core: read-only query over existing tables with `LIKE` + indexes. No new
table, no FTS5, no engine writer.**

- Acceptance bar is 100s of sessions — a bounded `LIKE` + `LIMIT`/`OFFSET` is fine there.
- E2E boots **web-only** and seeds rows directly; a read-only repository works with zero
  extra seeding and never needs the engine.
- The engine's single-writer rule is untouched (no derived table to keep in sync).
- **FTS5 is available and verified**, but introducing it as a materialized index is a 6.2
  upgrade: it needs a custom migration, sync triggers, a backfill, and an owner — all cost
  with no benefit at the acceptance scale. Documented as Open Question Q5.

Search surface (repository `src/server/repositories/archive-repo.ts`):
- Base: terminal tasks (`status in ('completed','failed','cancelled','interrupted')`) joined
  to `houses` (name), left-joined to `execution_sessions`/`usage_records` for cost/model.
- Text match: task `title`/`description`, plus result-artifact/agent-message content via an
  `EXISTS` subquery on `artifacts`/`agent_messages` for the task's sessions.
- Filters: `q`, `houseId`, `status`, `type`, `from`, `to`; order `created_at DESC`;
  pagination `limit`/`offset` (default 25, cap 100).
- Add supporting indexes if needed (task status/created index exists; consider
  `idx_tasks_created` and `idx_artifacts_task` — the latter exists).

### D.2 Types / service / API

| File | Change |
|---|---|
| `src/shared/types.ts` | `ArchiveEntryDto` (task, house, status, type, model, sessionCount, cost, summarySnippet, createdAt), `ArchiveQuery`. |
| `src/shared/schemas/archive.ts` (NEW) | `archiveQuerySchema` (single validation source). |
| `src/server/services/archive-service.ts` (NEW) | `searchArchives(db, query)` → `{ entries, total }`; pure read. |
| `src/app/api/archives/route.ts` (NEW) | `GET` → `{ entries, total }`. |
| `src/app/archives/page.tsx` | Replace placeholder: search input, house/status/type filters, paginated result table, link to the task/house. |

### D.3 Tests

- `tests/unit/archive-repo.test.ts` (NEW, temp DB, **golden dataset ≥100 sessions**): seed
  100+ terminal tasks + sessions + result artifacts; assert search-by-title, by-house, by
  text-in-artifact, status/date filters, pagination, and total counts.
- `tests/integration/archives-route.test.ts` (NEW): query params honoured; empty result shape;
  zod 400.
- `tests/e2e/phase6-archives.spec.ts` (NEW, engine OFF; seed 100+ rows via `better-sqlite3`):
  type a text query → only matching archive rows show; filter by house; ≥100 seeded sessions
  remain searchable and the result count is correct.

### D.4 6.2 upgrade (documented, not built)

If text volume outgrows `LIKE`: add an `archives_fts` external-content FTS5 table via
`drizzle-kit generate --custom`, keep `archive_entries` (or index `tasks` directly), add
AFTER INSERT/UPDATE/DELETE triggers, and a boot backfill. Owner decision required (engine vs
web). **Do not build in core.**

---

## 9. Stage E — Usage/cost dashboards (M)

**Goal:** per-house, per-task, per-model, and estimated-vs-provider-reported views whose
aggregates reconcile with OpenCode-reported session cost within ±1%.

### E.1 Aggregation queries (`src/server/repositories/usage-repo.ts`, NEW — keep
`execution-repo.ts` focused)

| Function | Returns |
|---|---|
| `getUsageByHouse(db, {from?,to?})` | totals grouped by `house_id` |
| `getUsageByModel(db, {houseId?,from?,to?})` | totals grouped by `model_id, provider, estimated` |
| `getUsageByTask(db, taskId)` | reuse `getUsageSummaryForTask` |
| `getUsageTotals(db, {houseId?,from?,to?})` | `{ totalCost, inputTokens, outputTokens, estimatedCost, reportedCost }` |
| `getUsageTimeSeries(db, {bucket:'day'|'hour', from, to})` | cost/tokens per bucket |

`estimatedCost` vs `reportedCost` split via `SUM(CASE WHEN estimated=1 THEN cost END)`.
All are `GROUP BY` reads over `usage_records` — **no writes**.

### E.2 Types / API

- `src/shared/types.ts`: `UsageBreakdownDto`, `UsageTotalsDto`, `UsageSeriesPointDto`.
- `src/shared/schemas/usage.ts` (NEW): `usageQuerySchema`.
- `src/app/api/usage/route.ts` (NEW): `GET ?houseId=&taskId=&modelId=&from=&to=&bucket=`
  returning the relevant aggregate(s); `bootstrapDb()`; `ok`/`routeErrorOrMapped`.

### E.3 UI (no chart dependency)

- **Chart approach:** CSS bar rows (`div` widths) + an inline SVG sparkline for the time
  series. **No new dependency** (AGENTS.md). Animations must be **transform/opacity only**,
  reduced-motion aware (the `globals.css` convention).
- Placement (low-churn recommendation): a "Usage & Cost" panel on the root dashboard
  (`src/app/page.tsx` via a new client component `src/components/dashboard/usage-panel.tsx`),
  plus a breakdown on the existing house overview (`house-overview.tsx`) and the Court plan
  cost line. Per-task detail already exists via `getUsageSummaryForTask`.
- A dedicated `/usage` page is an alternative but requires a 10th `NAV_SECTIONS` entry and
  `helpers.ts`/`navigation.spec.ts` updates — Open Question Q7.

### E.4 Reconciliation test (the acceptance criterion, proven deterministically)

- `tests/unit/usage-reconciliation.test.ts` (NEW): **golden dataset** of N sessions with
  known provider-reported costs (fixtures, e.g. `0.0123`, `0.0007`, `1.5`), written to
  `usage_records` with `estimated=false` and mirrored on `execution_sessions.cost_total`.
  Assert:
  1. `getUsageTotals()` total == Σ `execution_sessions.cost_total` == Σ fixture costs;
  2. relative error ≤ 1% after the documented display rounding (4 dp per row, 2 dp total);
  3. `estimatedCost + reportedCost == totalCost`;
  4. a mixed set (some Ollama `estimated=true`) does not contaminate `reportedCost`.
- **No live provider is required** — the fixtures are the provider-reported values. An opt-in
  `@real` smoke (run a real OpenCode session, compare `GET /session/{id}.cost` to our stored
  row) is documented but **off the gate**; a live server exists here, so it is possible, but
  the gate must not depend on it.
- `tests/unit/usage-repo.test.ts` (NEW): per-house/per-model/time-series golden assertions.
- `tests/integration/usage-route.test.ts` (NEW): query params + shapes.
- `tests/e2e/phase6-usage.spec.ts` (NEW, engine OFF; seed `usage_records`): dashboard renders
  totals, per-model rows, and the estimated badge for a seeded estimated row.

---

## 10. Stage F — Monitoring surface (S–M)

**Goal:** engine health, queue depth, and error rates visible without a new nav section.

### F.1 Read API (`src/app/api/monitoring/route.ts`, NEW)

Single `GET` returning `MonitoringDto`:

| Field | Source |
|---|---|
| `engineHeartbeatAt`, `heartbeatAgeMs`, `engineVersion` | `engine_state` (`engine_heartbeat_at`, `engine_version`) |
| `opencodeServerPid` | `engine_state` (`opencode_server_pid`) |
| `queueDepth` | count of `tasks.status='queued'` (new `countTasksByStatus`) |
| `runningCount` | count of `tasks.status='running'` |
| `errorsLast24h`, `failuresLast24h`, `eventsLast24h` | `execution_events` grouped by type since a timestamp (new `countEventsByTypeSince`) |
| `providerHealth` | best-effort OpenCode `GET /api/health` (web-side read, consistent with `/api/models`); tolerate unreachable → `false` |

New repo helpers in `task-repo.ts` (`countTasksByStatus`) and `execution-repo.ts`
(`countEventsByTypeSince`, `getEngineStateKey`). All reads.

### F.2 UI

- Panel on the root dashboard (`src/components/dashboard/monitoring-panel.tsx`, client):
  heartbeat age badge (stale if > ~15s), queue depth, running count, 24h error/failure rates,
  provider health. Poll on a modest interval (e.g. 5s) or reuse `sequence`; **no new SSE
  event type** (the established "event arrived → refetch REST" pattern).
- Placeholder/empty state when the engine has never run (heartbeat null) — essential for the
  engine-off e2e environment.

### F.3 Tests

- `tests/unit/monitoring-repo.test.ts` (NEW): counts/rates from seeded rows; missing heartbeat
  → null.
- `tests/integration/monitoring-route.test.ts` (NEW): shape; provider-unreachable tolerated.
- `tests/e2e/phase6-monitoring.spec.ts` (NEW, engine OFF): dashboard shows "engine offline"
  empty state; seed `engine_state` + queued/error rows directly → panel shows depth/rates.

> If the user prefers a dedicated `/monitoring` page, it requires updating
> `NAV_SECTIONS` (10 entries) + `tests/e2e/helpers.ts` + the `navigation.spec.ts` "9 sections"
> title. That is contained but is nav churn — Open Question Q7.

---

## 11. Stage G — *(6.2, stretch)* Real worktree isolation (L)

**Goal (deferred):** per-session git worktrees for OpenCode houses, behind a flag, default off.

### G.1 What "real" requires (grounded in the live endpoint)

1. **Fix the client** (`src/server/opencode/client.ts`): replace the wrong `worktree()`
   (GET, `{ok,isolated}`) with:
   - `createWorktree({name?, startCommand?})` → `POST /experimental/worktree` →
     `{ name, branch, directory }`;
   - `listWorktrees()` → `GET /experimental/worktree` → `string[]`;
   - `resetWorktree({directory})` → `POST /experimental/worktree/reset`.
2. **Persistence:** `execution_sessions.worktree_directory`, `worktree_branch` (nullable
   `ALTER TABLE ADD COLUMN`).
3. **Wiring (engine, OpenCode branch only):** when the flag is on, before
   `executeTask`, create/reuse a worktree and pass its `directory` as the run directory;
   store the mapping; reset/clean up on terminal; reconcile orphans on boot.
4. **Allowlist interaction (the hard part):** worktrees live under
   `~/.local/share/opencode/worktree/<hash>/<name>`, **outside** the house allowlist, so
   `resolveSafePath` would reject. Needs an explicit, documented exception (allow the
   OpenCode worktree root only when the flag is on) or a per-house opt-in.
5. **UI:** expose the flag (already in Settings) + surface the worktree directory/branch on
   the house activity panel.

### G.2 Verifiability (honest)

- **Live-verifiable on this machine** (contradicting Phase 5's claim): server 1.18.32 at
  `127.0.0.1:4096`, `POST /experimental/worktree` creates a real worktree. Verified by hand.
- **Gate-safe coverage:** unit tests with an injected `fetchImpl` pin the request/response
  shapes; the flag-off path asserts **no call** is made. A live `@real`-tagged test (skipped
  unless the server is reachable) is the deterministic-but-opt-in substitute. **E2E never
  requires a live server.**
- Risks: orphaned worktrees/branches, `opencode/*` branch pollution, cleanup on crash, and
  the allowlist exception. Recommend keeping it **default off** and out of the core gate.

### G.3 Tests (if pursued)

- `tests/unit/worktree-client.test.ts`: create/list/reset shapes via injected `fetchImpl`;
  flag-off makes no call.
- `tests/unit/queue-worktree.test.ts`: flag-on routes the session to the worktree directory;
  flag-off is byte-identical to today.
- `tests/unit/opencode-worktree-real.test.ts` (`@real`, opt-in): create → list → reset against
  the local server.

---

## 12. Schema drift / migration safety (dedicated)

**Context:** the Phase 5 `0004` incident — drizzle wraps all migration statements in one
transaction, so an in-file `PRAGMA foreign_keys=OFF` was a no-op and the CHECK-rebuild
`DROP TABLE` cascaded into every child table. `src/lib/db/migrate.ts` now disables FKs on the
raw connection *before* the migrator's `BEGIN` and runs `PRAGMA foreign_key_check` after.
`tests/integration/migration-0004-migrate-path.test.ts` is the permanent guard.

**Phase 6 rules:**

1. **No CHECK-constraint alteration in 6.1.** Every 6.1 change is `CREATE TABLE` or
   `ALTER TABLE … ADD COLUMN` (including `tasks.agent_id`). No rebuilds.
2. **Do not emit in-file PRAGMA toggles.** If a future migration must rebuild, rely on the
   existing `migrate.ts` FK-off guard and add a regression test.
3. **Constants/types parity in the same commit** as the schema edit (AGENTS.md): enum-like
   values mirror CHECKs.
4. **Commit generated `drizzle/0005_*.sql` + `drizzle/meta/*`.** Virtual-table DDL (only if
   FTS5 is pursued) uses `drizzle-kit generate --custom` (verified) and must be hand-written;
   it is *not* modelled in `schema.ts`.
5. **Test against a seeded copy of a real DB** and **from the Phase 1 schema head** (§4).
   Both exist as committed tests, not manual checks.
6. **`foreign_key_check` must be empty** after every migration test; a non-empty result is a
   hard failure.
7. **Idempotence:** a second `migrate()` is a no-op (assert in both migration tests).

**Risk:** if multi-agent ever wants *multiple configurations per agent* (not required), the
unique index must be dropped — a simple `DROP INDEX`, still rebuild-free, but re-plan it.

---

## 13. Testing strategy (consolidated)

### 13.1 Conventions to follow (verified)

- Unit `tests/unit/**` + `src/**/*.test.ts`; node env; real temp DB + `migrate()` +
  `resetDbForTests()` for DB-backed tests (see `execution-service.test.ts`,
  `house-seed.test.ts`).
- Integration `tests/integration/**`: set `VELARIS_DB_PATH` **before importing route
  modules**; `resetDbForTests()` + `resetBootstrapForTests()` in `beforeEach`; invoke handlers
  with `new NextRequest()`. Follow `tests/integration/api-routes.test.ts`.
- E2E: engine **off**, web-only, rows seeded via `better-sqlite3`, `workers:1`, shared e2e DB
  wiped by the Playwright `webServer` command. Never point e2e at a real provider.
- Aggregation tests use **golden datasets** (explicit expected sums/counts), not live data.
- Never run `npm run lint` (no config; `next lint` is interactive). **Zero dependency
  additions** — dashboard charts are CSS/SVG; no motion library; FTS is a SQLite built-in.

### 13.2 New/changed test files

| File | Covers |
|---|---|
| `tests/integration/migration-chain-head.test.ts` (NEW) | Full chain from Phase-1 head; survival + `foreign_key_check`. |
| `tests/integration/migration-phase6-data-loss.test.ts` (NEW) | Seeded real-DB upgrade guard. |
| `tests/unit/audit-repo.test.ts` (NEW) | Audit append/list/filter; never throws. |
| `tests/integration/audit-log-routes.test.ts` (NEW) | Audit API + service-boundary writes. |
| `tests/unit/house-agents.test.ts` (NEW) | Agent CRUD/guards/DTO. |
| `tests/unit/queue-agents.test.ts` (NEW) | Per-agent routing + no-agent regression. |
| `tests/integration/house-agents-routes.test.ts` (NEW) | Agent API status codes. |
| `tests/unit/template-repo.test.ts` (NEW) | Template CRUD/seed/immutability. |
| `tests/integration/template-routes.test.ts` (NEW) | Instantiation → configured house/project. |
| `tests/unit/archive-repo.test.ts` (NEW) | ≥100-session golden search. |
| `tests/integration/archives-route.test.ts` (NEW) | Query validation + shapes. |
| `tests/unit/usage-repo.test.ts` (NEW) | Per-house/model/series golden math. |
| `tests/unit/usage-reconciliation.test.ts` (NEW) | ±1% reconciliation (the criterion). |
| `tests/integration/usage-route.test.ts` (NEW) | Usage API. |
| `tests/unit/monitoring-repo.test.ts` + `tests/integration/monitoring-route.test.ts` (NEW) | Health/depth/rates. |
| `tests/e2e/phase6-audit.spec.ts`, `phase6-multi-agent.spec.ts`, `phase6-templates.spec.ts`, `phase6-archives.spec.ts`, `phase6-usage.spec.ts`, `phase6-monitoring.spec.ts` (NEW) | UI surfaces (engine off). |
| `tests/unit/schemas.test.ts` (extend) | New constants/schemas. |
| `tests/unit/repositories.test.ts` / `execution-service.test.ts` (extend) | `agent_id` round-trip; additive DTO fields. |

### 13.3 Gate order

`npx tsc --noEmit` → `npm test` → `npm run test:e2e` (UI/routes changed ⇒ all three).
Never `npm run lint`. No dependency changes.

---

## 14. Acceptance checklist (mapped to `IMPLEMENTATION_PLAN.md` §10)

- [ ] **Usage graphs reconcile with OpenCode-reported session cost (±1% rounding).** —
      `tests/unit/usage-reconciliation.test.ts` golden dataset: dashboard totals == Σ
      provider-reported `execution_sessions.cost_total` within 1% after documented rounding;
      `estimatedCost + reportedCost == totalCost`. Proven with fixtures, **no live provider
      required**; an opt-in `@real` smoke is documented but off the gate. (Stage E)
- [ ] **A template instantiates a fully configured house.** —
      `tests/integration/template-routes.test.ts` + `tests/e2e/phase6-templates.spec.ts`:
      seeded template → instantiate → the returned house carries the template's agent,
      configuration (provider/model/prompt/allowlist), then persists and is editable normally.
      (Stage C)
- [ ] **Archives search by task/house/text over ≥100 historical sessions.** —
      `tests/unit/archive-repo.test.ts` (100+ golden rows) + `tests/e2e/phase6-archives.spec.ts`
      (100+ seeded sessions): text query, house filter, and pagination all correct. (Stage D)
- [ ] **Migration test from Phase 1 schema head.** — `migration-chain-head.test.ts` builds the
      Phase-1 head via `_journal.json`, seeds, runs the real `migrate()`, asserts survival +
      empty `foreign_key_check` + idempotence. (Stage 0)
- [ ] **AuditLog surfaced in Settings.** — `audit_log` table + writes at house/project/
      provider-config/template/approval boundaries + `/api/audit-log` + Settings card.
      (Stage A)
- [ ] **Multi-agent houses (agents table 1:N activated).** — ≥2 agents per house with
      independent configuration; a quest can target a specific agent; single-agent behavior
      byte-identical (regression suites green). (Stage B)
- [ ] **Monitoring dashboard (engine health, queue depth, error rates).** — `/api/monitoring`
      + root-dashboard panel; engine-off empty state pinned by e2e. (Stage F)
- [ ] **Engine single-writer / web read-only preserved.** — Audit/templates are web-owned
      user-action rows; dashboards/archives/monitoring are pure reads; sessions' `agent_id`
      is populated by the engine only. (all stages)
- [ ] **Gates green:** `npx tsc --noEmit` (0), `npm test`, `npm run test:e2e`. No dependency
      changes; `npm run lint` never run.

**Deferred acceptance (6.2):** real per-session worktree isolation; FTS5 archive scale-up.
Both are explicitly outside the core gate.

---

## 15. Open Questions / User Decisions

Each has a recommended default matching codebase conventions, so the user can accept quickly.
Decisions are captured in an Addendum (§18) that supersedes the named sections.

**Q1. Multi-agent scope — full 1:N with per-agent routing, or minimal?**
→ **Recommend full core-minimal:** schema (`tasks.agent_id`), `agents[]` on the DTO, agent
CRUD API+UI, per-agent configuration, and **conditional** runtime routing (only when
`task.agentId` is set; the single-agent path is untouched). Defer per-agent cost rollups and
agent-level disable/status.

**Q2. What does each agent row hold + how is a quest routed?**
→ **Recommend:** `agents {id, house_id, name, role}` (unchanged) + one `agent_configurations`
row per agent (keep the unique index); add `tasks.agent_id` (nullable) for targeting; the
house default agent = oldest agent, used when `tasks.agent_id` is null.

**Q3. Template storage + are templates seeded or user-created?**
→ **Recommend a `templates` table with a JSON `payload`** (mirrors `execution_preferences`/
`provider_configs.extra`; no migration churn as config evolves); **both** seeded defaults
(idempotent, like provider configs) and user-created templates; seeded templates immutable.

**Q4. Project templates — what can they configure?**
→ **Recommend** `description`, `defaultModel`, `instructions`, and an optional `directory`
prompt supplied at instantiation (directory must still pass the existing
`assertValidDirectory`/`assertDirectoryUnique` checks). Do not template allowlists.

**Q5. FTS5 vs LIKE for archives?**
→ **Recommend LIKE-with-indexes over existing tables for 6.1** (web-only, no writer, e2e-
friendly, satisfies ≥100 sessions). FTS5 **is available and verified** — document it as the
6.2 upgrade if text volume/event-level search demands it. Do not add a dependency either way.

**Q6. Archives retention + pagination.**
→ **Recommend no automatic deletion** (local-first history is the point); paginate
(`limit` default 25, cap 100); search the full history; expose `total`. A retention/TTL
setting is a 6.2 follow-up.

**Q7. Monitoring placement — dedicated page or dashboard panel?**
→ **Recommend a panel on the root dashboard** (`src/app/page.tsx`) to avoid a 10th
`NAV_SECTIONS` entry and the `helpers.ts`/`navigation.spec.ts` churn. A dedicated
`/monitoring` page with the nav/test updates is the alternative if the user wants top-level
visibility.

**Q8. Dashboard chart approach.**
→ **Recommend CSS bars + inline SVG sparkline, no chart dependency** (AGENTS.md: no unprompted
dep bumps; transform/opacity animations only, reduced-motion aware). No canvas, no chart lib.

**Q9. Audit log retention + which actions?**
→ **Recommend:** retain indefinitely (local-first); audit only **web user-action rows**
(house/agent/project/provider-config/template CRUD, approval responses). Do **not** duplicate
engine execution lifecycle (already `execution_events`); a small engine-owned set (e.g. plan
abort) is an additive follow-up. `actor ∈ {'user','engine'}`; optional `actor_agent_id`.

**Q10. Monitoring poll vs push.**
→ **Recommend REST polling** (~5s) or `sequence`-keyed refetch — **no new SSE event type**,
matching the established "event arrived → refetch" pattern and avoiding a CHECK migration.

**Q11. Does real worktree isolation ship in 6.1 or stay scaffold (6.2)?**
→ **Recommend 6.2, flag-gated, default off.** The endpoint is live-verifiable here, but the
OpenCode client method is currently wrong, the worktree root is outside the allowlist, and
cleanup/branch-pollution risks are real. Gate coverage is mock/injected-fetch only, with an
opt-in `@real` smoke.

**Q12. Split Phase 6 into 6.1/6.2?**
→ **Recommend YES.** 6.1 = Stages 0, A–F (the six grounded deliverables + migration safety).
6.2 = real worktree isolation + optional FTS5 archive scale-up + per-agent cost rollups +
audit retention/export. Ship and gate 6.1 first.

---

## 16. Risks & mitigations

1. **Migration drift (the §12 register entry / Phase 5 incident).** Highest risk. Mitigation:
   Stage 0 harness first; 6.1 uses only `CREATE TABLE`/`ADD COLUMN` (no CHECK rebuilds); FK
   pragma handling stays in `migrate.ts`; `foreign_key_check` asserted; Phase-1-head + seeded-
   real-DB tests are committed.
2. **Multi-agent routing regresses single-agent execution.** Mitigation: routing branches only
   when `task.agentId` is non-null; keep `resolveRuntimeAgent` default == today's first agent;
   run the full `queue-loop`/`queue-ollama`/`queue-highlord`/`runner-status-machine`/
   `orchestrator` suites before landing the branch.
3. **`execution_sessions.agent_id` population changes session semantics.** It is currently
   null everywhere; setting it is additive but must not assume a non-null agent in existing
   code paths. Mitigation: keep it nullable end-to-end and add a round-trip test.
4. **Usage double-counting.** Each session writes one usage row at terminal; a dashboard that
   mistakenly sums `execution_sessions.cost_total` **and** `usage_records.cost` would
   double-count. Mitigation: aggregates read `usage_records` only; the reconciliation test
   asserts equality with the session mirror (not a sum of both).
5. **Archives `LIKE` performance at scale.** Fine at the 100-session acceptance bar; flag the
   FTS5 upgrade as 6.2 and add `idx_tasks_created` if scans show up. Mitigation documented in
   Stage D.
6. **Audit writes breaking user actions.** `recordAudit` must never throw into the request
   path; catch + log. Tested.
7. **E2E empty-state / nav regressions.** Monitoring stays on the root dashboard (no nav
   change); Archives keeps its existing nav slot; the seeded High Lord exclusion and
   `house-journey` empty-state are untouched. If a dedicated monitoring page is chosen, update
   `helpers.ts` + `navigation.spec.ts` together.
8. **Templates create mis-configured houses.** Instantiation must run the **same** zod schemas
   and repo validation as normal creation (no bypass), returning 400/409 unchanged.
9. **Worktree stage (if pursued): allowlist escape / orphaned worktrees / branch pollution.**
   Mitigation: default off, explicit documented allowlist exception, reset+cleanup on terminal
   and boot, `@real`-only live test.
10. **Scope creep.** The phase is genuinely broad. Mitigation: the 6.1/6.2 split (Q12); 6.2
    items are listed but not gated.

---

## 17. Verification / gates

1. `npx tsc --noEmit` → **0 errors** (the only typecheck gate; no lint).
2. `npm test` → all vitest green (unit + integration), including the new golden-dataset and
   migration tests.
3. `npm run test:e2e` → all Playwright specs green (engine off; rows seeded directly;
   viewport 1280×720; `workers:1`).
4. No dependency additions or version bumps (AGENTS.md; the reverts in git history).
5. Migrations committed (`drizzle/0005_*` + `meta/*`) with constants/types parity.
6. Phase retro appended to `docs/IMPLEMENTATION_PLAN.md` §10 listing deviations and the
   6.1/6.2 split.

---

## 18. Addendum — User Decisions (2026-09-25)

All Q1–Q12 answered: **the user accepted every recommended default** ("yes" to accept all).

| Q | Decision | Supersedes |
|---|---|---|
| Q1 | Full **core-minimal 1:N**: `tasks.agent_id` + `agents[]` DTO + agent CRUD API/UI + per-agent config + **conditional** runtime routing (single-agent path untouched). Per-agent cost rollups and agent-level disable/status DEFERRED to 6.2 | §Stage B |
| Q2 | `agents` row unchanged + one `agent_configurations` per agent (keep unique index); `tasks.agent_id` nullable for targeting; house default agent = oldest when `agent_id` is null | §Stage B |
| Q3 | `templates` table with JSON `payload`; **both** seeded defaults (idempotent, immutable) and user-created templates | §Stage C |
| Q4 | Project templates carry `description`, `defaultModel`, `instructions`; directory supplied at instantiation and validated by the existing repo checks; do NOT template allowlists | §Stage C |
| Q5 | **LIKE + indexes** for 6.1 (web-only, no writer, e2e-friendly). FTS5 verified available — documented as the 6.2 upgrade. No dependency either way | §Stage D |
| Q6 | No automatic deletion; paginate (`limit` default 25, cap 100); search full history; expose `total`. TTL/retention is 6.2 | §Stage D |
| Q7 | Monitoring is a **panel on the root dashboard** (`src/app/page.tsx`) — no 10th NAV_SECTIONS entry, no helpers/navigation.spec churn | §Stage F |
| Q8 | CSS bars + inline SVG sparkline, **no chart dependency**, transform/opacity only, reduced-motion aware | §Stage E/F |
| Q9 | Retain audit indefinitely; audit **web user-action rows only** (house/agent/project/provider-config/template CRUD + approval responses); do NOT duplicate engine lifecycle (already `execution_events`); `actor ∈ {'user','engine'}`, optional `actor_agent_id`. A small engine-owned set (e.g. plan abort) is an additive follow-up | §Stage A |
| Q10 | **REST polling** (~5s) / `sequence`-keyed refetch — **no new SSE event type**, avoiding a CHECK migration | §Stage F |
| Q11 | Real worktree isolation is **6.2**, flag-gated default off; mock/injected-fetch coverage + opt-in `@real` smoke | §Stage G |
| Q12 | **Split into 6.1 / 6.2.** 6.1 = Stages 0 + A–F (all §10 deliverables except the "where possible" qualifier on workspace isolation; satisfies all three acceptance criteria). 6.2 = real worktree isolation + FTS5 scale-up + per-agent cost rollups + audit retention/export | §14/§16 |

**6.1 is the gated scope.** Stage G and the 6.2 items are explicitly **not** part of the 6.1
gate. Standing conventions apply: `npx tsc --noEmit` → `npm test` → `npm run test:e2e`; never
`npm run lint`; no dependency changes; engine single-writer; e2e has no engine (seed rows
directly); transform/opacity animations only, reduced-motion safe; zod in `src/shared/schemas`
is the single API-input validation source; import boundaries per AGENTS.md. Migration safety
per Stage 0 (no fragile in-file `PRAGMA foreign_keys` toggles; `src/lib/db/migrate.ts` already
handles FK enforcement around the migrator).
