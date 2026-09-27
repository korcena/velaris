# Plan — Quest auto-assignment (house-less quests route or escalate)

**Date:** 2026-09-27
**Source of truth:** `docs/superpowers/specs/2026-09-27-quest-auto-assignment-design.md`
**Status:** Implementation plan (design approved)

## Goal
A quest posted with no house (`house_id = NULL`, the Board's "None") must stop failing at
claim time. The engine resolves the house **before claiming**:

1. **Deterministic first pass** — score the quest against the active `kind === 'agent'` roster
   with the existing `scoreHouse` heuristic. A *meaningful* match routes the quest to that house.
2. **High Lord escalation** — otherwise re-home onto the High Lord (`kind === 'high_lord'`), so it
   becomes a normal Court parent and plans → delegates → consolidates.
3. **Wait when OpenCode is down** — a re-homed quest stays `queued` under the existing per-task
   provider health gate; no new fallback.

Explicitly assigned quests are untouched (`house_id IS NULL` is the only trigger). No schema
change, no migration, no new event type.

## Non-goals (from the spec)
- No re-routing of explicitly assigned quests; explicit `houseId` is always honored.
- No new `execution_events` type / migration; no data backfill.
- No human-pick messenger bird; no change to approvals/questions.
- No change to High Lord planning internals, `POST /api/court/instructions`, or subtask resolution.
- No new fallback when OpenCode is down (the quest waits).
- No change to explicit-assignment workspace trust.

## Precise routing rule (single source of truth)
Pure function, no DB access (mirrors `resolve-plan.ts`):

```
chooseQuestHouse(
  signal: {
    title: string;
    type: string;
    description: string;
    workingDirectory: string | null;
    /** The task's own project directory (`projectDirectoryForTask`), or null. */
    projectDirectory: string | null;
  },
  houses: HouseDto[],                          // may include the High Lord
  effectiveAllowlists: Map<string, string[]>,  // houseId → effectiveWorkspaceAllowlist(...)
): RoutingDecision
```

1. `candidates = houses.filter(h => h.status === 'active' && h.kind === 'agent')`
   (same predicate as `resolvePlan`).
2. **Workspace-viability filter, before scoring (resolved A1; corrected to mirror
   `resolveWorkspace` exactly).** The pure module must derive the same run directory `D` the
   queue's `resolveWorkspace` will, per candidate house `h`:
   - `emptyHouseAllowlist = h.configuration.workspaceAllowlist.length === 0`
   - `effective = effectiveAllowlists.get(h.id) ?? []`
   - `D = signal.workingDirectory ?? (emptyHouseAllowlist ? signal.projectDirectory : null)`
   - viable iff:
     - `D != null` → `isPathAllowed(D, effective)`; else
     - `D == null` → `!emptyHouseAllowlist && effective.length > 0 && isPathAllowed(effective[0], effective)`

   The null-`D` branch must require `effective[0]` to itself be resolvable, because
   `resolveWorkspace`'s fallback is `fallback && isPathAllowed(fallback, effectiveAllowlist)` — a
   non-empty allowlist whose first entry does not exist on disk would otherwise route-then-fail.

   `signal.projectDirectory` is the task's own project directory (computed by the caller via
   `projectDirectoryForTask(db, task)`), NOT the first registered project. This is the only rule
   that cannot route-then-fail: an empty house allowlist with no working directory and no project
   yields `D = null` and is **not viable**; a non-empty house allowlist with no working directory
   is viable only when its first entry is resolvable. See corrected Resolved decision A1 below.

   **Multi-agent note (documented assumption):** the filter reads `h.configuration` (the default
   agent), matching `resolveWorkspace`'s `resolveRuntimeAgent(db, house.id, task) ?? house.configuration`
   **only because a house-less quest cannot carry a `task.agentId`** (the API enforces
   `agentId ⇒ houseId`; see `src/app/api/tasks/route.ts`), so the resolved runtime agent is always
   the house default. Add a code comment stating this; do not build a second resolution path.
3. `scores = candidates.map(h => ({ h, score: scoreHouse({ houseHints: signal.description, type: signal.type, title: signal.title }, h) }))`.
   Sort score DESC, stable, so equal scores keep the input (roster) order.
