/**
 * Task repository — insert, list, get, update mutable fields. No execution
 * semantics in Phase 1 (status locked to queued/cancelled).
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { eq, and, sql } from "drizzle-orm";
import type { VelarisDb } from "@/lib/db";
import { tasks, type TaskRow } from "@/lib/db/schema";
import { parseJson } from "@/shared/schemas/common";
import type { TaskDto, TaskPriority, TaskStatus } from "@/shared/types";

export class TaskNotFoundError extends Error {
  constructor(id: string) {
    super(`Task not found: ${id}`);
    this.name = "TaskNotFoundError";
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
  };
}

/* ------------------------------ Reading ----------------------------- */

export interface ListTasksOptions {
  houseId?: string;
  projectId?: string;
  status?: TaskStatus;
}

export function listTasks(db: VelarisDb, opts: ListTasksOptions = {}): TaskDto[] {
  const conditions = [
    opts.houseId ? eq(tasks.houseId, opts.houseId) : undefined,
    opts.projectId ? eq(tasks.projectId, opts.projectId) : undefined,
    opts.status ? eq(tasks.status, opts.status) : undefined,
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

export function deleteTask(db: VelarisDb, id: string): void {
  const existing = db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!existing) throw new TaskNotFoundError(id);
  db.delete(tasks).where(eq(tasks.id, id)).run();
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
    .where(eq(tasks.status, status))
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
    .prepare(`SELECT id FROM tasks WHERE status = 'queued' ORDER BY created_at ASC`)
    .all()
    .map((r) => (r as { id: string }).id);
}

/**
 * Atomically claim a queued task for execution. Multi-process safe under WAL:
 * UPDATE ... WHERE id = ? AND status = 'queued' is a single-statement UPDATE,
 * so only one engine wins the claim. Returns true if this process claimed it.
 */
export function claimQueuedTask(raw: Database.Database, taskId: string): boolean {
  const res = raw
    .prepare(
      `UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ? AND status = 'queued'`,
    )
    .run(new Date().toISOString(), taskId);
  return res.changes === 1;
}

/**
 * Task rows currently in a non-terminal, in-flight state — used by boot
 * reconciliation to requeue tasks whose session heartbeat went stale.
 */
export function listInFlightTaskIds(db: VelarisDb): TaskRow[] {
  return db
    .select()
    .from(tasks)
    .where(
      sql`status in ('running','awaiting_approval','awaiting_input','interrupted','paused')`,
    )
    .all();
}
