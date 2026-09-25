/**
 * Zod schemas for house/project templates (Phase 6 Stage C).
 *
 * The `templates.payload` JSON column is validated on write by reusing the
 * existing house/project schemas:
 *  - HOUSE templates reuse `houseCreateSchema` minus `name` (the house name is
 *    supplied at instantiation, or defaulted from the template name).
 *  - PROJECT templates reuse `projectCreateSchema` restricted to the Q4 fields
 *    (`description`, `defaultModel`, `instructions`); the `directory` is
 *    supplied at instantiation and validated by the existing repo checks
 *    (`assertValidDirectory` / `assertDirectoryUnique`). Allowlists are
 *    deliberately NOT templated.
 *
 * `templateCreateSchema` is discriminated on `kind` so a payload can never
 * mismatch its template kind.
 */

import { z } from "zod";
import { houseCreateSchema } from "./house";
import { projectCreateSchema } from "./project";
import { trimmedNonEmpty } from "./common";
import { TEMPLATE_KINDS } from "@/shared/constants";

const KIND_TUPLE = ["house", "project"] as const;

/**
 * A house template's payload: everything `houseCreateSchema` needs except name.
 * `.strict()` so a wrong-kind (project-shaped) payload is REJECTED rather than
 * silently stripped down to a partial house payload.
 */
export const houseTemplatePayloadSchema = houseCreateSchema.omit({ name: true }).strict();

export type HouseTemplatePayloadInput = z.infer<typeof houseTemplatePayloadSchema>;

/**
 * A project template's payload (Q4): description/defaultModel/instructions only.
 * `directory` is intentionally absent — it is an instantiation input.
 * `.strict()` so a wrong-kind (house-shaped) payload is REJECTED rather than
 * silently stripped down to `{description, defaultModel, instructions}`.
 */
export const projectTemplatePayloadSchema = projectCreateSchema
  .pick({
    description: true,
    defaultModel: true,
    instructions: true,
  })
  .strict();

export type ProjectTemplatePayloadInput = z.infer<typeof projectTemplatePayloadSchema>;

const templateBase = {
  name: trimmedNonEmpty(120).describe("Template name, unique per kind"),
  description: z.string().trim().max(2000).optional().default(""),
};

/**
 * Create a template. Discriminated on `kind`; each member is `.strict()` so a
 * client cannot smuggle `isSeeded`/`id`/timestamps.
 */
export const templateCreateSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("house"),
      ...templateBase,
      payload: houseTemplatePayloadSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("project"),
      ...templateBase,
      payload: projectTemplatePayloadSchema,
    })
    .strict(),
]);

export type TemplateCreateInput = z.infer<typeof templateCreateSchema>;

/**
 * Update a (non-seeded) template. Name/description/payload are all optional;
 * the kind is immutable so the payload shape cannot change. `.strict()` rejects
 * unknown keys; seeded templates are rejected at the service layer.
 */
export const templateUpdateSchema = z
  .object({
    name: trimmedNonEmpty(120).optional(),
    description: z.string().trim().max(2000).optional(),
    // Payload validation for updates: accept either kind's payload shape and let
    // the service verify it matches the existing template's kind.
    payload: z.union([houseTemplatePayloadSchema, projectTemplatePayloadSchema]).optional(),
  })
  .strict();

export type TemplateUpdateInput = z.infer<typeof templateUpdateSchema>;

/** GET /api/templates?kind= */
export const templateListQuerySchema = z.object({
  kind: z.enum(KIND_TUPLE).optional(),
});

export type TemplateListQueryInput = z.infer<typeof templateListQuerySchema>;

/**
 * POST /api/templates/{id}/instantiate body — instantiation overrides.
 * `directory` is required for a project template and is ignored/absent for a
 * house template (the service + kind-specific schemas enforce which apply).
 */
export const templateInstantiateSchema = z
  .object({
    name: trimmedNonEmpty(120).optional(),
    /** House templates only: override the created agent's name. */
    agentName: trimmedNonEmpty(120).optional(),
    /** Project templates only: the target directory (validated by createProject). */
    directory: z.string().trim().min(1).max(4096).optional(),
  })
  .strict();

export type TemplateInstantiateInput = z.infer<typeof templateInstantiateSchema>;

// Compile-time parity guard: the schema tuple must match the shared constant.
void (TEMPLATE_KINDS satisfies readonly (typeof KIND_TUPLE)[number][]);
