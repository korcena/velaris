import { NextRequest } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb, getRawDb } from "@/lib/db";
import { findHighLordHouse } from "@/server/repositories/house-repo";
import { getTask } from "@/server/repositories/task-repo";
import { listSubtasksForParent } from "@/server/repositories/subtask-repo";
import {
  listSessionsForTask,
  getActiveSessionForHouse,
  createAgentMessage,
  findPendingUserMessage,
} from "@/server/repositories/execution-repo";
import { courtSteerSchema } from "@/shared/schemas/plan";
import { ok, notFound, conflict, badRequest, routeErrorOrMapped } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

const TERMINAL_TASK = ["completed", "failed", "cancelled", "interrupted"] as const;

/**
 * POST /api/court/steer { parentTaskId, message }
 *
 * Mid-plan steering: writes the user's message as an agent_messages row on the
 * High Lord's planning session (the same web-writes-intent pattern as
 * /api/houses/{id}/messages) so the engine's orchestrator relays it into the
 * resumable planning session.
 *
 *  404 — unknown task, or a task that is not an active High Lord parent.
 *  409 — the parent is terminal, or the planning session is already busy (a
 *        steer is in flight). Reject rather than queue.
 *  200 — accepted: agent_messages row written for the engine to pick up.
 */
export async function POST(req: NextRequest) {
  bootstrapDb();
  try {
    const hl = findHighLordHouse(getDb());
    if (!hl) return notFound("High Lord house not seeded");

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return badRequest("Request body must be valid JSON");
    }
    const parsed = courtSteerSchema.parse(body);

    const parent = getTask(getDb(), parsed.parentTaskId);
    if (!parent) return notFound(`Task not found: ${parsed.parentTaskId}`);

    // Must be a High Lord parent with a plan.
    const subtasks = listSubtasksForParent(getDb(), parsed.parentTaskId);
    if (parent.houseId !== hl.id || subtasks.length === 0) {
      return notFound("Task is not an active High Lord plan");
    }

    // 409 if the parent is terminal — steering a finished plan is meaningless.
    if ((TERMINAL_TASK as readonly string[]).includes(parent.status as string)) {
      return conflict("This plan has already finished — start a new instruction instead");
    }

    // 409 if the planning session is busy (a steer is already in flight). The
    // engine marks a steering exchange by flipping the planning session to
    // `running` and only returns it to `completed` AFTER the reply is ingested
    // and handled. So an explicit session-status check (not just the active
    // session probe) is the authoritative "mid-counsel" signal; a pending
    // un-relayed user message also means a steer is queued.
    const sessions = listSessionsForTask(getDb(), parent.id);
    const planningSession = sessions[sessions.length - 1];
    const busyHouse = getActiveSessionForHouse(getDb(), hl.id);
    const planningBusy = Boolean(planningSession && planningSession.status === "running");
    const pendingSteer = planningSession
      ? findPendingUserMessage(getRawDb(), planningSession.id, null)
      : null;
    if (busyHouse || planningBusy || !planningSession || pendingSteer) {
      return conflict("The High Lord is mid-counsel — try again in a moment");
    }

    // Persist the user message on the planning session for the engine to relay.
    createAgentMessage(getDb(), {
      sessionId: planningSession.id,
      role: "user",
      content: parsed.message,
    });
    return ok({ accepted: true, sessionId: planningSession.id });
  } catch (err) {
    return routeErrorOrMapped(err);
  }
}
