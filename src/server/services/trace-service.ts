/**
 * Trace service — read-only aggregation of a quest tree's activity.
 *
 * `buildTaskTrace` merges the parent task's execution events + agent messages
 * with those of every delegated child (each tagged with its `subtasks.id` /
 * plan-local `planId` / resolved agent), ordered ascending by `createdAt` with
 * a deterministic `id` tie-break for stable refetches.
 *
 * Soft-deleted children are excluded (the engine never runs/aggregates a deleted
 * task); the parent's own trace is always included, even when the parent itself
 * is soft-deleted. Pure read service — no writes, no audit, no engine import.
 */

import type { VelarisDb } from "@/lib/db";
import {
  listSessionsForTask,
  listEventsForTask,
  listAgentMessagesForSession,
} from "@/server/repositories/execution-repo";
import { listSubtasksForParent } from "@/server/repositories/subtask-repo";
import { getTask } from "@/server/repositories/task-repo";
import { resolveRuntimeAgent, getAgent } from "@/server/repositories/house-repo";
import type { TaskDto, TaskTraceDto, TraceEntryDto } from "@/shared/types";

/** Merged cap across parent + children (per-task events are capped at 1000). */
export const TRACE_DEFAULT_LIMIT = 1000;

/** A task whose rows are merged into the trace, plus its step/agent tags. */
interface TraceSource {
  taskId: string;
  subtaskId: string | null;
  planId: string | null;
  agentId: string | null;
  agentName: string | null;
}

/**
 * Resolve the agent a task ran as: its explicit agent when it belongs to the
 * task's house, else the house default (oldest agent). Mirrors the engine's
 * `resolveRuntimeAgent` routing rule for null `agent_id`.
 */
function resolveAgentForTask(
  db: VelarisDb,
  task: TaskDto,
): { agentId: string | null; agentName: string | null } {
  const agent = task.houseId
    ? resolveRuntimeAgent(db, task.houseId, task)
    : task.agentId
      ? getAgent(db, task.agentId)
      : null;
  return { agentId: agent?.id ?? null, agentName: agent?.name ?? null };
}

/** Collect event entries for one source task. */
function eventEntries(db: VelarisDb, source: TraceSource): TraceEntryDto[] {
  return listEventsForTask(db, source.taskId).map((ev) => ({
    id: `e:${ev.id}`,
    kind: "event" as const,
    taskId: source.taskId,
    subtaskId: source.subtaskId,
    planId: source.planId,
    agentId: source.agentId,
    agentName: source.agentName,
    type: ev.type,
    createdAt: ev.createdAt,
    payload: ev.payload,
    content: null,
  }));
}

/** Collect agent-message entries across all of one source task's sessions. */
function messageEntries(db: VelarisDb, source: TraceSource): TraceEntryDto[] {
  const entries: TraceEntryDto[] = [];
  for (const session of listSessionsForTask(db, source.taskId)) {
    for (const m of listAgentMessagesForSession(db, session.id)) {
      entries.push({
        id: `m:${m.id}`,
        kind: "message",
        taskId: source.taskId,
        subtaskId: source.subtaskId,
        planId: source.planId,
        agentId: source.agentId,
        agentName: source.agentName,
        type: m.role,
        createdAt: m.createdAt,
        payload: null,
        content: m.content,
      });
    }
  }
  return entries;
}

/**
 * Build the aggregated trace for a quest tree, or null when the task does not
 * exist. The parent is always included; delegated children are included only
 * when their task row exists and is not soft-deleted.
 */
export function buildTaskTrace(
  db: VelarisDb,
  taskId: string,
  opts: { limit?: number } = {},
): TaskTraceDto | null {
  const parent = getTask(db, taskId);
  if (!parent) return null;

  const sources: TraceSource[] = [
    {
      taskId: parent.id,
      subtaskId: null,
      planId: null,
      ...resolveAgentForTask(db, parent),
    },
  ];

  // Delegated steps: skip missing/soft-deleted child tasks entirely.
  for (const subtask of listSubtasksForParent(db, taskId)) {
    if (!subtask.taskId) continue;
    const child = getTask(db, subtask.taskId);
    if (!child || child.deletedAt !== null) continue;
    sources.push({
      taskId: child.id,
      subtaskId: subtask.id,
      planId: subtask.planId,
      ...resolveAgentForTask(db, child),
    });
  }

  const entries: TraceEntryDto[] = [];
  for (const source of sources) {
    entries.push(...eventEntries(db, source), ...messageEntries(db, source));
  }

  // Ascending time; deterministic id tie-break for stable refetches.
  entries.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const limit = opts.limit ?? TRACE_DEFAULT_LIMIT;
  const truncated = entries.length > limit;
  return { taskId, entries: entries.slice(0, limit), truncated };
}
