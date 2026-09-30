# Plan — Quest Board roots + quest detail page

**Date:** 2026-09-30
**Source of truth:** `docs/superpowers/specs/2026-09-30-quest-detail-page-design.md` (approved)

## Goal

Two changes, exactly as the approved spec:

1. **Quest Board shows only top-level quests.** `GET /api/tasks` gains a
   `?parent=roots|all` filter (default `roots`); engine spin-off children are
   hidden from `/quests`, while the house panel keeps seeing them via
   `parent=all`.
2. **A quest detail page at `/quests/<id>`** — stacked sections (details ·
   spin-off flow · todos & status · activity & traces · total usage), fed by
   existing endpoints plus two additions: per-step agent on `SubtaskDto`, and a
   new read-only `GET /api/tasks/{id}/trace` rollup across the quest tree.

## Non-goals

- No migration, no schema change, no engine change (engine stays the single
  writer for execution tables; the new endpoint is read-only).
- No hard delete / purge; soft-delete semantics from
  `2026-09-27-quest-soft-delete-design.md` are unchanged.
- No new todo concept (todos = existing `subtasks` rows).
- No chain-of-thought capture (OpenCode reasoning/step-start/compaction stay
  dropped by the mapper); trace = existing visible agent messages + tool
  calls/results.
- No new dependencies; no `npm run lint`.

## Verified references (checked against current code)

| File | Current anchor |
|---|---|
| `src/shared/schemas/task.ts` | `taskDeletedFilterSchema` L64 (`z.enum([...]).default("exclude")`) |
| `src/server/repositories/task-repo.ts` | `ListTasksOptions` L65–75; `listTasks` L77–92; `sql`/`isNull` imports L8 |
| `src/app/api/tasks/route.ts` | `GET` L14–38; `deleted` parse/400 L25–30; `badRequest` import L7 |
| `src/app/api/tasks/[id]/events/route.ts` | route shape L17–31 (`getTask` 404 → `listEventsForTask`) |
| `src/shared/types.ts` | `ExecutionEventDto` L289–298; `AgentMessageDto` L300–306; `SubtaskDto` L401–418 |
| `src/server/repositories/subtask-repo.ts` | `subtaskRowToDto` L30–51; `enrichSubtask` L136–152 |
| `src/server/repositories/house-repo.ts` | `resolveRuntimeAgent` L178–189; `getAgent` L480–495 |
| `src/server/services/plan-service.ts` | `buildPlanDto` L43–59; imports L15–36 |
| `src/server/repositories/execution-repo.ts` | `listSessionsForTask` L118–126; `listEventsForTask` L307–324 (`limit(1000)` L321); `listAgentMessagesForSession` L475–492 |
| `src/components/court/plan-board.tsx` | `PlanBoard` L38–165; `SubtaskCard` L167–204; `SUBTASK_STYLES` L23–31 |
| `src/components/court/plan-depth.ts` | `computePlanDepth` L35 |
| `src/app/quests/page.tsx` | state L68–69; `load` L113–129 (fetch L117); events effect L135–140; `FragmentRow` L455–608; activity expander L575–605 |
| `src/components/houses/results/task-results.tsx` | fetch L47–49 (`deleted=include`) |
| `src/app/houses/[id]/page.tsx` | client not-found pattern L31, L189–200 |
| `src/app/api/usage/route.ts` | `taskId` passthrough L25 |
| `src/lib/db/schema.ts` | `subtasks` L473–502 (`idx_subtasks_task` L493); `tasks.agentId` L179; `execution_events` L280–301 |
| `tests/unit/plan-revision.test.ts` | `sub()` SubtaskDto literal L14–31 |
| `tests/unit/schemas.test.ts` | `taskDeletedFilterSchema` describe L655–671 |
| `tests/unit/task-soft-delete.test.ts` | `listTasks deleted filter` describe L177–201 |
| `tests/unit/plan-service.test.ts` | `buildPlanDto` describe L130–195 |
| `tests/integration/api-routes.test.ts` | imports L51; `GET /api/tasks` describe L862–893; deleted test L1038–1052; `idCtx` L102–104 |
| `tests/integration/court-routes.test.ts` | `seedParentWithPlan` L128–162; plan test L370–396 |
| `tests/e2e/phase4-court.spec.ts` | `openDb` L25–29; `seedPlanRows` L73–102 |

