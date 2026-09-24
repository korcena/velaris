import { NextRequest } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb } from "@/lib/db";
import { getTask } from "@/server/repositories/task-repo";
import { buildPlanDto } from "@/server/services/plan-service";
import { ok, notFound } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/tasks/{id}/plan → { plan: PlanDto }
 *
 * The Court plan board. Returns `{ plan: null }` (200) for a task with no
 * subtask rows (i.e. not a Court quest), and 404 for an unknown task.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  bootstrapDb();
  const { id } = await ctx.params;
  const task = getTask(getDb(), id);
  if (!task) return notFound(`Task not found: ${id}`);
  const plan = buildPlanDto(getDb(), id);
  // A task with no subtask rows is not a Court quest → plan: null (200).
  if (!plan || plan.subtasks.length === 0) return ok({ plan: null });
  return ok({ plan });
}
