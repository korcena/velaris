/**
 * Subtask repository — orchestrator-owned rows linking a parent (High Lord)
 * task to its child task rows via a 1:1 child-task link.
 *
 * WRITE DISCIPLINE: the ENGINE is the single writer of subtasks rows (creation,
 * status transitions, attempt bumps, child-task re-pointing). The web process
 * only reads these rows to serve the Court plan DTO / planState derivation.
 *
 * `status` here is the orchestrator's scheduling state, distinct from the child
 * task row's tasks.status (which the runner owns). `depends_on` stores plan-local
 * ids ("s0","s1",...) so edges stay renderable after delegation.
 */

import { randomUUID } from "node:crypto";
import { eq, and, inArray, sql } from "drizzle-orm";
import type { VelarisDb } from "@/lib/db";
import { subtasks, houses, tasks, type SubtaskRow } from "@/lib/db/schema";
import { parseJson } from "@/shared/schemas/common";
import type { SubtaskDto, SubtaskStatus, TaskStatus } from "@/shared/types";

export class SubtaskNotFoundError extends Error {
  constructor(id: string) {
    super(`Subtask not found: ${id}`);
    this.name = "SubtaskNotFoundError";
  }
}

/* ------------------------------ Mapping ------------------------------ */

export function subtaskRowToDto(row: SubtaskRow): SubtaskDto {
  return {
    id: row.id,
    parentTaskId: row.parentTaskId,
    taskId: row.taskId,
    orderIndex: row.orderIndex,
    dependsOn: parseJson<string[]>(row.dependsOn, []),
    planId: row.planId,
    status: row.status as SubtaskStatus,
    attemptCount: row.attemptCount,
    title: row.title,
    instructions: row.instructions,
    completionRequirements: row.completionRequirements,
    // These are populated by the listing queries (which join for names/statuses);
    // the bare row mapper leaves them null until resolved.
    houseId: null,
    houseName: null,
    childTaskStatus: null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/* ------------------------------ Create ------------------------------ */

export interface CreateSubtaskInput {
  id?: string;
  parentId: string;
  planId: string;
  orderIndex: number;
  dependsOn: string[];
  status?: SubtaskStatus;
  title: string;
  instructions?: string;
  completionRequirements?: string;
  taskId?: string | null;
}

/** Create a subtask row linked to a parent task. `taskId` defaults null (planned). */
export function createSubtask(db: VelarisDb, input: CreateSubtaskInput): SubtaskDto {
  const id = input.id ?? randomUUID();
  db.insert(subtasks)
    .values({
      id,
      parentTaskId: input.parentId,
      planId: input.planId,
      orderIndex: input.orderIndex,
      dependsOn: JSON.stringify(input.dependsOn ?? []),
      status: input.status ?? "planned",
      title: input.title,
      instructions: input.instructions ?? "",
      completionRequirements: input.completionRequirements ?? "",
      taskId: input.taskId ?? null,
    })
    .run();
  return getSubtask(db, id)!;
}

/* ------------------------------ Reading ------------------------------ */

export function getSubtask(db: VelarisDb, id: string): SubtaskDto | null {
  const row = db.select().from(subtasks).where(eq(subtasks.id, id)).get();
  return row ? subtaskRowToDto(row) : null;
}

/**
 * The "is this a child task?" probe — one indexed lookup on the unique task_id.
 */
export function getSubtaskByChildTaskId(db: VelarisDb, taskId: string): SubtaskDto | null {
  const row = db.select().from(subtasks).where(eq(subtasks.taskId, taskId)).get();
  return row ? subtaskRowToDto(row) : null;
}

/**
 * List subtasks for a parent, ordered by order_index, joining the child task's
 * tasks.status (for `childTaskStatus`) and destination house name (for `houseName`).
 */
export function listSubtasksForParent(db: VelarisDb, parentId: string): SubtaskDto[] {
  const rows = db
    .select()
    .from(subtasks)
    .where(eq(subtasks.parentTaskId, parentId))
    .orderBy(subtasks.orderIndex)
    .all();
  return rows.map((row) => enrichSubtask(db, row));
}

/** List subtasks for a parent restricted to a set of statuses (scheduler ready-set). */
export function listSubtasksForParentByStatus(
  db: VelarisDb,
  parentId: string,
  statuses: SubtaskStatus[],
): SubtaskDto[] {
  const rows = db
    .select()
    .from(subtasks)
    .where(and(eq(subtasks.parentTaskId, parentId), inArray(subtasks.status, statuses)))
    .all();
  return rows.map((row) => enrichSubtask(db, row));
}

/**
 * Enrich a subtask row with its child task's status and resolved destination
 * house (id + denormalized name) via single-row lookups. The destination house
 * lives on the child task row's houseId — the subtasks table has no house column.
 */
function enrichSubtask(db: VelarisDb, row: SubtaskRow): SubtaskDto {
  const dto = subtaskRowToDto(row);

  if (row.taskId) {
    const task = db.select().from(tasks).where(eq(tasks.id, row.taskId)).get();
    if (task) {
      dto.childTaskStatus = task.status as TaskStatus;
      if (task.houseId) {
        dto.houseId = task.houseId;
        const house = db.select().from(houses).where(eq(houses.id, task.houseId)).get();
        if (house) dto.houseName = house.name;
      }
    }
  }

  return dto;
}

/* ------------------------------ Writing ------------------------------ */

/**
 * Set a subtask's status directly. Engine-only transitions, no guard — mirrors
 * the setTaskStatus discipline (the orchestrator owns the lifecycle).
 */
export function setSubtaskStatus(
  db: VelarisDb,
  subtaskId: string,
  status: SubtaskStatus,
): SubtaskDto | null {
  const existing = db.select().from(subtasks).where(eq(subtasks.id, subtaskId)).get();
  if (!existing) return null;
  db.update(subtasks)
    .set({ status, updatedAt: new Date().toISOString() })
    .where(eq(subtasks.id, subtaskId))
    .run();
  return getSubtask(db, subtaskId);
}

/** Increment a subtask's attempt_count; returns the new count. */
export function incrementSubtaskAttempt(db: VelarisDb, subtaskId: string): number {
  const existing = db.select().from(subtasks).where(eq(subtasks.id, subtaskId)).get();
  if (!existing) throw new SubtaskNotFoundError(subtaskId);
  const next = existing.attemptCount + 1;
  db.update(subtasks)
    .set({ attemptCount: next, updatedAt: new Date().toISOString() })
    .where(eq(subtasks.id, subtaskId))
    .run();
  return next;
}

/**
 * (Re-)point a subtask at a child task row at delegation/retry time. The unique
 * `task_id` index makes the link 1:1; on retry the old child row stays terminal
 * and this re-points to the fresh child.
 */
export function linkChildTask(
  db: VelarisDb,
  subtaskId: string,
  childTaskId: string,
): SubtaskDto | null {
  const existing = db.select().from(subtasks).where(eq(subtasks.id, subtaskId)).get();
  if (!existing) return null;
  db.update(subtasks)
    .set({ taskId: childTaskId, updatedAt: new Date().toISOString() })
    .where(eq(subtasks.id, subtaskId))
    .run();
  return getSubtask(db, subtaskId);
}

/**
 * Cancel every non-terminal subtask of a parent (planned|ready|delegated|in_flight
 * → cancelled). The parent-abort / user-cancel cascade path (§5.7). Idempotent.
 * Returns the ids of the subtasks actually flipped.
 */
export function cancelSubtasksForParent(db: VelarisDb, parentId: string): string[] {
  const nonTerminal = db
    .select()
    .from(subtasks)
    .where(
      sql`${subtasks.parentTaskId} = ${parentId} AND ${subtasks.status} IN ('planned','ready','delegated','in_flight')`,
    )
    .all();

  const ids = nonTerminal.map((r) => r.id);
  if (ids.length) {
    db.update(subtasks)
      .set({ status: "cancelled", updatedAt: new Date().toISOString() })
      .where(and(eq(subtasks.parentTaskId, parentId), inArray(subtasks.status, ["planned", "ready", "delegated", "in_flight"])))
      .run();
  }
  return ids;
}
