# Quest Board roots + quest detail page — Design

**Date:** 2026-09-30
**Status:** Approved (design)

## Problem

The Quest Board lists **every** `tasks` row from `GET /api/tasks`. When a quest is
executed by the High Lord, the engine's orchestrator spins off **child tasks** (one
per plan step, each run by a different house/agent) via
`createTask` + `linkChildTask` (`src/engine/orchestrator.ts`). Those children appear on
the board as ordinary, unrelated postings, so the board no longer reads as "the
quests *I* posted" — it is flooded with internals the user never asked for.

Separately, the only way to inspect a quest is a thin inline activity expander on the
row (`FragmentRow`) that shows raw execution events and nothing else: no details, no
view of how the quest branched into steps, no per-step agent, no todos, no usage.

## Decision

Two changes:

1. **The Quest Board shows only user-created top-level quests.** A "top-level" quest
   is one with no `subtasks` row pointing at it (`subtasks.task_id`). Engine spin-off
   children are hidden from the board and surface only inside their parent's detail
   page. Both user-initiated creators count as top-level: Quest Board posts
   (`POST /api/tasks`) and High Lord Court instruction parents
   (`POST /api/court/instructions`) — the Court parent is user-created and merely
   happens to have children.

2. **A dedicated quest detail page at `/quests/<id>`.** Stacked sections, one scroll:
   details · spin-off flow diagram · todos & status · activity & traces · total usage.

## Non-goals

- No new todo concept. "Todos" = the existing `subtasks` rows (each is a step with a
  status and a destination agent). No new table.
- No chain-of-thought capture. OpenCode `reasoning`/`step-start`/`compaction` parts
  are deliberately dropped by the mapper (`opencode/events/mapper.ts:140-141`);
  "activity & traces" is built from existing visible data (agent messages + tool
  calls/results), plus the `reasoningTokens` **count** already in usage.
- No change to how the orchestrator creates children, and no engine change at all.
- No hard delete, no purge. Soft-delete semantics from
  `2026-09-27-quest-soft-delete-design.md` are unchanged.

## Root identification

The authoritative link is `subtasks.task_id` (1:1 with a child task, unique index
`idx_subtasks_task`). A task is a **spin-off child** iff a `subtasks` row references
it as `task_id`. Its parent is that row's `parent_task_id`.

`executionPreferences.parentTaskId` is also written on children
(`orchestrator.ts:521`) but is a denormalized JSON hint; the `subtasks` link is the
source of truth and the only thing the API filters on.

### API: `GET /api/tasks?parent=roots|all`

New zod `taskParentFilterSchema = z.enum(["roots","all"]).default("roots")` in
`src/shared/schemas/task.ts` (single validation source), mirroring the existing
tri-state `deleted` filter.

- `roots` (default) — only top-level quests:
  `WHERE id NOT IN (SELECT task_id FROM subtasks WHERE task_id IS NOT NULL)`.
  Index-backed by `idx_subtasks_task`.
- `all` — every task, exactly the current behaviour (house panel, monitoring, any
  caller that needs the full set).

`ListTasksOptions` gains `parent?: "roots" | "all"`. Invalid values → `400`, matching
the `deleted` param's handling in `src/app/api/tasks/route.ts`.

**Caller audit (only one non-test caller today):** the route (`src/app/api/tasks/route.ts`)
passes the query through to `listTasks`. The Quest Board will send `parent=roots`
explicitly. The house panel (`task-results.tsx`) already requests
`?deleted=include` and must send `parent=all` so a deleted/child task remains
restorable. Monitoring counts use `countTasksByStatus` (unchanged) — not `listTasks`.

## Detail page data — reuse first

Most of the page is already served; the design reuses it rather than rebuilding:

| Need | Source (existing) |
|---|---|
| Details | `GET /api/tasks/{id}` → `TaskDto` |
| Flow diagram + todos + per-step house/status/attempts | `GET /api/tasks/{id}/plan` → `PlanDto` (subtasks, handoffs, `consolidated`) |
| **Total usage (parent + all children)** | `PlanDto.cost` — `buildPlanDto` calls `getUsageSummaryForTask`, which already sums `parent ∪ subtasks` and carries the `estimated` flag |
| Own activity events | `GET /api/tasks/{id}/events` |

### Two additions

1. **Per-step agent on `SubtaskDto`.** `getUsageByAgent`-style attribution needs the
   agent that ran each step. `SubtaskDto` gains `agentId: Id | null` and
   `agentName: string | null`, resolved from the child task's `agent_id` (falling
   back to the destination house's default agent — the oldest agent, the same rule the
   engine routes to when `agent_id` is null). Resolved in `plan-service.ts` when
   building the DTO; no schema change.

