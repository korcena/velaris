/**
 * Task repository — insert, list, get, update mutable fields. No execution
 * semantics in Phase 1 (status locked to queued/cancelled).
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { eq, and, sql, isNull, isNotNull } from "drizzle-orm";
import { rawDb, type VelarisDb } from "@/lib/db";
import { tasks, type TaskRow } from "@/lib/db/schema";
import { parseJson } from "@/shared/schemas/common";
import { DELETABLE_TASK_STATUSES, isTaskDeletable } from "@/shared/constants";
import type { TaskDto, TaskPriority, TaskStatus } from "@/shared/types";

export class TaskNotFoundError extends Error {
  constructor(id: string) {
    super(`Task not found: ${id}`);
    this.name = "TaskNotFoundError";
  }
}

/**
 * Thrown by `softDeleteTask` when a task is in an active state
 * (running/awaiting_approval/awaiting_input/paused) and therefore cannot be
 * removed from the board. Mapped to HTTP 422 by the API.
 */
export class TaskNotDeletableError extends Error {
  constructor(status: TaskStatus | string) {
    super(`Task cannot be deleted while it is '${status}'`);
    this.name = "TaskNotDeletableError";
  }
}

export class InvalidTaskStatusTransitionError extends Error {
  constructor(from: TaskStatus | string, to: TaskStatus | string) {
    super(`Invalid task status transition: ${from} → ${to}`);
    this.name = "InvalidTaskStatusTransitionError";
  }
}

/* ------------------------------ Mapping ----------------------------- */

export function taskRowToDto(row: (typeof tasks.$inferSelect)): TaskDto {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? "",
    type: row.type,
    priority: row.priority as TaskPriority,
    status: row.status as TaskStatus,
    houseId: row.houseId ?? null,
    projectId: row.projectId ?? null,
    agentId: row.agentId ?? null,
    workingDirectory: row.workingDirectory ?? null,
    executionPreferences: parseJson<Record<string, unknown>>(row.executionPreferences, {}),
    attachments: parseJson<Array<{ name: string; path: string }>>(row.attachments, []),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt ?? null,
  };
}

/* ------------------------------ Reading ----------------------------- */

export interface ListTasksOptions {
  houseId?: string;
  projectId?: string;
  status?: TaskStatus;
  /**
   * Soft-delete visibility: "exclude" (default) = live only; "include" = live +
   * deleted; "only" = deleted only. A tri-state (not a boolean) so Archives and
   * the house panel can request exactly the deleted rows.
   */
  deleted?: "exclude" | "include" | "only";
}

export function listTasks(db: VelarisDb, opts: ListTasksOptions = {}): TaskDto[] {
  const deleted = opts.deleted ?? "exclude";
  const conditions = [
    opts.houseId ? eq(tasks.houseId, opts.houseId) : undefined,
    opts.projectId ? eq(tasks.projectId, opts.projectId) : undefined,
    opts.status ? eq(tasks.status, opts.status) : undefined,
    deleted === "exclude" ? isNull(tasks.deletedAt) : undefined,
    deleted === "only" ? isNotNull(tasks.deletedAt) : undefined,
  ].filter((c): c is ReturnType<typeof eq> => c !== undefined);

  const query = conditions.length
    ? db.select().from(tasks).where(and(...conditions))
    : db.select().from(tasks);

  return query.orderBy(sql`${tasks.createdAt} DESC`).all().map(taskRowToDto);
}

export function getTask(db: VelarisDb, id: string): TaskDto | null {
  const row = db.select().from(tasks).where(eq(tasks.id, id)).get();
  return row ? taskRowToDto(row) : null;
}

/* ------------------------------ Writing ----------------------------- */

export interface CreateTaskInput {
  id?: string;
  title: string;
  description?: string;
  type?: string;
  priority?: TaskPriority;
  houseId?: string | null;
  projectId?: string | null;
  agentId?: string | null;
  workingDirectory?: string | null;
  executionPreferences?: Record<string, unknown>;
  attachments?: Array<{ name: string; path: string }>;
}

export function createTask(db: VelarisDb, input: CreateTaskInput): TaskDto {
  const id = input.id ?? randomUUID();
  db.insert(tasks)
    .values({
      id,
      title: input.title,
      description: input.description ?? "",
      type: input.type ?? "general",
      priority: input.priority ?? "medium",
      // Phase 1: always created as 'queued'; engine ignores rows until Phase 2.
      status: "queued",
      houseId: input.houseId ?? null,
      projectId: input.projectId ?? null,
      agentId: input.agentId ?? null,
      workingDirectory: input.workingDirectory ?? null,
      executionPreferences: JSON.stringify(input.executionPreferences ?? {}),
      attachments: JSON.stringify(input.attachments ?? []),
    })
    .run();
  return getTask(db, id)!;
}

