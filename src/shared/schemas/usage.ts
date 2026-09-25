/**
 * Zod schemas for the read-only usage/cost dashboard API (Phase 6 Stage E).
 *
 * `usageQuerySchema` is the single validation source for `GET /api/usage`.
 * Query params arrive as strings, so numeric coercion happens here (mirrors
 * `archiveQuerySchema`).
 *
 * Aggregates read `usage_records` ONLY — never the `execution_sessions` mirror,
 * which would double-count (plan §16 risk 4). The dashboard's reconciliation
 * guarantee is that the usage-row totals equal the provider-reported session
 * mirror within ±1% rounding.
 */

import { z } from "zod";

/** Supported time-series bucket granularities. */
export const USAGE_BUCKETS = ["day", "hour"] as const;

/** Default bucket when the query omits one (a compact dashboard default). */
export const USAGE_DEFAULT_BUCKET = "day" as const;

/** Default cap for the per-task breakdown (top tasks by cost). */
export const USAGE_DEFAULT_TASK_LIMIT = 10;
/** Hard cap for the per-task breakdown. */
export const USAGE_MAX_TASK_LIMIT = 50;

/** GET /api/usage?houseId=&taskId=&modelId=&provider=&from=&to=&bucket=&taskLimit= */
export const usageQuerySchema = z.object({
  houseId: z.string().trim().min(1).max(200).optional(),
  taskId: z.string().trim().min(1).max(200).optional(),
  modelId: z.string().trim().min(1).max(300).optional(),
  provider: z.string().trim().min(1).max(120).optional(),
  /** ISO timestamps; compared lexically against the ISO text column. */
  from: z.string().trim().min(1).max(40).optional(),
  to: z.string().trim().min(1).max(40).optional(),
  bucket: z.enum(USAGE_BUCKETS).optional(),
  taskLimit: z.coerce.number().int().min(1).max(USAGE_MAX_TASK_LIMIT).optional(),
});

export type UsageQueryInput = z.infer<typeof usageQuerySchema>;
