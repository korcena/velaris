/**
 * Zod schemas for the audit log API.
 *
 * `auditLogQuerySchema` is the single validation source for
 * `GET /api/audit-log`. Query params arrive as strings, so numeric/enum
 * coercion happens here (mirrors notificationsQuerySchema).
 */

import { z } from "zod";
import { AUDIT_ACTORS, AUDIT_ENTITY_TYPES } from "@/shared/constants";

const AUDIT_ACTOR_TUPLE = ["user", "engine"] as const;
const AUDIT_ENTITY_TYPE_TUPLE = [
  "house",
  "agent",
  "project",
  "provider_config",
  "approval",
  "template",
] as const;

/** Default page size for the audit list (matches the plan's Settings card). */
export const AUDIT_LOG_DEFAULT_LIMIT = 25;
/** Hard cap on a single page — keeps the read bounded regardless of input. */
export const AUDIT_LOG_MAX_LIMIT = 100;

/** GET /api/audit-log query — all filters optional; defaults apply server-side. */
export const auditLogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(AUDIT_LOG_MAX_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  actor: z.enum(AUDIT_ACTOR_TUPLE).optional(),
  entityType: z.enum(AUDIT_ENTITY_TYPE_TUPLE).optional(),
  entityId: z.string().trim().min(1).max(200).optional(),
  action: z.string().trim().min(1).max(120).optional(),
});

export type AuditLogQueryInput = z.infer<typeof auditLogQuerySchema>;

// Compile-time parity guard: the schema tuples must match the shared constants.
void (AUDIT_ACTORS satisfies readonly (typeof AUDIT_ACTOR_TUPLE)[number][]);
void (AUDIT_ENTITY_TYPES satisfies readonly (typeof AUDIT_ENTITY_TYPE_TUPLE)[number][]);