2. **`GET /api/tasks/{id}/trace` — aggregated activity across the quest tree.**
   Returns the parent's and every child's execution events **and** agent messages,
   each tagged with `{ taskId, subtaskId?, planId?, agentId?, agentName? }`, grouped
   by step/agent, ordered by time. Soft-deleted children are **excluded** from the
   rollup (consistent with the engine's "never run/aggregate a deleted task" rule);
   the parent's own trace is always included. A non-Court quest (no children)
   degrades to its own events/messages. Read-only; no audit write.

## The page (`/quests/<id>`)

A new App Router page. Stacked sections, top to bottom:

1. **Header / details** — title, status badge, priority, house, agent, project,
   created/updated; a back-link to the Quest Board; a *deleted* badge when
   `deletedAt !== null`.
2. **Spin-off flow** — reuse the existing DAG from
   `src/components/court/plan-board.tsx` (layered by dependency depth via
   `computePlanDepth`, one node per step, destination house, subtask status,
   attempt count). Generalize it from "Court board" to a reusable plan view so the
   quest page can render it with the new per-step agent. A quest with no children
   renders a single node (itself).
3. **Todos & status** — the subtask rows: plan id, title, status, agent, attempts.
4. **Activity & traces** — the `/trace` payload, grouped by step/agent: agent
   messages and tool calls/results. Replaces the row's inline feed.
5. **Total usage** — `plan.cost`: cost, input/output/reasoning/cacheRead tokens, and
   the estimated-vs-provider-reported split.

Real-time: the page refetches on the existing SSE `sequence` cursor
(`useVelarisStream`), like the board and Court.

## Quest Board changes

- `load()` fetches `/api/tasks?parent=roots`.
- The row **View** action becomes a `Link` to `/quests/<id>` (Next `<Link>`).
- **Remove** the inline expander: `activityOpen`, `eventsByTask`, the events-fetch
  effect, and `FragmentRow`'s activity row. The full page strictly supersedes it.
  (Per decision: one clear affordance, less code.)

## Error handling & edge cases

- Unknown id → 404 page (`notFound()`).
- Soft-deleted quest → still viewable, with a *deleted* marker; its children rollup
  excludes deleted children.
- Non-Court quest (`plan === null`) → details + own trace + own usage only.
- Root with zero subtasks but events → flow section renders just the root node.
- Trace for a child whose session/messages were never written → empty, not an error.

## Testing

- **Unit (repo):** `listTasks` `parent: "roots"` excludes a task referenced by a
  `subtasks.task_id` and includes its parent; `"all"` returns both; default is
  `roots`.
- **Unit (schemas):** `taskParentFilterSchema` default/valid/invalid.
- **Unit (plan-service):** `SubtaskDto.agentId`/`agentName` resolved from the child
  task, and falls back to the destination house's default agent when the child has no
  `agent_id`.
- **Unit (trace):** aggregation includes parent + children, excludes deleted
  children, orders by time, tags each row with its step/agent.
- **Integration:** `GET /api/tasks?parent=roots|all|bogus` (roots excludes children,
  all includes, bogus → 400); `GET /api/tasks/{id}/trace` shape + 404 unknown.
- **E2E:** create a house + a Court-style parent with a child (seed via API/DB);
  assert the child is **absent** from `/quests`; click View → `/quests/<id>` shows
  details, flow node(s), todos, and total usage; assert the removed inline expander is
  gone.

## Risks

- **Filtering the board could hide something a user expects.** Only engine-created
  children are hidden; user-created Court parents remain. The `?parent=all` escape
  hatch exists for the house panel and any future consumer.
- **`PlanBoard` reuse.** It is currently Court-specific by name and props
  (`parentTaskId`, `refreshKey`). Generalizing it must not regress the Court board;
  keep the existing behaviour byte-identical for the High Lord page.
- **Trace volume.** A quest tree can produce many events; the endpoint caps/orders
  like `listEventsForTask` (limit 1000) and the UI groups + collapses per step.
- **Reasoning text is out of scope** (see Non-goals); the usage section still shows
  the reasoning-token count so nothing looks missing.

## Acceptance criteria

- `/quests` lists only user-created top-level quests; engine spin-off children are not
  rows. `GET /api/tasks?parent=all` still returns children (house panel unaffected).
- `/quests/<id>` renders details, the spin-off flow diagram with the agent used per
  step, todos with per-todo status, activity & traces, and the total (parent +
  children) usage.
- The row's inline activity expander is removed; View navigates to the page.
- No migration; `src/shared/**` stays React/Next-free; no engine change; no new
  dependencies.
