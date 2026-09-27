# Quest Auto-Assignment — Design

**Date:** 2026-09-27
**Status:** Approved (design)

## Problem

A quest posted on the Quest Board with **no house** (`house_id = null`, the
Board's "None" option) is not routed by the system. The engine's claim path
immediately fails it:

```
[queue] task <id> has no assigned house — marking failed
```

Two facts make this a real gap rather than user error:

1. `taskCreateSchema.houseId` is optional/nullable and the Quest Board renders an
   explicit **None** option (`src/app/quests/page.tsx`). Posting a house-less
   quest is a first-class, intended action.
2. The app's premise (README, IMPLEMENTATION_PLAN §1) is that **the High Lord /
   system orchestrates and chooses which house does the work**. That routing
   exists only for two paths today:
   - `POST /api/court/instructions` — always pre-assigns the parent to the High
     Lord (`house_id = hl.id`), so it never concerns itself with unassigned
     quests.
   - High Lord **subtask** resolution (`resolve-plan.ts` `resolvePlan` /
     `scoreHouse`) — assigns *subtasks inside a plan*, not user-posted quests.

   There is **no** routing for a directly-posted, house-less quest.

### Root-cause context (already fixed, tracked here for completeness)

The original symptom — a quest stuck showing `running` forever — was a **separate
queue defect**: `TaskQueue.processOnce()` claimed a house-less task twice (once
in the `!task || !task.houseId` branch, then again at the unconditional atomic
claim), so the second claim returned `false` and `runClaimedTask` was skipped,
stranding the row at `running` with no session. That double-claim was fixed
(single claim). The consequence of that fix is that a house-less quest now fails
cleanly with *"No house assigned"* instead of hanging — **but it still fails**.
This spec addresses the missing routing behavior.

## Decision

**When a quest is posted without a house, the system chooses the house —
deterministically first, escalating to the High Lord when the match is not
meaningful.**

This is a **hybrid** of the two routing mechanisms the app already has:

1. **Deterministic first pass** — score the quest against the active agent-house
   roster using the existing `scoreHouse` heuristic. If there is a *meaningful*
   match, assign that house and run normally.
2. **High Lord escalation** — otherwise re-home the quest onto the High Lord
   (`house_id = High Lord`), so it becomes a normal Court parent and goes
   through the full plan → subtasks → handoffs → consolidation path.
3. **Wait when OpenCode is down** — a re-homed quest stays `queued` until the
   OpenCode server is healthy (the engine's existing health gate), then plans.
   No new fallback path.

This reuses both existing systems end-to-end and invents no second router.

## Routing algorithm

A new **pure** module — `src/server/execution/planning/route-quest.ts` — decides
the destination. No DB access; the caller passes everything the decision needs,
mirroring `resolve-plan.ts`:

```
chooseQuestHouse(
  signal: { title: string; type: string; description: string; workingDirectory: string | null },
  houses: HouseDto[],
  effectiveAllowlists: Map<houseId, string[]>,   // computed by the engine caller
): RoutingDecision
```

The engine caller computes `effectiveAllowlists` with the existing
`effectiveWorkspaceAllowlist(db, configuration)` (empty allowlist ⇒ the
registered-project directories). The pure module never touches the DB.

```
chooseQuestHouse(task, houses):
  candidates = active, kind === "agent" houses        // same predicate as resolvePlan
  if candidates is empty:
      return { escalated: true, reason: "no_agent_houses" }   // HL fallback (or fail)
  scores = candidates.map(h -> ({ h, score: scoreHouse(task-signal, h) }))
  [best, runnerUp] = top two by score (ties by roster order)
  if best.score >= MIN_ROUTE_SCORE and (best.score - runnerUp.score) >= MIN_SCORE_MARGIN:
      return { houseId: best.id, escalated: false, reason: "scored" }
  return { escalated: true, reason: "weak_match" | "no_match" }
```

- **Signal**: reuse `scoreHouse({ houseHints: task.description, type: task.type,
  title: task.title }, house)` verbatim — no duplicated scoring logic.
- **Threshold**: `MIN_ROUTE_SCORE = 2` and `MIN_SCORE_MARGIN = 1`; a single weak
  word overlap is **not** enough, so ambiguous quests correctly escalate.
- **Constants** live in `src/shared/constants.ts` as `QUEST_ROUTING_DEFAULTS`
  (no hardcoded magic numbers).
- **Workspace-viability filter (accepted)**: restrict candidates to houses for
  which `task.workingDirectory` is viable — i.e. an empty allowlist, or the
  directory is inside the house allowlist (via the Phase 6.2
  `effectiveWorkspaceAllowlist`) — so we do not route a quest into an instant
  allowlist rejection. Filtering happens before scoring.
- **No eligible house** (no agents and no High Lord) → terminal `failed` with an
  actionable message (last resort; should not occur with seeded defaults).

## Where it runs

**Engine, pre-claim, inside `TaskQueue.processOnce()`.** Before the atomic claim
and before the existing per-task provider health gate:

```
task = getTask(db, taskId)
if (task && !task.houseId) resolveUnassignedTask(db, raw, task, log)  // writes house_id
// re-read the task; the existing health gate, claim, and runClaimedTask proceed unchanged
```

Rationale for pre-claim (vs. inside `runClaimedTask`):

- The "wait for OpenCode" requirement falls out of the **existing** health gate
  for free: once re-homed to the High Lord, the normal per-task gate holds the
  quest until OpenCode is healthy.
- Avoids claim → requeue churn: the house is resolved before `runClaimedTask`,
  so no new branch is added there.
- Covers quests created by any source (not only the API).

`runClaimedTask`'s `!task.houseId` branch is reduced to a defensive fallback
(it should be unreachable now) rather than the primary handling.

## Persistence, events, concurrency

- Assign via a small engine repo helper `setTaskHouse(db, taskId, houseId)`
  (explicit engine-owned write; mirrors `setTaskStatus`).
- Emit a **reused** event type: `type: "message"`, payload
  `{ routing: { houseId, escalated, reason, score } }`. The
  `execution_events.type` CHECK has no `task_routed`, so reuse avoids a
  migration. (Adding a dedicated type is explicitly deferred — see Non-goals.)
- **High Lord concurrency**: if another plan is active, `runClaimedTask` already
  requeues the quest → retried next tick. No change.
- A re-homed quest appears on the Board with house = High Lord and on the Court
  as the active plan — the desired, visible outcome.

## Edge cases

- **No working directory and no project directory**: High Lord planning needs a
  directory (`planningDirectory` → `""`). Escalation requires a resolvable
  directory; if absent, the quest **fails with a clear actionable message**
  (accepted). It does not silently stay queued.
- **Disabled/archived explicit house**: unchanged (task requeues; existing
  behavior).
- **Ollama-house assignment while OpenCode is down**: runs normally via the
  per-task provider gate.
- **A house-less quest with an explicit `workingDirectory`** outside every
  candidate's allowlist → candidates filtered out → escalate to High Lord
  (which validates the directory itself).
- **Reconcile interaction**: boot reconcile already requeues in-flight tasks with
  no live session; a requeued house-less quest is then routed by the pre-claim
  step on the next tick. Consistent.

## Touchpoints

| File | Change |
|---|---|
| `src/server/execution/planning/route-quest.ts` | **New.** Pure `chooseQuestHouse` + types. |
| `src/engine/queue.ts` | Pre-claim resolution step in `processOnce()`; replace the house-less `failed` branch in `runClaimedTask` with a defensive fallback. |
| `src/server/repositories/task-repo.ts` | New `setTaskHouse(db, taskId, houseId)`. |
| `src/shared/constants.ts` | `QUEST_ROUTING_DEFAULTS` (`MIN_ROUTE_SCORE`, `MIN_SCORE_MARGIN`). |
| `src/app/quests/page.tsx` (optional) | Relabel the house "None" option to make auto-routing explicit. |
| `tests/unit/route-quest.test.ts` | **New.** Pure-module coverage. |
| `tests/unit/queue-loop.test.ts` | Update the house-less regression test: now routes (or escalates), no longer fails. |

## Testing

- **Pure module**: deterministic pick above threshold; tie → escalate; weak
  single-word score → escalate; no agent houses → escalate; High Lord absent →
  terminal failure; workspace-viability filter excludes an out-of-allowlist
  house.
- **Queue integration**: house-less quest routes to the best-scoring house and
  runs; weak-match quest re-homes to the High Lord; OpenCode-down escalation
  stays `queued`; no-houses case fails cleanly with an actionable message.
- **Gates**: `npx tsc --noEmit` → `npm test` → `npm run test:e2e` if the Quest
  Board UI changes.

## Non-goals

- No re-routing of explicitly assigned quests; explicit `houseId` is always
  honored.
- No new `execution_events` type / migration (event reuse above).
- No human-pick messenger bird for routing (rejected in favor of "the system
  chooses"; a bird remains the mechanism for approvals/questions only).
- No change to High Lord planning internals, `POST /api/court/instructions`, or
  subtask resolution.
- No new fallback when OpenCode is down: a re-homed quest waits.
- No change to explicit-assignment workspace trust.

## Compatibility

- **Explicitly assigned quests are byte-identical** to today (the pre-claim step
  only touches `house_id IS NULL`).
- **House-less quests** change from "immediately failed" to "routed or
  escalated". This is the intended fix and the only behavioral change.
- No schema change, no migration, no data backfill.
