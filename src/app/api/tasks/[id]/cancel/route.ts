import { NextRequest } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb } from "@/lib/db";
import { getTask, setTaskStatus, writeTaskPlanAbortReason, InvalidTaskStatusTransitionError } from "@/server/repositories/task-repo";
import { getActiveSessionForHouse, setExecutionSessionStatus, createExecutionEvent } from "@/server/repositories/execution-repo";
import { listSubtasksForParent, cancelSubtasksForParent } from "@/server/repositories/subtask-repo";
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
 *
 * If the task is a High Lord PARENT (has subtask rows), this cascades per
 * §5.7: every non-terminal child task is cancelled (and its active session
 * aborted), and every non-terminal subtask row is flipped to `cancelled`.
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

    // Cascade-cancel a High Lord plan's children + subtask rows (web-side
    // sibling of the engine's abortPlan). Cancel each non-terminal child task
    // and abort its active session.
    const subtasks = listSubtasksForParent(getDb(), id);
    if (subtasks.length > 0) {
      for (const sub of subtasks) {
        if (!sub.taskId) continue;
        const child = getTask(getDb(), sub.taskId);
        if (!child || isTerminal(child.status)) continue;
        setTaskStatus(getDb(), child.id, "cancelled", "Parent plan cancelled by user");
        const childSession = getActiveSessionForHouse(getDb(), child.houseId ?? "");
        if (childSession && childSession.taskId === child.id) {
          setExecutionSessionStatus(getDb(), childSession.id, "aborted", {
            lastError: "Parent plan cancelled by user",
            finishedAt: new Date().toISOString(),
          });
        }
      }
      cancelSubtasksForParent(getDb(), id);
    }

    const updated = setTaskStatus(getDb(), id, "cancelled");
    void updated;
    // Addendum D4e(b)/D4f: a user abort must show burning visuals on both Court
    // and map. Record the plan abortReason so plan-board.tsx / the map's
    // `data-plan-state` render the burned-house state instead of a dead "cancelled".
    if (subtasks.length > 0) {
      writeTaskPlanAbortReason(getDb(), id, {
        abortReason: "user_cancel",
        abortedAt: new Date().toISOString(),
      });
    }
    const taskNow = getTask(getDb(), id)!;
    return ok({ task: taskNow, cancelled: true });
  } catch (err) {
    if (err instanceof InvalidTaskStatusTransitionError) return badTransition(err.message);
    return routeErrorOrMapped(err);
  }
}

function isTerminal(status: string): boolean {
  return ["completed", "failed", "cancelled", "interrupted"].includes(status);
}
