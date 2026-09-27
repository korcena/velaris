# Plan — Quest Board soft-delete

**Date:** 2026-09-27
**Source of truth:** `docs/superpowers/specs/2026-09-27-quest-soft-delete-design.md`

## Goal
Hide a posting from the Quest Board without destroying history. `tasks.deleted_at` (nullable,
additive); delete = set now, restore = NULL; **status is never changed by soft delete**. Deleted
rows stay in Archives/Ledgers/house panel (marked *deleted*, restorable) and are **never claimed
by the engine**. Replace the current unguarded hard `DELETE /api/tasks/{id}`.

## Non-goals
No hard delete / purge / TTL / bulk delete. No new table. No change to create/cancel/execute
(other than the engine not claiming deleted rows). No change to Archives/Ledgers aggregation math.

## Migration spec (additive-only, Phase 5 rule)
- `schema.ts` `tasks` block (`161-203`): add `deletedAt: text("deleted_at")` (nullable) +
  `index("idx_tasks_deleted").on(t.deletedAt)`. Run `npm run db:generate` (emits `0012_*` +
  journal + `meta/0012_snapshot.json`; commit all). Emitted SQL must be exactly:
  ```sql
  ALTER TABLE `tasks` ADD `deleted_at` text;--> statement-breakpoint
  CREATE INDEX `idx_tasks_deleted` ON `tasks` (`deleted_at`);
  ```
  No `DROP` / `CREATE TABLE` / rebuild / `PRAGMA`.
- **Guard-test extensions:** `migration-chain-head.test.ts` — 0012 additivity (mirror 0009 at
  `414-428`), `hasColumn("tasks","deleted_at")`, `idx_tasks_deleted` on `deleted_at`.
  `migration-phase6-data-loss.test.ts` — `deleted_at` nullable (`notnull === 0`), `task-p6`
  survives with `NULL`. `phase6-adversarial.test.ts` (`340-350`) — add `0012_*` to the
  no-destructive-DDL/no-PRAGMA loop (the journal-orphan test passes once the entry is committed).

## Deletability predicate + restore rule (single source)
Put the predicate in `src/shared/constants.ts` (pure, both processes + UI import it):
```ts
export const DELETABLE_TASK_STATUSES: readonly TaskStatus[] =
  ["queued", "completed", "failed", "cancelled", "interrupted"];
export function isTaskDeletable(status: TaskStatus): boolean {
  return DELETABLE_TASK_STATUSES.includes(status);
}
```
Active (NOT deletable) = `running`, `awaiting_approval`, `awaiting_input`, `paused`.
Restore rule lives only in `restoreTask` (repo): **terminal → restore as-is; `queued` → flip to
`cancelled`** so a restored removed quest can never silently execute. Flagged approved default.

## Files + per-file changes
| File | Change |
|---|---|
| `src/lib/db/schema.ts` | `tasks.deletedAt` + `idx_tasks_deleted`. |
| `drizzle/0012_*.sql` + `meta/*` | Additive migration + journal + snapshot (generated). |
| `src/shared/types.ts` | `TaskDto.deletedAt: IsoTimestamp \| null` (`156-175`); `ArchiveEntryDto.deletedAt` (`543-557`); add `"task"` to `AuditEntityType` (`476-482`). |
| `src/shared/constants.ts` | `DELETABLE_TASK_STATUSES` + `isTaskDeletable`; add `'task'` to `AUDIT_ENTITY_TYPES` (`370-377`). |
| `src/shared/schemas/task.ts` | `taskDeletedFilterSchema = z.enum(["exclude","include","only"]).default("exclude")`. No body schema needed (id is a path param); reuse `taskIdSchema`. |
| `src/shared/schemas/audit.ts` | Add `"task"` to `AUDIT_ENTITY_TYPE_TUPLE` (keeps `satisfies` parity guard). |
| `src/server/repositories/task-repo.ts` | See below. |
| `src/server/repositories/archive-repo.ts` | Select `t.deleted_at AS deletedAt` (`200-220`); add to `ArchiveRow` (`86-98`) + `rowToDto` (`100-113`). |
| `src/server/api-helpers.ts` | Map `TaskNotDeletableError` → `badTransition` (422) in `routeError` (`58-99`). |
| `src/app/api/tasks/[id]/route.ts` | Repurpose `DELETE` (`99-110`) to soft delete. |
| `src/app/api/tasks/[id]/restore/route.ts` (new) | `POST` restore. |
| `src/app/api/tasks/route.ts` | `GET` (`13-26`) gains `?deleted=`. |
| `src/app/quests/page.tsx` | Per-row Delete + confirm dialog. |
| `src/app/archives/page.tsx` | *deleted* badge + Restore. |
| `src/components/houses/results/task-results.tsx` | Fetch `deleted=include`; *deleted* marker + Restore. |