**Caller audit (verified).** `listTasks` is called from exactly one non-test
site: `src/app/api/tasks/route.ts:31`. API consumers of `/api/tasks`:
`src/app/quests/page.tsx:117` (board → will send `parent=roots`),
`src/app/high-lord/page.tsx:38` (HL house; all roots → unaffected),
`src/components/houses/results/task-results.tsx:48` (house panel → must add
`parent=all`), plus test files. `countTasksByStatus` / `searchArchives` do not
use `listTasks`.

---

## S0 — Preflight

- `npx tsc --noEmit` (expect 0) and `npm test` (baseline **1229 passed / 1
  skipped, 89 files** on 2026-09-30). Record output.
- Confirm no in-flight edits: `git status --short`.
- Re-read the spec's "Testing"/"Acceptance criteria" before starting.

---

## S1 — `parent` schema + repo filter

### S1.1 `src/shared/schemas/task.ts`
Append after `taskDeletedFilterSchema` (L64), mirroring its style:

```ts
/**
 * Board visibility filter for `GET /api/tasks`:
 *   - "roots" (default): top-level quests only — a task referenced by a
 *     `subtasks.task_id` is an engine spin-off child and is hidden.
 *   - "all": every task (house panel / monitoring / full set).
 */
export const taskParentFilterSchema = z.enum(["roots", "all"]).default("roots");

export type TaskParentFilter = z.infer<typeof taskParentFilterSchema>;
```

### S1.2 `src/server/repositories/task-repo.ts`
- `ListTasksOptions` (L65–75): add
  ```ts
  /**
   * Board visibility: "roots" (default) excludes any task referenced by a
   * `subtasks.task_id` (engine spin-off child); "all" returns every task.
   */
  parent?: "roots" | "all";
  ```
- `listTasks` (L77–92): after `const deleted = ...` add
  `const parent = opts.parent ?? "roots";` and add to the `conditions` array:
  ```ts
  parent === "roots"
    ? sql`${tasks.id} NOT IN (SELECT task_id FROM subtasks WHERE task_id IS NOT NULL)`
    : undefined,
  ```
  `sql` is already imported (L8) and the expression is `SQL`, matching the
  array's `ReturnType<typeof eq>` predicate. The subquery is index-backed by
  `idx_subtasks_task` (L493); the `WHERE task_id IS NOT NULL` guard removes the
  SQL `NOT IN (NULL)` pitfall. An empty subquery returns all rows (correct).
- No other repo change. `getTask`, `softDeleteTask`, `restoreTask`,
  `countTasksByStatus`, `listQueuedTaskIds`, `claimQueuedTask` untouched.

**Default-is-roots is a semantic change** — S2/S8/S9 must land together.

---

## S2 — `GET /api/tasks?parent=`

`src/app/api/tasks/route.ts`:
- Import `taskParentFilterSchema` from `@/shared/schemas/task` (extend L6).
- Update the doc comment (L13) to
  `GET /api/tasks?houseId=&projectId=&status=&deleted=exclude|include|only&parent=roots|all`.
- Before the `listTasks` call (L31), parse exactly like `deleted` (L25–30):
  ```ts
  const parentRaw = sp.get("parent");
  const parentParsed =
    parentRaw === null ? undefined : taskParentFilterSchema.safeParse(parentRaw);
  if (parentParsed && !parentParsed.success) {
    return badRequest("parent must be one of: roots, all");
  }
  ```
- Pass `parent: parentParsed?.data` into `listTasks`. Absent → `undefined` →
  repo default `roots`.

---

## S3 — `SubtaskDto` per-step agent

### S3.1 `src/shared/types.ts` — `SubtaskDto` (L401–418)
Add two required fields (additive, `string | null`):
```ts
/** Engine-routed agent for this step: child task agent, else destination house default. */
agentId: Id | null;
agentName: string | null;
```

### S3.2 `src/server/repositories/subtask-repo.ts`
- `subtaskRowToDto` (L30–51): add `agentId: null, agentName: null` alongside the
  existing `houseId: null, houseName: null` placeholders. **Required** for the
  type; the bare row mapper leaves them null until resolved.
