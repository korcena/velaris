/**
 * Zod schemas for tasks (Phase 1 stub — no execution semantics).
 */

import { z } from "zod";
import { uuidSchema, trimmedNonEmpty } from "./common";

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
  workingDirectory: z.string().trim().optional().nullable().default(null),
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
  workingDirectory: z.string().trim().optional().nullable(),
  executionPreferences: z.record(z.string(), z.unknown()).optional(),
  // Phase 1: status may only be set to "cancelled" (nothing else executes).
  status: z.enum(TASK_STATUS_TUPLE).optional(),
});

export type TaskUpdateInput = z.infer<typeof taskUpdateSchema>;

export const taskIdSchema = uuidSchema;
