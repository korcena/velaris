/**
 * Execution read service — used by the web API routes to derive extended
 * HouseDto details (runtime status, active task, pending approval count) and
 * to expose approval / notification / message / usage data.
 *
 * Runtime status is DERIVED (AGENT_ORCHESTRATION §4) — it is not stored on the
 * house row. The config status (active/disabled/archived) stays on houses.status.
 */

import type { VelarisDb } from "@/lib/db";
import type {
  HouseDto,
  HouseDetailDto,
  HouseRuntimeStatus,
  TaskStatus,
  HighLordPlanState,
} from "@/shared/types";
import { getActiveSessionForHouse, listApprovalRequests, getUsageSummaryForHouse } from "@/server/repositories/execution-repo";
import { getTask } from "@/server/repositories/task-repo";
import { deriveHighLordPlanState } from "@/server/services/plan-service";

/** Compute the derived runtime status for a house from its active session. */
export function deriveRuntimeStatus(
  session: { status: string } | null,
): HouseRuntimeStatus {
  if (!session) return "idle";
  switch (session.status) {
    case "awaiting_approval":
      return "awaiting_approval";
    case "awaiting_input":
      return "awaiting_input";
    case "running":
      return "working";
    case "pending":
      return "planning";
    default:
      return "idle";
  }
}

/** Extend a HouseDto with P2 runtime detail (GET /api/houses/{id}). */
export function buildHouseDetail(db: VelarisDb, house: HouseDto): HouseDetailDto {
  const session = getActiveSessionForHouse(db, house.id);
  const runtimeStatus = deriveRuntimeStatus(session);

  let activeTask: { id: string | null; title: string | null; status: TaskStatus | null } = {
    id: null,
    title: null,
    status: null,
  };
  if (session) {
    const task = getTask(db, session.taskId);
    if (task) {
      activeTask = { id: task.id, title: task.title, status: task.status };
    }
  }

  const pendingApprovals = listApprovalRequests(db, {
    houseId: house.id,
    status: "pending",
  }).length;

  const usage = getUsageSummaryForHouse(db, house.id);

  const planState =
    house.kind === "high_lord" ? deriveHighLordPlanState(db, house.id) : undefined;

  return {
    ...house,
    runtimeStatus,
    activeTask,
    pendingApprovals,
    usage,
    ...(planState ? { planState } : {}),
  };
}

/**
 * Lightweight list-time enrichment for a house: derived runtime status + pending
 * approval count. Used by GET /api/houses (bird indicator on house cards) where
 * full `buildHouseDetail` per row would be too heavy. Keeps the house's own
 * fields untouched so the list envelope stays backward compatible. A High Lord
 * house additionally surfaces its derived `planState` (addendum D4f).
 */
export function buildHouseListSummary(
  db: VelarisDb,
  house: HouseDto,
): { runtimeStatus: HouseRuntimeStatus; pendingApprovals: number; planState?: HighLordPlanState } {
  const session = getActiveSessionForHouse(db, house.id);
  const runtimeStatus = deriveRuntimeStatus(session);
  const pendingApprovals = listApprovalRequests(db, {
    houseId: house.id,
    status: "pending",
  }).length;
  const planState =
    house.kind === "high_lord" ? deriveHighLordPlanState(db, house.id) : undefined;
  return {
    runtimeStatus,
    pendingApprovals,
    ...(planState ? { planState } : {}),
  };
}
