import { NextRequest } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb } from "@/lib/db";
import { getTask } from "@/server/repositories/task-repo";
import { buildTaskTrace } from "@/server/services/trace-service";
import { ok, notFound } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/tasks/{id}/trace → { trace: TaskTraceDto }
 * Read-only rollup of the parent's and every non-deleted child's execution
 * events + agent messages, tagged per step/agent and ordered by time.
 * 404 for an unknown task; no audit write.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  bootstrapDb();
  const { id } = await ctx.params;
  const task = getTask(getDb(), id);
  if (!task) return notFound(`Task not found: ${id}`);
  const trace = buildTaskTrace(getDb(), id);
  return ok({ trace });
}