### `task-repo.ts` (verified line refs)
- `taskRowToDto` (`30-47`): add `deletedAt: row.deletedAt ?? null`.
- `ListTasksOptions` (`51-55`): add `deleted?: "exclude" | "include" | "only"` (tri-state; the
  spec's `includeDeleted` boolean cannot express `only`). `listTasks` (`57-69`): default
  `"exclude"` → `isNull(tasks.deletedAt)`; `"include"` → no condition; `"only"` → `isNotNull`.
- `getTask` (`71-74`) unchanged — must keep returning deleted rows (restore + detail).
- New `TaskNotDeletableError extends Error` (message names the blocking status). New
  `softDeleteTask(db, id)`: absent → `TaskNotFoundError`; `!isTaskDeletable(row.status)` →
  `TaskNotDeletableError`; already deleted → return unchanged (idempotent); else
  `UPDATE tasks SET deleted_at = now, updated_at = now` (**status untouched**); return `getTask`.
- New `restoreTask(db, id)`: absent → `TaskNotFoundError`; not deleted → unchanged; else
  `deleted_at = NULL` and `status = row.status === "queued" ? "cancelled" : row.status`,
  `updated_at = now`; return `getTask`.
- Keep hard `deleteTask` (`178-182`) — still used by `repositories.test.ts:56,377,610,617`;
  docblock it "internal/test-only hard delete; NOT exposed via the API". Do not route to it.
- **Engine safety (key property):** add `AND deleted_at IS NULL` to `listQueuedTaskIds`
  (`250-255`) and `claimQueuedTask`'s WHERE (`262-269`); add `deleted_at IS NULL` to
  `listInFlightTaskIds` (`275-283`) so reconcile cannot requeue a deleted row.
- `countTasksByStatus` (`236-247`): add `deleted_at IS NULL` so queue depth excludes deleted rows.

### `DELETE /api/tasks/{id}` (route `99-110`)
`bootstrapDb()`; `softDeleteTask(getDb(), id)`; `recordAudit(getDb(), { actor:"user",
action:"delete", entityType:"task", entityId:id, metadata:{ title, status } })`; return
`ok({ task })` (**200, was 204**). Catch `TaskNotFoundError → notFound`, `TaskNotDeletableError
→ badTransition` (422), else `routeErrorOrMapped`. Idempotent already-deleted → 200 no-op.

### `POST /api/tasks/{id}/restore` (new; mirror `cancel/route.ts`)
`bootstrapDb()`; `restoreTask(getDb(), id)`; `recordAudit(... action:"update" or "restore",
entityType:"task", entityId:id, metadata:{ restored:true, status:task.status })`; `ok({ task })`.
Catch `TaskNotFoundError → notFound`. 404 unknown; idempotent 200 if not deleted.

### `GET /api/tasks` (`route.ts:13-26`)
Parse `sp.get("deleted")` with `taskDeletedFilterSchema`; invalid → `badRequest` (400); pass
`{ houseId, projectId, status, deleted }` to `listTasks`.

### UI
- **Quest Board** (`src/app/quests/page.tsx`): `load()` (`102-118`) keeps the default (exclude).
  Add `deleteTarget` state + `deleteTask(id)` calling `DELETE /api/tasks/${id}`, toast, then
  filter the row from `setTasks`. In the actions cell (`484-501`) add a Delete `Button`
  (`data-testid="quest-delete-${id}"`, `title` explains when active) **disabled unless
  `isTaskDeletable(task.status)`**; confirm via the existing `AlertDialog`
  (`src/components/ui/alert-dialog`, as in `projects/page.tsx:252-265`) with confirm
  `data-testid="quest-delete-confirm"`.
- **Archives** (`src/app/archives/page.tsx`): a small "deleted" `Badge` in the Task cell when
  `entry.deletedAt` (`214-253`) + a Restore `Button`
  (`data-testid="archive-restore-${entry.taskId}"`) that POSTs `/restore` then re-runs `load`.
  Archives is terminal-only and intentionally lists deleted terminal rows; no query change.
- **House panel** (`task-results.tsx`): fetch (`41`) gains `&deleted=include`; keep the
  completed/failed filter; show the *deleted* marker + Restore on the selected task.

## Test plan
- **Unit — new `tests/unit/task-soft-delete.test.ts`:** `softDeleteTask` sets `deletedAt` and
  leaves `status`; throws `TaskNotFoundError` (unknown) and `TaskNotDeletableError` for each of
  `running`/`awaiting_approval`/`awaiting_input`/`paused`; idempotent second call; `restoreTask`
  clears `deletedAt` (terminal unchanged) and flips `queued → cancelled`; unknown →
  `TaskNotFoundError`; `listTasks` default excludes / `include` includes / `only` returns only
  deleted; `getTask` still returns a deleted row.
- **Engine unit — `tests/unit/queue-loop.test.ts` (key safety test):** set `deleted_at` on a
  `queued` task, then assert `listQueuedTaskIds` omits it, `claimQueuedTask` returns `false`, and
  a queue pass does not call `executeTask`.
- **Integration — `tests/integration/api-routes.test.ts`:** **replace** the old hard-delete test
  (`980-990`, expected 204 + GET 404) with stronger assertions: DELETE → 200 with
  `task.deletedAt` set, `status` unchanged, hidden from default `GET /api/tasks`, still 200 from
  `GET /api/tasks/{id}`, unknown → 404; active (seed `running`) → 422; second DELETE → 200;
  `?deleted=include|only`; import `POST as restoreTaskRoute` (new) and test reversible +
  `queued → cancelled` + 404; assert the `listAuditLog` row after DELETE.
- **Migration guards:** extensions above.
- **Schemas — `tests/unit/schemas.test.ts`:** `taskDeletedFilterSchema` (default/valid/invalid);
  update the `omits 'task'` test (`853-857`) to assert it now **contains** `"task"` (deliberate,
  not a weakening).
- **Archive unit — `tests/unit/archive-repo.test.ts`:** set `deleted_at` on a terminal task and
  assert `searchArchives` returns it with `deletedAt` set (live rows → `null`).
- **E2E — new `tests/e2e/phase6-quest-soft-delete.spec.ts`** (engine OFF): create a house;
  `POST /api/tasks` + `PATCH` `cancelled`; `/quests` → Delete → confirm → row gone; `/archives`
  → *deleted* badge → Restore → badge gone. Cleanup: archive + delete the house via API.

## Acceptance criteria
- Deleted rows vanish from `/quests`; deleted terminal rows remain in Archives marked *deleted*
  and restorable; `GET /api/tasks?deleted=include|only` behaves; DELETE 200/404/422/idempotent;
  restore 200/404 with `queued → cancelled`.
- The engine never lists, claims or executes a deleted task (`listQueuedTaskIds`,
  `claimQueuedTask`, `listInFlightTaskIds` all exclude `deleted_at IS NOT NULL`).
- Additive-only 0012; existing rows default live; no data loss.

## Gates
```bash
npx tsc --noEmit     # baseline 0
npm test             # baseline 1182 (+1 @real skipped); expect +new cases
# free port 3000 first, then:
npm run test:e2e     # baseline 55
```
`npx tsc --noEmit` → `npm test` → `npm run test:e2e`. Do not run `npm run lint`. No dependency
changes.

## Risks
- **DELETE semantic change (204 hard → 200 soft):** no UI callers (grep-confirmed); the
  integration test is rewritten to stronger soft-delete assertions, never weakened.
- **`deleteTask` retained:** a hard-delete footgun — document test-only, never import in the
  route. Removing it breaks `repositories.test.ts:377` (it clears a project reference; a soft
  delete would leave it and `deleteProject` would still throw `ProjectHasTasksError`).
- **Deleted parent with children:** a planning parent is `running` → not deletable; once terminal
  it is deletable, but deleting it does not cancel running children (no execution change — flag).
  Restore cannot resurrect a plan: a parent is terminal or `queued`, and `queued → cancelled`.
- **`AUDIT_ENTITY_TYPES` reversal:** adding `'task'` contradicts the current decision/docblock
  (`constants.ts:361-377`) + test; intentional now that real task writes exist — update both.
- **Monitoring:** `countTasksByStatus` must exclude deleted rows (else deleted `queued` rows
  inflate `queueDepth`). Archives `total` includes deleted rows (intended).
