import { NextRequest } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb } from "@/lib/db";
import { getTask, setTaskStatus, InvalidTaskStatusTransitionError } from "@/server/repositories/task-repo";
import { getActiveSessionForHouse, setExecutionSessionStatus, createExecutionEvent } from "@/server/repositories/execution-repo";
import { ok, notFound, badTransition, routeErrorOrMapped } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/**
 * POST /api/tasks/{id}/cancel
 *
 * Cancels a task:
 *  - queued → cancelled directly (nothing to abort).
 *  - running/awaiting_* → flips the task to cancelled and marks the active
 *    session `aborted`. The engine's task runner notices the aborted session
 *    (via GET /session/{id} status) and stops; it also calls POST .../abort on
 *    the provider session on its next termination path.
 */
export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  bootstrapDb();
  const { id } = await ctx.params;
  try {
    const task = getTask(getDb(), id);
    if (!task) return notFound(`Task not found: ${id}`);

    if (task.status === "cancelled" || task.status === "completed" || task.status === "failed") {
      // Idempotent cancel / already terminal.
      return ok({ task, cancelled: task.status === "cancelled" });
    }

    // Abort the active session if one exists so the engine stops it.
    const session = getActiveSessionForHouse(getDb(), task.houseId ?? "");
    if (session && session.taskId === id) {
      setExecutionSessionStatus(getDb(), session.id, "aborted", {
        lastError: "Cancelled by user",
        finishedAt: new Date().toISOString(),
      });
      createExecutionEvent(getDb(), {
        sessionId: session.id,
        taskId: task.id,
        houseId: task.houseId,
        rawType: "session_aborted",
        type: "session_aborted",
        payload: { reason: "user_cancel" },
      });
    }

    const updated = setTaskStatus(getDb(), id, "cancelled");
    void updated;
    const taskNow = getTask(getDb(), id)!;
    return ok({ task: taskNow, cancelled: true });
  } catch (err) {
    if (err instanceof InvalidTaskStatusTransitionError) return badTransition(err.message);
    return routeErrorOrMapped(err);
  }
}