4. `best = scores[0]`, `runnerUpScore = scores[1]?.score ?? 0`.
   Route iff `best.score >= MIN_ROUTE_SCORE (2)` **and**
   `(best.score - runnerUpScore) >= MIN_SCORE_MARGIN (1)`:
   `{ houseId: best.h.id, escalated: false, reason: "scored", score: best.score }`.
   Otherwise the quest escalates.
5. Escalation resolution (all inside the pure module, since `houses` carries the High Lord and its
   `configuration.workspaceAllowlist`):
   - `hl = houses.find(h => h.kind === 'high_lord' && h.status === 'active')`.
   - **No active agent candidates:** reason `"no_agent_houses"`; if filtered-to-empty instead, reason
     `"no_match"`.
   - **Weak match:** `best.score === 0` → `"no_match"`, else `"weak_match"`.
   - If **no HL** → terminal decision `{ houseId: null, escalated: false, reason: "no_high_lord" }`.
   - If HL but no resolvable directory (`signal.workingDirectory ?? hl.configuration.workspaceAllowlist[0] ?? ""` is `""`)
     → terminal `{ houseId: null, escalated: false, reason: "no_directory" }`.
   - Else `{ houseId: hl.id, escalated: true, reason, score: best?.score ?? 0 }`.

`RoutingDecision` (new type in `route-quest.ts`):
```ts
export type RoutingReason =
  | "scored" | "no_agent_houses" | "weak_match" | "no_match" | "no_high_lord" | "no_directory";
export interface RoutingDecision {
  houseId: string | null;   // agent house, HL on escalation, null on terminal failure
  escalated: boolean;       // true ⇒ re-home onto the High Lord
  reason: RoutingReason;
  score: number;            // best match score (0 when no candidates)
}
```

## Files
| File | Change |
|---|---|
| `src/shared/constants.ts` | Add `QUEST_ROUTING_DEFAULTS` (`MIN_ROUTE_SCORE`, `MIN_SCORE_MARGIN`) near `ORCHESTRATION_DEFAULTS`. |
| `src/server/execution/planning/route-quest.ts` | **New.** Pure `chooseQuestHouse` + `RoutingDecision`/`RoutingReason`. |
| `src/server/repositories/task-repo.ts` | New `setTaskHouse(db, taskId, houseId)` (mirrors `setTaskStatus`). |
| `src/engine/queue.ts` | Pre-claim `resolveUnassignedTask` step in `processOnce()`; defensive fallback in `runClaimedTask`. |
| `tests/unit/route-quest.test.ts` | **New.** Pure-module coverage. |
| `tests/unit/queue-loop.test.ts` | Update the house-less regression test; add routing/escalation cases. |
| `src/app/quests/page.tsx` (optional) | Relabel the house "None" option so auto-routing is explicit. |

---

## Ordered stages

### Stage 0 — Constants (independently verifiable)
`src/shared/constants.ts`: add immediately after `ORCHESTRATION_DEFAULTS`:
```ts
/**
 * Quest auto-assignment thresholds (house-less quests only). A single weak word
 * overlap is NOT enough — ambiguous quests escalate to the High Lord.
 */
export const QUEST_ROUTING_DEFAULTS = {
  MIN_ROUTE_SCORE: 2,
  MIN_SCORE_MARGIN: 1,
} as const;
```
Verify: `npx tsc --noEmit` clean.

### Stage 1 — `setTaskHouse` repo helper
`src/server/repositories/task-repo.ts`, in the "Execution status transitions" section, mirroring
`setTaskStatus`:
```ts
/**
 * Set a task's house directly (engine-owned routing write). Explicit-assignment
 * paths always set house_id at creation; this is only used by the engine's
 * pre-claim routing of a house-less quest.
 */
export function setTaskHouse(db: VelarisDb, taskId: string, houseId: string): TaskDto | null {
  const existing = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!existing) return null;
  db.update(tasks)
    .set({ houseId, updatedAt: new Date().toISOString() })
    .where(eq(tasks.id, taskId))
    .run();
  return getTask(db, taskId);
}
```
Verify: `npx tsc --noEmit`; a focused unit assertion can be added in `route-quest.test.ts`'s sibling
or exercised through the queue tests (Stage 5).

### Stage 2 — New pure module `route-quest.ts`
`src/server/execution/planning/route-quest.ts`. No DB, no Next/React. Imports:
- `scoreHouse` from `./resolve-plan` (reuse verbatim — do **not** duplicate scoring);
- `QUEST_ROUTING_DEFAULTS` from `@/shared/constants`;
- `isPathAllowed` from `@/lib/paths` (pure, DB-free);
- `HouseDto` type from `@/shared/types`.

