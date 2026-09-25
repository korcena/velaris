import { NextRequest } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb } from "@/lib/db";
import {
  getTask,
  updateTask,
  deleteTask,
  TaskNotFoundError,
  InvalidTaskStatusTransitionError,
} from "@/server/repositories/task-repo";
import { getSubtaskByChildTaskId, listSubtasksForParent } from "@/server/repositories/subtask-repo";
import { agentBelongsToHouse } from "@/server/repositories/house-repo";
import { taskUpdateSchema } from "@/shared/schemas/task";
import { ok, noContent, notFound, badRequest, badTransition, routeErrorOrMapped } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/** GET /api/tasks/{id} */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  bootstrapDb();
  const { id } = await ctx.params;
  const task = getTask(getDb(), id);
  if (!task) return notFound(`Task not found: ${id}`);
  return ok({ task });
}

/** PATCH /api/tasks/{id} — mutable fields; status only → 'cancelled' in Phase 1. */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  bootstrapDb();
  const { id } = await ctx.params;
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return badRequest("Request body must be valid JSON");
    }
    const parsed = taskUpdateSchema.parse(body);

    // Addendum D4c prefs-clobber guard: `execution_preferences` on a subtask
    // linked task (a High Lord parent or a delegated child) carries engine-owned
    // state (e.g. `plan.abortReason`). Rejecting a wholesale PATCH of
    // executionPreferences preserves that engine block from being clobbered.
    if (parsed.executionPreferences !== undefined) {
      const isSubtaskLinked =
        listSubtasksForParent(getDb(), id).length > 0 ||
        getSubtaskByChildTaskId(getDb(), id) !== null;
      if (isSubtaskLinked) {
        return badTransition(
          "executionPreferences on a plan-linked task is engine-owned and cannot be patched",
        );
      }
    }

    // Phase 6 Stage B: an explicit target agent must belong to the task's
    // (possibly newly PATCHed) house.
    let effectiveAgentId: string | null | undefined = parsed.agentId;
    if (parsed.agentId) {
      const current = getTask(getDb(), id);
      if (!current) return notFound(`Task not found: ${id}`);
      const effectiveHouseId = parsed.houseId !== undefined ? parsed.houseId : current.houseId;
      if (!effectiveHouseId || !agentBelongsToHouse(getDb(), parsed.agentId, effectiveHouseId)) {
        return badRequest("agentId does not belong to the selected house");
      }
    } else if (parsed.houseId !== undefined) {
      // Moving the task to another house without naming an agent must not leave
      // the OLD house's agentId attached (it would target a foreign agent).
      // Validate the existing target against the new house; clear it if foreign.
      const current = getTask(getDb(), id);
      if (!current) return notFound(`Task not found: ${id}`);
      if (
        current.agentId &&
        (!parsed.houseId || !agentBelongsToHouse(getDb(), current.agentId, parsed.houseId))
      ) {
        effectiveAgentId = null;
      }
    }

    const task = updateTask(getDb(), id, {
      title: parsed.title,
      description: parsed.description,
      type: parsed.type,
      priority: parsed.priority,
      houseId: parsed.houseId,
      projectId: parsed.projectId,
      agentId: effectiveAgentId,
      workingDirectory: parsed.workingDirectory,
      executionPreferences: parsed.executionPreferences,
      status: parsed.status,
    });
    return ok({ task });
  } catch (err) {
    if (err instanceof TaskNotFoundError) return notFound(err.message);
    if (err instanceof InvalidTaskStatusTransitionError) return badTransition(err.message);
    return routeErrorOrMapped(err);
  }
}

/** DELETE /api/tasks/{id} */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  bootstrapDb();
  const { id } = await ctx.params;
  try {
    deleteTask(getDb(), id);
    return noContent();
  } catch (err) {
    if (err instanceof TaskNotFoundError) return notFound(err.message);
    return routeErrorOrMapped(err);
  }
}
