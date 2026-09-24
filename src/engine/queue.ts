/**
 * Task queue — the engine's poll loop (ARCHITECTURE §3).
 *
 * Every ~2s, claims runnable `queued` tasks and executes them through the
 * AgentExecutionProvider, honoring per-house concurrency and skipping houses
 * that are disabled/archived (task stays queued).
 *
 * Concurrency model (P2): one active execution task per house. The task row is
 * atomically claimed (UPDATE ... WHERE status='queued'), so multi-process safety
 * holds under WAL.
 */

import type Database from "better-sqlite3";
import type { VelarisDb } from "@/lib/db";
import type { AgentExecutionProvider } from "@/server/execution/types";
import { executeTask } from "@/server/execution/runner";
import { OpencodeClient } from "@/server/opencode";
import type { HouseDto, TaskDto } from "@/shared/types";
import { getHouse } from "@/server/repositories/house-repo";
import { getTask } from "@/server/repositories/task-repo";
import {
  listQueuedTaskIds,
  claimQueuedTask,
  setTaskStatus,
} from "@/server/repositories/task-repo";
import { createExecutionEvent, getActiveSessionForHouse } from "@/server/repositories/execution-repo";
import { resolveSafePath, isPathAllowed } from "@/lib/paths";
import { runParent, tickActivePlans } from "./orchestrator";
import type { OrchestratorDeps } from "./orchestrator";

export interface QueueDeps {
  db: VelarisDb;
  raw: Database.Database;
  adapter: AgentExecutionProvider;
  client: OpencodeClient;
  /** Signal aborted on engine shutdown — stops the queue + aborts in-flight. */
  signal?: AbortSignal;
  log: (msg: string) => void;
}