Export `RoutingReason`, `RoutingDecision`, and `chooseQuestHouse(signal, houses, effectiveAllowlists)`
implementing the routing rule above. Include a docblock explaining: candidates = active agent
houses; workspace filter before scoring; `MIN_ROUTE_SCORE`/`MIN_SCORE_MARGIN`; escalation reasons;
roster-order tie stability; and that `houses` may include the High Lord.

Verify: `npx tsc --noEmit`; write `tests/unit/route-quest.test.ts` (Stage 6) and run it.

### Stage 3 — Pre-claim wiring in `TaskQueue.processOnce()`
`src/engine/queue.ts`:
- Stage 3 imports: `setTaskHouse` (task-repo); `listHouses`, `findHighLordHouse` (house-repo);
  `chooseQuestHouse`, `type RoutingDecision`, `type RoutingReason` (route-quest); and add
  `projectDirectoryForTask` (from `@/server/repositories/workspace`, already the source of
  `effectiveWorkspaceAllowlist`).
- In `processOnce()`'s per-task loop, restructure the top so routing runs **before** the existing
  provider health gate and **before** `claimQueuedTask`:
  ```ts
  // Pre-claim routing: a house-less quest is resolved ONCE per tick, before the
  // provider health gate and the atomic claim. Explicitly-assigned quests are
  // untouched. A re-homed quest then waits under the normal health gate.
  let task = getTask(db, taskId);
  if (task && !task.houseId) {
    this.resolveUnassignedTask(task);
    task = getTask(db, taskId); // re-read: routing wrote house_id (or failed the task)
  }
  ```
  The current `const task = getTask(db, taskId);` (line ~110) becomes the pre-routing read; the
  health-gate block below stays structurally identical and uses the re-read `task`.
- New private method `resolveUnassignedTask(task: TaskDto): void`:
  1. `const houses = listHouses(db, { includeHighLord: true });`
  2. Build `effectiveAllowlists = new Map<string, string[]>()` by
     `effectiveWorkspaceAllowlist(db, h.configuration)` for each house (one list per house per
     routing decision).
  3. `const decision = chooseQuestHouse({ title: task.title, type: task.type, description: task.description, workingDirectory: task.workingDirectory, projectDirectory: projectDirectoryForTask(db, task) }, houses, effectiveAllowlists);`
  4. `decision.houseId != null` (routed **or** escalated to HL) → `setTaskHouse(db, task.id, decision.houseId)` and emit the routing event (Stage 4), then `return`.
  5. Terminal (`houseId == null`) → `setTaskStatus(db, task.id, "failed", msg)` +
     `createExecutionEvent({ taskId, houseId: null, rawType: "task_failed", type: "task_failed", payload: { error: msg, routing: { houseId: null, escalated: decision.escalated, reason: decision.reason, score: decision.score } } })`,
     **and a `failure` notification** (mirroring `failPlanning`/`persistTerminal` — other failure
     seams surface a notification, so routing failures must too).
     `msg` from `routingFailureMessage(decision.reason)`:
     - `"no_high_lord"` → `"No house can run this quest: create an active house or restore the High Lord."`
     - `"no_directory"` → `"This quest has no working directory and no project directory — set one before the court can plan it."`
       (do **NOT** reuse `WORKSPACE_UNREGISTERED_MESSAGE`: there is no directory to register in this
       case; that message is only correct where a directory exists but is unregistered).
   - `findHighLordHouse` is imported for consistency/tests but the decision already carries `hl.id`;
     prefer the decision's `houseId` as the source of truth (flag A2 if a reviewer prefers a
     re-lookup).

Rationale for pre-claim (spec): the "wait for OpenCode" behavior falls out of the existing health
gate for free; no claim → requeue churn; covers quests from any source.

### Stage 4 — Event emission (reuse, no migration)
In `resolveUnassignedTask` (both routed and escalated), emit:
```ts
createExecutionEvent(db, {
  taskId: task.id,
  houseId: decision.houseId,           // chosen agent house, or HL id
  rawType: "message",
  type: "message",
  payload: { routing: { houseId: decision.houseId, escalated: decision.escalated, reason: decision.reason, score: decision.score } },
});
```
`type: "message"` already exists in `EXECUTION_EVENT_TYPES` and the CHECK constraint — **no new type,
no migration**. `rawType: "message"` matches the orchestrator's `emitMessage`.

