/**
 * Plan service — web-facing read service for the High Lord Court surface.
 *
 * Responsibilities (Phase 4):
 *  - `buildPlanDto`: assemble a parent task's full plan (subtasks + handoffs +
 *    cost rollup + consolidated result) for the Court board.
 *  - `buildCourtHistory`: the Court chat log across recent High Lord parent tasks
 *    (user instruction + agent plan text from the planning session's agent_messages).
 *  - `deriveHighLordPlanState`: derive the additive `planState` on the High Lord's
 *    DTO from its latest parent task + subtask rollup (addendum D4f).
 *
 * Pure read service — performs no writes.
 */

import type { VelarisDb } from "@/lib/db";
import { eq, sql } from "drizzle-orm";
import { tasks, subtasks } from "@/lib/db/schema";
import {
  listSubtasksForParent,
} from "@/server/repositories/subtask-repo";
import { listHandoffsForParent } from "@/server/repositories/handoff-repo";
import { getTask, taskRowToDto } from "@/server/repositories/task-repo";
import {
  getUsageSummaryForTask,
  listSessionsForTask,
  listArtifactsForTask,
  listAgentMessagesForSession,
} from "@/server/repositories/execution-repo";
import type {
  PlanDto,
  PlanConsolidatedResult,
  CourtMessageDto,
  HighLordPlanState,
  TaskDto,
} from "@/shared/types";
import { parseJson } from "@/shared/schemas/common";

/**
 * Build the full PlanDto for a parent task (the Court plan board), or null when
 * the parent task does not exist. `consolidated` is populated when the parent is
 * terminal (reads the `result`-kind artifact on the parent task).
 */
export function buildPlanDto(db: VelarisDb, parentTaskId: string): PlanDto | null {
  const parentTask = getTask(db, parentTaskId);
  if (!parentTask) return null;

  const subtasks = listSubtasksForParent(db, parentTaskId);
  const handoffs = listHandoffsForParent(db, parentTaskId);
  const cost = getUsageSummaryForTask(db, parentTaskId);

  return {
    parentTaskId,
    parentTask,
    subtasks,
    handoffs,
    cost,
    consolidated: buildConsolidated(db, parentTask),
  };
}

/** Read the consolidated result block off the parent task when it is terminal. */
function buildConsolidated(db: VelarisDb, parent: TaskDto): PlanConsolidatedResult | null {
  if (!["completed", "failed", "cancelled", "interrupted"].includes(parent.status)) {
    return null;
  }

  const artifacts = listArtifactsForTask(db, parent.id);
  const resultArtifact = artifacts.find((a) => a.kind === "result");

  // fileCount from the diff/file_list artifacts; diffPreview from the diff artifact.
  let fileCount = 0;
  let diffPreview: string | null = null;
  for (const a of artifacts) {
    if (a.kind === "diff") {
      diffPreview = diffPreview ?? a.content.slice(0, 4000);
    } else if (a.kind === "file_list") {
      fileCount = parseJson<string[]>(a.content, []).length;
    }
  }

  return {
    summary: resultArtifact?.content ?? null,
    fileCount,
    diffPreview,
  };
}

/**
 * Court chat history — for each of the latest `limit` High Lord parent tasks
 * (ordered newest-first), the user instruction row + the newest agent reply from
 * the planning session, as chronological CourtMessageDto[].
 *
 * Planning conversations live in the planning session's agent_messages. Keep it
 * simple: one user + agent pair per parent task.
 */
export function buildCourtHistory(db: VelarisDb, hlHouseId: string, limit = 20): CourtMessageDto[] {
  const parents = db
    .select()
    .from(tasks)
    .where(eq(tasks.houseId, hlHouseId))
    .orderBy(sql`${tasks.createdAt} DESC`)
    .limit(limit)
    .all()
    .map(taskRowToDto);

  const messages: CourtMessageDto[] = [];

  for (const task of parents) {
    // The planning session is the latest session on the parent task.
    const sessions = listSessionsForTask(db, task.id);
    const session = sessions[sessions.length - 1];
    if (!session) continue;

    const agentMessages = listAgentMessagesForSession(db, session.id);
    // The first user message is the submitted instruction; the newest agent
    // message is the planner's reply (post-steer messages extend the thread).
    const userMsg = agentMessages.find((m) => m.role === "user");
    const agentMsgs = agentMessages.filter((m) => m.role === "agent");
    const agentMsg = agentMsgs[agentMsgs.length - 1];

    if (userMsg) {
      messages.push({
        id: `${task.id}:user:${userMsg.id}`,
        role: "user",
        content: userMsg.content,
        createdAt: userMsg.createdAt,
        taskId: task.id,
      });
    }
    if (agentMsg) {
      messages.push({
        id: `${task.id}:agent:${agentMsg.id}`,
        role: "agent",
        content: agentMsg.content,
        createdAt: agentMsg.createdAt,
        taskId: task.id,
      });
    }
  }

  // Chronological across tasks (oldest task first within the limited window).
  return messages.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

/**
 * Derive the High Lord's `planState` (addendum D4f) from its latest parent task
 * and subtask rollup. One query for the latest task + one rollup probe.
 *
 *    no parent task                      → idle
 *    parent queued (not yet claimed)     → planning
 *    parent running AND subtasks empty   → planning   (planner call in flight)
 *    parent running AND subtasks exist   → active
 *    parent completed                    → completed
 *    parent failed                       → aborted
 *    parent cancelled/interrupted        → aborted
 */
export function deriveHighLordPlanState(db: VelarisDb, hlHouseId: string): HighLordPlanState {
  const latest = db
    .select()
    .from(tasks)
    .where(eq(tasks.houseId, hlHouseId))
    .orderBy(sql`${tasks.createdAt} DESC`)
    .limit(1)
    .get();

  if (!latest) return "idle";

  const status = latest.status as TaskDto["status"];

  if (status === "queued") return "planning";
  if (status === "completed") return "completed";
  if (status === "failed" || status === "cancelled" || status === "interrupted") {
    return "aborted";
  }
  // running / awaiting_* : planner in flight if no subtask rows yet.
  const hasSubtasks =
    db.select().from(subtasks).where(eq(subtasks.parentTaskId, latest.id)).all().length > 0;
  return hasSubtasks ? "active" : "planning";
}
