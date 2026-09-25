import { NextRequest } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb } from "@/lib/db";
import { getTask, setTaskStatus } from "@/server/repositories/task-repo";
import { getHouse } from "@/server/repositories/house-repo";
import {
  getActiveSessionForHouse,
  setExecutionSessionStatus,
  createExecutionEvent,
} from "@/server/repositories/execution-repo";
import { ok, notFound, conflict, routeErrorOrMapped } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/**
 * POST /api/tasks/{id}/pause
 *
 * THE WEB'S SECOND execution-adjacent intent write (besides approval responses).
 * It records the USER'S INTENT to pause — it does NOT execute anything. The
 * ENGINE's Ollama tool loop is the only thing that actually suspends, by
 * observing the session/task rows flipped to `paused` at its next in-loop
 * checkpoint. This mirrors the cancel route: web flips status + emits an event,
 * the engine acts.
 *
 * Guards (decision Q10 / provider-aware):
 *  - 404 task unknown;
 *  - 409 the house's provider cannot natively pause (executionProvider !== 'ollama'
 *    → "This provider cannot pause — cancel instead");
 *  - 409 the task/session is already terminal (paused is non-terminal).
 *
 * On success: flips the active session + task to `paused` and emits a
 * `{ pause: true }` message event so the UI reacts immediately. The queue's
 * `getActiveSessionForHouse` includes `paused` (Stage C), so a paused session
 * is still "in flight" and no second task claims the same house.
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

    if (isTerminal(task.status)) {
      return conflict("Task is already terminal and cannot be paused");
    }
    if (task.status === "paused") {
      // Idempotent pause.
      return ok({ task });
    }

    const house = task.houseId ? getHouse(getDb(), task.houseId) : null;
    if (!house) return conflict("Task has no house to pause");

    // Provider-aware: only the native Ollama runtime can suspend in place.
    if (house.configuration.executionProvider !== "ollama") {
      return conflict("This provider cannot pause — cancel instead");
    }

    const session = getActiveSessionForHouse(getDb(), house.id);
    if (!session || session.taskId !== id) {
      // A queued/non-running Ollama task can still be paused (the engine has not
      // claimed it yet). Flip the task to paused; no session to mark.
      setTaskStatus(getDb(), id, "paused");
      return ok({ task: getTask(getDb(), id)! });
    }

    setExecutionSessionStatus(getDb(), session.id, "paused");
    setTaskStatus(getDb(), id, "paused");
    createExecutionEvent(getDb(), {
      sessionId: session.id,
      taskId: task.id,
      houseId: house.id,
      rawType: "message",
      type: "message",
      payload: { pause: true, note: "Native pause requested — the Ollama loop suspends between steps" },
    });

    return ok({ task: getTask(getDb(), id)! });
  } catch (err) {
    return routeErrorOrMapped(err);
  }
}

function isTerminal(status: string): boolean {
  return ["completed", "failed", "cancelled", "interrupted"].includes(status);
}
