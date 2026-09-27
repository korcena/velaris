# Quest Board soft-delete — Design

**Date:** 2026-09-27
**Status:** Approved (design)

## Problem

The Quest Board has no way to remove a posting. A `DELETE /api/tasks/{id}` route
technically exists but is (a) never called by the UI and (b) an unguarded **hard
delete** that cascades to `execution_sessions` (and their messages/usage/artifacts),
`approval_requests`, `notifications`, `subtasks`, and `handoffs`. Using it would
silently erase exactly the history the Archives and Ledgers dashboards display.

Users need to clear postings off the board without destroying the chronicle.

## Decision

**Soft delete.** A removable posting is hidden from the Quest Board; its history is
retained and it stays visible (marked *deleted*) in the Archives, Ledgers and the
house panel, where it can be **restored**.

- **Deletable** = any **non-active** task: `queued`, `completed`, `failed`,
  `cancelled`, `interrupted`.
- **Never deletable** = `running`, `awaiting_approval`, `awaiting_input`, `paused`
  (in-flight or awaiting the user; the High Lord's plan runs as `running`, so a
  planning parent is never deletable).
- The operation is **reversible** (restore), and **preserves** sessions, usage/cost,
  approvals, notifications, artifacts, subtasks and handoffs.
- No hard-delete is exposed via the API.

## Mechanism

`tasks` gains one nullable column, `deleted_at TEXT`, via an **additive** migration
(next number, `0012_*`: `ALTER TABLE tasks ADD deleted_at text;`, no rebuild, no
DROP, no PRAGMA — per the Phase 5 migration-safety rule). Plus a small index
`idx_tasks_deleted ON tasks(deleted_at)` for the "not deleted" filter.

- **Delete** = set `deleted_at = <now>` (status is **not** changed).
- **Restore** = set `deleted_at = NULL`.
- A task is "live" when `deleted_at IS NULL`.

## The engine never runs a deleted task

Critical: a deleted `queued` posting must never be claimed. The engine's queued-claim
path (`listQueuedTaskIds` and the claim update in `src/engine/queue.ts` /
`task-repo.ts`) must exclude `deleted_at IS NOT NULL`. This is the one place a missed
filter would cause a deleted quest to execute.

## Restore semantics (flagged decision)

Restoring a task that still holds status `queued` would make it immediately claimable
and it would **spontaneously run**. To keep restore safe and unsurprising:

- Restoring a **terminal** task (`completed`/`failed`/`cancelled`/`interrupted`)
  restores it as-is.
- Restoring a task whose status is **`queued`** flips it to **`cancelled`** (it was
  deliberately removed, so it must not silently execute on restore). The user can
  re-post/re-queue deliberately.

This is the recommended default; flag if a different restore rule is wanted.

## Visibility (Option A)

| Surface | Deleted posting |
|---|---|
| Quest Board (`/quests`) | **Hidden** |
| Archives (`/archives`) | **Visible if terminal**, marked *deleted*, with **Restore** |
| House panel (`/houses/{id}`) | **Visible**, marked *deleted*, with **Restore** |
| Ledgers / usage (`/dashboard`) | Cost/tokens **unchanged** (usage rows retained) |
| Audit log | Delete + restore recorded as user actions |

Note: Archives already lists **terminal tasks only** (`completed`/`failed`/
`cancelled`/`interrupted`, `archive-repo.ts` `TERMINAL_STATUSES`). Four of the five
deletable statuses are terminal, so a deleted `completed`/`failed`/`cancelled`/
`interrupted` posting appears there marked *deleted* and restorable. A deleted
`queued` posting is never in Archives (it was never terminal); it remains
recoverable from the house panel and via the API (`?deleted=only`). Deleting does
**not** change a task's status, so soft delete never moves a task into or out of
the Archives terminal set.

## API

- **`DELETE /api/tasks/{id}`** → **soft delete** (replaces the current hard delete;
  no UI calls it today, so repurposing is safe). 200 with the updated task.
  - `404` if not found.
  - **`422`** if the task is active (not deletable) — reusing the repo's existing
    422 `badTransition` convention (matching the High Lord / status-transition
    guards), with a message naming the reason.
  - Idempotent: deleting an already-deleted task is a no-op 200.
- **`POST /api/tasks/{id}/restore`** → clears `deleted_at`; applies the restore rule
  above; 200 with the updated task; `404` if not found.
- **`GET /api/tasks`** gains `?deleted=exclude|include|only` (**default `exclude`**).
  Quest Board uses the default; the house panel passes `include`.
- Both write routes call `bootstrapDb()` + `recordAudit` (user action) and use the
  existing `ok`/`routeErrorOrMapped` helpers. Zod input (a small `taskDeleteSchema`
  or reuse of the id param) lives in `src/shared/schemas/task.ts`.

## Types / repository

- `TaskDto` gains `deletedAt: IsoTimestamp | null` (`taskRowToDto` maps it) — additive.
- `ArchiveEntryDto` gains `deletedAt: IsoTimestamp | null` so Archives can badge it.
- `task-repo.ts`: `softDeleteTask(db, id)`, `restoreTask(db, id)`, and
  `ListTasksOptions.includeDeleted` (default excluded). `getTask` still returns
  deleted rows (restore and detail views need them).

## UI

- **Quest Board** (`src/app/quests/page.tsx`): a per-row **Delete** action, enabled
  only for deletable statuses (disabled/absent for active ones, with a tooltip),
  behind a confirm dialog. Calls `DELETE /api/tasks/{id}` then removes the row.
- **Archives** (`src/app/archives/page.tsx`): a *deleted* badge on rows with
  `deletedAt`, plus a **Restore** action.
- **House panel**: show the *deleted* marker on such tasks with **Restore**.
- Existing `TaskStatusBadge` is reused; the deleted marker is a separate, small
  badge. No new nav, no chart, no animation beyond opacity; reduced-motion safe.

## Non-goals

- No hard delete, no purge/TTL, no bulk delete.
- No schema change beyond `tasks.deleted_at` (+ index).
- No change to how tasks are created, cancelled, or executed (other than the engine
  never claiming deleted rows).
- No change to Archives/Ledgers aggregation math.

## Compatibility

- Existing rows have `deleted_at = NULL` → behave exactly as today.
- The `DELETE` route changes semantics (hard → soft). It had no callers, so nothing
  regresses; the old `deleteTask` repo function is retained only if still referenced
  (remove if unused, and say so).

## Testing

- **Migration chain / data-loss guards** extended: `tasks.deleted_at` exists and is
  nullable; `0012` is additive-only; source rows survive; `foreign_key_check` empty.
- **Repo/unit:** `softDeleteTask` sets the timestamp; `restoreTask` clears it;
  `listTasks` default excludes deleted and `includeDeleted` includes; restore of a
  `queued` task becomes `cancelled`; restore of a terminal task is unchanged.
- **Engine:** a deleted `queued` task is **not** claimed or executed (the key
  safety test).
- **Integration (routes):** `DELETE` soft-deletes a non-active task (200, hidden from
  the default list) and **rejects** an active task (4xx); `POST /restore` is
  reversible; `?deleted=include|only` behaves.
- **E2E:** post a quest, delete it (it leaves the board), find it marked *deleted* in
  Archives, restore it, see it return. Keep deterministic (engine OFF; no external
  calls).

## Rollout

Single change set: schema + migration + repo + routes + UI + tests. No data backfill
(all existing rows default to live). Docblocks updated in `task-repo.ts` and the
Quest Board.