export class TaskQueue {
  private deps: QueueDeps;
  private stopping = false;
  private inFlight = new Set<string>(); // task ids currently executing
  /** per-house concurrency tracking (P2: 1 at a time per house). */
  private houseBusy = new Set<string>();
  private loopTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: QueueDeps) {
    this.deps = deps;
  }

  async start(): Promise<void> {
    this.deps.log("[queue] task queue started (poll 2s)");
    this.deps.signal?.addEventListener("abort", () => {
      this.stopping = true;
      this.stop();
    });
    this.tick();
  }

  private tick(): void {
    if (this.stopping) return;
    void this.processOnce().finally(() => {
      if (!this.stopping) {
        this.loopTimer = setTimeout(() => this.tick(), 2000);
      } else {
        this.stop();
      }
    });
  }

  /** One full queue pass. */
  private async processOnce(): Promise<void> {
    const { raw, db } = this.deps;
    // Health gate (ARCHITECTURE §8): do not claim/execute tasks while the
    // OpenCode server is unhealthy/not yet up. Tasks stay queued and are retried
    // on the next tick once the server becomes healthy. This is the minimal
    // health-gate — the queue runner must not attempt OpenCode work blindly.
    try {
      if (!(await this.deps.client.health())) {
        this.deps.log("[queue] OpenCode server not healthy — skipping this tick");
        return;
      }
    } catch {
      this.deps.log("[queue] OpenCode health probe failed — skipping this tick");
      return;
    }

    // 1. Find queued tasks.
    const queuedIds = listQueuedTaskIds(raw);

    for (const taskId of queuedIds) {
      if (this.stopping) break;
      if (this.inFlight.has(taskId)) continue;

      // Atomic claim.
      if (!claimQueuedTask(raw, taskId)) continue; // already taken

      this.inFlight.add(taskId);
      void this.runClaimedTask(taskId).finally(() => {
        this.inFlight.delete(taskId);
      });
    }

    // Supervisor pass: reconcile/advance active High Lord plans (mirror child
    // terminal states, release dependents, steer, budget, consolidate).
    const orchestratorDeps: OrchestratorDeps = {
      db,
      raw,
      adapter: this.deps.adapter,
      client: this.deps.client,
      log: this.deps.log,
    };
    await tickActivePlans(orchestratorDeps);
  }

  /** Execute an already-claimed task. */
  private async runClaimedTask(taskId: string): Promise<void> {
    const { db, raw, adapter, client, signal } = this.deps;
    const task = getTask(db, taskId);
    if (!task) {
      setTaskStatus(db, taskId, "cancelled", "Task deleted while queued");
      return;
    }
    
    // Ensure the task has a house & the house is active.
    if (!task.houseId) {
      this.deps.log(`[queue] task ${taskId} has no assigned house — marking failed`);
      setTaskStatus(db, taskId, "failed", "No house assigned");
      createExecutionEvent(db, { taskId, houseId: null, rawType: "task_failed", type: "task_failed", payload: { error: "No house assigned" } });
      return;
    }
    const house = getHouse(db, task.houseId);
    if (!house) {
      setTaskStatus(db, taskId, "failed", "Houses not found");
      return;
    }
    if (house.status !== "active") {
      // Skip disabled/archived houses — leave the task queued (will retry).
      this.deps.log(`[queue] house ${house.name} not active; leaving ${taskId} queued`);
      // We already claimed it; put it back to queued so it can be retried.
      setTaskStatus(db, taskId, "queued");
      return;
    }

    // Per-house concurrency: only one active execution session per house in P2.
    const hasActiveSession = getActiveSessionForHouse(db, house.id);
    if (this.houseBusy.has(house.id) || hasActiveSession) {
      setTaskStatus(db, taskId, "queued");
      return;
    }
    this.houseBusy.add(house.id);

    try {
      // High Lord house → route to the orchestrator (planning + delegation) instead
      // of the normal runner. The orchestrator bypasses resolveWorkspace (the HL
      // seed has an empty allowlist; the planning "workspace" is the chat).
      if (house.kind === "high_lord") {
        this.deps.log(`[queue] routing ${task.title} to the High Lord orchestrator`);
        const orchestratorDeps: OrchestratorDeps = {
          db,
          raw,
          adapter,
          client,
          log: this.deps.log,
        };
        await runParent(task, house, orchestratorDeps, { signal });
        return;
      }

      // Workspace safety: resolve + allowlist. resolveWorkspace sets the task
      // to failed/queued itself when it cannot run.
      const resolvedDir = this.resolveWorkspace(db, task, house);
      if (!resolvedDir) return;

      this.deps.log(`[queue] running task ${task.title} for house ${house.name} in ${resolvedDir}`);

      // Build the run context.
      const result = await executeTask(
        {
          db,
          raw,
          adapter,
          client,
          task,
          house,
          directory: resolvedDir,
          modelId: house.configuration.modelId,
        },
        { signal },
      );
      this.deps.log(`[queue] task ${task.title} → ${result.terminalStatus}`);
    } catch (err) {
      this.deps.log(`[queue] task ${task.title} errored: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.houseBusy.delete(house.id);
    }
  }

  /** Resolve + validate the working directory against the house allowlist.
   * Returns the real path, or null (with the task set to a state indicating block).
   */
  private resolveWorkspace(db: VelarisDb, task: TaskDto, house: HouseDto): string | null {
    const dir = task.workingDirectory;
    if (!dir) {
      // If the working directory is missing, try the house's first allowlist entry.
      const fallback = house.configuration.workspaceAllowlist[0];
      if (fallback && isPathAllowed(fallback, house.configuration.workspaceAllowlist)) {
        return resolveSafePath(fallback, house.configuration.workspaceAllowlist);
      }
      this.deps.log(`[queue] task ${task.title}: no working_directory and no valid allowlist entry`);
      setTaskStatus(db, task.id, "failed", "No working directory and no allowlist entry");
      return null;
    }

    if (house.configuration.workspaceAllowlist.length === 0) {
      // Plan §6 P2 enforcement: no allowlist → require approval before ANY execution.
      // We surface this as a blocked task + notification; the runner won't start.
      this.deps.log(`[queue] task ${task.title}: house has no workspace allowlist — blocked`);
      setTaskStatus(db, task.id, "failed", "House has no workspace allowlist; execution requires an allowlist entry");
      createExecutionEvent(db, {
        taskId: task.id,
        houseId: house.id,
        rawType: "task_failed",
        type: "task_failed",
        payload: { error: "No workspace allowlist configured" },
      });
      return null;
    }

    try {
      return resolveSafePath(dir, house.configuration.workspaceAllowlist);
    } catch (err) {
      this.deps.log(`[queue] task ${task.title}: path outside allowlist — ${err instanceof Error ? err.message : String(err)}`);
      setTaskStatus(db, task.id, "failed", `working_directory outside house allowlist: ${err instanceof Error ? err.message : String(err)}`);
      createExecutionEvent(db, {
        taskId: task.id,
        houseId: house.id,
        rawType: "task_failed",
        type: "task_failed",
        payload: { error: "working_directory outside allowlist" },
      });
      return null;
    }
  }

  async stop(): Promise<void> {
    if (this.loopTimer) clearTimeout(this.loopTimer);
    this.stopping = true;
    this.deps.log("[queue] task queue stopped");
  }
}
