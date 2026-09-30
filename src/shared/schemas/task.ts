/**
 * Zod schemas for tasks (Phase 1 stub — no execution semantics).
 */

import { z } from "zod";
import {
  uuidSchema,
  trimmedNonEmpty,
  absolutePathOrNullCreate,
  absolutePathOrNullUpdate,
} from "./common";

/**
 * Task type is an extensible string — validated as a non-empty string, NOT a
 * closed enum, so users can add arbitrary custom types in Settings.
 */
export const taskTypeSchema = trimmedNonEmpty(120);

// Literal tuples (constants widen to string when passed to z.enum()).
const TASK_PRIORITY_TUPLE = ["low", "medium", "high", "urgent"] as const;
const TASK_STATUS_TUPLE = ["queued", "cancelled"] as const;

const taskBase = z.object({
  title: trimmedNonEmpty(200),
  description: z.string().trim().optional().default(""),
  type: taskTypeSchema.optional().default("general"),
  priority: z.enum(TASK_PRIORITY_TUPLE).optional().default("medium"),
});

export const taskCreateSchema = taskBase.extend({
  houseId: uuidSchema.optional().nullable().default(null),
  projectId: uuidSchema.optional().nullable().default(null),
  /** Phase 6 Stage B: optional target agent (must belong to houseId — checked at the route). */
  agentId: uuidSchema.optional().nullable().default(null),
  workingDirectory: absolutePathOrNullCreate,
  executionPreferences: z.record(z.string(), z.unknown()).optional().default({}),
});

export type TaskCreateInput = z.infer<typeof taskCreateSchema>;

export const taskUpdateSchema = z.object({
  title: trimmedNonEmpty(200).optional(),
  description: z.string().trim().optional(),
  type: taskTypeSchema.optional(),
  priority: z.enum(TASK_PRIORITY_TUPLE).optional(),
  houseId: uuidSchema.optional().nullable(),
  projectId: uuidSchema.optional().nullable(),
  agentId: uuidSchema.optional().nullable(),
  workingDirectory: absolutePathOrNullUpdate,
  executionPreferences: z.record(z.string(), z.unknown()).optional(),
  // Phase 1: status may only be set to "cancelled" (nothing else executes).
  status: z.enum(TASK_STATUS_TUPLE).optional(),
});

export type TaskUpdateInput = z.infer<typeof taskUpdateSchema>;

/**
 * Tri-state soft-delete visibility filter for `GET /api/tasks`.
 *   - "exclude" (default): live tasks only.
 *   - "include": live + soft-deleted.
 *   - "only": soft-deleted only.
 * A boolean cannot express "only", hence the enum.
 */
export const taskDeletedFilterSchema = z.enum(["exclude", "include", "only"]).default("exclude");

export type TaskDeletedFilter = z.infer<typeof taskDeletedFilterSchema>;

/**
 * Board visibility filter for `GET /api/tasks`:
 *   - "roots" (default): top-level quests only — a task referenced by a
 *     `subtasks.task_id` is an engine spin-off child and is hidden.
 *   - "all": every task (house panel / monitoring / full set).
 */
export const taskParentFilterSchema = z.enum(["roots", "all"]).default("roots");

export type TaskParentFilter = z.infer<typeof taskParentFilterSchema>;

export const taskIdSchema = uuidSchema;