### Stage 5 — `runClaimedTask` defensive fallback
`src/engine/queue.ts` `runClaimedTask` (~168-173): the `!task.houseId` branch should now be
unreachable. Keep it as a defensive guard but make the message actionable, e.g.
`"Unassigned quest reached execution — routing did not assign a house"`, still setting `failed` and
emitting a `task_failed` event. Do not add new routing logic here (routing is pre-claim).

### Stage 6 — Unit tests: `tests/unit/route-quest.test.ts` (new)
Model the fixture style on `tests/unit/plan-resolve.test.ts` (`house(over)` helper returning a full
`HouseDto`). Workspace-filter cases need **real temp directories** because `isPathAllowed` calls
`fs.realpathSync` (same pattern as `queue-loop.test.ts`'s `tmpDir`). Cover:
1. **Deterministic pick above threshold** — two agent houses, quest text overlapping one by ≥2
   words and unique max → routed to it, `escalated: false`, `reason: "scored"`.
2. **Tie → escalate** — two houses with equal top score → `escalated: true` (HL present) and
   `houseId === hl.id`.
3. **Weak single-word → escalate** — one-word overlap (score 1 < 2) → escalate, `reason: "weak_match"`.
4. **No agent houses → escalate** — only HL in `houses` → `escalated: true`, `reason: "no_agent_houses"`.
5. **HL absent → fail** — no candidates and no HL → `{ houseId: null, escalated: false, reason: "no_high_lord" }`.
6. **Workspace filter** — cases must mirror `resolveWorkspace`:
   - candidate with a non-empty house allowlist not containing a present `workingDirectory` is
     excluded (its score, even high, cannot route); a viable candidate routes.
   - empty **house** allowlist + present `workingDirectory` inside the effective (project-derived)
     allowlist → viable.
   - `workingDirectory == null` + empty **house** allowlist + `projectDirectory == null` → **not**
     viable (excluded; escalation follows) — the default Board flow.
   - `workingDirectory == null` + empty house allowlist + `projectDirectory != null` → viable.
   - `workingDirectory == null` + non-empty house allowlist → viable (via `allowlist[0]` fallback).
7. **No-directory → fail** — no candidates, HL present, `workingDirectory == null` and HL
   `workspaceAllowlist` empty → `{ houseId: null, escalated: false, reason: "no_directory" }`.
Assert reason, `escalated`, `houseId`, and `score` explicitly (not just houseId).

### Stage 7 — Queue integration tests: update `tests/unit/queue-loop.test.ts`
Current house-less regression test (`"task with no house is claimed exactly once → failed…"`, ~123)
must be **replaced**: the behavior is now route-or-escalate.
- **No-houses fails cleanly** — house-less quest, DB has no HL and no agent houses → `failed`, and
  the `task_failed` event error equals the no-High-Lord actionable message; `executeTask` not called.
- **Route-to-best-house runs** — create an agent house whose name/role/description overlaps the
  quest title/description (≥2 words) with a non-empty allowlist containing `tmpDir`; house-less task
  with `workingDirectory: tmpDir` and no project registered → after a pass, `task.houseId === house.id`,
  status `running`, `executeTask` called, and a `message` event with `payload.routing.houseId === house.id`.
- **Weak-match re-homes to HL** — seed the HL (`seedHighLordHouse(getDb())`) and create only a
  weakly-matching agent house; house-less quest → `task.houseId === hl.id`. **Place this and the
  OpenCode-down case in `tests/unit/queue-highlord.test.ts`** (already mocks
  `@/engine/orchestrator` per A3), not `queue-loop.test.ts`.
- **OpenCode-down escalation stays queued** — same weak-match + HL setup but `fakeClient(false)` →
  after a pass `task.status === "queued"` **and** `task.houseId === hl.id` (routing ran; the health
  gate held it). Lives in `queue-highlord.test.ts` per A3.

Do not weaken existing assertions. Explicit-assignment tests in `queue-loop.test.ts` and
`queue-highlord.test.ts` must stay green unedited (regression: routing only touches `house_id IS NULL`).

---

## Event emission summary
| Case | `type` / `rawType` | payload |
|---|---|---|
| Routed to agent house | `message` / `message` | `{ routing: { houseId, escalated: false, reason: "scored", score } }` |
| Escalated to High Lord | `message` / `message` | `{ routing: { houseId: <hl.id>, escalated: true, reason, score } }` |
| Terminal failure | `task_failed` / `task_failed` | `{ error: <actionable>, routing: { houseId: null, escalated: false, reason, score } }` |

No new event type; `execution_events.type` CHECK is unchanged; **no migration**.

## Acceptance criteria
- A house-less quest with a meaningful match routes to the best agent house and runs.
- A house-less quest with a weak/ambiguous match re-homes to the High Lord and plans (waits
  `queued` while OpenCode is down).
- No eligible house and no High Lord → terminal `failed` with an actionable message and a
  `task_failed` event; no silent hang.
- Escalation with no resolvable directory → terminal `failed` with the workspace actionable message.
- Explicitly-assigned quests are byte-identical; no schema/migration; `npx tsc --noEmit` clean.

## Gates (order per AGENTS.md)
```bash
npx tsc --noEmit     # gate — there is no typecheck script
npm test             # unit + integration
# Run ONLY if the Quest Board UI (None relabel, Stage 8) changes; free port 3000 first:
npm run test:e2e
```
Do **not** run `npm run lint` (no ESLint config; interactive prompt). Do **not** bump dependency
versions.

### Stage 8 (optional, UI only) — Quest Board relabel
`src/app/quests/page.tsx` (~317): relabel `SelectItem value="__none__"` from `None` to something like
`Auto — the court chooses` and/or add a hint under the select. This is the **only** part covered by
e2e (the engine is not started by Playwright); if changed, run `npm run test:e2e`. If skipped, no e2e
run is required.

## Risks / edge cases
- **R1 — Workspace filter vs. queue behavior (A1).** `isPathAllowed` requires the directory to exist
  and treats an empty effective allowlist as permitting nothing. Filtering a house out solely because
  a directory does not exist yet will escalate rather than route. Acceptable (escalation validates
  the directory), but document it.
- **R2 — `planningDirectory` ignores the project registry.** The spec's edge case says "no working
  directory and no project directory", but the orchestrator's `planningDirectory` is
  `task.workingDirectory ?? hl.configuration.workspaceAllowlist[0] ?? ""` and never consults
  `projectDirectoryForTask`. The plan mirrors the real code (see A4); flag if the spec owner expected
  the project fallback.
- **R3 — High Lord concurrency.** If another plan is active, `runClaimedTask` requeues the parent
  (existing behavior); the re-homed quest is retried next tick. No change needed.
- **R4 — Routing runs every tick until the claim succeeds.** The write is idempotent (same decision
  under an unchanged roster) but emits a routing event per tick while a task is held by the health
  gate. If that becomes noisy, suppress the event when `task.houseId` is already set (do not change
  decision logic).
- **R5 — Filesystem-touching "pure" module.** `isPathAllowed` does `realpathSync`; the module is
  DB-free but not fs-free. Unit tests must use real temp dirs.
- **R6 — Roster order determinism.** Ties are stable to the caller's array order; pass the same
  `listHouses(db, { includeHighLord: true })` order the orchestrator uses so behavior is reproducible.

## Resolved decisions (were flagged as ambiguities)

- **A1 — Workspace viability (resolved; CORRECTED after review — see routing rule step 2).** The
  earlier "effective allowlist non-empty ⇒ viable" rule was wrong: the queue's `resolveWorkspace`
  only uses the effective/project directory when the task has a project; an empty *house* allowlist
  with no `workingDirectory` and no project fails at claim. The filter must mirror `resolveWorkspace`
  exactly, including the task's **own** project directory. This means `QuestSignal` gains a
  `projectDirectory` field (computed by the engine caller via `projectDirectoryForTask(db, task)`),
  and the pure module's null-directory viability uses
  `!emptyHouseAllowlist && effective.length > 0 && isPathAllowed(effective[0], effective)` — the
  final clause makes it a true mirror of `resolveWorkspace`'s `fallback && isPathAllowed(fallback, …)`
  guard (a non-empty allowlist whose first entry does not exist must not route). The filter reads
  `h.configuration` and assumes no `task.agentId`, which holds because a house-less quest cannot
  carry an agent (API enforces `agentId ⇒ houseId`).
  Rationale: this is the only rule that cannot route-then-fail, satisfying the design's stated goal.
  (Original mis-resolution retained below for the record.)
- **A1 (original, superseded).** "Empty effective allowlist + present dir excluded; null dir
  requires non-empty effective allowlist." This let the default Board flow (house/project/dir all
  null, seeded empty-allowlist houses, ≥1 registered project) pass the filter and then fail at
  claim instead of escalating. Superseded by the corrected rule above.
