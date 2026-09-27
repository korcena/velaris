import { NextRequest } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb } from "@/lib/db";
import { getUsageDashboard } from "@/server/services/usage-service";
import { ok, routeErrorOrMapped } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/usage?houseId=&taskId=&modelId=&provider=&agentId=&from=&to=&bucket=&taskLimit=
 *
 * Read-only usage/cost dashboard aggregate over `usage_records` ONLY (the
 * session mirror is never summed — that would double-count). Returns totals,
 * per-house, per-model, top-task and per-agent breakdowns with an explicit
 * estimated-vs-provider-reported split, plus a day/hour time series for the
 * sparkline. `agentId` scopes only the `byAgent` breakdown (it reads the
 * session's `agent_id`); the other aggregates stay session-join-free. No
 * writer, no engine coupling.
 */
export async function GET(req: NextRequest) {
  bootstrapDb();
  try {
    const sp = req.nextUrl.searchParams;
    const result = getUsageDashboard(getDb(), {
      houseId: sp.get("houseId") ?? undefined,
      taskId: sp.get("taskId") ?? undefined,
      modelId: sp.get("modelId") ?? undefined,
      provider: sp.get("provider") ?? undefined,
      agentId: sp.get("agentId") ?? undefined,
      from: sp.get("from") ?? undefined,
      to: sp.get("to") ?? undefined,
      bucket: sp.get("bucket") ?? undefined,
      taskLimit: sp.get("taskLimit") ?? undefined,
    });
    return ok(result);
  } catch (err) {
    return routeErrorOrMapped(err);
  }
}