export type UpdateTaskPatch = {
  title?: string;
  description?: string;
  type?: string;
  priority?: TaskPriority;
  houseId?: string | null;
  projectId?: string | null;
  agentId?: string | null;
  workingDirectory?: string | null;
  /**
   * Replaces `execution_preferences` WHOLESALE (line 137 below does
   * `JSON.stringify(patch.executionPreferences)`).
   *
   * CONTRACT: the `execution_preferences.plan.*` block is ENGINE-OWNED — the
   * orchestrator writes `plan.abortReason` / `plan.abortedAt` on a High Lord
   * parent (addendum D4c) and re-reads it to drive the burned-house UI. Any
   * wholesale write here (e.g. the PATCH route) can erase that block. The web
   * PATCH route guards against this for subtask-linked parents (422), but that
   * is route-only; this repo type is the documented contract: when setting
   * `executionPreferences`, MERGE onto the existing object rather than
   * replacing it if the existing prefs contain a top-level `plan` key, so the
   * engine's abort-reason block and any future engine-written plan state are
   * never clobbered.
   */
  executionPreferences?: Record<string, unknown>;
  /** Phase 1: only 'cancelled' is permitted after creation. */
  status?: TaskStatus;
};

export function updateTask(db: VelarisDb, id: string, patch: UpdateTaskPatch): TaskDto {
  const existing = db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!existing) throw new TaskNotFoundError(id);

  const set: Record<string, unknown> = {};
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.type !== undefined) set.type = patch.type;
  if (patch.priority !== undefined) set.priority = patch.priority;
  if (patch.houseId !== undefined) set.houseId = patch.houseId;
  if (patch.projectId !== undefined) set.projectId = patch.projectId;
  if (patch.agentId !== undefined) set.agentId = patch.agentId;
  if (patch.workingDirectory !== undefined) set.workingDirectory = patch.workingDirectory;
  if (patch.executionPreferences !== undefined)
    set.executionPreferences = JSON.stringify(patch.executionPreferences);

  // Status transitions: allowed from 'queued' → 'cancelled'; anything else rejected.
  if (patch.status !== undefined) {
    const from = existing.status as TaskStatus;
    if (patch.status === "cancelled" && from === "queued") {
      set.status = "cancelled";
    } else if (patch.status !== from) {
      throw new InvalidTaskStatusTransitionError(from, patch.status);
    }
  }

  if (Object.keys(set).length) {
    set.updatedAt = new Date().toISOString();
    db.update(tasks).set(set).where(eq(tasks.id, id)).run();
  }
  return getTask(db, id)!;
}

/* ------------------------------ Delete ------------------------------ */

/**
 * INTERNAL / TEST-ONLY HARD DELETE — NOT exposed via the API. Removes the task
 * row and cascades (execution sessions, approvals, notifications, subtasks,
 * handoffs). The API uses `softDeleteTask` instead: history must be retained.
 * Retained for repository tests that need a real row removal (e.g. clearing a
 * project reference before `deleteProject`).
 */
export function deleteTask(db: VelarisDb, id: string): void {
  const existing = db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!existing) throw new TaskNotFoundError(id);
  db.delete(tasks).where(eq(tasks.id, id)).run();
}

/**
 * Soft-delete a task: set `deleted_at = now` and bump `updated_at`. The task's
 * `status` is NEVER changed — a deleted queued/terminal task keeps its status so
 * Archives classification and history are untouched. The engine excludes
 * deleted rows (`listQueuedTaskIds` / `claimQueuedTask` / `listInFlightTaskIds`).
 *
 * TOCTOU-safe: the initial read produces precise errors for the common path,
 * but the write is a SINGLE conditional UPDATE guarded by `deleted_at IS NULL`
 * and the deletable-status list. Under WAL the engine (separate process, same
 * SQLite file) may claim a queued task (`queued→running`) between the read and
 * the write; the guarded UPDATE then matches zero rows and we re-read to
 * report the real outcome instead of stamping an active task as deleted.
 *
 * Idempotent: deleting an already-deleted task returns it unchanged (the
 * `deleted_at IS NULL` guard makes the second delete a zero-change no-op, which
 * we detect by re-reading and seeing the row is already deleted).
 *
 * @throws TaskNotFoundError when no such task exists.
 * @throws TaskNotDeletableError when the task is in an active (non-deletable) state.
 */
export function softDeleteTask(db: VelarisDb, id: string): TaskDto {
  // Common-path read: precise errors without relying on a failed UPDATE.
  const existing = db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!existing) throw new TaskNotFoundError(id);
  if (existing.deletedAt) return taskRowToDto(existing);
  if (!isTaskDeletable(existing.status as TaskStatus)) {
    throw new TaskNotDeletableError(existing.status);
  }

  const now = new Date().toISOString();
  // Conditional, atomic write. The status list is derived from the shared
  // source of truth (DELETABLE_TASK_STATUSES) so it can never drift from
  // `isTaskDeletable`; `deleted_at IS NULL` keeps the delete idempotent.
  const placeholders = DELETABLE_TASK_STATUSES.map(() => "?").join(", ");
  const res = rawDb(db)
    .prepare(
      `UPDATE tasks SET deleted_at = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL AND status IN (${placeholders})`,
    )
    .run(now, now, id, ...DELETABLE_TASK_STATUSES);

  if (res.changes === 0) {
    // Lost the race (engine claimed it → now active) or it was already deleted.
    const current = db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!current) throw new TaskNotFoundError(id);
    // Already deleted → idempotent success, unchanged.
    if (current.deletedAt) return taskRowToDto(current);
    // Status became active (or otherwise non-deletable) between read and write.
    throw new TaskNotDeletableError(current.status);
  }

  return getTask(db, id)!;
}