- Leave `enrichSubtask` (L136–152) unchanged (it already resolves house/child
  status). Agent resolution happens in the service per the spec.

### S3.3 `src/server/services/plan-service.ts`
- Add imports: `resolveRuntimeAgent, getAgent` from `@/server/repositories/house-repo`;
  `Id` type from `@/shared/types`.
- Add an exported helper (single source of the default-agent rule):
  ```ts
  /**
   * The agent that ran a subtask's child task: the child's explicit agent,
   * else the destination house's default (oldest) agent — the same rule the
   * engine applies when task.agent_id is null. Null when there is no child
   * task or no resolvable agent.
   */
  export function resolveSubtaskAgent(
    db: VelarisDb,
    subtask: Pick<SubtaskDto, "taskId" | "houseId">,
  ): { agentId: Id | null; agentName: string | null } {
    if (!subtask.taskId) return { agentId: null, agentName: null };
    const child = getTask(db, subtask.taskId);
    if (!child) return { agentId: null, agentName: null };
    const agent = child.houseId
      ? resolveRuntimeAgent(db, child.houseId, child)
      : child.agentId
        ? getAgent(db, child.agentId)
        : null;
    return { agentId: agent?.id ?? null, agentName: agent?.name ?? null };
  }
  ```
- In `buildPlanDto` (L47) map the list:
  ```ts
  const subtasks = listSubtasksForParent(db, parentTaskId).map((s) => ({
    ...s,
    ...resolveSubtaskAgent(db, s),
  }));
  ```
- Update the file docblock to note quest-detail reuse.

### S3.4 Test literal fix (compile-gate)
`tests/unit/plan-revision.test.ts` `sub()` (L14–31) constructs a full
`SubtaskDto` literal — add `agentId: null, agentName: null`. Without this,
`npx tsc --noEmit` fails after S3.1.

---

## S4 — Trace DTO + aggregation service

### S4.1 `src/shared/types.ts` (place after `AgentMessageDto`, ~L306)
Pure types (no React/Next):
```ts
export type TraceEntryKind = "event" | "message";

/** One tagged row of a quest-tree trace (event or agent message). */
export interface TraceEntryDto {
  /** React key, stable across refetches: `e:${eventId}` / `m:${messageId}`. */
  id: string;
  kind: TraceEntryKind;
  /** Parent task id; also the owning task for a child entry (child task id). */
  taskId: Id | null;
  /** `subtasks.id` when the row belongs to a delegated step, else null. */
  subtaskId: Id | null;
  /** Plan-local step id ("s0") when delegated, else null. */
  planId: string | null;
  agentId: Id | null;
  agentName: string | null;
  /** Event type for events; message role for messages. */
  type: string;
  createdAt: IsoTimestamp;
  /** Event payload for kind="event"; null for messages. */
  payload: Record<string, unknown> | null;
  /** Message text for kind="message"; null for events. */
  content: string | null;
}

/** Aggregated read-only trace across a quest tree (parent + non-deleted children). */
export interface TaskTraceDto {
  taskId: Id;
  entries: TraceEntryDto[];
  /** True when the merged list exceeded the cap and was truncated. */
  truncated: boolean;
}
```

### S4.2 New `src/server/services/trace-service.ts`
Pure read service (mirror `plan-service.ts` style; no writes, no audit).

```ts
export const TRACE_DEFAULT_LIMIT = 1000;

export function buildTaskTrace(
  db: VelarisDb,
  taskId: string,
  opts: { limit?: number } = {},
): TaskTraceDto | null;
```

Algorithm (exact):
1. `const parent = getTask(db, taskId); if (!parent) return null;`
2. Build the delegated-step map from `listSubtasksForParent(db, taskId)`:
   for each subtask with `taskId != null`, fetch `child = getTask(db, taskId)`;
   **skip** when `child === null` **or `child.deletedAt !== null`** (soft-deleted
   children are excluded from the rollup). Resolve the child's agent with
   `resolveRuntimeAgent(db, child.houseId, child)` (when `houseId` set), else
   `getAgent(child.agentId)`. Store `{ subtaskId, planId, agentId, agentName }`
   keyed by child task id.
