import { NextRequest } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb } from "@/lib/db";
import { listArtifactsForTask } from "@/server/repositories/execution-repo";
import { getTask } from "@/server/repositories/task-repo";
import { ok, notFound } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/tasks/{id}/artifacts → { artifacts }
 * All artifacts a task produced across its sessions (diff, result, file_list,
 * other), ordered by creation time. 404 for an unknown task id.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  bootstrapDb();
  const { id } = await ctx.params;
  const task = getTask(getDb(), id);
  if (!task) return notFound(`Task not found: ${id}`);

  const artifacts = listArtifactsForTask(getDb(), id);
  return ok({ artifacts });
}
