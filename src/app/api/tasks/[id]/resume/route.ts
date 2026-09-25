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
 * POST /api/tasks/{id}/resume
 *
 * The web-side twin of /pause. It records the USER'S INTENT to resume — the
 * engine's Ollama loop notices the session/task flipped back to `running` at its
 * next in-loop checkpoint and continues in place from the persisted
 * `agent_messages` memory (no step is lost; every turn was persisted before the
 * previous call).
 *
 * Guards:
 *  - 404 task unknown;
 *  - 409 not paused (only a paused task can resume) or non-Ollama provider.
 *
 * On success: flips the active session + task to `running` and emits a
 * `{ pause: false }` message event. If the engine is not currently live, the
 * queue re-claims the `running` task next tick and re-enters `runOllamaTask`,
 * which detects the existing non-terminal session with persisted memory and
 * continues it (crash-recovery discipline).
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

    if (task.status !== "paused") {
      return conflict("Task is not paused and cannot be resumed");
    }

    const house = task.houseId ? getHouse(getDb(), task.houseId) : null;
    if (!house) return conflict("Task has no house to resume");

    // Provider-aware: only the native Ollama runtime supports in-place resume.
    if (house.configuration.executionProvider !== "ollama") {
      return conflict("This provider cannot resume — it cannot pause");
    }

    const session = getActiveSessionForHouse(getDb(), house.id);
    if (session) {
      // In-place resume: a session exists (the engine was live and paused it).
      // Flip the session + task back to `running`; the Ollama loop observes the
      // flip at its next checkpoint and continues in place from persisted memory.
      setExecutionSessionStatus(getDb(), session.id, "running");
      createExecutionEvent(getDb(), {
        sessionId: session.id,
        taskId: task.id,
        houseId: house.id,
        rawType: "message",
        type: "message",
        payload: { pause: false, note: "Native resume — the Ollama loop continues in place" },
      });
      setTaskStatus(getDb(), id, "running");
      return ok({ task: getTask(getDb(), id)! });
    }

    // No active session → the task was paused BEFORE the engine ever claimed it
    // (still `queued`, never started). Resuming to `running` would strand it:
    // the queue claims only `queued` tasks (claimQueuedTask / listQueuedTaskIds)
    // and the session flip is what the loop observes for in-place resume. So put
    // it back to `queued` (claimable) — the engine re-claims it next tick and
    // starts the session fresh.
    setTaskStatus(getDb(), id, "queued");
    return ok({ task: getTask(getDb(), id)! });
  } catch (err) {
    return routeErrorOrMapped(err);
  }
}
