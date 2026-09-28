import { NextRequest } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb } from "@/lib/db";
import { restoreTask, TaskNotFoundError } from "@/server/repositories/task-repo";
import { recordAudit } from "@/server/repositories/audit-repo";
import { ok, notFound, routeErrorOrMapped } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/**
 * POST /api/tasks/{id}/restore
 *
 * Clears the soft-delete marker, returning the posting to the Quest Board.
 * Restore rule: a terminal task is restored as-is; a task whose status is
 * `queued` is flipped to `cancelled` so a deliberately-removed posting can never
 * silently execute on restore.
 *
 * Idempotent: restoring a live task is a 200 no-op. 404 for an unknown task.
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  bootstrapDb();
  const { id } = await ctx.params;
  try {
    const task = restoreTask(getDb(), id);
    recordAudit(getDb(), {
      actor: "user",
      action: "restore",
      entityType: "task",
      entityId: id,
      metadata: { restored: true, status: task.status },
    });
    return ok({ task });
  } catch (err) {
    if (err instanceof TaskNotFoundError) return notFound(err.message);
    return routeErrorOrMapped(err);
  }
}
