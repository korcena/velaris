/**
 * Zod schemas for houses, including the nested agent and configuration.
 * One source of truth for API input validation (see ARCHITECTURE §7).
 */

import { z } from "zod";
import {
  APPROVAL_POLICIES,
  DEFAULT_AI_PROVIDER,
  DEFAULT_MODEL_ID,
  PERMISSION_MODES,
} from "@/shared/constants";
import { uuidSchema, trimmedNonEmpty } from "./common";
import type { HouseStatus } from "@/shared/types";

/* --------------------------------- Agent ----------------------------- */

export const houseAgentSchema = z.object({
  name: trimmedNonEmpty(120).describe("Agent name, e.g. 'Azriel'"),
  role: trimmedNonEmpty(200).describe("Agent role, e.g. 'Shadow-singer · senior engineer'"),
});

/* --------------------------- Permissions ----------------------------- */

/** Each permission action: allow | ask | deny. */
export const permissionModeSchema = z.enum(PERMISSION_MODES);

export const permissionsSchema = z.object({
  fileSystem: permissionModeSchema.default("ask"),
  shell: permissionModeSchema.default("ask"),
  network: permissionModeSchema.default("deny"),
  git: permissionModeSchema.default("allow"),
});

/* -------------------------- Configuration ---------------------------- */

export const houseConfigurationSchema = z.object({
  systemPrompt: trimmedNonEmpty(40000).describe("System prompt for the agent"),
  executionProvider: z.enum(["opencode", "ollama"]).describe("Execution engine"),
  aiProvider: z.string().trim().min(1).default(DEFAULT_AI_PROVIDER),
  modelId: z.string().trim().default(DEFAULT_MODEL_ID),
  workspaceAllowlist: z.array(trimmedNonEmpty(2048)).default([]),
  tools: z.array(trimmedNonEmpty(120)).default([]),
  permissions: permissionsSchema,
  approvalPolicy: z.enum(APPROVAL_POLICIES).default("always"),
  concurrency: z.number().int().min(1, { message: "Concurrency must be ≥ 1" }).default(1),
});

/* ----------------------------- Houses ------------------------------- */

const houseBase = z.object({
  name: trimmedNonEmpty(80),
  description: z.string().trim().max(2000).optional().default(""),
  agent: houseAgentSchema,
  configuration: houseConfigurationSchema,
});

export const houseCreateSchema = houseBase;

export type HouseCreateInput = z.infer<typeof houseCreateSchema>;

/**
 * Update schema — all fields optional, including the nested agent /
 * configuration (ARCHITECTURE §7). Nested objects are themselves partial:
 * only the keys present in the payload are merged onto the existing record
 * by the repository (zod's `.partial()` also neutralizes inner defaults, so
 * absent keys stay absent rather than being reset to defaults).
 *
 * `.strict()` so an unrecognized key (e.g. a bogus `status` value that is
 * not a valid transition) is a 400 validation error instead of being
 * silently stripped into a no-op update. Valid status transitions are
 * handled by the route via `houseStatusTransitionSchema` before this
 * schema sees the payload.
 */
export const houseUpdateSchema = houseBase
  .partial()
  .extend({
    agent: houseAgentSchema.partial().optional(),
    configuration: houseConfigurationSchema.partial().optional(),
  })
  .strict();

export type HouseUpdateInput = z.infer<typeof houseUpdateSchema>;

/* ----------------------------- Status ------------------------------- */

export const houseStatusSchema = z.enum(
  // Explicit tuple so zod preserves the literal union (HOUSE_STATUSES is a
  // readonly HouseStatus[] which would widen to string in z.enum()).
  ["active", "disabled", "archived"],
);

/** Payload for PATCH /api/houses/{id}/status — an explicit status transition. */
export const houseStatusTransitionSchema = z.object({
  status: houseStatusSchema,
});

export type HouseStatusTransitionInput = z.infer<typeof houseStatusTransitionSchema>;
