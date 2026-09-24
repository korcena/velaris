/**
 * Engine boot reconciliation (ARCHITECTURE §9 / plan §6 risks).
 *
 * On boot, repair state left over from a previous crash or shutdown:
 *  1. In-flight tasks (status running/awaiting_approval/awaiting_input) whose
 *     session heartbeat went stale → mark session `interrupted` and requeue the
 *     task so it can be re-run (new session). If the session is still live in
 *     the provider, it is reconciled from GET /session.
 *  2. Approval requests still `pending` in the provider are re-synced from
 *     GET /permission + GET /question so a resolved-while-disconnected approval
 *     isn't lost.
 *
 * Idempotent — safe to call on every boot.
 */

import type Database from "better-sqlite3";
import type { VelarisDb } from "@/lib/db";
import type { OpencodeClient } from "@/server/opencode";
import {
  listInFlightTaskIds,
  setTaskStatus,
} from "@/server/repositories/task-repo";
import {
  getActiveSessionForHouse,
  setExecutionSessionStatus,
  getExecutionSession,
  createExecutionEvent,
  listSessionsForTask,
} from "@/server/repositories/execution-repo";
import { findHighLordHouse } from "@/server/repositories/house-repo";
import { listSubtasksForParent } from "@/server/repositories/subtask-repo";
import { tasks, type TaskRow } from "@/lib/db/schema";

export async function reconcile(db: VelarisDb, raw: Database.Database, client: OpencodeClient, log: (m: string) => void): Promise<void> {
  // 1. In-flight tasks.
  const inflight = listInFlightTaskIds(db);
  for (const task of inflight) {
    // High Lord parents with a live plan (subtask rows) are owned by the
    // orchestrator supervisor loop + reconcile pass below, NOT the generic
    // runner orphan handler — skip them here (plan §5.9).
    if ((task.houseId && isHighLordParentWithPlan(db, task)) ) {
      continue;
    }

    const session = getActiveSessionForHouse(db, task.houseId ?? "");
    if (!session) {
      // No live session → the previous engine died mid-claim. Requeue.
      log(`[reconcile] task ${task.title} had no live session — requeued`);
      setTaskStatus(db, task.id, "queued");
      continue;
    }

    // If we still have a provider session id, reconcile live status.
    if (session.providerSessionId) {
      try {
        const info = await client.getSession(session.providerSessionId);
        if (info.id) {
          // The provider session is STILL ALIVE, but no runner owns it anymore
          // (we just restarted the engine). Per the plan (§6 / §12 recovery
          // story) we must NOT leave it "running" with no owner — that would
          // strand it forever. Mark the session interrupted and REQUEUE the task
          // so a fresh runner/session re-runs the work (bug 3).
          log(`[reconcile] task ${task.title} had a live provider session ${info.id} but no owning runner — interrupting & requeueing`);
          await client.abortSession(session.providerSessionId).catch(() => { /* best-effort abort */ });
          setExecutionSessionStatus(db, session.id, "interrupted", {
            lastError: "Provider session orphaned by engine restart (no active runner)",
            finishedAt: new Date().toISOString(),
          });
          setTaskStatus(db, task.id, "queued");
          continue;
        }
      } catch {
        // getSession failed → provider gone; treat as interrupted below.
      }
    }

    // Session is stale / provider unreachable → interrupt it and requeue.
    log(`[reconcile] task ${task.title} session interrupted (stale) — requeued`);
    setExecutionSessionStatus(db, session.id, "interrupted", {
      lastError: "Interrupted on engine restart (stale session)",
      finishedAt: new Date().toISOString(),
    });
    setTaskStatus(db, task.id, "queued");
  }

  // 2. Re-sync pending approvals from the provider.
  try {
    const perms = await client.listPendingPermissions();
    const questions = await client.listPendingQuestions();
    log(`[reconcile] re-syncing approvals: ${perms.length} permissions, ${questions.length} questions`);
    // Re-sync is handled lazily by the event mapper on the next SSE event + the
    // runner's relay; we just log here. Persisting them is done via the engine's
    // SSE ingest on connect. This keeps reconciliation lightweight and avoids
    // writing rows that may duplicate.
  } catch (err) {
    log(`[reconcile] approval re-sync failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. Orchestrator pass (Phase 4 — plan §5.9 + addendum D10.1).
  //    (a) A High Lord parent that is `running` with NO subtask rows died between
  //        the queue claiming it and the planning session persisting → requeue so
  //        the queue re-triggers planning next tick.
  //    (b) A steering-busy HL planning session left `running` by a crash must be
  //        returned to `completed` and surfaced via an informational event so a
  //        subsequent steer is accepted (D10.1).
  await reconcileHighLord(db, log);

  log("[reconcile] boot reconciliation complete");
}

/** Orchestrator reconciliation pass (idempotent — safe on every boot). */
async function reconcileHighLord(db: VelarisDb, log: (m: string) => void): Promise<void> {
  const hl = findHighLordHouse(db);
  if (!hl) return;

  // (b) Steering-busy planning sessions → flip back to completed + informational.
  for (const task of listHlParentTasks(db, hl.id)) {
    if ((task.status as TaskRow["status"]) !== "running") continue;
    const session = latestSessionForTask(db, task.id);
    if (session && session.status === "running") {
      log(`[reconcile] High Lord planning session ${session.id} steering-busy on restart — returning to completed`);
      setExecutionSessionStatus(db, session.id, "completed");
      createExecutionEvent(db, {
        taskId: task.id,
        houseId: hl.id,
        rawType: "message",
        type: "message",
        payload: { plan: false, steer: true, note: "Steering session interrupted by engine restart — reply discarded" },
      });
    }
  }

  // (a) A running parent with NO subtask rows and NO live session → requeue.
  for (const task of listHlParentTasks(db, hl.id)) {
    if ((task.status as TaskRow["status"]) !== "running") continue;
    const hasSubtasks = listSubtasksForParent(db, task.id).length > 0;
    if (hasSubtasks) continue;
    const session = latestSessionForTask(db, task.id);
    if (session && ["pending", "running", "awaiting_approval", "awaiting_input"].includes(session.status)) {
      continue; // planning session still live — queue/runner will handle it
    }
    log(`[reconcile] High Lord parent ${task.title} running with no plan — requeueing`);
    setTaskStatus(db, task.id, "queued");
  }
}

function listHlParentTasks(db: VelarisDb, hlHouseId: string): TaskRow[] {
  return db.select().from(tasks).all().filter((t) => t.houseId === hlHouseId);
}

/** True when `task` is a High Lord parent task with a live plan (subtask rows). */
function isHighLordParentWithPlan(db: VelarisDb, task: TaskRow): boolean {
  const hl = findHighLordHouse(db);
  if (!hl || task.houseId !== hl.id) return false;
  return listSubtasksForParent(db, task.id).length > 0;
}

function latestSessionForTask(db: VelarisDb, taskId: string) {
  const sessions = listSessionsForTask(db, taskId);
  return sessions.length ? sessions[sessions.length - 1] : null;
}
