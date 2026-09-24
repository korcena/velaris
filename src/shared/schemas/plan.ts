/**
 * Zod schemas for the High Lord planning surface (Phase 4).
 *
 * Single source for everything the planner emits and every plan/court API
 * validates. No Next.js/React imports — this module is shared by web + engine.
 */

import { z } from "zod";
import { ORCHESTRATION_DEFAULTS } from "@/shared/constants";
import { uuidSchema, trimmedNonEmpty } from "./common";
import { taskTypeSchema } from "./task";

/** A single planner-emitted subtask (plan-local ids: "s0","s1",...). */
export const planSubtaskSchema = z.object({
  id: z.string().trim().min(1).max(40), // plan-local id: "s0", "s1"...
  title: trimmedNonEmpty(200),
  description: z.string().trim().max(8000).default(""),
  type: taskTypeSchema.optional(), // defaults to "general"
  houseId: uuidSchema.nullable().optional(), // explicit pick
  houseHints: z.string().trim().max(2000).optional(), // free-text capability hints
  dependsOn: z.array(z.string().trim().min(1)).default([]), // plan ids
  instructions: z.string().trim().max(8000).default(""),
  context: z.record(z.string(), z.unknown()).default({}),
  artifacts: z.array(z.string().trim().min(1)).default([]), // expected outputs
  completionRequirements: z.string().trim().max(4000).default(""),
});

export type PlanSubtaskInput = z.infer<typeof planSubtaskSchema>;

/** The full plan object the planner must emit (capped by ORCHESTRATION_DEFAULTS). */
export const planSchema = z.object({
  subtasks: z
    .array(planSubtaskSchema)
    .min(1, { message: "A plan must contain at least one subtask" })
    .max(ORCHESTRATION_DEFAULTS.MAX_SUBTASKS, {
      message: `A plan may contain at most ${ORCHESTRATION_DEFAULTS.MAX_SUBTASKS} subtasks`,
    }),
});

export type Plan = z.infer<typeof planSchema>;

/** Payload for POST /api/court/instructions — the Court composer. */
export const courtInstructionSchema = z.object({
  instruction: trimmedNonEmpty(8000),
  projectId: uuidSchema.optional().nullable(),
  workingDirectory: z.string().trim().optional().nullable(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
});

export type CourtInstructionInput = z.infer<typeof courtInstructionSchema>;

/** Payload for POST /api/court/steer — mid-plan steering into an active plan. */
export const courtSteerSchema = z.object({
  parentTaskId: uuidSchema,
  message: trimmedNonEmpty(8000),
});

export type CourtSteerInput = z.infer<typeof courtSteerSchema>;

/**
 * Shape of the engine-written `plan` block inside a parent task's
 * execution_preferences. Documented, not enforced at the API boundary (it is an
 * internal engine write).
 */
export const planExecutionPreferencesSchema = z
  .object({
    abortReason: z.string(),
    abortedAt: z.string(),
  })
  .partial();