3. Entries:
   - **Parent (always included):** push every event from
     `listEventsForTask(db, taskId)` tagged `{ taskId, subtaskId: null,
     planId: null, agentId/agentName: resolveRuntimeAgent(parent) }`; and every
     message from each `listSessionsForTask(db, taskId)` via
     `listAgentMessagesForSession(db, session.id)`.
   - **Each included child:** same with the child task id and the step map tag.
   - Message entries: `kind:"message"`, `id: m:${m.id}`, `type: m.role`,
     `content: m.content`, `payload: null`, `createdAt: m.createdAt`.
   - Event entries: `kind:"event"`, `id: e:${ev.id}`, `type: ev.type`,
     `payload: ev.payload`, `content: null`, `createdAt: ev.createdAt`.
4. Sort ascending by `createdAt`; tie-break `id` lexicographically (deterministic).
5. `const limit = opts.limit ?? TRACE_DEFAULT_LIMIT;` `truncated = entries.length > limit;`
   return `{ taskId, entries: entries.slice(0, limit), truncated }`.

Notes:
- Non-Court quest (no children) degrades to the parent's own events/messages.
- Soft-deleted **parent** is still traceable (parent always included).
- Per-task events are already capped at 1000 by `listEventsForTask`; the service
  cap is the merged cap.
- Imports: `listSessionsForTask, listEventsForTask, listAgentMessagesForSession`
  from execution-repo; `listSubtasksForParent` from subtask-repo; `getTask` from
  task-repo; `resolveRuntimeAgent, getAgent` from house-repo.

### S4.3 New `src/app/api/tasks/[id]/trace/route.ts`
Mirror `events/route.ts` exactly:
```ts
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  bootstrapDb();
  const { id } = await ctx.params;
  const task = getTask(getDb(), id);
  if (!task) return notFound(`Task not found: ${id}`);
  const trace = buildTaskTrace(getDb(), id);
  return ok({ trace });
}
```
No query schema (no params). Read-only, no `recordAudit`, no engine import.

---

## S5 — PlanBoard reuse/generalization (lowest-risk)

**Approach: extract the presentational DAG verbatim; keep `PlanBoard` as a thin
fetch wrapper so the High Lord page is unchanged.**

### S5.1 New `src/components/court/plan-dag.tsx` (`"use client"`)
Move, unchanged, from `plan-board.tsx`:
- `SUBTASK_STYLES` (L23–31), `SubtaskStatusBadge` (L33–36), `SubtaskCard`
  (L167–204), and the entire `return (...)` JSX of `PlanBoard` (L104–164).
- Export `PlanDag({ plan, showAgents = false }: { plan: PlanDto; showAgents?: boolean })`.
- `SubtaskCard` gains `showAgents?: boolean`; when true and
  `subtask.agentName`, render an additional `<Badge variant="outline">{subtask.agentName}</Badge>`
  in the meta row (L182–191). When false the DOM is identical to today.
- Keep all `data-testid`s (`plan-lane-*`, `subtask-*`) and the abort/consolidated
  rendering. Import `AbortVisual`, `DiffViewer`, `computePlanDepth`.

### S5.2 `src/components/court/plan-board.tsx`
- Keep `PlanBoard` with the same `{ parentTaskId, refreshKey }` props and the
  same fetch/loading/empty/no-plan branches and copy (L42–95) — **byte-identical
  behaviour**.
- Replace the inlined JSX (L104–164) with `<PlanDag plan={plan} />` (no
  `showAgents`, so no agent chip).
- Remove the now-duplicated `SUBTASK_STYLES`/`SubtaskStatusBadge`/`SubtaskCard`
  and unused imports from this file; import `PlanDag`.

Regression guard: `tests/e2e/phase4-court.spec.ts` (L180–190) must pass
unchanged.

---

## S6 — `/quests/[id]` detail page

New `src/app/quests/[id]/page.tsx` (`"use client"`; needs SSE + interactivity).
Model the shell on `src/app/houses/[id]/page.tsx`.

