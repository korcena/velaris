/**
 * Usage dashboard service (Phase 6 Stage E) — pure read. Validates the query
 * with `usageQuerySchema` (the single API-input source), applies the default
 * bucket/taskLimit, and assembles the dashboard payload from the read-only
 * usage repo.
 *
 * No audit writes: the dashboard is read-only (Q9 audits web user-action rows).
 */

import type { VelarisDb } from "@/lib/db";
import {
  getUsageByHouse,
  getUsageByModel,
  getUsageByTask,
  getUsageTimeSeries,
  getUsageTotals,
  type UsageFilters,
} from "@/server/repositories/usage-repo";
import {
  usageQuerySchema,
  USAGE_DEFAULT_BUCKET,
  USAGE_DEFAULT_TASK_LIMIT,
  USAGE_MAX_TASK_LIMIT,
  type UsageQueryInput,
} from "@/shared/schemas/usage";
import type { UsageDashboardDto } from "@/shared/types";

export { USAGE_DEFAULT_BUCKET, USAGE_DEFAULT_TASK_LIMIT, USAGE_MAX_TASK_LIMIT };

export function getUsageDashboard(db: VelarisDb, input: unknown): UsageDashboardDto {
  const parsed: UsageQueryInput = usageQuerySchema.parse(input);
  const bucket = parsed.bucket ?? USAGE_DEFAULT_BUCKET;
  const taskLimit = Math.min(parsed.taskLimit ?? USAGE_DEFAULT_TASK_LIMIT, USAGE_MAX_TASK_LIMIT);

  const filters: UsageFilters = {
    houseId: parsed.houseId,
    taskId: parsed.taskId,
    modelId: parsed.modelId,
    provider: parsed.provider,
    from: parsed.from,
    to: parsed.to,
  };

  return {
    totals: getUsageTotals(db, filters),
    byHouse: getUsageByHouse(db, filters),
    byModel: getUsageByModel(db, filters),
    byTask: getUsageByTask(db, filters, taskLimit),
    series: getUsageTimeSeries(db, bucket, filters),
    bucket,
    generatedAt: new Date().toISOString(),
  };
}
