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
import type { AgentExecutionProvider, ProviderKind } from "@/server/execution/types";
import { executeTask } from "@/server/execution/runner";
import { runOllamaTask } from "@/server/execution/ollama/runtime";
import { OpencodeClient } from "@/server/opencode";
import { OllamaClient } from "@/server/execution/ollama/client";
import type { HouseConfiguration, HouseDto, TaskDto } from "@/shared/types";
import { getHouse, resolveRuntimeAgent } from "@/server/repositories/house-repo";
import { getTask } from "@/server/repositories/task-repo";
import {
  listQueuedTaskIds,
  claimQueuedTask,
  setTaskStatus,
} from "@/server/repositories/task-repo";
import { createExecutionEvent, getActiveSessionForHouse } from "@/server/repositories/execution-repo";
import { resolveSafePath, isPathAllowed, worktreeRoot } from "@/lib/paths";
import { getWorktreeIsolationEnabled } from "@/server/repositories/provider-config-repo";
import { cleanupWorktree, resolveWorktree, type ResolvedWorktree } from "./worktree";
import { runParent, tickActivePlans } from "./orchestrator";
import type { OrchestratorDeps } from "./orchestrator";
import { providerHealth, resolveProviderKindForAgent } from "./provider-factory";

export interface QueueDeps {
  db: VelarisDb;
  raw: Database.Database;
  adapter: AgentExecutionProvider;
  client: OpencodeClient;
  /** Optional Ollama client — set when the engine owns one (Stage B+). */
  ollamaClient?: OllamaClient;
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
    // Per-tick provider health cache — probe each provider kind ONCE at the top
    // of the pass (mirroring the old single up-front OpenCode gate) so no
    // per-task await re-orders claim dispatch. A down OpenCode must not block an
    // Ollama house task, and vice-versa.
    const kinds: ProviderKind[] = ["opencode", "ollama"];
    const healthProbes = await Promise.all(
      kinds.map(async (k) => [k, await providerHealth(k, this.deps)] as const),
    );
    const healthCache = new Map<ProviderKind, boolean>(healthProbes);

    // 1. Find queued tasks.
    const queuedIds = listQueuedTaskIds(raw);

    for (const taskId of queuedIds) {
      if (this.stopping) break;
      if (this.inFlight.has(taskId)) continue;

      // 2. Per-task provider health gate BEFORE claim: leave the task queued and
      //    retry next tick when the task's own provider is unhealthy. This
      //    preserves the previous global OpenCode health-gate behaviour for
      //    OpenCode tasks while letting Ollama tasks through when only OpenCode
      //    is down.
      const task = getTask(db, taskId);
      if (!task || !task.houseId) {
        // Handled by runClaimedTask below; let it claim to surface the failure.
        if (!claimQueuedTask(raw, taskId)) continue;
      } else {
        const house = getHouse(db, task.houseId);
        if (house) {
          // Phase 6 Stage B: gate on the ROUTED agent's provider. With no
          // explicit task.agentId the default agent's config === house config,
          // so this is identical to the pre-multi-agent gate.
          const runtimeAgent = resolveRuntimeAgent(db, house.id, task);
          const kind = resolveProviderKindForAgent(runtimeAgent, house);
          if (healthCache.get(kind) === false) {
            this.deps.log(`[queue] ${kind} provider not healthy — leaving ${taskId} queued`);
            continue;
          }
        }
      }

      // Atomic claim.
      if (!claimQueuedTask(raw, taskId)) continue; // already taken

      this.inFlight.add(taskId);
      void this.runClaimedTask(taskId).finally(() => {
        this.inFlight.delete(taskId);
      });
    }