### S6.1 Data
`const { id } = useParams<{ id: string }>();` then a `load()` in
`useEffect(..., [id, sequence])` with `Promise.all`:
- `GET /api/tasks/${id}` → `{ task: TaskDto }` (404 → local `notFound` state —
  `notFound()` is not usable from a client component; the house page uses this
  same pattern, `houses/[id]/page.tsx:189`).
- `GET /api/tasks/${id}/plan` → `{ plan: PlanDto | null }`.
- `GET /api/tasks/${id}/trace` → `{ trace: TaskTraceDto }`.
- `GET /api/houses?includeArchived=true` and `GET /api/projects` to resolve
  house/agent/project display names (mirrors the board's `load`, `quests/page.tsx:116–120`).
- Own usage when there is no plan: if `plan === null`, also
  `GET /api/usage?taskId=${id}` → `{ totals: UsageTotalsDto }` and map
  `totalCost→total`, token counters, `estimated = estimatedCost > 0`.

Refetch on `sequence` like the board (`quests/page.tsx:131–133`).

### S6.2 Layout (top → bottom, one scroll)
1. **Header/details.** `PageHeader` with the quest title and
   `actions={<Button asChild variant="outline" size="sm"><Link href="/quests"><ArrowLeft/>Back to quests</Link></Button>}`.
   `data-testid="quest-detail-title"`. A row of badges: `TaskStatusBadge`,
   priority, house name, agent name (`task.agentId ? <agent name> : "default"`),
   project name, created/updated; a crimson **deleted** badge
   (`data-testid="quest-deleted-badge"`) when `task.deletedAt !== null`.
2. **Spin-off flow.** When `plan && plan.subtasks.length > 0`:
   `<PlanDag plan={plan} showAgents />` (from S5). Otherwise render a local
   `QuestRootNode` card: the root task title, status badge, house, agent
   (`data-testid="quest-flow-root"`). Do **not** change `PlanDag`'s empty-plan
   behaviour (Court depends on it).
3. **Todos & status.** When `plan`: a list/table of `plan.subtasks` — plan id,
   title (`title`), `SubtaskStatusBadge`-equivalent, `agentName ?? "—"`,
   `houseName`, `attemptCount`; `data-testid="quest-todo-${planId}"`. When no
   plan: a muted "This quest has no subtasks." note.
4. **Activity & traces.** A local `TraceSection({ groups })` in the same file:
   group `trace.entries` by `subtaskId ?? "root"` (label: `planId` + agent
   name, or "The quest"); each group is a native `<details>`/`<summary>`
   (dependency-free collapse). Event rows reuse
   `describeExecutionEvent` (`components/houses/activity/describe-event.ts:46`)
   or render `type` + `payload`; message rows render role + `content`.
   `data-testid="quest-trace"`, `quest-trace-group-${key}`. Empty → "No activity
   recorded yet."
5. **Total usage.** A `UsageSection` card showing cost total, input/output/
   reasoning/cacheRead tokens, and the estimated vs provider-reported split.
   Source = `plan.cost` when `plan` exists, else the `/api/usage?taskId=` totals
   mapped in S6.1. `data-testid="quest-usage"`. `reasoningTokens` count is shown
   (its text is intentionally out of scope).

### S6.3 Not found
Local `notFound` state → render a "Quest not found" `PageHeader` + card
(mirror `houses/[id]/page.tsx:189–200`).

---

## S7 — Quest Board cleanup

`src/app/quests/page.tsx`:
- `load()` (L117): fetch `"/api/tasks?parent=roots"`.
- Remove state `activityOpen` / `eventsByTask` (L68–69), the events-fetch effect
  (L135–140), the `Activity` icon import if unused (L4), and the
  `ExecutionEventDto` import (L56).
- Remove the `Activity` `<TableHead>` (L233) and the activity `<TableCell>`
  (L534–539); remove the expander `<TableRow>` (L575–605). Colspan-7 row is
  deleted with it.
- **View becomes a Link.** Replace the activity `Button` with a Next
  `<Link href={/quests/${task.id}}>` (add `import Link from "next/link"`),
  styled via `<Button asChild variant="ghost" size="sm"><Link ... data-testid={quest-view-${task.id}}>View</Link></Button>`.
- Thread-through cleanup: drop `activityOpen`, `events`, `onToggleActivity`
  props from `FragmentRow`/`FragmentRowContent` (L455–608). Keep cancel + delete
  buttons and the delete confirm dialog unchanged. `Fragment` (L518), if now
  wrapping a single `<TableRow>`, may be dropped; keep the component names to
  minimize the diff (rename optional/cosmetic).

---

## S8 — House panel `parent=all`

`src/components/houses/results/task-results.tsx` L48:
`/api/tasks?houseId=${houseId}&deleted=include` →
`/api/tasks?houseId=${houseId}&deleted=include&parent=all`.
Add a one-line comment: children must remain restorable here, so this surface
opts out of the roots filter. No other change.

---

## Test plan

### Unit — schemas (`tests/unit/schemas.test.ts`, after L671)
Import `taskParentFilterSchema`; add a `describe("taskParentFilterSchema")`:
default `undefined → "roots"`; accepts `"roots"`/`"all"`; rejects `"exclude"`,
`"true"`, `""`, `"nonsense"`.

### Unit — repo parent filter (`tests/unit/task-soft-delete.test.ts`, after L201)
Import `createTask`, `listTasks`, `createSubtask`, `linkChildTask` (already has
`createTask`/`listTasks`). New `describe("listTasks parent filter")`:
- Create parent P + child C (`createTask`), `createSubtask({parentId:P,…})` +
  `linkChildTask(s.id, C.id)`.
- Default `listTasks(db)` returns P but **not** C.
- `listTasks(db, { parent: "roots" })` same.
- `listTasks(db, { parent: "all" })` returns both.
- Combined with `deleted: "include"` still respects `parent`.

### Unit — plan-service agent resolution (`tests/unit/plan-service.test.ts`, after L195)
- Explicit child agent: create house H1 (default agent "A"), add a second agent
  via `createAgent` (returns id `n`); child task created with `agentId: n.id`;
  assert `plan.subtasks[0].agentId === n.id` and `agentName === "n name"`.
- Fallback: child with `agentId: null` → destination house's **oldest** agent
  (assert `agentId` is H1's default agent id, not the newer one). This encodes
  the "same rule the engine uses" invariant.
- No child task (`taskId: null`) → `agentId`/`agentName` null.

### Unit — trace (`tests/unit/trace-service.test.ts`, new)
Seed parent + one delegated child (subtask + link) + a second **soft-deleted**
child; add `createExecutionSession` + `createExecutionEvent`/`createAgentMessage`
per task. Assert:
- Parent and live-child events **and** messages are present and tagged with the
  right `taskId`/`subtaskId`/`planId`/`agentId`/`agentName`.
- The soft-deleted child's events/messages are **absent**.
- Entries are ordered ascending by `createdAt`.
- `buildTaskTrace(db, id, { limit: 2 })` → `entries.length === 2`,
  `truncated === true`.
- Non-Court task (no children) returns only its own events/messages.
- Unknown id → `null`.

### Integration (`tests/integration/api-routes.test.ts`)
- Import `createSubtask`, `linkChildTask` from subtask-repo; import
  `GET as getTaskTrace` from `@/app/api/tasks/[id]/trace/route`.
- Extend the `GET /api/tasks` describe (L862): seed parent + linked child,
  assert `GET /api/tasks` (no param) excludes the child, `?parent=all` includes
  it, `?parent=roots` excludes it, `?parent=bogus` → 400.
- New `describe("GET /api/tasks/{id}/trace")`: 404 for unknown id; for a seeded
  parent + child with a session/event/message each, 200 with a `trace` whose
  `entries` include both task ids and carry step/agent tags.

### Integration (`tests/integration/court-routes.test.ts`)
Extend the plan test (L370–396): assert `plan.subtasks[0].agentName` equals the
destination house's default agent name and `agentId` is non-null (fallback path,
since `seedParentWithPlan`'s children have no explicit `agentId`).

### E2E — new `tests/e2e/quest-detail-page.spec.ts`
Engine OFF. Model DB seeding on `phase4-court.spec.ts` (`openDb` L25–29,
`seedPlanRows` L73–102) using `db/velaris-e2e.db`.
1. Create a house via the form; resolve its id via `GET /api/houses`.
2. `POST /api/tasks` a **parent** quest (attach the house).
3. In DB: insert one subtask linked to a **child** task (title marker), plus a
   session + event for the child.
4. `/quests`: parent title visible; **child title count 0** (roots filter).
5. `getByTestId(quest-view-${parentId})` has `href` `/quests/${parentId}`;
   click → `/quests/<id>`:
   - title/details visible (`quest-detail-title`);
   - flow section shows the plan node(s) (`subtask-s0` from `PlanDag`);
   - todos show the step (`quest-todo-s0`);
   - `quest-usage` visible;
   - `quest-trace` visible.
6. Assert the old inline expander is gone: no `aria-expanded` activity button /
   no expander row on `/quests`; View is a link (not a toggle).
7. Cleanup: detach tasks from the house (`PATCH houseId:null`), soft-delete
   parent + child, archive + delete the house.

---

## Acceptance criteria

- `/quests` lists only top-level quests; engine spin-off children are not rows.
  `GET /api/tasks?parent=all` still returns children, so the house panel and
  restore flow are unaffected.
- `/quests/<id>` renders details (with back-link and *deleted* badge when
  applicable), the spin-off flow with the agent used per step, todos with
  per-todo status/agent/attempts, activity & traces grouped by step, and the
  total (parent + children) usage.
- The row's inline activity expander is removed; View is a `<Link>` to the page.
- `GET /api/tasks?parent=roots|all` validates; invalid → 400.
- `GET /api/tasks/{id}/trace` returns a time-ordered, step/agent-tagged rollup
  of parent + non-deleted children, capped at 1000 (`truncated` set), 404
  unknown, no audit write.
- No migration; `src/shared/**` stays React/Next-free; `src/app` imports no
  `src/engine`; no engine change; no new dependencies.

## Gates

```bash
npx tsc --noEmit     # baseline 0
npm test             # baseline 1229 passed / 1 skipped (89 files) on 2026-09-30; expect +new
# free port 3000 first, then:
npm run test:e2e     # baseline was 55 on 2026-09-27; re-confirm, expect +1 spec
```

Order: `npx tsc --noEmit` → `npm test` → `npm run test:e2e`. **Do not run
`npm run lint`.** No dependency changes. No `git add -A`.

## Risks

- **Default `parent=roots` changes `listTasks` semantics globally.** Only
  engine-created children are hidden; user-created Court parents are roots and
  stay. Mitigated by the audited caller list: board sends `roots` explicitly,
  house panel sends `all`, HL page is roots by nature, monitoring/archives use
  different queries. Run the full suite; `phase3-artifacts-usage.test.ts` hits
  `/api/tasks` but seeds no subtasks.
- **`NOT IN` NULL semantics.** Guarded by `WHERE task_id IS NOT NULL`; empty
  subquery returns all rows.
- **PlanBoard refactor regressing the High Lord page.** Mitigate by moving the
  JSX verbatim into `PlanDag` and leaving `PlanBoard`'s branches/copy untouched;
  `phase4-court.spec.ts` is the regression guard. `showAgents` defaults false,
  so no agent chip is added to the Court board.
- **`SubtaskDto` gains required fields** → the `plan-revision.test.ts` literal
  must be updated or typecheck fails (S3.4). No production literal exists.
- **Trace volume / N+1.** The service reads per-child events/sessions; a wide
  plan issues one `listEventsForTask` + session lookups per child. Acceptable
  (the plan board already does N+1 in `enrichSubtask`); the merged cap is 1000
  and the UI collapses per step. Truncation keeps the oldest 1000 (consistent
  with `listEventsForTask`).
- **`notFound()` from a client component.** The spec's wording is implemented as
  a local not-found state, matching `houses/[id]/page.tsx`; a Server Component
  page is not viable here (SSE-driven refetch + interactivity).
- **Usage for non-Court quests.** `/api/usage?taskId=` sums only the task's own
  usage (no children); this is correct precisely when `plan === null`. When a
  plan exists, `plan.cost` (parent ∪ children) is authoritative.
- **Trace cross-task ordering.** ISO `createdAt` can tie within a millisecond;
  the deterministic `id` tie-break keeps refetches stable.