- **A2 — Terminal failures live in the pure module (resolved).** Add reasons `no_high_lord` and
  `no_directory` with `escalated: false, houseId: null`. Keeping them in `chooseQuestHouse` keeps
  the whole decision in one pure, unit-testable place; the engine only maps `null` →
  `task_failed`. (Alternative of splitting the checks into `queue.ts` rejected — would fragment
  the rule and re-introduce untested branches.)
- **A3 — Weak-match→HL queue test location (resolved).** Put the escalation cases (weak-match
  re-homes; OpenCode-down stays queued) in `tests/unit/queue-highlord.test.ts`, which already
  mocks `@/engine/orchestrator`. Do **not** add an orchestrator mock to `queue-loop.test.ts`;
  keep `queue-loop.test.ts` for the no-houses-failure and route-to-best-house cases (which do not
  enter the orchestrator). This keeps each file's mocking story coherent.
- **A4 — `planningDirectory` ignores the project registry (resolved as documented limitation).**
  The plan mirrors real code: escalation requires `task.workingDirectory` or a non-empty HL
  allowlist; a `projectId`-only quest with neither terminates as `no_directory`. Extending
  `planningDirectory` to consult `projectDirectoryForTask` is a **follow-up**, not part of this
  change. Add a code comment at the `no_directory` decision noting this.