    // Supervisor pass: reconcile/advance active High Lord plans (mirror child
    // terminal states, release dependents, steer, budget, consolidate).
    //
    // OpenCode-dependent guard (pre-seam parity): `tickActivePlans` drives the
    // High Lord court, which depends on the OpenCode server (steering,
    // awaitSteerReply → client.getSession/listMessages). Restore the old
    // `if (!(await client.health())) return;` guarantee for the supervisor:
    // skip the ENTIRE supervisor pass when OpenCode is unhealthy so it does not
    // hammer the down server every tick. This does NOT affect per-task provider
    // dispatch above — an Ollama house task still proceeds when only OpenCode is
    // down (Stage A's point, preserved).
    const orchestratorDeps: OrchestratorDeps = {
      db,
      raw,
      adapter: this.deps.adapter,
      client: this.deps.client,
      log: this.deps.log,
    };
    if (healthCache.get("opencode") !== false) {
      await tickActivePlans(orchestratorDeps);
    }
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
      //
      // Phase 6 Stage B: an explicitly targeted agent (task.agentId) drives the
      // run's configuration; when null the house default (oldest agent) does.
      //
      // Phase 6.2 S3 (Q6): ALWAYS resolve the runtime agent — including default
      // runs — so `execution_sessions.agent_id` is populated for future runs and
      // per-agent cost rollups can attribute them. This does NOT change the run
      // config: `houseRowToDto` already sets `house.configuration` to the default
      // agent's configuration, so for a house WITH agents the resolved config is
      // the same object's values; for a house with ZERO agents
      // `resolveRuntimeAgent` still returns null → `runtimeConfig` stays
      // `house.configuration` and `runtimeAgentId` stays null (identical to
      // before). Historical nulls are intentionally NOT backfilled (Q6).
      const runtimeAgent = resolveRuntimeAgent(db, house.id, task);
      const runtimeConfig = runtimeAgent?.configuration ?? house.configuration;
      const runtimeAgentId = runtimeAgent?.id ?? null;
      const provider: ProviderKind = runtimeConfig.executionProvider;

      const resolvedDir = this.resolveWorkspace(db, task, house, runtimeConfig);
      if (!resolvedDir) return;

      // Phase 6.2 Stage S1.4/S1.5 — OpenCode worktree isolation (default OFF).
      // For every OpenCode run the flag check below costs one un-indexed
      // `provider_configs` SELECT (`getWorktreeIsolationEnabled`); the `&&`
      // short-circuit means Ollama runs skip it entirely. When the flag is OFF
      // the rest of the path is otherwise byte-identical to the pre-S1 engine.
      // The precise guarantee is: no worktree client call, no worktree event,
      // no session change.
      // When ON + OpenCode:
      //   1. `resolvedDir` above already validated the ORIGINAL task repo against
      //      the house allowlist ALONE (a task can never point at an arbitrary
      //      dir just because worktree mode is on).
      //   2. `resolveWorktree` ALWAYS creates a fresh worktree (Q3: a prior
      //      worktree is never reused — it may be dirty or belong to a different
      //      source repo after a task edit) bound to that source repo.
      //   3. The worktree dir is validated against the ONE documented exception:
      //      the house allowlist augmented with `worktreeRoot()` — and nothing
      //      else.
      // Any failure falls back to the normal resolved dir and emits an error
      // event; isolation is best-effort and must never fail the task.
      let runDirectory = resolvedDir;
      let worktree: ResolvedWorktree | null = null;
      const worktreeEnabled = provider === "opencode" && getWorktreeIsolationEnabled(raw);
      if (worktreeEnabled) {
        try {
          worktree = await resolveWorktree({
            client,
            task,
            sourceDirectory: resolvedDir,
            houseAllowlist: runtimeConfig.workspaceAllowlist,
          });
          // Validate the final run dir against the augmented allowlist (S1.5).
          resolveSafePath(worktree.directory, [...runtimeConfig.workspaceAllowlist, worktreeRoot()]);
          runDirectory = worktree.directory;
          this.deps.log(`[queue] task ${task.title} isolated in worktree ${worktree.directory}`);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          this.deps.log(`[queue] task ${task.title}: worktree isolation unavailable — using the resolved directory ${resolvedDir}: ${detail}`);
          createExecutionEvent(db, {
            taskId: task.id,
            houseId: house.id,
            rawType: "error",
            type: "error",
            payload: { error: "worktree isolation unavailable", detail },
          });
          worktree = null;
          runDirectory = resolvedDir;
        }
      }

