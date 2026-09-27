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
import { getHouse, listHouses, resolveRuntimeAgent } from "@/server/repositories/house-repo";
import { getTask } from "@/server/repositories/task-repo";
import {
  listQueuedTaskIds,
  claimQueuedTask,
  setTaskStatus,
  setTaskHouse,
} from "@/server/repositories/task-repo";
import {
  createExecutionEvent,
  createNotification,
  getActiveSessionForHouse,
} from "@/server/repositories/execution-repo";
import { resolveSafePath, isPathAllowed, worktreeRoot } from "@/lib/paths";
import {
  effectiveWorkspaceAllowlist,
  projectDirectoryForTask,
  WORKSPACE_UNREGISTERED_MESSAGE,
} from "@/server/repositories/workspace";
import { getWorktreeIsolationEnabled } from "@/server/repositories/provider-config-repo";
import {
  chooseQuestHouse,
  type RoutingReason,
} from "@/server/execution/planning/route-quest";
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

/**
 * Actionable message for a terminal routing failure (`houseId === null`).
 * The `no_directory` case has no directory at all, so it must NOT reuse the
 * workspace "register this directory" message.
 */
function routingFailureMessage(reason: RoutingReason): string {
  if (reason === "no_directory") {
    return "This quest has no working directory and no project directory — set one before the court can plan it.";
  }
  // "no_high_lord" (and any other terminal reason) — no eligible destination.
  return "No house can run this quest: create an active house or restore the High Lord.";
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

      // 2. Pre-claim routing: a house-less quest is resolved ONCE per tick,
      //    before the provider health gate and the atomic claim. Explicitly
      //    assigned quests are untouched. A re-homed quest then waits under the
      //    normal health gate below.
      let task = getTask(db, taskId);
      if (task && !task.houseId) {
        this.resolveUnassignedTask(task);
        task = getTask(db, taskId); // re-read: routing wrote house_id (or failed the task)
      }

      // 3. Per-task provider health gate BEFORE claim: leave the task queued and
      //    retry next tick when the task's own provider is unhealthy. This
      //    preserves the previous global OpenCode health-gate behaviour for
      //    OpenCode tasks while letting Ollama tasks through when only OpenCode
      //    is down.
      if (task && task.houseId) {
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

      // Atomic claim (exactly once).
      if (!claimQueuedTask(raw, taskId)) continue; // already taken or gone

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

  /**
   * Resolve a house-less quest before it is claimed: score the active agent
   * roster (with workspace-viability filtering) and either assign the winning
   * house, re-home the quest onto the High Lord, or terminally fail it with an
   * actionable message. Explicitly assigned quests never reach this method.
   *
   * Idempotent: under an unchanged roster the same decision is re-derived, but
   * this only runs while `house_id IS NULL`; once it writes a house (or fails
   * the task), subsequent ticks skip it.
   */
  private resolveUnassignedTask(task: TaskDto): void {
    const { db } = this.deps;
    const houses = listHouses(db, { includeHighLord: true });

    const effectiveAllowlists = new Map<string, string[]>();
    for (const h of houses) {
      effectiveAllowlists.set(h.id, effectiveWorkspaceAllowlist(db, h.configuration));
    }

    const decision = chooseQuestHouse(
      {
        title: task.title,
        type: task.type,
        description: task.description,
        workingDirectory: task.workingDirectory,
        projectDirectory: projectDirectoryForTask(db, task),
      },
      houses,
      effectiveAllowlists,
    );

    if (decision.houseId != null) {
      // Routed to an agent house, or escalated to the High Lord.
      setTaskHouse(db, task.id, decision.houseId);
      createExecutionEvent(db, {
        taskId: task.id,
        houseId: decision.houseId,
        rawType: "message",
        type: "message",
        payload: {
          routing: {
            houseId: decision.houseId,
            escalated: decision.escalated,
            reason: decision.reason,
            score: decision.score,
          },
        },
      });
      this.deps.log(
        decision.escalated
          ? `[queue] task ${task.id}: no meaningful match — escalated to the High Lord (${decision.reason})`
          : `[queue] task ${task.id}: routed to house ${decision.houseId} (score ${decision.score})`,
      );
      return;
    }

    // Terminal: no house can run this quest.
    const msg = routingFailureMessage(decision.reason);
    this.deps.log(`[queue] task ${task.id}: ${msg} (${decision.reason})`);
    setTaskStatus(db, task.id, "failed", msg);
    createExecutionEvent(db, {
      taskId: task.id,
      houseId: null,
      rawType: "task_failed",
      type: "task_failed",
      payload: {
        error: msg,
        routing: {
          houseId: null,
          escalated: decision.escalated,
          reason: decision.reason,
          score: decision.score,
        },
      },
    });
    createNotification(db, {
      type: "failure",
      houseId: null,
      taskId: task.id,
      title: `Quest routing failed: ${task.title}`,
      body: msg,
    });
  }

  /** Execute an already-claimed task. */
  private async runClaimedTask(taskId: string): Promise<void> {
    const { db, raw, adapter, client, signal } = this.deps;
    const task = getTask(db, taskId);
    if (!task) {
      setTaskStatus(db, taskId, "cancelled", "Task deleted while queued");
      return;
    }
    
    // Defensive fallback: pre-claim routing already resolves every house-less
    // quest, so this branch should be unreachable. Keep it as a guard with an
    // actionable message rather than re-introducing routing logic here.
    if (!task.houseId) {
      const msg = "Unassigned quest reached execution — routing did not assign a house";
      this.deps.log(`[queue] task ${taskId}: ${msg}`);
      setTaskStatus(db, taskId, "failed", msg);
      createExecutionEvent(db, { taskId, houseId: null, rawType: "task_failed", type: "task_failed", payload: { error: msg } });
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

      // Workspace resolution: one effective list per claim, threaded through
      // resolveWorkspace and the worktree calls so every gate agrees (empty house
      // allowlist = bounded by the project registry).
      const effectiveAllowlist = effectiveWorkspaceAllowlist(db, runtimeConfig);

      const resolvedDir = this.resolveWorkspace(db, task, house, runtimeConfig, effectiveAllowlist);
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
            houseAllowlist: effectiveAllowlist,
          });
          // Validate the final run dir against the augmented allowlist (S1.5).
          resolveSafePath(worktree.directory, [...effectiveAllowlist, worktreeRoot()]);
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

  /** Resolve + validate the ORIGINAL task working directory against the
   * ROUTED agent's EFFECTIVE allowlist (non-empty house allowlist verbatim;
   * otherwise the registered-project directories — defaults to the house
   * configuration for single-agent houses). Returns the real path, or null (with
   * the task set to failed + a `task_failed` event) when it cannot run.
   *
   * Decision table for `D` = `task.workingDirectory`:
   *  - `D` absent + non-empty allowlist → `allowlist[0]` fallback (unchanged).
   *  - `D` absent + empty allowlist     → fail with the actionable message
   *    (never arbitrarily pick the first registered project).
   *  - `D` present → `resolveSafePath(D, effective)`; on failure the message is
   *    the actionable one for an empty house allowlist, or the existing
   *    `working_directory outside house allowlist: …` for a non-empty one.
   *
   * This is the same effective rule the orchestrator uses in
   * `destinationHasUsableWorkspace`, so the two cannot disagree.
   *
   * Phase 6.2 Stage S1.5: this validates the SOURCE repo only. When worktree
   * isolation is ON the worktree directory (under OpenCode's `worktreeRoot()`)
   * is validated separately against `[...effectiveAllowlist, worktreeRoot()]`;
   * that single root is the ONE documented allowlist exception and never appears
   * here.
   */
  private resolveWorkspace(
    db: VelarisDb,
    task: TaskDto,
    house: HouseDto,
    configuration: HouseConfiguration = house.configuration,
    effectiveAllowlist: string[] = effectiveWorkspaceAllowlist(db, configuration),
  ): string | null {
    const emptyHouseAllowlist = configuration.workspaceAllowlist.length === 0;
    // D = the task's own working directory; when absent and the house has no
    // allowlist, fall back to the task's own project directory (never the first
    // registered project).
    const dir = task.workingDirectory ?? (emptyHouseAllowlist ? projectDirectoryForTask(db, task) : null);

    if (!dir) {
      // If the working directory is missing, try the agent's first allowlist entry.
      const fallback = effectiveAllowlist[0];
      if (!emptyHouseAllowlist && fallback && isPathAllowed(fallback, effectiveAllowlist)) {
        return resolveSafePath(fallback, effectiveAllowlist);
      }
      this.deps.log(`[queue] task ${task.title}: no working_directory and no valid allowlist entry`);
      if (emptyHouseAllowlist) {
        setTaskStatus(db, task.id, "failed", WORKSPACE_UNREGISTERED_MESSAGE);
        createExecutionEvent(db, {
          taskId: task.id,
          houseId: house.id,
          rawType: "task_failed",
          type: "task_failed",
          payload: { error: WORKSPACE_UNREGISTERED_MESSAGE },
        });
      } else {
        setTaskStatus(db, task.id, "failed", "No working directory and no allowlist entry");
      }
      return null;
    }

    try {
      return resolveSafePath(dir, effectiveAllowlist);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.deps.log(`[queue] task ${task.title}: path outside allowlist — ${detail}`);
      if (emptyHouseAllowlist) {
        setTaskStatus(db, task.id, "failed", WORKSPACE_UNREGISTERED_MESSAGE);
        createExecutionEvent(db, {
          taskId: task.id,
          houseId: house.id,
          rawType: "task_failed",
          type: "task_failed",
          payload: { error: WORKSPACE_UNREGISTERED_MESSAGE },
        });
      } else {
        // Byte-identical to the pre-effective-allowlist behavior for a non-empty
        // house allowlist.
        setTaskStatus(db, task.id, "failed", `working_directory outside house allowlist: ${detail}`);
        createExecutionEvent(db, {
          taskId: task.id,
          houseId: house.id,
          rawType: "task_failed",
          type: "task_failed",
          payload: { error: "working_directory outside allowlist" },
        });
      }
      return null;
    }
  }

  async stop(): Promise<void> {
    if (this.loopTimer) clearTimeout(this.loopTimer);
    this.stopping = true;
    this.deps.log("[queue] task queue stopped");
  }
}