- **A5 — Test file name corrected.** Pure-resolver test style is `tests/unit/plan-resolve.test.ts`.
- **A6 — Event `house_id` column (resolved: set to the target).** `execution_events.house_id` is
  set to the chosen agent house or the High Lord id, matching the payload, so house-scoped
  activity feeds/SSE attribute the routing event to the destination. Terminal `task_failed`
  events use `houseId: null` (no destination).

## Original ambiguities (superseded by the resolutions above)
- **A1 — "empty allowlist ⇒ viable" is underspecified.** The signature passes `effectiveAllowlists`
  (already expanded to registered-project dirs), so an all-empty effective list also means "zero
  projects". Treating that as viable would route into an instant `resolveSafePath` failure. This plan
  treats `workingDirectory == null` as viable and otherwise requires `isPathAllowed` success; confirm
  with the spec owner if a literal "effective list empty ⇒ viable" was intended.
- **A2 — Terminal-failure representation extends the stated `RoutingDecision` shape.** The spec lists
  the shape `{ houseId, escalated, reason, score }` and reasons `weak_match | no_match |
  no_agent_houses`, but the test list also requires pure-module "HL absent → fail" and "no-directory →
  fail". This plan adds reasons `no_high_lord` / `no_directory` with `escalated: false, houseId: null`
  as the terminal signal. Confirm this is acceptable (alternative: keep those two checks in `queue.ts`
  and test them only through the queue).
- **A3 — Where the weak-match→HL queue test lives.** `queue-loop.test.ts` does not currently mock the
  orchestrator; the HL branch would run real `runParent`. Either add the orchestrator mock there or
  move that one case to `queue-highlord.test.ts`.
- **A4 — "no project directory" check does not match code.** `planningDirectory` never falls back to
  `projectDirectoryForTask`, so a quest with a `projectId` but no `workingDirectory` still yields `""`
  and fails escalation. The plan follows the real code; fixing the edge case would require touching
  High Lord planning internals (non-goal).
- **A5 — File reference correction.** The task brief names `tests/unit/resolve-plan.test.ts`; the
  actual pure-resolver test is `tests/unit/plan-resolve.test.ts`.
- **A6 — Escalation event `house_id` column.** The plan sets `execution_events.house_id` to the target
  house (agent or HL). The spec only fixes the payload, not the column; confirm null vs. target is
  preferred for consistency with the SSE/UI.

## Out of scope / follow-ups
- Dedicated `execution_events.type` (e.g. `task_routed`) + migration (spec defers this).
- Surfacing routing provenance in the Court/Board UI beyond the reused `message` event.
- A "re-route on roster change" policy for quests already escalated (out of scope).
- Human-pick / messenger-bird routing (rejected).
- Extending `planningDirectory` to consult the project registry (A4) — a separate High Lord planning
  change.
