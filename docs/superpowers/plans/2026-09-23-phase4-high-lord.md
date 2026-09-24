# Phase 4 — High Lord (Orchestrator) Implementation Plan

**Date:** 2026-09-23
**Baseline:** HEAD `f190a8c` (Phases 1–3.1 complete)
**Author:** planning agent (no code written)

---

## 0. Codebase verification findings (read before implementing)

Everything below was verified against the code, not the docs. Doc claims that
did NOT match code are flagged. These findings drive the plan.

### 0.1 Confirmed facts (answers to the required verification questions)

| Question | Answer (verified) |
|---|---|
| NAV_SECTIONS | 9 sections in `src/shared/constants.ts` (AGENTS.md says "the 9" — correct). Court entry: `path: "/high-lord"`, `name: "High Lord's Court"`, `icon: "Crown"` (already mapped in `app-sidebar.tsx` `ICONS`). **No nav change needed.** |
| Court placeholder | `src/app/high-lord/page.tsx` renders `PlaceholderPage` ("This throne sits empty."). Route is `/high-lord`, **not** `/high-lords-court` (the task brief said `src/app/high-lords-court/page.tsx` — that file does not exist; docs also reference `/high-lords-court` — the code's `/high-lord` wins). |
| Task status transition validation | Web-side: `updateTask()` in `task-repo.ts` only allows `queued → cancelled` via PATCH (`InvalidTaskStatusTransitionError` otherwise). Engine-side: `setTaskStatus()` **bypasses all guards** (direct UPDATE) — the orchestrator will use this for all subtask/parent transitions. POST `/api/tasks` forces `status: "queued"` in `createTask`. |
| Queue claim mechanism | `src/engine/queue.ts` → `TaskQueue.processOnce()` (2s poll): `listQueuedTaskIds(raw)` → per task: skip if `inFlight`, atomic `claimQueuedTask(raw, taskId)` (single-statement `UPDATE ... WHERE status='queued'`), then `runClaimedTask()`: loads task + house, checks house active, per-house concurrency via `houseBusy` Set + `getActiveSessionForHouse()`, resolves workspace via `resolveSafePath`, then `executeTask()` from `runner.ts`. |
| usage_records writing | `runner.ts persistTerminal()` — one `createUsageRecord()` per session at terminal (provider-reported, `estimated: false`), cost from `lastCost` which is updated by `session.updated` usage events + `GET /session/{id}` reconcile on each poll. `execution-repo.ts` has `getUsageSummaryForHouse()` (SUM per house); **no per-task rollup query exists yet** — we add one. |
| houses.kind CHECK | `ck_houses_kind: kind in ('agent','high_lord')` — column + CHECK already exist (default `'agent'`). No migration needed for `kind` itself. |
| High Lord agent/config seed | **Nothing exists.** `bootstrap.ts` (web) only calls `migrate()` + `seedDefaultProviderConfigs()`. Engine `main.ts` does the same two. There is **no** house/agent/agent_configurations seed and **no `kind` on any DTO** — `HouseDto` does not even include `kind` (see 0.2). |
| E2E seeding pattern | Engine is never started. Tests seed execution rows directly into `db/velaris-e2e.db` via `better-sqlite3` (`openDb()` in phase2/phase3 specs) and/or use Playwright `request` to hit the REST API. Shared DB, `workers: 1`. |
| EXECUTION_EVENT_TYPES | 13 values, CHECK `ck_execution_events_type` in schema. Adding a new event type = schema CHECK change + migration + constants + types + mapper updates (we avoid this — see §6). |
| SSE polling | `/api/stream` `tick()` polls `listEventsAfter(db, lastSeenId)` every **2s** (docs say 500ms — code wins) + notification `(createdAt, id)` cursor. `RealtimeEvent` union: `hello / event / notification`. |
| Existing engine test mock style | `tests/unit/queue-loop.test.ts` mocks `@/server/execution/runner` with `vi.mock`, fake `OpencodeClient` (`{ health: vi.fn(async () => healthy) }` cast), real temp DB + `migrate()`, `resetDbForTests()` per test. Orchestrator tests mirror this exactly. |
| Runner terminal semantics | `executeTask()` returns `RunResult { sessionId, terminalStatus: completed|failed|aborted|interrupted, error }`. It fully owns session rows, events, artifacts, usage, task status, notifications for the child task. **The orchestrator must NOT re-implement this** — child subtasks flow through the existing queue untouched. |

### 0.2 Contradictions / gotchas found (docs vs code)

1. **Route path**: docs (`IMPLEMENTATION_PLAN §5.2`) say `/high-lords-court`; code says `/high-lord` (constants + page + e2e `NAV_SECTIONS` in `tests/e2e/helpers.ts` all assert `/high-lord` → heading "High Lord's Court"). **Build at `/high-lord`. Do not rename** (renaming breaks `navigation.spec.ts` + `helpers.ts`).
2. **`HouseDto` lacks `kind`** even though the column + CHECK exist. The web can't currently tell a High Lord house from an agent house. We must surface `kind` on the DTO (additive, no API break).
3. **`houses` list ordering**: `listHouses` sorts `createdAt DESC` (newest first) — but the **map** (`computePlotLayout`) sorts `createdAt ASC` and gives slot 0 (city centre) to the *oldest* house. If the High Lord is seeded at web boot it will be the oldest house in fresh DBs and get the centre plot — nice, but in existing DBs it will be newest → ring plot. Optional gold-plating (§7.4) must handle both.
4. **E2E empty-state regression risk**: `house-journey.spec.ts` asserts `"The city's great houses lie empty."` on a fresh DB. If web boot seeds a High Lord house unconditionally, that assertion breaks and `/map` shows a castle with no user houses. Mitigation: seeded High Lord is **excluded from the default house list response** (list filter), and e2e seeds explicitly — see §3.1 and §9.4. **This is the single biggest existing-test risk in the phase.**
5. **`getActiveSessionForHouse`** loads *all* sessions for a house and filters in JS. Fine for now, unchanged.
6. **`/api/stream` poll cadence is 2s**, not the 500ms the docs claim. Plan DAG live updates accordingly (subtask status events arrive via existing event rows; the Court UI refetches plan DTO on `sequence` bumps — consistent with every other page).
7. **AGENTS.md says the queue respects per-house concurrency and per-directory serialization**; code reality: concurrency = 1 per house (hardcoded semantics, `houseBusy` Set + active-session check). **Per-directory serialization is NOT actually implemented** (the runner subscribes per-directory SSE; two tasks on different houses in the same dir would race). The orchestrator reuses queue claims for children, so it inherits house-level serialization; we additionally serialize **per working directory at the DAG level** (§5.4) so the parallel pair runs in distinct directories — matching AGENT_ORCHESTRATION §2.1 without touching the runner.
8. **`approval_policy: "risky_only"`** is treated like `always` (deferred). Unchanged.
9. Docs' `handoffs` schema (`source_agent_id/destination_agent_id`) is over-specified for MVP; the Court UI needs house-level references. Plan simplifies to house ids while keeping a compatible column set (§4.4).
10. **`DEFAULT_TASK_TYPES`** already includes `"planning"` — subtasks can use it; no constant change needed for types.

---

## 1. Objective

Implement the High Lord orchestrator: a special auto-seeded house (`kind='high_lord'`) that, when assigned a task, plans it (one model call through the standard OpenCode session machinery with a planning system prompt), decomposes it into subtasks linked via a new `subtasks` table, records handoffs, schedules the subtask DAG (sequential + parallel branches, respecting per-house concurrency + per-directory serialization), enforces loop safeguards (depth 1, max subtasks, repeated-failure escalation, token budget), and consolidates results + cost rollup on the parent task when all children reach a terminal state. Build the Court chat UI at `/high-lord` (send instruction → create parent task on the High Lord house → live plan DAG view → consolidated results) plus a minimal "Plan" surface on the parent-task side. Real-time flows through the existing `/api/stream` (no new event types). Direct-to-house assignment keeps working (regression-tested).

**Out of scope**: Ollama-direct planning calls (Phase 5), multi-agent houses (Phase 6), nested/recursive delegation beyond depth 1, re-planning mid-flight, audit-log UI.

---

## 2. Schema migration plan

Single migration (`0003_*`) generated by `npm run db:generate` after editing `src/lib/db/schema.ts`. All DDL below is the exact target state; drizzle generates the SQL.

### 2.1 New table: `subtasks`

```sql
CREATE TABLE subtasks (
  id               TEXT PRIMARY KEY NOT NULL,         -- uuid
  parent_task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE cascade,
  task_id          TEXT NOT NULL REFERENCES tasks(id) ON DELETE cascade,  -- the child task row
  order_index      INTEGER NOT NULL,                   -- plan order (0..n-1)
  depends_on       TEXT NOT NULL DEFAULT '[]',        -- JSON: [subtask ids] (plan-graph edges)
  status           TEXT NOT NULL DEFAULT 'planned',   -- orchestrator-owned lifecycle, see below
  attempt_count    INTEGER NOT NULL DEFAULT 0,        -- repeated-failure rule
  created_at       TEXT NOT NULL DEFAULT (strftime(...)),
  updated_at       TEXT NOT NULL DEFAULT (strftime(...)),
  CONSTRAINT ck_subtasks_status CHECK (status IN ('planned','ready','delegated','in_flight','completed','failed','skipped','escalated','cancelled')),
  CONSTRAINT ck_subtasks_order  CHECK (order_index >= 0)
);
CREATE UNIQUE INDEX idx_subtasks_task ON subtasks (task_id);          -- 1:1 child task ↔ subtask row
CREATE INDEX idx_subtasks_parent ON subtasks (parent_task_id);
```

**Decisions:**
- `status` here is the **orchestrator's scheduling state**, deliberately distinct from `tasks.status` (which the existing runner owns for the child task). Mirror values in `constants.ts` as `SUBTASK_STATUSES` (see §3.1). `ready` = deps met, claimable by scheduler; `delegated` = child task row created & queued; `in_flight` = child claimed by queue; scheduler watches the **child task row's** `tasks.status` for terminal transitions and mirrors into subtask status.
- `depends_on` stores **subtask ids** (plan-local identity assigned by the planner: `s0, s1, …`), not task uuids — the planner emits ids before tasks exist. Scheduler maps plan-id → subtask row id.
- `parent_task_id` cascade: deleting a parent deletes subtask links (child tasks themselves are independent rows; the Court cancel flow cancels them explicitly, §5.7).
- Unique `task_id` index makes the subtask↔child-task link 1:1, enforcing "max delegation depth = 1" data-model-wise: the scheduler refuses to create a subtask whose `task_id` equals any `parent_task_id` (§5.6).

### 2.2 New table: `handoffs`

```sql
CREATE TABLE handoffs (
  id                       TEXT PRIMARY KEY NOT NULL,   -- uuid
  parent_task_id           TEXT NOT NULL REFERENCES tasks(id) ON DELETE cascade,
  subtask_id               TEXT NOT NULL REFERENCES subtasks(id) ON DELETE cascade,
  source_house_id          TEXT REFERENCES houses(id) ON DELETE set null,   -- High Lord
  destination_house_id     TEXT NOT NULL REFERENCES houses(id) ON DELETE set null,
  instructions             TEXT NOT NULL DEFAULT '',
  context                  TEXT NOT NULL DEFAULT '{}',  -- JSON
  artifacts                TEXT NOT NULL DEFAULT '[]',  -- JSON: expected artifact refs
  completion_requirements  TEXT NOT NULL DEFAULT '',
  created_at               TEXT NOT NULL DEFAULT (strftime(...))
);
CREATE INDEX idx_handoffs_subtask ON handoffs (subtask_id);
CREATE INDEX idx_handoffs_parent  ON handoffs (parent_task_id);
```

**Decisions:**
- Keyed by **house ids** (not agent ids as docs suggested) — MVP is 1 house = 1 agent; `source_house_id` is normally the High Lord, `destination_house_id` the executor. `agents.id` remains derivable; this keeps the Court UI join-free.
- `destination_house_id` nullable on delete so history survives a house being archived+deleted; the Court renders "—" for a deleted destination.
- One handoff row per subtask, created at delegation time (UNIQUE could be added on `subtask_id`; an index suffices since delegation is engine-single-writer — keep it non-unique to allow future re-handoff rows).

### 2.3 Column additions to existing tables

**`tasks`** — none required. Parent linkage lives in `subtasks.parent_task_id` only (per the mission brief: "maybe tasks.parent linkage via subtasks only" — confirmed: a `parent_task_id` column on tasks would duplicate the relation and invite drift; the repo layer can answer "is this a child task?" with one indexed lookup: `SELECT 1 FROM subtasks WHERE task_id = ?`).

**`execution_events`** — no new event types (CHECK unchanged). Plan/DAG updates are surfaced as **existing event types** with structured payloads (§6).

### 2.4 High Lord house seeding

**Where**: a new `seedHighLordHouse()` in `src/server/repositories/house-repo.ts` (or a small dedicated `orchestrator-repo.ts`; recommend house-repo since it's house-shaped), called from **both** `bootstrapDb()` (web) and engine `main.ts` boot (right after `seedDefaultProviderConfigs`). Both processes already idempotently migrate; the seed must be equally idempotent:

```sql
SELECT id FROM houses WHERE kind = 'high_lord' LIMIT 1
-- absent → INSERT house + agents + agent_configurations in one tx (reuse createHouse() repo fn
--          with explicit kind — createHouse currently does NOT set kind; extend CreateHouseInput)
```

**Seeded values** (constants in `src/shared/constants.ts`, §3.1):
- house: `name: "High Lord"`, `description: "Velaris' orchestrator — plans, delegates, consolidates."`, `kind: "high_lord"`, `status: "active"`.
- agent: `name: "Rhysand"`, `role: "High Lord · orchestrator"`.
- configuration: `systemPrompt` = the **planning system prompt template** (§5.2 — editable by the user via the normal house edit UI, which is desirable), `executionProvider: "opencode"`, `aiProvider: "ollama-cloud"`, `modelId: "glm-5.3"`, `workspaceAllowlist: []` (planner only reads/writes JSON in chat; **empty allowlist is safe** because the planning session runs in the parent task's working directory… see Risk §10.5 — the queue's `resolveWorkspace` requires a non-empty allowlist for ordinary tasks, so the orchestrator must special-case the High Lord planning session directory, or seed the allowlist with the project dir at plan time; §5.3 resolves this), `tools: []`, `approvalPolicy: "never"` (auto-approve so a planning call never blocks on a permission bird), `concurrency: 1`.

**Migration steps (exact workflow):**
1. Edit `src/lib/db/schema.ts`: append `subtasks` + `handoffs` tables (with indexes/checks) + row types; extend `CreateHouseInput` handling of `kind` is a repo change, not schema (column exists).
2. `npm run db:generate` → produces `drizzle/0003_*.sql` + updated `meta/*` — **commit these**.
3. Update `src/shared/constants.ts` (SUBTASK_STATUSES, HOUSE_KINDS, defaults) in the same commit (AGENTS.md: enums mirror CHECKs — update both together).
4. No manual `db:migrate` needed (boot self-migrates), but tests' `migrate()` picks the new file up automatically.

---

## 3. Shared layer (src/shared — no React/Next imports)

### 3.1 Constants (`src/shared/constants.ts`)

```ts
/** houses.kind values (echoed by ck_houses_kind). */
export const HOUSE_KINDS: readonly ["agent", "high_lord"] = ["agent", "high_lord"] as const;

/** subtasks.status values (echoed by ck_subtasks_status). */
export const SUBTASK_STATUSES: readonly SubtaskStatus[] = [
  "planned", "ready", "delegated", "in_flight",
  "completed", "failed", "skipped", "escalated", "cancelled",
] as const;

/** Loop safeguards (configurable via the High Lord's house edit → executionPreferences later). */
export const ORCHESTRATION_DEFAULTS = {
  MAX_SUBTASKS: 8,
  MAX_ATTEMPTS_PER_SUBTASK: 2,      // 2nd failure → escalate (no 3rd attempt)
  PLAN_TOKEN_BUDGET: 400_000,       // total plan budget (input+output) via usage_records rollup
} as const;

/** Seeded High Lord house identity (used by web+engine boot seeds). */
export const HIGH_LORD_SEED = {
  HOUSE_NAME: "High Lord",
  AGENT_NAME: "Rhysand",
  AGENT_ROLE: "High Lord · orchestrator",
  SYSTEM_PROMPT: "<planning prompt §5.2 — defined here as a template string>",
} as const;
```

Types in `src/shared/types.ts`: `HouseKind`, `SubtaskStatus`, `SubtaskDto`, `HandoffDto`, `PlanDto`, `CourtInstructionDto` (full shapes §4.4). `HouseDto` gains `kind: HouseKind` (additive).

### 3.2 Zod schemas (`src/shared/schemas/plan.ts` — new file)

Single source for everything the planner emits and every plan API validates:

```ts
export const planSubtaskSchema = z.object({
  id: z.string().trim().min(1).max(40),            // plan-local id: "s0", "s1"...
  title: trimmedNonEmpty(200),
  description: z.string().trim().max(8000).default(""),
  type: taskTypeSchema.optional(),                  // defaults to "general"
  houseId: uuidSchema.nullable().optional(),       // explicit pick
  houseHints: z.string().trim().max(2000).optional(), // free-text capability hints
  dependsOn: z.array(z.string().trim().min(1)).default([]), // plan ids
  instructions: z.string().trim().max(8000).default(""),
  context: z.record(z.string(), z.unknown()).default({}),
  artifacts: z.array(z.string().trim().min(1)).default([]), // expected outputs
  completionRequirements: z.string().trim().max(4000).default(""),
});

export const planSchema = z.object({
  subtasks: z.array(planSubtaskSchema).min(1).max(ORCHESTRATION_DEFAULTS.MAX_SUBTASKS),
});

export const courtInstructionSchema = z.object({
  instruction: trimmedNonEmpty(8000),
  projectId: uuidSchema.optional().nullable(),
  workingDirectory: z.string().trim().optional().nullable(),
  priority: z.enum(["low","medium","high","urgent"]).optional(),
});
```

Also `planQuerySchema` (none needed — id param only) and reuse `taskCreateSchema` untouched.

**Engine-side extras** (live in `src/server/execution/planning/`, not shared, since they're not API inputs): the planner's JSON-extraction + repair-retry prompt constants.

### 3.3 Types (additions to `src/shared/types.ts`)

```ts
export type HouseKind = "agent" | "high_lord";
export type SubtaskStatus = "planned" | "ready" | "delegated" | "in_flight"
  | "completed" | "failed" | "skipped" | "escalated" | "cancelled";

export interface SubtaskDto {
  id: Id;                       // subtasks.id
  parentTaskId: Id;
  taskId: Id | null;             // child task row (null until delegation)
  orderIndex: number;
  dependsOn: string[];           // plan-local ids (stable for UI keys/edges)
  planId: string;               // plan-local id ("s0") — stored in dependsOn
  status: SubtaskStatus;
  attemptCount: number;
  title: string;
  instructions: string;
  completionRequirements: string;
  houseId: Id | null;           // resolved destination
  houseName: string | null;     // denormalized for the UI (join)
  childTaskStatus: TaskStatus | null; // tasks.status of the child row
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface HandoffDto { id: Id; subtaskId: Id; sourceHouseId: Id | null; destinationHouseId: Id | null;
  instructions: string; context: Record<string, unknown>; artifacts: string[];
  completionRequirements: string; createdAt: IsoTimestamp; }

export interface PlanDto {
  parentTaskId: Id;
  parentTask: TaskDto;
  subtasks: SubtaskDto[];
  handoffs: HandoffDto[];
  cost: CostSummary;            // rollup across child usage_records
  consolidated: {               // present when parent is terminal
    summary: string | null;
    fileCount: number;
    diffPreview: string | null;
  } | null;
}

export interface CourtMessageDto {  // Court chat history item
  id: Id; role: "user" | "agent"; content: string; createdAt: IsoTimestamp;
  taskId: Id | null;
}
```

**Where plan-local ids survive**: store the plan id on the subtask row (`planId` — added to §2.1's table as one more TEXT column; include it: `plan_id TEXT NOT NULL`) so `dependsOn` edges stay renderable after delegation. (Amend §2.1: add `plan_id TEXT NOT NULL` + index on `(parent_task_id, plan_id)` unique.)

---

## 4. Repositories & services (web-safe, engine-shared)

Layering stays: routes → services → repositories → db. The orchestrator (engine) uses the same repos.

### 4.1 `src/server/repositories/subtask-repo.ts` (new)

- `createSubtask(db, { parentId, planId, orderIndex, dependsOn, status: "planned", title, instructions, completionRequirements, taskId: null })` → SubtaskDto
- `listSubtasksForParent(db, parentId): SubtaskDto[]` (ordered by `order_index`; joins `tasks.status` for `childTaskStatus` and `houses.name` for `houseName`)
- `getSubtaskByChildTaskId(db, taskId): SubtaskDto | null` (the "is this a child task" probe — one indexed lookup)
- `setSubtaskStatus(db, subtaskId, status)` (engine-only transitions, no guard — mirrors `setTaskStatus` discipline)
- `incrementSubtaskAttempt(db, subtaskId): number`
- `listSubtasksForParentByStatus(db, parentId, statuses)` (scheduler ready-set queries)
- `linkChildTask(db, subtaskId, childTaskId)` (delegation-time)

### 4.2 `src/server/repositories/handoff-repo.ts` (new)

- `createHandoff(db, { parentTaskId, subtaskId, sourceHouseId, destinationHouseId, instructions, context, artifacts, completionRequirements })`
- `listHandoffsForParent(db, parentId): HandoffDto[]`

### 4.3 `src/server/repositories/execution-repo.ts` (modify — additive)

- `getUsageSummaryForTask(db, taskId): CostSummary` — SUM over `usage_records WHERE task_id IN (parent + all child task ids)`; used for the parent cost rollup + budget enforcement (§5.6). Implementation: accept an array of task ids or take parentId and resolve children via subtasks (prefer the latter, one query with a subselect).

### 4.4 `src/server/services/plan-service.ts` (new)

Web-facing read service used by the API routes:
- `buildPlanDto(db, parentTaskId): PlanDto | null` — parent task + subtasks + handoffs + cost rollup + consolidated result (reads the `result`-kind artifact on the parent task, §5.8).
- `buildCourtHistory(db, limit): CourtMessageDto[]` — the Court chat log. **Source of truth decision:** planning conversations live in `agent_messages` of the parent task's planning session. History = for each High Lord parent task (latest N): the `role=user` instruction row + the `role=agent` planning reply + the consolidated summary artifact. Query: `SELECT ... FROM tasks WHERE house_id = <hlHouseId> ORDER BY created_at DESC LIMIT 20` joined per-task with `agent_messages` via `execution_sessions.task_id`. Keep it simple: return one `CourtMessageDto[]` where each task contributes its user instruction + agent plan text.

### 4.5 `src/server/repositories/house-repo.ts` (modify)

- `CreateHouseInput` + `createHouse()` accept optional `kind` (default `"agent"`).
- `houseRowToDto()` returns `kind` (reads the row; no query change).
- `listHouses(db, { includeArchived, includeHighLord })` — **default excludes `kind='high_lord'`** from the plain list (protects the Houses grid + the empty-state e2e assertion + the map "great houses lie empty" empty state); `includeHighLord: true` opts in. `getHouse()` always returns it.
- `findHighLordHouse(db): HouseDto | null` — `WHERE kind='high_lord'`.
- `seedHighLordHouse(db, raw): boolean` — idempotent upsert by kind (§2.4), reusing `createHouse` inside a tx.

### 4.6 `src/server/bootstrap.ts` (modify)

`bootstrapDb()`: after provider seed, call `seedHighLordHouse(getDb(), getRawDb())`. Engine `main.ts` does the same after its own `seedDefaultProviderConfigs` (symmetric boot).

---

## 5. Engine orchestration (the core)

### 5.0 Design principles

1. **Reuse, don't fork, the child execution path.** Child subtasks are ordinary `tasks` rows with `houseId` + `workingDirectory`; the **existing** queue claims and runs them via the untouched `executeTask()`. The orchestrator never runs a child itself.
2. **Orchestrator = supervisor loop, not a thread.** A new `orchestrator.ts` module invoked by the queue poll each tick (like `processOnce`'s health gate) — no new process, no long-lived timers beyond the existing queue loop. All state in DB rows → crash-recoverable by construction, `reconcile.ts` extension for restart (§5.9).
3. **Single-writer discipline preserved**: orchestrator writes `subtasks`, `handoffs`, child `tasks` rows (creation only — engine is allowed to write tasks), parent task status, planning session/events/usage via the standard runner, notifications, escalation approval_requests rows. Web still writes nothing new.

### 5.1 Detection: task assigned to the High Lord

In `TaskQueue.runClaimedTask()`, after loading `house`: if `house.kind === "high_lord"` → instead of `resolveWorkspace`/`executeTask`, call `orchestrator.runParent(task, house)` (imported from the new `src/engine/orchestrator.ts`). Everything else in the queue stays identical. The High Lord house is `status: "active"`, so it passes the active check; its `concurrency: 1` means one planning run at a time (the `houseBusy` Set already enforces this for free).

### 5.2 Planning session (reuse the OpenCode machinery)

The planner runs through the **same session mechanism** as any task — `executeTask()` with a planning-shaped prompt — but we need the final assistant text to parse. Two options were considered:

- (a) Reuse `executeTask()` verbatim and after terminal completion read `agent_messages` for the assistant reply. ✅ chosen — zero runner changes; the planner session is just a task run whose prompt demands JSON.
- (b) Call the client directly. ❌ rejected (mission: reuse session machinery).

**Planner flow (`orchestrator.runParent`):**
1. Set parent task `status: "planning"`… **not a legal tasks.status** — CHECK has no `planning`. Use `running` for the parent task while orchestrating (existing enum), and emit `execution_events { type: "task_started", payload: { planning: true } }` + `message`-type events for Court chat. The `HouseRuntimeStatus` of the High Lord derives to `working` while planning — acceptable; optional tiny polish: extend `deriveRuntimeStatus` to map a session whose task has an orchestrator marker… **skip** (keep Phase 4 surface minimal; runtime badge "working" while planning is fine).
2. Create the planning session by calling `executeTask()` with:
   - `task`: the parent task row (so session/events/usage hang off the parent for free).
   - `house`: the High Lord house (its config's systemPrompt is the planning prompt).
   - `directory`: resolved as the parent's working directory; the High Lord seed carries an **empty allowlist**, so `resolveWorkspace` would fail → the orchestrator **bypasses `resolveWorkspace`** and passes the directory directly (it must still be a real path; the Court API validated it against the chosen project at creation, §7.1). This is the one place we don't reuse the queue's helper, and it's deliberate: the planner's "workspace" is the chat, not the filesystem.
   - `taskPrompt`: `composePlanningPrompt(instruction, houseRoster)` — embeds the **house roster** (id, name, description, agent role, model of every non-high-lord active house) + the strict plan-JSON contract + the plan schema + the instruction + max-subtasks cap. The exact system-prompt template lives in `HIGH_LORD_SEED.SYSTEM_PROMPT` (constants) so users can edit the High Lord like any house; the roster is appended per-run by the orchestrator (models/roster drift between runs is fine).
3. `executeTask` returns `RunResult`. If `terminalStatus !== "completed"` → orchestrator failure path (§5.6): parent → `failed`, notification, done.
4. Read the planner's assistant text: newest `role='agent'` row in `agent_messages` for the planning session (`listAgentMessagesForSession`). Extract JSON.

### 5.3 Plan JSON extraction + validation + repair + fallback

New pure module `src/server/execution/planning/parse.ts` (no DB imports — fully unit-testable):

```ts
export function extractPlanJson(text: string): unknown | null
```
- strip leading/trailing prose;
- strip Markdown code fences (```json … ``` or ``` … ```);
- find the first balanced `{ … }` scanning with a depth counter (string/escape-aware);
- `JSON.parse` → object, or null.

```ts
export function validatePlan(raw: unknown): Plan | PlanError   // planSchema.safeParse wrapper
export function normalizePlan(plan: Plan): NormalizedPlan       // houseId resolution + dependency checks
```

`normalizePlan` (engine-side, `resolve-plan.ts`, DB-aware, still pure given inputs):
- **Resolve house**: explicit valid `houseId` → that house (must be `status: "active"`, `kind: "agent"`, else fall through to hints); no/invalid `houseId` → **hint match**: score each active agent house by case-insensitive substring overlap of `houseHints` + subtask `type` against house name/description/agent.role; best score wins; zero score for everyone → single-house fallback below.
- **Dependency hygiene**: drop `dependsOn` ids that don't exist in the plan; detect cycles via Kahn's algorithm; if cyclic, break the cycle by dropping the offending edge and log (never fail the whole plan to the user).
- **Cap**: truncate `subtasks` to `MAX_SUBTASKS` (engine-side hard cap independent of zod max).
- **Depth guard**: every resolved destination must have `kind === "agent"` — a subtask naming the High Lord is reassigned by hints (§5.6 loop safeguard #1).
- **Fallback**: `subtasks.length === 0` or every house unresolvable → single subtask `{ planId: "s0", title: parent title, instructions: <parent description + houseHints text>, destinationHouseId: <best-matching house or first active agent house>, dependsOn: [] }`. If **no agent houses exist at all** → parent fails with a clear error + notification ("No houses to delegate to — found a house first").

**Repair retry**: if `validatePlan` fails on the first extraction, send ONE follow-up message into the same planning session (runner already supports `sendMessage` via `findPendingUserMessage` — but the session has terminated; instead the orchestrator issues a **second `executeTask`** on a new session with a repair prompt: "Your previous reply was not valid plan JSON (error: …). Reply with ONLY the corrected JSON object." — planner sessions are cheap and this keeps the runner untouched). Still failing → fallback plan. Repair prompt constant in the planning module.

### 5.4 Subtask + handoff creation + DAG scheduling

After a valid `NormalizedPlan`:

1. `db.transaction`: for each plan subtask in order —
   - `createSubtask()` (`status: "planned"`, `planId`, `dependsOn` mapped to plan ids, `title`, `instructions`, `completionRequirements`);
   - `createHandoff()` (`source: highLord.id`, `destination: resolvedHouse.id`, instructions = plan `instructions` + `context` + `artifacts` + `completionRequirements`).
   - Emit `execution_events { type: "message", payload: { plan: true, subtask: { planId, title, house } } }` on the parent task — Court UI timeline shows the plan entries (reuses `message` type; §6).
2. Compute the **ready set**: subtasks whose `dependsOn` are all in terminal-ok states — initially those with no deps. Mark them `ready` → **delegate immediately** (see 3) up to the parallelism budget.
3. **Delegation** (`delegateSubtask`): create the child `tasks` row (`createTask()` repo — engine writes tasks, allowed) with:
   - `houseId: destinationHouse.id`, `projectId: parent.projectId`,
   - `workingDirectory`: **parent's working directory** (so child diffs relate to the same project),
   - `title: subtask.title`, `description:` composed from handoff (instructions + context + completion requirements + "This is subtask <planId> of parent quest <title>" so the agent has context),
   - `type: subtask.type ?? "general"`, `priority: parent.priority`,
   - `executionPreferences: { parentTaskId }` (lightweight traceability; subtasks table is the authoritative link).
   Then `linkChildTask(subtask.id, child.id)`, `setSubtaskStatus(subtask.id, "delegated")`. The **existing queue picks it up on its next 2s tick** — no scheduler hand-off needed for in-flight tracking; the orchestrator watches.
4. **Parallelism rules**: the DAG may delegate multiple ready subtasks at once (different houses). Enforce:
   - distinct destination houses per concurrent pair (per-house concurrency is already 1, so two ready subtasks on the same house are delegated anyway — the queue serializes them; no need to hold them back, **but** the plan's own semantics (a parallel pair) expect simultaneity — with same-house they'll run sequentially; acceptable, document in UI via house chips),
   - **per-directory serialization**: if two ready subtasks share `workingDirectory` AND different houses, delegate only the first; hold the second at `ready` until the first is terminal (guard against concurrent sessions in one directory per AGENT_ORCHESTRATION §2.1). Ready-set computation runs each orchestrator tick, so the held subtask flips to delegated as soon as the directory frees.
5. **Sequential branches**: a subtask with unmet deps stays `planned` (NOT delegated); when its deps complete, next tick marks it `ready` and delegates.

### 5.5 Orchestrator supervisor loop

`orchestrator.tickActivePlans(deps)` — called from `TaskQueue.processOnce()` after the health gate (one line addition in queue.ts):

For each parent task in orchestrating state (`SELECT DISTINCT parent_task_id FROM subtasks WHERE status IN ('planned','ready','delegated','in_flight','escalated')` join tasks non-terminal):
1. **Mirror child terminal states**: for each subtask `delegated/in_flight` with a child task row: read `tasks.status` of child:
   - `running/awaiting_*` → ensure subtask `in_flight`;
   - `completed` → subtask `completed` (+ emit parent-task `execution_events { type: "tool_result", payload: { subtaskCompleted: planId, house } }` — hmm, `tool_result` is semantically wrong; better: `message` payload `{ subtaskCompleted: planId }`… see §6 for the final choice: **`message` with structured payload keys** the Court UI filters on);
   - `failed` → increment `attemptCount`; if `attemptCount >= MAX_ATTEMPTS_PER_SUBTASK(2)` → `escalated` (§5.6 repeated-failure rule: create an **approval_requests row `kind: "question"`** on a synthetic basis + a notification so a bird lands in the Roost asking the user how to proceed; options: ["Retry once more", "Skip this subtask", "Abort the plan"]; the reply drives the orchestrator: approve/reply→re-delegate fresh child task; select skip→`skipped`; reject→abort plan) — **note**: this approval has no provider session; the existing approval relay in the runner tolerates that because the row is engine-owned and the orchestrator itself polls `approval_requests WHERE status IN (approved/replied/rejected)` for escalated rows (new repo fn `listEscalationsForParent`). `createApprovalRequest` requires a `sessionId` — use the parent's planning session id (it exists, is terminal, but FK-valid). 
   - `cancelled/interrupted` → treat as failure path (attempts++ / escalate per rule).
2. **Release dependents**: recompute ready set among `planned` subtasks whose deps are now `completed` or `skipped`; delegate (per §5.4 rules).
3. **Check terminal**: all subtasks terminal (`completed|skipped|escalated-not-pending|failed-handled`) → consolidate (§5.7) and finalize parent.
4. **Budget check** (§5.6): rollup via `getUsageSummaryForTask(parent)`; if over → abort remaining.

Parent status while orchestrating stays `running` (mirrors the plan being in-flight); children carry the detail.

### 5.6 Loop safeguards (all in `orchestrator.ts`, pure helpers where possible)

| Safeguard | Implementation |
|---|---|
| Max delegation depth = 1 | Delegation refuses if the would-be child task's `houseId` is a High Lord house (resolved houses must be `kind='agent'`, §5.3); AND `createTask` for children is only reachable from `delegateSubtask`, which is only reachable from `runParent`, which the queue only invokes for High Lord-house tasks whose `subtasks` probe (`getSubtaskByChildTaskId`) is null. A High Lord house cannot be the destination because normalizePlan rejects it. Double-enforced + data-model unique index on `subtasks.task_id`. |
| Max subtasks per plan (default 8, configurable) | `planSchema.max` + engine truncation (§5.3). Configurable: read from parent task's `executionPreferences.maxSubtasks` first, else `ORCHESTRATION_DEFAULTS.MAX_SUBTASKS`; the Court UI passes a sensible value; Settings UI for the default is **out of scope** (constant + per-task pref only). |
| Repeated failure → escalation | §5.5 step 1: 2nd failure flips subtask `escalated`, spawns a question-approval + notification (bird), no 3rd child task until the user replies. |
| Total plan token budget | `getUsageSummaryForTask(parentTaskId)` each tick (covers planning session + all children); `inputTokens + outputTokens` over `PLAN_TOKEN_BUDGET` (pref-overridable via `executionPreferences.tokenBudget`) → cancel all non-terminal children (§5.7), mark remaining subtasks `skipped`, parent → `failed` with error "Token budget exceeded" + notification. |

### 5.7 Consolidation + terminal states + abort

- **All children terminal** → `consolidate(parent)`:
  - summary artifact: `createArtifact(db, { sessionId: planningSessionId, taskId: parent.id, kind: "result", content: <composed summary> })` — summary composed from per-child `task_completed` events + last agent message per child + child diff stats (files changed count from diff artifacts) — simple template, no extra model call (docs don't require a model-summarized consolidation; results/files/diffs/cost rollup only).
  - diff rollup: concatenate child `diff` artifacts into one parent `diff` artifact (per-child sections labeled).
  - cost rollup: parent's `execution_sessions` costTotal is only the planning session; the PlanDto's `cost` comes from `getUsageSummaryForTask` (SUM across children) — no new writes needed.
  - parent → `completed` (`setTaskStatus`), `createExecutionEvent { type: "task_completed", taskId: parent }` (this is what triggers the Court UI + fireworks logic on the High Lord castle, §7.4) + completion notification.
- **Any child `failed` after escalation handling (user rejects retry / rejects) or unrecoverable** → parent → `failed` with error listing failed subtask titles + failure notification. **Recommendation: fail-fast is NOT used**; remaining independent branches continue to completion, and the parent terminal decision is: all `completed|skipped` → `completed` (with skipped noted in summary); any `failed`/aborted-escalation → `failed`. This honors "a plan partially succeeded" without adding a new status, and keeps the status vocabulary unchanged.
- **Parent abort (user cancel via POST /api/tasks/{parent}/cancel)**: existing route flips parent task + its active session; extend the route (§7.2) to also: cancel each non-terminal child task (`setTaskStatus(child, "cancelled")` + their active sessions aborted — reuse the route's session-abort snippet per child), set all `planned|ready|delegated|in_flight` subtasks → `cancelled`. Engine-side, running `executeTask` loops already observe task `cancelled` and self-terminate.
- **Escalated plan stall**: if the only outstanding subtask is `escalated` with a pending approval, the plan waits indefinitely — intentional (user decision required); the Roost bird is the surface. A "cancel plan" is always available on the parent.

### 5.8 What the existing per-child flow looks like (untouched)

Child task rows flow through `listQueuedTaskIds → claimQueuedTask → runClaimedTask → executeTask` with zero changes. Approvals for children bird normally (Roost already shows `taskId` → the Court links by child task id). Child usage/artifacts land via `persistTerminal`. The orchestrator only reads child `tasks.status` + artifacts.

### 5.9 Crash recovery (`src/engine/reconcile.ts` — modify)

Boot reconcile gains an orchestrator pass (after existing logic):
- Parent tasks `running` with subtask rows and **no planning session** (died before planning) → requeue parent (`queued`) — queue re-triggers planning.
- Parent `running` with a live plan → nothing needed: children are ordinary tasks; the existing reconcile already requeues orphaned children; the supervisor loop re-mirrors state on first tick.
- Subtasks `in_flight` whose child task was requeued by reconcile → mirror back to `delegated` (tick re-marks). Idempotent by construction since the tick derives from tasks.status.

### 5.10 New engine files

| File | Responsibility |
|---|---|
| `src/engine/orchestrator.ts` | `runParent(task, house, deps)` (plan → delegate → supervise start), `tickActivePlans(deps)` (mirror/ready-set/budget/terminal), consolidation, escalation handling, abort helpers. Invoked from queue. |
| `src/server/execution/planning/parse.ts` | Pure: `extractPlanJson`, `validatePlan`, cycle-break, cap, fallback-plan builder. |
| `src/server/execution/planning/prompts.ts` | Planning prompt template (roster injection), repair prompt, strict-JSON contract text. (Pure strings; constants import for caps.) |
| `src/server/execution/planning/resolve-plan.ts` | House resolution (explicit id → hints → fallback scoring), dep normalization. Takes `houses: HouseDto[]` as input (pure given roster). |

Modified engine files: `queue.ts` (high-lord branch + tick call), `reconcile.ts` (orchestrator pass), `main.ts` (seed call).

---

## 6. Real-time (no new event types — recommendation)

**Decision: do NOT add a plan/execution-event type.** Rationale: adding one means schema CHECK migration + constants + types + mapper + `describe-event.ts` updates for marginal benefit, and the app's established pattern (see `useVelarisStream` doc comment) is "an event arrived → refetch my REST list." The Court page follows exactly that.

Mechanics:
1. Every orchestrator state change writes an `execution_events` row **on the parent task** with `houseId = highLord.id` using existing types:
   - plan produced → `message` payload `{ plan: true, subtasks: [{planId,title,house}] }`
   - subtask delegated/in-flight/completed/failed/skipped/escalated → `message` payload `{ subtask: planId, state: "..." }`
   - plan terminal → `task_completed` / `task_failed` on parent (already standard; also drives map fireworks).
2. The browser's shared SSE picks these up as `{type:"event"}` frames → `sequence` bumps → the Court page's plan DTO refetch (`GET /api/tasks/{parent}/plan`) runs on `sequence` (identical to every other page). Subtask status chips update within ~2s.
3. Court **chat history** (user instruction + planner reply) streams the same way (`message` rows on the parent session appear as `event` frames with `taskId = parent`).
4. Child-task events already carry their own `taskId`s (child) — the Court timeline optionally subscribes and displays them grouped under subtask chips (via `on(frame)` filtering on the child ids from the plan DTO). Keep v1 simple: per-subtask "view activity" link to the child's task events endpoint is not needed — show a compact per-subtask status line only; the child detail lives on the house panel.

`describe-event.ts` gains a case: `message` events with `payload.plan`/`payload.subtask` keys → plan-flavored labels ("Plan drafted — 4 subtasks", "Subtask s2 completed — House of Mist") so the High Lord's house-panel Activity tab reads well. Additive, unit-tested.

---

## 7. Web / API surface

### 7.1 API routes (all under `src/app/api`, thin, validated by shared zod)

| Route | Method | Behavior |
|---|---|---|
| `/api/court/instructions` | POST | `courtInstructionSchema`. Resolves the High Lord house (`findHighLordHouse`), 404 "High Lord house not seeded" if absent. Creates the **parent task** via `createTask` (`houseId: hl.id`, `projectId`, `workingDirectory` (validated to exist + absolute; defaults to project directory if projectId given; may be null → planner session needs a directory, so require either workingDirectory or projectId with a directory — else 400), `title: instruction.slice(0,80)`, `description: instruction`, `executionPreferences: { maxSubtasks, tokenBudget }` if provided). Returns `{ task }`. The engine picks it up like any queued task. **Why a new route and not POST /api/tasks**: the Court flow guarantees HL assignment + directory semantics + lets the UI stay simple; generic POST /api/tasks remains untouched (regression path). |
| `/api/court/history` | GET | `buildCourtHistory(db, 20)` → `{ messages }` (Court chat across recent parent tasks). |
| `/api/tasks/[id]/plan` | GET | `buildPlanDto(db, id)` → `{ plan }`; 404 unknown task; `{ plan: null }` (200) for a task with no subtask rows (UI distinguishes "not a Court quest"). |
| `/api/tasks/[id]/cancel` | modify | Extend: after existing logic, if `getSubtaskByChildTaskId(id)` or `listSubtasksForParent(id)` finds plan linkage → cascade-cancel per §5.7 (children + subtask rows). Route stays the single user-initiated cancel path. |

All routes: `bootstrapDb()` first; `routeErrorOrMapped` error mapping; `ok/created/badRequest/notFound` helpers — matching house style.

### 7.2 Court page UI (`src/app/high-lord/page.tsx` — replace placeholder)

Client component (mirrors `quests/page.tsx` patterns):
- **Header**: PageHeader "High Lord's Court" + subtitle "Speak to the High Lord — instructions become plans, plans become quests."
- **Chat panel** (left/top): history from `GET /api/court/history` + composer (Textarea + Send). Submit → `POST /api/court/instructions` → toast "The High Lord convenes the court…" → optimistically append the user message; the planner's reply arrives via `sequence`-keyed history refetch (2s cadence).
- **Plan panel** (right/bottom): after submission, `GET /api/tasks/{parent}/plan` keyed on `sequence`. Renders:
  - parent status badge (`TaskStatusBadge`),
  - **DAG as grouped lanes** (simple, shadcn-only, no new deps): subtask cards in `order_index` order, each showing plan id chip (`s0`), title, destination house name, `childTaskStatus` badge, attempt count, and dependency chips (`← s0, s1`) — the "DAG" is a **layered list**: rows grouped by dependency depth (computed client-side with the same Kahn logic, small pure helper `plan-depth.ts` under the court components — unit-testable). Parallel-pair siblings share a row (grid-cols-2) — visually communicates "runs in parallel".
  - cost rollup line + token budget usage,
  - when terminal: consolidated summary card (result artifact) + DiffViewer for the rolled-up diff (reuse `DiffViewer` component).
  - escalation state: crimson card "Subtask s2 needs your counsel" linking to the Roost (`/roost`).
- Empty states: no High Lord house (seed missing) → "The throne sits empty" + retry hint; no instructions yet → guidance text.
- **No motion library** — CSS transitions only.

### 7.3 Houses grid / map / panel touches (minimal)

- Houses grid: High Lord **excluded by default** from `GET /api/houses` (list change §4.5) so the grid keeps its meaning; users can still visit `/high-lord` directly. **No UI change to `/houses` page** (avoid regression churn). Optional (flagged, do only if cheap): a small "High Lord" link chip above the grid.
- House panel for the **High Lord house** (`/houses/{hlId}`): works as-is via `getHouse` (always returned); its Activity tab shows planning events via the `describe-event.ts` additions. Optional "Plan" tab: **skip** — the Court page is the plan surface; the panel's Task Results tab already shows parent artifacts (result/diff) once consolidated. Document this decision in the retro.
- Map gold-plating (optional, flagged): `castle.tsx` accepts `house.kind` (already on HouseCardData via HouseDto) and renders `data-kind="high_lord"` on `.castle`; `globals.css` adds a `.castle[data-kind="high_lord"]` rule (gold window glow + slightly larger keep). The High Lord appears on the map only if the map fetch opts into it — map currently calls `/api/houses?includeArchived=true`; extend `listHouses` call from castle-map to `?includeHighLord=true` (one-line) so the throne castle renders at the city centre… **but only when the user has founded at least one house** is not enforceable simply; decide: always render the High Lord castle (it IS a house in the city). This changes the map-empty e2e ("great houses lie empty") — that assertion must be updated to expect the High Lord castle + empty state text tweak. Given the ripple, mark gold-plating as **stretch task, last, behind a feature flag question for the user (§11 open questions)**. Default recommendation: implement the `data-kind` CSS hook (cheap, no fetch change), leave the map fetch unchanged; the castle shows up once the user opens it via `/high-lord`… it won't without the fetch change — so: **fetch change + data-kind together, update the one e2e assertion, OR skip both.** Ask the user.

### 7.4 Realtime client

No changes to `velaris-stream.tsx` — the Court consumes `sequence` + `on` like existing pages.

---

## 8. Testing strategy

### 8.1 Unit (vitest, pure modules isolated per convention)

| File | Covers |
|---|---|
| `src/server/execution/planning/parse.ts` → `tests/unit/plan-parse.test.ts` | JSON extraction: fenced/unfenced/prose-wrapped/nested braces/invalid JSON; schema validation (valid plan, missing subtasks, over-cap, bad dependsOn refs); cycle detection + edge-drop; truncation; fallback-plan shape. |
| `resolve-plan.ts` → `tests/unit/plan-resolve.test.ts` | house resolution matrix: explicit id; hints scoring (name/description/role/type matches); high-lord destination rejected; no agent houses → null → fallback-fails; dependency normalization idempotence. |
| `plan-depth.ts` (court client helper) → `tests/unit/plan-depth.test.ts` | Kahn layering, parallel siblings share depth, orphan deps tolerated. |
| `describe-event.ts` plan cases → extend `tests/unit/activity-describe-event.test.ts` | plan message labels. |
| `tests/unit/orchestrator.test.ts` | **DB-backed like `queue-loop.test.ts`**: temp DB + migrate; mock `@/server/execution/runner` with scripted `executeTask` results; fake OpencodeClient. Scenarios: (1) HL task claimed → planning session runs → plan JSON from a stubbed message row → subtasks+handoffs rows created with correct statuses; (2) repair retry on bad JSON (second executeTask called with repair prompt); (3) fallback single subtask on double failure; (4) ready-set: independent pair delegated while dependent stays planned; dep completion releases it; (5) per-directory serialization holds the second same-dir subtask; (6) 2nd child failure → escalated + approval row + notification, no 3rd child; reply "skip" → skipped; (7) token budget exceeded → children cancelled, parent failed; (8) all-complete → consolidated result+diff artifacts on parent, parent completed; (9) one failed → parent failed, others complete; (10) cancel parent → children cancelled + subtasks cancelled. Uses `vi.mock` for runner + fake client exactly like `queue-loop.test.ts`; orchestrator functions take injected deps (`executeTask` fn, clock) for determinism. |
| `tests/unit/subtask-repo.test.ts` (+handoff) | CRUD against temp DB; unique child-task index; status transitions; parent listing join (childTaskStatus/houseName). |
| extend `tests/unit/schemas.test.ts` | courtInstructionSchema + planSchema + planQuery validation. |
| extend `tests/unit/execution-service.test.ts` | `getUsageSummaryForTask` rollup incl. children. |
| `tests/unit/house-seed.test.ts` | `seedHighLordHouse` idempotence (second call no-op), kind surfaced on DTO, listHouses default excludes HL. |

### 8.2 Integration (route handlers, temp DB per `api-routes.test.ts` contract)

`tests/integration/court-routes.test.ts`:
- `VELARIS_DB_PATH` before imports; `resetDbForTests()` + `resetBootstrapForTests()` in `beforeEach`; `new NextRequest()` direct invocation.
- POST /api/court/instructions: 201 + task created with HL houseId + queued; 404 when HL house deleted (simulate); 400 without directory/project; zod errors.
- GET /api/tasks/{id}/plan: `{plan: null}` for plain task; full PlanDto after seeding subtask/handoff rows via repos; 404 unknown.
- GET /api/court/history: empty; then populated from seeded parent session agent_messages.
- POST /api/tasks/{id}/cancel cascade: seed parent + 2 subtasks + child tasks (one running + session) → cancel parent → children cancelled, subtasks cancelled, child session aborted (mirror `execution-routes.test.ts` cancel tests).
- GET /api/houses default excludes the seeded High Lord; `?includeHighLord=true` includes (verify via route).

### 8.3 Engine-loop regression

Extend `tests/unit/queue-loop.test.ts` (or new `queue-highlord.test.ts`): a task on a normal house still claims + runs (mocked runner) — existing tests already cover this; add one test where a `kind: 'high_lord'` house task routes to the (mocked) orchestrator instead of the runner, proving the branch doesn't leak into direct assignment.

### 8.4 E2E (Playwright; engine OFF, rows seeded via better-sqlite3/REST — per existing patterns)

`tests/e2e/phase4-court.spec.ts`:
1. **Court instruction journey**: fresh DB → navigate `/high-lord` → assert court empty state → type instruction with a real temp working directory → submit → toast → parent task listed (via GET /api/tasks response + `request.post('/api/court/instructions')` is the UI's call — assert through the UI and then verify with a REST read) → **seed plan rows directly** (subtasks ×3: s0 completed, s1 in_flight, s2 planned dependsOn [s0, s1]; handoffs; child tasks rows + one running child session + events) → plan panel renders lanes: s0 completed chip, s1 running chip (house names visible), s2 queued-pending; cost line renders.
2. **Escalation card**: seed an `escalated` subtask + pending question-approval + notification → Court shows crimson "needs your counsel" + link → Roost shows the bird (existing roost patterns).
3. **Consolidation**: seed all-terminal subtasks + a `result` artifact + `diff` artifact on parent → Court terminal view shows summary card + DiffViewer.
4. **Direct-to-house regression (acceptance §16)**: create a normal house via UI, POST /api/tasks directly with that houseId (Playwright `request`) → quest board shows it queued (engine off ⇒ it stays queued — assert the row + badge). This is the documented regression.
5. **Houses grid empty-state preservation**: with only the seeded High Lord (no user houses), `/houses` still shows "The city's great houses lie empty." (proves the list exclusion).
6. (If map gold-plating is approved) `/map` shows the High Lord castle with `data-kind="high_lord"`; update `phase3-map.spec.ts` empty-state expectations accordingly.

**Never attempt engine orchestration in e2e** — no engine process, no OpenCode mocking server; the vitest suites own orchestration behavior.

### 8.5 Gate order

`npx tsc --noEmit` → `npm test` → `npm run test:e2e` (UI/routes changed → all three). NEVER `npm run lint`. No dependency additions (Tailwind/shadcn/lucide only; no motion lib).

---

## 9. File-by-file change list (ordered implementation steps)

### Step 1 — Migration + shared
| File | Change |
|---|---|
| `src/lib/db/schema.ts` | +`subtasks`, `handoffs` tables (DDL §2.1/§2.2 incl. `plan_id`), row types (`SubtaskRow/New`, `HandoffRow/New`) |
| `drizzle/0003_*.sql` + `meta/*` | generated (`npm run db:generate`) — commit |
| `src/shared/constants.ts` | +`HOUSE_KINDS`, `SUBTASK_STATUSES`, `ORCHESTRATION_DEFAULTS`, `HIGH_LORD_SEED` (system prompt template lives here) |
| `src/shared/types.ts` | +`HouseKind`, `SubtaskStatus`, `SubtaskDto`, `HandoffDto`, `PlanDto`, `CourtMessageDto`; `HouseDto.kind` |
| `src/shared/schemas/plan.ts` | NEW: `planSchema`, `planSubtaskSchema`, `courtInstructionSchema` |
| `tests/unit/schemas.test.ts` | extend |

### Step 2 — Repos + services
| File | Change |
|---|---|
| `src/server/repositories/subtask-repo.ts` | NEW (§4.1) |
| `src/server/repositories/handoff-repo.ts` | NEW (§4.2) |
| `src/server/repositories/house-repo.ts` | `kind` in create/list/get DTO; `includeHighLord` list option; `findHighLordHouse`; `seedHighLordHouse` |
| `src/server/repositories/execution-repo.ts` | +`getUsageSummaryForTask` |
| `src/server/services/plan-service.ts` | NEW: `buildPlanDto`, `buildCourtHistory` |
| `src/server/bootstrap.ts` | +`seedHighLordHouse` call |
| `src/server/execution-service.ts` | none (deriveRuntimeStatus untouched) |
| `tests/unit/subtask-repo.test.ts`, `tests/unit/house-seed.test.ts`, `tests/unit/execution-service.test.ts` | NEW/extend |

### Step 3 — Engine orchestration
| File | Change |
|---|---|
| `src/server/execution/planning/parse.ts` | NEW pure JSON/validate/cycle/cap/fallback |
| `src/server/execution/planning/prompts.ts` | NEW planning/repair prompt builders |
| `src/server/execution/planning/resolve-plan.ts` | NEW house + dep resolution |
| `src/engine/orchestrator.ts` | NEW: runParent, tickActivePlans, delegateSubtask, escalate, consolidate, abort helpers |
| `src/engine/queue.ts` | high-lord branch in `runClaimedTask`; call `orchestrator.tickActivePlans` in `processOnce` |
| `src/engine/reconcile.ts` | orchestrator boot pass (§5.9) |
| `src/engine/main.ts` | +`seedHighLordHouse` after provider seed |
| `tests/unit/plan-parse.test.ts`, `tests/unit/plan-resolve.test.ts`, `tests/unit/orchestrator.test.ts`, `tests/unit/queue-highlord.test.ts` | NEW |

### Step 4 — API
| File | Change |
|---|---|
| `src/app/api/court/instructions/route.ts` | NEW POST |
| `src/app/api/court/history/route.ts` | NEW GET |
| `src/app/api/tasks/[id]/plan/route.ts` | NEW GET |
| `src/app/api/tasks/[id]/cancel/route.ts` | cascade-cancel extension |
| `src/app/api/houses/route.ts` | pass `includeHighLord` query through to `listHouses` |
| `tests/integration/court-routes.test.ts` | NEW |

### Step 5 — UI
| File | Change |
|---|---|
| `src/app/high-lord/page.tsx` | replace placeholder with Court chat + plan DAG (§7.2) |
| `src/components/court/plan-depth.ts` | NEW pure Kahn layering helper |
| `src/components/court/court-chat.tsx` | NEW chat history + composer |
| `src/components/court/plan-board.tsx` | NEW plan lanes/status cards/consolidation/escalation |
| `src/components/houses/activity/describe-event.ts` | plan-message describe cases |
| `tests/unit/plan-depth.test.ts`, `tests/unit/activity-describe-event.test.ts` | NEW/extend |
| `tests/e2e/phase4-court.spec.ts` | NEW (§8.4) |
| *(optional, flagged)* `src/components/map/castle.tsx` + `castle-map.tsx` + `globals.css` + `phase3-map.spec.ts` | `data-kind` gold-plating (only if user approves §11 Q3) |

### Step 6 — Retro/docs
- `docs/IMPLEMENTATION_PLAN.md` §8 acceptance checklist ticked; note deviations (route path is `/high-lord`; handoffs keyed by houses; escalation = question-approval reuse). `docs/AGENT_ORCHESTRATION.md` §6 small update to match implementation (status vocabulary, escalation mechanics).

---

## 10. Key risks & mitigations

1. **E2E empty-state regressions** (houses grid, map): mitigated by excluding the seeded High Lord from default list responses; dedicated e2e test pins it (§8.4.5). Highest-probability breakage; implement the exclusion *before* the seed lands in the same step.
2. **Planner JSON unreliability**: mitigated by robust extraction + one repair retry + deterministic fallback (single subtask, best-matching house) — every failure path still produces a delegated plan or a clearly-failed parent; never a silent hang.
3. **Planning session allowlist conflict**: High Lord seeds `workspaceAllowlist: []` but the queue's `resolveWorkspace` fails empty-allowlist tasks. The orchestrator must **bypass resolveWorkspace for the planning session** and pass the Court-validated directory. If missed, every HL task dies with "No workspace allowlist configured" — covered by orchestrator unit test (1).
4. **Per-directory parallel races**: DAG-level serialization (§5.4.4) prevents two same-directory sessions; relies on the orchestrator being the only child-creation path (true — depth 1).
5. **Escalation approvals have no provider session**: reuse the parent planning session id for the FK; the runner's approval relay never sees them (different session); the orchestrator polls them itself. Risk: the Roost UI assumes approvals belong to active sessions — verify `approval-card.tsx` renders a terminal-session question (it reads the row, not the session — safe; covered by e2e §8.4.2).
6. **usage rollup double counting**: budget checks sum child usage rows only (`usage_records.task_id IN children` + parent planning session); each child writes exactly one usage row per session attempt (retries add rows — intended; budget counts real spend).
7. **Court UI complexity creep**: keep v1 to lanes + chips; no arrows/canvas/absolute positioning.
8. **Migration on existing dev DBs**: additive only; the seed back-fills the High Lord house for existing DBs; the map slot ordering shifts by one plot (slot 0) in fresh DBs — acceptable (visual only).

---

## 11. Open questions for the user

1. **Planning model identity**: seed the High Lord with `modelId: "glm-5.3"` (project default) — or leave `""` so the first plan requires the user to configure a model in the (otherwise normal) house edit form? Plan assumes `"glm-5.3"` + user-editable.
2. **Court chat follow-ups**: should replying *inside* an active plan's chat thread to the High Lord (e.g. mid-plan steering "also do X") be supported in v1? Plan currently supports a new instruction → new parent task; mid-plan steering is deferred (Phase 4.1 candidate).
3. **Map gold-plating**: render the High Lord castle on the map (requires `?includeHighLord=true` fetch + one updated e2e empty-state assertion) — yes or defer to Phase 5 polish? Plan default: **defer**, implement only the `data-kind` CSS hook if trivial.
4. **Escalation options wording**: "Retry once more / Skip this subtask / Abort the plan" — confirm wording/choices.
5. **Max subtasks / token budget configurability**: per-task prefs via the Court composer (plan includes API support) — should the Court UI v1 expose the two inputs, or hide them (defaults only)? Plan default: hide (defaults), API supports them.

---

## 12. Acceptance criteria (phase gate)

- [ ] "Ask the High Lord to do X" via the Court creates a parent task, produces a plan (visible as subtask rows), delegates to ≥2 houses with at least one parallel pair (independent branches), and consolidates results + cost on the parent.
- [ ] Delegation capped (max 8 default) and surfaced (subtask cards + cap notice when truncated); repeated failure escalates to a clarification bird instead of a third attempt; token budget enforced.
- [ ] Direct-to-house assignment still works (vitest + e2e regression green).
- [ ] All gates green: `npx tsc --noEmit`, `npm test`, `npm run test:e2e`.
- [ ] Migration `0003_*` committed; drizzle meta updated; no dependency changes; no `npm run lint` runs.

---

## Addendum — User Decisions (2026-09-23)

**Status:** supersedes specific sections of this plan (each delta below names what it
replaces). All other sections, file paths, table/column names, and the gate order
(`npx tsc --noEmit` → `npm test` → `npm run test:e2e`; **never lint**; no new deps;
CSS transform/opacity animations only; engine single-writer; e2e has NO engine —
seed rows directly; vitest mocks OpenCode) remain authoritative.

**Open questions §11 are now answered:**
Q1 → seed `glm-5.3`, fully user-editable (D1). Q2 → steering **in v1** (D2).
Q3 → map gold-plating **in scope, not optional** (D3). Q4 → escalation bird
**removed entirely**, replaced by retry-then-abort (D4). Q5 → defaults only,
no budget inputs in the composer (D5 — matches plan default, restated in D2e).

### D1. High Lord model: seeded default, user-configurable, non-destructible

**Delta vs §2.4/§4.5/§7.2/§7.3:**

1. **Seed unchanged** (glm-5.3, §2.4) — but the High Lord is *just a house row*.
   Its agent configuration (model, provider, system prompt) is editable via the
   standard house form / house panel. The plan needs no new UI: `HouseForm`
   (edit mode) and `/houses/{id}` both operate on plain `HouseDto`s via
   `PATCH /api/houses/{id}` — the HL row is reachable through them today.
2. **Court "Configure the High Lord" affordance** (new, small): a link/button on
   the Court page header that navigates to `/houses/{hlHouseId}` (the standard
   house panel, which already hosts the edit dialog entry point). Resolve the id
   via `findHighLordHouse` — expose it on `GET /api/court/history`'s response as
   `{ highLordHouseId }` (additive envelope field, no new route). No bespoke
   config UI: the panel + form ARE the affordance. (If the panel's edit dialog
   proves awkward to reach, the fallback is a direct `HouseForm` open on the
   Court page with `existing = hlHouse` — implement whichever is less code;
   both use the same PATCH path.)
3. **HL guard — not disableable/archivable/deletable via API (422).** Add
   `HighLordTransitionError` (reuse shape of `InvalidStatusTransitionError`) in
   `src/server/services/house-service.ts`:
   - `transitionHouseStatusService`: reject when the target house has
     `kind === 'high_lord'` and `to ∈ {'disabled','archived'}` (active ⇄ active is
     a no-op; there is no legal non-active target, so effectively all
     transitions off `active` are rejected).
   - `deleteHouseService`: reject unconditionally for `kind === 'high_lord'`
     (even if somehow archived).
   - Map `HighLordTransitionError → 422` via `badTransition` in
     `src/server/api-helpers.ts` `routeError()` (the mapping slot already
     exists next to `InvalidStatusTransitionError`).
   The guard lives in the **service layer** (web-write boundary). The engine
   never transitions house status, so no engine change. Guard applies to all
   routes that funnel through the services — that's every house PATCH/DELETE
   path (verified: `/api/houses/[id]` route is the only status/delete caller).
4. **Default-houses-list exclusion stays** (§4.5 `includeHighLord` default-off)
   — it exists to protect the `/houses` grid empty-state e2e
   (`house-journey.spec.ts:27`). Because the HL is excluded from
   `GET /api/houses` lists, the **house panel route `/houses/{hlId}` must still
   work for it** — it does: the panel uses `getHouse` (always returns the HL)
   and the panel page fetches by id, not from the list. No change needed; the
   Court configure-link must therefore deep-link by **id**, never by "first
   house in the list". Add a unit test pinning `getHouse(hl) != null` while
   `listHouses()` excludes it.

### D2. Mid-plan steering IN v1 (supersedes §11 Q2's deferral)

While a plan is active (parent task in a non-terminal state with subtask rows),
the user can send a message in the Court chat; it is prompted into the High
Lord's *planning session*, and a plan-shaped reply triggers a plan revision.

#### D2a. Why the planning session is steerable

`executeTask()` terminates its poll loop but the **provider session persists**
(OpenCode sessions are server-side and resumable by id; the engine's
`adapter.sendMessage({ providerSessionId, … })` works against any known
session id). `execution_sessions.provider_session_id` retains it after
terminal. The existing runner cannot relay into a terminal session
(`getActiveSessionForHouse` only returns pending/running/awaiting_*), so the
**orchestrator** owns the steer pump — same discipline as the approval-relay
pattern (web writes intent rows; engine notices and relays).

#### D2b. API route — `POST /api/court/steer` (new)

```ts
// src/shared/schemas/plan.ts (additive)
export const courtSteerSchema = z.object({
  parentTaskId: uuidSchema,
  message: trimmedNonEmpty(8000),
});
```

**Why a top-level `/api/court/*` route and not nested under tasks:** the Court
surface already owns `/api/court/{instructions,history}` (§7.1); steering is a
court-chat verb semantically bound to "the user is talking to the High Lord",
and the route must resolve the High Lord's *planning session* (via
subtasks → parent → latest session), not merely "a task". Nesting it under
`/api/tasks/[id]/steer` would imply task-generic behavior we don't want (steer
is only valid for HL parent tasks with a live plan). `POST /api/court/steer`
with `{ parentTaskId, message }` keeps the court routes cohesive and the zod
schema small. Route behavior (all web writes are already-legal classes —
agent_messages user rows + notifications):

1. `bootstrapDb()`; validate via `courtSteerSchema`.
2. Load parent task; 404 if absent. 404 if not an HL parent (probe:
   `listSubtasksForParent(parentTaskId)` empty AND task's house is not the HL
   house → reject).
3. **409 if the parent is terminal** (`completed|failed|cancelled|interrupted`)
   — steering a finished plan is meaningless; the UI should offer a new
   instruction instead.
4. **409 if the planning session is still busy** (`getActiveSessionForHouse(hl)`
   finds it, or a steer row is already pending — see below). **Recommendation:
   reject, don't queue.** Rationale: two steers racing one planning session
   have undefined merge order; the composer re-enables within ~2s of the
   session going quiet; queueing adds a hidden state machine (pending steer
   rows needing reconciliation) for near-zero UX gain. The engine tick is the
   only retry path we keep (below).
5. Otherwise: `createAgentMessage(db, { sessionId: planningSession.id, role:
   "user", content: message })` — this is the exact
   `/api/houses/[id]/messages` pattern, and `findPendingUserMessage` (un-relayed
   user row) is what the engine will pick up. Because the planning session is
   terminal, the *runner* won't (it's not polling it) — the **orchestrator
   tick** calls `findPendingUserMessage(raw, planningSessionId, null)` itself
   and relays via `adapter.sendMessage({ providerSessionId, … })`, then
   `markAgentMessageRelayed`. To know the session went "busy" again, the tick
   flips `execution_sessions.status` back to `running` for the steering
   exchange (engine owns session rows — legal), and after the reply quiets
   down (reuse the runner's quiet heuristic — see D2d) flips it back to
   `completed` so `getActiveSessionForHouse` stops matching it and the next
   steer is accepted. This mirrors how the engine detects cancel: row state
   the engine itself owns.
6. Return `ok({ accepted: true })`. The Court renders the user message in
   history immediately (it IS an agent_messages row on the planning session —
   `buildCourtHistory` picks it up on the next `sequence` refetch with zero
   changes).

#### D2c. Engine-side handling (orchestrator tick extension)

New tick pass in `orchestrator.tickActivePlans` (before the terminal check):

1. For each active parent, load its planning session row; if
   `findPendingUserMessage` returns a row AND `session.status` is not already
   `running`:
   - set session status → `running` (steer exchange in flight);
   - relay via `adapter.sendMessage({ sessionId, providerSessionId,
     aiProvider, modelId, message })`; `markAgentMessageRelayed` after success
     (identical to runner step 2, same crash-safety: un-relayed row → next
     tick retries).
2. For each steering-busy planning session: poll `client.getSession(
   providerSessionId)` (runner's reconcile pattern); the HL's reply streams in
   via the directory SSE (subscribed sessions only — the orchestrator must
   briefly subscribe the planning directory like the runner does, OR poll
   `GET /session/{id}` messages; **use the poll**: one `getSession` + one
   `client.listMessages(providerSessionId)` if available, else the SSE
   subscribe — pick `getSession` quiet-watch, matching the runner, and read
   the newest agent message from `agent_messages` after ingest). Simpler
   concrete contract: reuse `executeTask`'s quiet heuristic by driving a
   **mini-run**: the orchestrator calls a new `awaitSteerReply()` helper that
   polls `getSession` until quiet, mirroring runner step 3 — no new machinery,
   ~20 lines.
3. When the reply arrives: newest `role='agent'` row for the planning session →
   `extractPlanJson` → `validatePlan` (§5.3's exact extraction/repair path —
   one repair retry allowed here too, same second-message approach). If a
   valid plan parses → apply revision (D2d). If not → informational only: emit
   a `message`-type execution_event on the parent (`payload:
   { plan: false, steer: true }`) so Court chat renders the reply; NO DAG
   change. Session flips back to `completed`.

#### D2d. Revision algorithm (new pure module `apply-plan-revision.ts`)

Input: current `SubtaskDto[]` + house roster + `Plan` (parsed revision, plan ids
`r0, r1, …` distinct from original `s0, s1, …`). Match rule: **by title**,
normalized (trimmed, case-insensitive) — plan-local ids are not stable across
revisions; titles are the only user-meaningful key the model reliably echoes.

```
for each revision subtask r:
  if ∃ existing subtask s with normTitle(s) == normTitle(r):
        REWRITE s in place (update instructions/context/artifacts/completionRequirements/
        houseId resolution — new destination allowed; orderIndex/dependsOn may change
        BUT only if s is still 'planned' or 'ready')
  else: CREATE new subtask, status 'planned', fresh planId r*
for each existing subtask s NOT matched:
  if s.status ∈ {'planned','ready'}            → 'cancelled'   (never delegated)
  if s.status ∈ {'delegated','in_flight'}      → UNTOUCHED (in-flight work keeps
                                                 running; its result lands; the
                                                 revision just stops caring)
  if s.status is terminal ('completed','failed',
  'cancelled','skipped')                        → UNTOUCHED
```

Edge rules (all unit-tested — D6):
- A matched subtask whose rewrite would change `workingDirectory` semantics:
  not applicable — children inherit the parent's directory; no action.
- A matched **in-flight/delegated** subtask whose instructions changed:
  keep the delegated child untouched (don't mutate a queued/running task's
  description mid-run — engine already claimed it), and DO NOT re-delegate;
  the revision is advisory for already-delegated work. Log via event payload.
- New subtasks' `dependsOn` may reference matched subtasks' plan ids → the
  applier normalizes edges against the post-revision id set (Kahn cycle-break,
  §5.3 rules reused verbatim).
- Empty `subtasks` array in the revision → treat as informational (reject at
  zod level: `planSchema.min(1)` already does) — never cancels the whole plan.
- Revision applied inside one `db.transaction` (subtask writes + events); the
  next tick's ready-set computation picks up new `planned` rows naturally.
- Emit per-parent `execution_events { type: 'message', payload:
  { plan: true, revision: true, added: [...], cancelled: [...], changed: [...] } }`
  so the Court board visibly re-renders (sequence bump → plan DTO refetch).

#### D2e. Court UI (delta to §7.2)

- The composer **stays enabled while a plan is active**. Submit behavior
  branches client-side: if the latest parent task is non-terminal → POST
  `/api/court/steer`; else → POST `/api/court/instructions`. (Or always steer
  when the chat shows an active plan panel — the board already knows the
  active parentTaskId.)
- On 409 (steer race): toast "The High Lord is mid-counsel — try again in a
  moment"; keep the draft.
- Steer messages + HL replies appear in history (they're agent_messages rows —
  no new history shape). The revision application is visible as the plan
  panel's lane structure changing on the next `sequence` refetch (no extra
  socket work).
- **No budget inputs** (D5 restated): composer = Textarea + Send only; zod
  schema keeps `maxSubtasks`/`tokenBudget` optional prefs support, UI hides
  them (matches plan default in §7.1).

### D3. Map gold-plating in scope (supersedes §7.3's optional flag & §11 Q3)

1. **Fetch change**: `castle-map.tsx` `load()` URL becomes
   `/api/houses?includeArchived=true&includeHighLord=true` (one line; the
   query param pass-through already lands via §4.5/Step-4 `includeHighLord`).
   The map now ALWAYS shows the lone High Lord castle at the city heart: in a
   fresh DB the seeded HL is the oldest house and `computePlotLayout` sorts
   `createdAt ASC` → slot 0 = world centre (verified `plot-layout.ts:69-95`).
   In existing DBs the HL is newest → ring plot; acceptable (documented §0.2.3).
2. **`castle.tsx`**: add `data-kind={house.kind ?? "agent"}` on the root
   `.castle` div (`kind` arrives via `HouseDto.kind`, Step-1 types change).
   `globals.css` gains `.castle[data-kind="high_lord"]` — gold/gilded keep
   (override the palette vars with fixed gold tones), slightly larger via
   existing `plot.sizeVariance` — **do not** scale in CSS beyond a modest
   `1.08` multiplier on the existing transform. All animation via
   transform/opacity only; a `data-plan-aborted` visual (D4) rides the same
   attribute pattern (below). Reduced-motion: static classes only — no
   keyframes under `.velaris-reduced-motion .castle[data-kind="high_lord"]`
   (the codebase convention in `globals.css`).
3. **E2E impact — verified, narrower than §7.3 feared**:
   - `phase3-map.spec.ts` has **no** empty-map assertion (the "great houses
     lie empty" text asserted at `house-journey.spec.ts:27` is the `/houses`
     GRID, not `/map` — and the grid stays empty-safe via the list exclusion).
     No change to `house-journey.spec.ts`.
   - `phase3-map.spec.ts` changes: (a) the fresh-DB pre-founding state now has
     1 castle (the HL) not 0 — the map's `houses.length === 0` empty-state
     branch (`castle-map.tsx:355`) never fires on a seeded DB; adjust any
     count-adjacent assertions; add an assertion that
     `map-castle-{hlId}` is visible with `data-kind="high_lord"` at slot 0.
     (b) House-founding tests: founded houses get slots 1..n (HL owns slot 0)
     — `findHouse`/aria-label assertions unchanged (id-keyed, not
     slot-keyed). (c) Cleanup blocks that archive+delete houses are unaffected
     (they never touch the HL).
   - New e2e (in `phase4-court.spec.ts`, D6): `/map` shows the HL castle
     (seeded) even with zero user houses — pin the gold treatment via
     `data-kind` attribute.

### D4. Retry/abort semantics REPLACE the escalation-bird design

**Supersedes:** §5.5 step 1 (escalation branch), §5.6 row "Repeated failure →
escalation", §5.7 bullet 2 (partial-failure semantics), §8.4.2 (escalation-card
e2e), §11 Q4. There is **NO clarification bird** for subtask failure.

#### D4a. Retry loop

- `ORCHESTRATION_DEFAULTS.MAX_SUBTASK_RETRIES = 3` (constant in
  `src/shared/constants.ts`; total runs per subtask = 1 + 3 = 4). Replaces
  `MAX_ATTEMPTS_PER_SUBTASK: 2`.
- Tick mirroring (§5.5 step 1) changes: child task terminal `failed |
  cancelled | interrupted` → `incrementSubtaskAttempt`; if
  `attemptCount <= MAX_SUBTASK_RETRIES` → re-delegate: create a **fresh child
  task row** via `delegateSubtask` (new task row; the old child row stays
  terminal as history), `linkChildTask(subtask.id, newChild.id)` (the unique
  index is on `subtasks.task_id` — it must be *re-pointed*, i.e. update the
  subtask row's `task_id` to the new child), status stays through the normal
  planned→ready→delegated cycle. Backoff: none in v1 (2s queue tick is the
  natural spacing; retries are cheap model calls).
- If `attemptCount > MAX_SUBTASK_RETRIES` → **abort the entire plan** (D4b).

#### D4b. Abort state machine (any abort: retries-exhausted OR budget-exceeded OR user cancel of the parent)

`abortPlan(parent, reason)` in `orchestrator.ts` — one helper for all three
triggers (the cancel route's cascade is the web-side sibling and stays):

1. Cancel every child task not terminal: `setTaskStatus(child,
   'cancelled')` + abort its active session (`setExecutionSessionStatus(
   session.id, 'aborted')` — running `executeTask` loops observe and
   self-terminate, verified runner.ts:195-206).
2. Every non-terminal subtask row → `cancelled`.
3. Parent task → `failed` via `setTaskStatus` (engine-legal write) + record
   **abortReason** (D4c).
4. Emit `execution_events { type: 'task_failed', payload: { aborted: true,
   reason } }` on the parent + a `failure` notification.
5. **Consolidated results still written for completed children** (D4e) so the
   user sees partial output + abort reason in the terminal view.

Terminal-state consolidation (supersedes §5.7 bullet 2 — the partial-failure
case disappears): with fail-fast abort, when the parent goes terminal the
subtask rollup is only ever `completed` + `cancelled` (+ terminal history of
the failed one). Parent status mapping: all-`completed` → `completed`;
abort-reached → `failed` (with abortReason); there is no longer a
"some failed, plan continued" outcome to spec.

#### D4c. abortReason storage — `tasks.execution_preferences` (NO extra migration)

`tasks.execution_preferences` (existing JSON column, default `'{}'`) carries:
```json
{ "plan": { "abortReason": "retries_exhausted", "abortedAt": "2026-09-23T…Z" } }
```
**Verified fit:** the engine already writes task rows (`setTaskStatus`,
`createTask`); `setTaskStatus` doesn't touch prefs, so no conflict. Web PATCH
`/api/tasks/[id]` *can* write `executionPreferences` — it REPLACES the JSON
wholesale (`updateTask`, task-repo.ts:136) — so a user PATCH on an aborted
parent could clobber the block. Guard: the PATCH route (or repo) merges
instead of replaces when the existing prefs contain a `plan` key, or simpler:
**engine writes the key; web PATCH on a parent task with subtask rows is
rejected 422 anyway** (§7.1 already routes parent edits away from generic
PATCH in practice — but enforce: reject `executionPreferences` patches on
subtask-linked parents in the route; one conditional). Zod: add
`export const planExecutionPreferencesSchema = z.object({ abortReason:
z.string(), abortedAt: z.string() }).partial()` — shape documented, not
enforced at the API boundary (internal engine write). Recommend **not**
adding a tasks column — this is the zero-migration path and the data is
rarely-queried (only planState derivation + Court display read it).

#### D4d. Statuses: drop `'escalated'` and `'skipped'`

`subtasks` has not shipped yet (no migration exists at HEAD) — **remove both
from the CHECK and constants** (§2.1, §3.1):
`('planned','ready','delegated','in_flight','completed','failed','cancelled')`.
- `escalated` — the bird is gone; nothing sets it.
- `skipped` — only the escalation UI offered skip; budget-abort and
  retry-abort both use `cancelled`; ready-set release logic (§5.5 step 2)
  drops its `skipped` term.
No compat surface exists (no code reads these values yet). `attemptCount`
column stays (now counts up to 4).

#### D4e. Burning-house UI (court + map)

**(a) Court plan board — aborted state** (`src/components/court/abort-visual.tsx` NEW):
when `plan.parentTask.status === 'failed'` and prefs carry `plan.abortReason`,
the board header renders a burning-castle strip: layered flame divs
(clip-path triangles like `castle-tower-roof`), 2-3 smoke plumes reusing the
existing `.smoke-puff` pattern (already transform/opacity-animated in
`globals.css` for map smoke), fire flicker via opacity keyframes on ember
spans. All classes in `globals.css` (`.court-abort-*`); animation = opacity +
transform only; under `.velaris-reduced-motion` render the static variant
(dimmed crimson banner + "Plan aborted — <reason>" text, no keyframes).
Abort reason copy: `retries_exhausted` → "The High Lord's plan collapsed — a
subtask failed 3 times"; `token_budget_exceeded` → "…the treasury ran dry";
`user_cancel` → "…recalled by decree".

**(b) Map — burning High Lord castle while its latest plan is aborted**:
`planState` derived field (D4f) reaches the map via the houses DTO. `castle.tsx`
adds `data-plan-state={house.planState ?? undefined}` when
`house.kind === 'high_lord'`; `globals.css` `.castle[data-kind="high_lord"]
[data-plan-state="aborted"]` renders a small fire overlay (same ember/flicker
recipe, positioned over the keep) — **transform/opacity only,
reduced-motion static** (single dimmed crimson window tint, no keyframes).
The overlay clears when a new instruction starts a new plan (latest parent
task changes → `planState` recomputes → attribute drops).

#### D4f. `planState` derivation (additive, on the High Lord's DTO)

`"idle" | "planning" | "active" | "aborted" | "completed"` derived from the
HL's **latest parent task** (latest task on the HL house) + its subtask
rollup:

```
no parent task                          → 'idle'
parent queued (not yet claimed)         → 'planning'
parent running AND subtasks empty       → 'planning'   (planner call in flight)
parent running AND subtasks exist       → 'active'
parent completed                        → 'completed'
parent failed                           → 'aborted'    (abortReason distinguishes cause)
parent cancelled/interrupted           → 'aborted'    (user cancel = abort by decree)
```

**Where it lives:** `src/server/services/plan-service.ts` —
`deriveHighLordPlanState(db, hlHouseId): PlanState`, one query (latest task on
house) + one rollup probe (`listSubtasksForParent`) — both repos exist after
Step 2. It is NOT a house-repo join (house-repo stays execution-ignorant,
matching the existing layering where execution derivations live in
execution/plan services). Surface: **`GET /api/houses` enrichment adds
`planState` for high_lord rows only** (undefined/absent for agent houses —
additive, non-breaking): wire into `buildHouseListSummary` /
`buildHouseDetail` via a plan-service call guarded on `house.kind ===
'high_lord'`. The map consumes it through the same `/api/houses` fetch it
already does (D3's `includeHighLord=true`). Type: `HighLordPlanState` in
`src/shared/types.ts`; `HouseCardData` gains optional `planState`.

### D5. Court composer: defaults only (restate)

No `maxSubtasks`/`tokenBudget` inputs in the Court UI. The zod schemas and
`executionPreferences` plumbing keep optional support (API-level
configurability per §7.1); v1 UI sends instruction text only. Matches plan
default; recorded here because the user explicitly confirmed it.

---

### D6. Addendum test matrix (delta to §8)

**Unit (vitest, mocks OpenCode per queue-loop.test.ts style):**

| Scenario | File (new/extend) |
|---|---|
| Retry loop: child fails ×1 → re-delegated (fresh child row, subtask re-linked, attempt=1); fails ×3 total attempts exhausted → abort fires | `tests/unit/orchestrator.test.ts` extend |
| Abort cascade: running child + queued child + planned subtask → all cancelled, sessions aborted, parent failed + prefs `{plan:{abortReason}}` | `tests/unit/orchestrator.test.ts` extend |
| Budget abort reuses `abortPlan` (same terminal rows + burning inputs) | `tests/unit/orchestrator.test.ts` extend |
| Revision matrix: matched-rewrite; add-new; cancel-unmatched-planned; unmatched-in-flight-untouched; unmatched-terminal-untouched; title-norm matching; empty-revision rejected by zod; cycle re-normalization | `tests/unit/plan-revision.test.ts` NEW |
| Steer engine flow: pending user row on planning session → sendMessage relayed + marked; reply parses plan → revision applied; reply non-plan → informational event only; session status running→completed transitions | `tests/unit/orchestrator-steer.test.ts` NEW |
| HL guard: `transitionHouseStatusService(disable/archive)` → 422-class error; `deleteHouseService` rejected; field-only PATCH (model edit) **allowed** | `tests/unit/house-seed.test.ts` extend (+ service-level test) |
| `deriveHighLordPlanState`: all six mappings (idle/planning×2/active/completed/aborted) | `tests/unit/plan-service.test.ts` NEW/extend |
| `planState` enrichment present on HL list rows, absent on agent rows | extend houses-route integration |
| MAX_SUBTASK_RETRIES constant = 3; SUBTASK_STATUSES excludes escalated/skipped | extend `tests/unit/schemas.test.ts` |

**Integration (route handlers, temp DB per api-routes.test.ts contract):**

| Scenario | File |
|---|---|
| `POST /api/court/steer`: 202 accepted (agent_messages row written); 404 unknown task / non-parent; 409 terminal parent; 409 busy planning session; zod 400s | `tests/integration/court-routes.test.ts` extend |
| PATCH `/api/houses/{hl}` status transition → **422**; DELETE → **422**; PATCH config fields → 200 (editability preserved) | `tests/integration/house-highlord-guard.test.ts` NEW |
| PATCH `/api/tasks/{parent}` with `executionPreferences` while subtask-linked → 422 (abortReason clobber guard) | extend `tests/integration/api-routes.test.ts` |
| `GET /api/houses?includeHighLord=true` → HL present with `planState`; default → absent | extend court-routes.test.ts |

**E2E (Playwright, engine OFF — seed rows directly via better-sqlite3):**

| Scenario | Notes |
|---|---|
| Steering race + happy path is engine-owned → e2e covers UI only: composer stays enabled during active plan; POST steer blocked-409 toast path mocked by seeding a running planning session | `phase4-court.spec.ts` extend |
| Aborted state on court: seed parent failed + prefs `{plan:{abortReason:'retries_exhausted'}}` + mixed subtask rows (completed + cancelled) + result/diff artifacts on completed children → burning banner visible (static variant asserted; reduced-motion-safe) + consolidated partial output + abort copy | `phase4-court.spec.ts` extend |
| Aborted map: seed HL latest parent failed → `/map` HL castle has `data-plan-state="aborted"` (overlay is CSS; assert the attribute + static reduced-motion fallback) | `phase4-court.spec.ts` extend |
| Configure link: `/high-lord` → "Configure the High Lord" link → `/houses/{hlId}` panel renders with edit affordance; PATCH via form saves model change (glm-5.3 → other) and Court reflects it (no re-seed clobber) | `phase4-court.spec.ts` extend |
| Guard e2e (optional, cheap): direct `request.patch('/api/houses/{hl}', {status:'archived'})` → 422 response asserted | `phase4-court.spec.ts` extend |
| Map gold: fresh DB → `/map` shows HL castle `data-kind="high_lord"` at centre with zero user houses | `phase4-court.spec.ts` extend; `phase3-map.spec.ts` count adjustments per D3.3 |

**Existing e2e deltas (verified narrow):** `phase3-map.spec.ts` slot/count
adjustments only (HL always occupies slot 0); `house-journey.spec.ts:27`
empty-grid assertion **unchanged** (list exclusion holds it); no other specs
touch house counts on `/map`.

### D7. Implementation-order delta (which §9 steps gain work)

- **Step 1 (migration + shared):** unchanged tables; `SUBTASK_STATUSES` now
  excludes `escalated`/`skipped`; add `MAX_SUBTASK_RETRIES = 3`;
  add `courtSteerSchema`; add `HighLordPlanState` type; `HouseDto.kind` (as
  planned).
- **Step 2 (repos + services):** + `deriveHighLordPlanState` +
  `planState` enrichment (plan-service); + HL guard errors in house-service;
  `seedHighLordHouse` unchanged.
- **Step 3 (engine):** + steer pump in `tickActivePlans` (relay + reply
  handling); + retry loop in mirror step; + `abortPlan` helper (shared by
  retry-exhaustion, budget, reconcile-of-orphans); + revision applier module
  `src/server/execution/planning/apply-plan-revision.ts` (pure); queue branch
  unchanged.
- **Step 4 (API):** + `src/app/api/court/steer/route.ts` NEW; + 422 mapping
  for `HighLordTransitionError` in api-helpers; + `includeHighLord`
  pass-through (as planned); + PATCH-parent-prefs 422 guard.
- **Step 5 (UI):** + Court configure-link; + composer steer branch; +
  `src/components/court/abort-visual.tsx` NEW + `globals.css` burning styles;
  + `castle.tsx` `data-kind`/`data-plan-state` hooks + `globals.css` gold &
  burning overlays; + `castle-map.tsx` fetch param.
- **Step 6 (retro/docs):** note the superseded sections (§5.5 escalation,
  §5.6 repeated-failure row, §5.7 partial-failure, §7.3 optional flag, §11
  Q1–Q5 answered).

### D8. New/changed files vs §9 table (addendum-delta)

**New:** `src/app/api/court/steer/route.ts` ·
`src/server/execution/planning/apply-plan-revision.ts` (pure) ·
`src/components/court/abort-visual.tsx` ·
`tests/unit/plan-revision.test.ts` · `tests/unit/orchestrator-steer.test.ts` ·
`tests/unit/plan-service.test.ts` ·
`tests/integration/house-highlord-guard.test.ts`.

**Changed beyond §9's list:** `src/server/services/house-service.ts` (guard
errors) · `src/server/api-helpers.ts` (422 mapping) ·
`src/app/api/tasks/[id]/route.ts` (prefs-clobber guard) ·
`src/server/services/plan-service.ts` (planState derivation — was new in §9
already; grows) · `src/server/services/execution-service.ts` (planState
enrichment hook for HL rows) · `src/components/court/court-chat.tsx` (steer
branch) · `src/components/court/plan-board.tsx` (aborted state + abort-visual
mount) · `src/components/map/castle.tsx` + `castle-map.tsx` + `globals.css`
(gold + burning overlays, data-kind/data-plan-state) ·
`src/shared/schemas/plan.ts` (courtSteerSchema + prefs shape) ·
`src/shared/types.ts` (HighLordPlanState) · `tests/e2e/phase3-map.spec.ts`
(count adjustments) · `tests/e2e/phase4-court.spec.ts` (D6 scenarios).

### D9. Acceptance-criteria delta (§12)

- Replace "repeated failure escalates to a clarification bird" with: "a failed
  subtask is retried up to 3 times (4 runs max); exhaustion (or budget breach)
  aborts the plan — children cancelled, parent `failed` with
  `execution_preferences.plan.abortReason`, burning-house visuals on Court and
  map, partial consolidated output preserved."
- Add: "steering an active plan via the Court chat reaches the High Lord's
  planning session and a plan-shaped reply revises the DAG (terminal subtasks
  untouched, new subtasks planned, un-delegated absentees cancelled)."
- Add: "the High Lord house is editable via the standard house form and cannot
  be disabled/archived/deleted via the API (422)."

### D10. Risks specific to these decisions

1. **Steering relay vs runner discipline:** the orchestrator relays into a
   terminal planning session the runner no longer polls; a crash between
   `sendMessage` and `markAgentMessageRelayed` is safe (un-relayed row → next
   tick retries) but a crash AFTER relay and BEFORE reply-quiet detection
   leaves the session `running` — reconcile (§5.9) must treat a
   steering-busy HL planning session like an orphaned child: mark interrupted,
   flip parent's planning session back to completed, emit informational event.
   Add to the orchestrator reconcile pass.
2. **Title-based revision matching is fuzzy:** a model re-wording a subtask
   title in the revision creates spurious new+cancelled pairs. Mitigation: the
   steering prompt (append to `HIGH_LORD_SEED.SYSTEM_PROMPT` or the steer
   message wrapper) instructs "echo unchanged subtasks with IDENTICAL titles";
   the informational-only fallback bounds the damage (worst case: an odd
   extra subtask the user can see and reason about). Do not attempt fuzzy
   matching beyond exact-title.
3. **Prefs clobber guard is a soft contract:** `setTaskStatus` bypasses prefs,
   but any future code writing `executionPreferences` wholesale on a parent
   could erase abortReason. The 422 PATCH guard covers the only existing web
   writer; note it in the repo's `UpdateTaskPatch` doc-comment.
4. **Retries multiply spend:** 4 runs max per subtask inside the same plan
   budget; budget checks (§5.6) still run per tick, so exhaustion aborts cap
   total spend — but a subtask that always fails slowly can burn up to 4× its
   single-run cost before abort. Acceptable per user decision; surfaced via
   the cost rollup.
5. **Map now never empty:** the `houses.length === 0` empty-state in
   `castle-map.tsx` becomes dead code on seeded DBs (HL always present). Keep
   the branch (DBs could theoretically lose the seed) but no e2e covers it;
   do not delete — `getHighLord` null-safety elsewhere depends on the same
   seed-existing assumption.