/**
 * Restore a soft-deleted task: clear `deleted_at` and bump `updated_at`.
 *
 * Restore rule: a terminal task is restored as-is; a task whose status is
 * `queued` is flipped to `cancelled` so a deliberately-removed posting can never
 * silently execute on restore (the user may re-post it deliberately).
 *
 * Idempotent: restoring a live task returns it unchanged.
 *
 * @throws TaskNotFoundError when no such task exists.
 */
export function restoreTask(db: VelarisDb, id: string): TaskDto {
  const existing = db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!existing) throw new TaskNotFoundError(id);
  if (!existing.deletedAt) return taskRowToDto(existing);
  const now = new Date().toISOString();
  const status = existing.status === "queued" ? "cancelled" : existing.status;
  db.update(tasks)
    .set({ deletedAt: null, status, updatedAt: now })
    .where(eq(tasks.id, id))
    .run();
  return getTask(db, id)!;
}

/* --------------------- Execution status transitions ------------------ */

/**
 * Set a task's status directly (engine-owned writes in Phase 2). Bypasses the
 * PATCH transition guard — the engine owns execution transitions
 * (queued→running→completed/failed, requeue, cancel, interrupt). The optional
 * `note` is informational (logged by callers); the tasks table has no dedicated
 * error column, so failures are also recorded on the session + execution_events.
 */
export function setTaskStatus(
  db: VelarisDb,
  taskId: string,
  status: TaskStatus,
  _note?: string | null | undefined,
): TaskDto | null {
  const existing = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!existing) return null;
  db.update(tasks)
    .set({ status, updatedAt: new Date().toISOString() })
    .where(eq(tasks.id, taskId))
    .run();
  return getTask(db, taskId);
}

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

/**
 * Record/overwrite the High Lord `execution_preferences.plan` block with an
 * abort reason (addendum D4c). Shared by the ENGINE's abortPlan and the WEB's
 * cancel route so the burn-house UI (`plan-board.tsx` / map) sees `abortReason`
 * consistently. Merges onto any existing `plan` sub-object rather than
 * clobbering unrelated top-level prefs.
 */
export function writeTaskPlanAbortReason(
  db: VelarisDb,
  taskId: string,
  { abortReason, abortedAt }: { abortReason: string; abortedAt: string },
): TaskDto | null {
  const existing = getTask(db, taskId);
  if (!existing) return null;
  const prefs = { ...existing.executionPreferences };
  const plan = (existing.executionPreferences?.plan ?? {}) as Record<string, unknown>;
  prefs.plan = { ...plan, abortReason, abortedAt };
  db.update(tasks)
    .set({ executionPreferences: JSON.stringify(prefs) })
    .where(eq(tasks.id, taskId))
    .run();
  return getTask(db, taskId);
}

/**
 * Count tasks in a given status. Used by the Phase 6 Stage F monitoring panel
 * for queue depth (`queued`) and running count (`running`). Pure read.
 */
export function countTasksByStatus(db: VelarisDb, status: TaskStatus): number {
  const row = db
    .select({ c: sql<number>`COUNT(*)` })
    .from(tasks)
    .where(and(eq(tasks.status, status), isNull(tasks.deletedAt)))
    .get();
  const v = row?.c;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") return Number(v) || 0;
  return 0;
}

/** Raw task id columns for tasks still `queued` (used by the engine queue poll). */
export function listQueuedTaskIds(raw: Database.Database): string[] {
  return raw
    .prepare(
      `SELECT id FROM tasks WHERE status = 'queued' AND deleted_at IS NULL ORDER BY created_at ASC`,
    )
    .all()
    .map((r) => (r as { id: string }).id);
}

/**
 * Atomically claim a queued task for execution. Multi-process safe under WAL:
 * UPDATE ... WHERE id = ? AND status = 'queued' is a single-statement UPDATE,
 * so only one engine wins the claim. Returns true if this process claimed it.
 * Soft-deleted rows are never claimed (`deleted_at IS NULL`).
 */
export function claimQueuedTask(raw: Database.Database, taskId: string): boolean {
  const res = raw
    .prepare(
      `UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ? AND status = 'queued' AND deleted_at IS NULL`,
    )
    .run(new Date().toISOString(), taskId);
  return res.changes === 1;
}

/**
 * Task rows currently in a non-terminal, in-flight state — used by boot
 * reconciliation to requeue tasks whose session heartbeat went stale. Deleted
 * rows are excluded so reconcile can never requeue a removed task.
 */
export function listInFlightTaskIds(db: VelarisDb): TaskRow[] {
  return db
    .select()
    .from(tasks)
    .where(
      and(
        sql`status in ('running','awaiting_approval','awaiting_input','interrupted','paused')`,
        isNull(tasks.deletedAt),
      ),
    )
    .all();
}