      this.deps.log(`[queue] running task ${task.title} for house ${house.name} in ${runDirectory}`);

      // Provider dispatch: OpenCode routes through the existing runner; Ollama
      // routes to the native tool-loop runtime (Stage F). The OpenCode branch
      // here is byte-identical to the pre-seam code.
      if (provider === "ollama") {
        if (!this.deps.ollamaClient) {
          this.deps.log(`[queue] task ${task.title} for house ${house.name}: no Ollama client configured`);
          setTaskStatus(db, task.id, "failed", "No Ollama client configured");
          createExecutionEvent(db, {
            taskId: task.id,
            houseId: house.id,
            rawType: "task_failed",
            type: "task_failed",
            payload: { error: "No Ollama client configured" },
          });
          return;
        }
        this.deps.log(`[queue] routing ${task.title} to the Ollama tool-loop runtime`);
        const result = await runOllamaTask(
          {
            db,
            raw,
            ollama: this.deps.ollamaClient,
            task,
            house,
            agent: runtimeAgent,
            directory: resolvedDir,
            modelId: runtimeConfig.modelId,
          },
          { signal },
        );
        this.deps.log(`[queue] task ${task.title} → ${result.terminalStatus}`);
        return;
      }

      // Build the run context.
      const result = await executeTask(
        {
          db,
          raw,
          adapter,
          client,
          task,
          house,
          agent: runtimeAgent,
          agentId: runtimeAgentId,
          directory: runDirectory,
          modelId: runtimeConfig.modelId,
          worktreeDirectory: worktree?.directory ?? null,
          worktreeBranch: worktree?.branch ?? null,
        },
        { signal },
      );
      this.deps.log(`[queue] task ${task.title} → ${result.terminalStatus}`);

      // Terminal worktree cleanup (Q3). Chosen seam: the queue, right after the
      // runner has returned AND persisted the terminal session/task state. The
      // runner's `onTerminal` callback is synchronous and fires inside
      // `persistTerminalNow`, so it cannot await the provider calls; the queue
      // owns the client and the awaited result. Cleanup is best-effort: it logs
      // and swallows, and can never change the runner result.
      if (worktree) {
        await cleanupWorktree({
          db,
          client,
          sessionId: result.sessionId,
          directory: worktree.directory,
          terminalStatus: result.terminalStatus,
          log: this.deps.log,
        });
      }
    } catch (err) {
      this.deps.log(`[queue] task ${task.title} errored: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.houseBusy.delete(house.id);
    }
  }

  /** Resolve + validate the ORIGINAL task working directory against the ROUTED
   * agent's allowlist (defaults to the house configuration for single-agent
   * houses). Returns the real path, or null (with the task set to a state
   * indicating block).
   *
   * Phase 6.2 Stage S1.5: this validates the SOURCE repo only. When worktree
   * isolation is ON the worktree directory (under OpenCode's `worktreeRoot()`)
   * is validated separately against `[...allowlist, worktreeRoot()]`; that single
   * root is the ONE documented allowlist exception and never appears here.
   */
  private resolveWorkspace(
    db: VelarisDb,
    task: TaskDto,
    house: HouseDto,
    configuration: HouseConfiguration = house.configuration,
  ): string | null {
    const dir = task.workingDirectory;
    if (!dir) {
      // If the working directory is missing, try the agent's first allowlist entry.
      const fallback = configuration.workspaceAllowlist[0];
      if (fallback && isPathAllowed(fallback, configuration.workspaceAllowlist)) {
        return resolveSafePath(fallback, configuration.workspaceAllowlist);
      }
      this.deps.log(`[queue] task ${task.title}: no working_directory and no valid allowlist entry`);
      setTaskStatus(db, task.id, "failed", "No working directory and no allowlist entry");
      return null;
    }

    if (configuration.workspaceAllowlist.length === 0) {
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
      return resolveSafePath(dir, configuration.workspaceAllowlist);
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
