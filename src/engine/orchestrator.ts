/**
 * High Lord Orchestrator (Phase 4 — stage B).
 *
 * The orchestrator is the engine-side supervisor for a `kind === 'high_lord'`
 * house task. When the queue claims such a task it routes here via `runParent`
 * instead of the normal runner:
 *
 *   1. PLAN — run the planning session through the standard `executeTask`
 *      machinery (the High Lord house's editable systemPrompt is the planning
 *      persona; the roster + strict-JSON contract are staged into the parent
 *      description so executeTask composes the prompt for free). Extract JSON,
 *      validate, repair-retry once, else fallback to a single-subtask plan.
 *   2. PERSIST — create subtask + handoff rows for the parsed plan.
 *   3. DELEGATE — create child `tasks` rows (ordinary queued tasks the existing
 *      queue claims and runs via the untouched runner), link them to subtasks,
 *      respecting per-house concurrency (inherited) + per-directory
 *      serialization at the DAG level.
 *   4. SUPERVISE — each queue tick calls `tickActivePlans`, which mirrors child
 *      terminal states, retries failed subtasks (up to MAX_SUBTASK_RETRIES then
 *      abort via abortPlan), releases dependents, checks token budget, steers an
 *      active plan (addendum D2), and consolidates results when terminal.
 *
 * WRITE DISCIPLINE: engine-side; legal writer of execution_* rows, tasks rows
 * (create/status/prefs), subtasks and handoffs rows. Import boundaries: it may
 * import pure src/server/execution/planning/* and repos, but never Next/UI.
 */

import type Database from "better-sqlite3";
import { eq, inArray } from "drizzle-orm";
import type { VelarisDb } from "@/lib/db";
import type { AgentExecutionProvider } from "@/server/execution/types";
import { OpencodeClient } from "@/server/opencode";
import { executeTask } from "@/server/execution/runner";
import { getTask, setTaskStatus, createTask, updateTask, writeTaskPlanAbortReason } from "@/server/repositories/task-repo";
import { listHouses, findHighLordHouse } from "@/server/repositories/house-repo";
import {
  createSubtask,
  listSubtasksForParent,
  setSubtaskStatus,
  incrementSubtaskAttempt,
  linkChildTask,
  cancelSubtasksForParent,
} from "@/server/repositories/subtask-repo";
import { createHandoff, listHandoffsForSubtask } from "@/server/repositories/handoff-repo";
import {
  createExecutionEvent,
  createNotification,
  createArtifact,
  listSessionsForTask,
  listAgentMessagesForSession,
  listArtifactsForTask,
  findPendingUserMessage,
  markAgentMessageRelayed,
  setSessionStatus,
  getExecutionSession,
  getUsageSummaryForTask,
  upsertAgentMessage,
} from "@/server/repositories/execution-repo";
import { subtasks as subtasksTable } from "@/lib/db/schema";
import {
  extractPlanJson,
  validatePlan,
  buildFallbackPlan,
} from "@/server/execution/planning/parse";
import {
  composePlanningTaskPrompt,
  composeRepairPrompt,
  type RosterHouse,
} from "@/server/execution/planning/prompts";
import {
  normalizePlan,
  resolvePlan,
  type ResolvedPlan,
  type ResolvedSubtask,
} from "@/server/execution/planning/resolve-plan";
import {
  computePlanRevision,
  type RevisionMutation,
} from "@/server/execution/planning/apply-plan-revision";
import { ORCHESTRATION_DEFAULTS } from "@/shared/constants";
import type {
  HouseDto,
  TaskDto,
  SubtaskDto,
  SubtaskStatus,
  SessionStatus,
} from "@/shared/types";

export interface OrchestratorDeps {
  db: VelarisDb;
  raw: Database.Database;
  adapter: AgentExecutionProvider;
  client: OpencodeClient;
  log: (msg: string) => void;
  /** Injected clock (epoch ms) for deterministic tests. */
  now?: () => number;
  /** Quiet period (ms) for steering reply detection. */
  steerQuietMs?: number;
}

/* ------------------------------ helpers ---------------------------- */

function nowMs(deps: OrchestratorDeps): number {
  return deps.now ? deps.now() : Date.now();
}

function emitMessage(
  deps: OrchestratorDeps,
  parent: TaskDto,
  hl: HouseDto,
  payload: Record<string, unknown>,
): void {
  createExecutionEvent(deps.db, {
    taskId: parent.id,
    houseId: hl.id,
    rawType: "message",
    type: "message",
    payload,
  });
}

const TERMINAL_TASK = ["completed", "failed", "cancelled", "interrupted"] as const;
const ACTIVE_SESSION: SessionStatus[] = ["pending", "running", "awaiting_approval", "awaiting_input", "paused"];

function maxSubtasksFor(parent: TaskDto): number {
  const v = parent.executionPreferences?.maxSubtasks;
  return typeof v === "number" && v > 0 ? v : ORCHESTRATION_DEFAULTS.MAX_SUBTASKS;
}

function tokenBudgetFor(parent: TaskDto): number {
  const v = parent.executionPreferences?.tokenBudget;
  return typeof v === "number" && v > 0 ? v : ORCHESTRATION_DEFAULTS.PLAN_TOKEN_BUDGET;
}

function isTaskTerminal(s: string | null | undefined): boolean {
  return s == null || (TERMINAL_TASK as readonly string[]).includes(s as string);
}

/** Parent task ids with running plans (subtask rows in a non-terminal state). */
const PLAN_ACTIVE_STATUS: SubtaskStatus[] = ["planned", "ready", "delegated", "in_flight"];

function listActivePlanParentIds(db: VelarisDb): string[] {
  const rows = db
    .select({ pid: subtasksTable.parentTaskId, st: subtasksTable.status })
    .from(subtasksTable)
    .all();
  const pids = new Set<string>();
  for (const r of rows) {
    if ((PLAN_ACTIVE_STATUS as readonly string[]).includes(r.st as string)) {
      pids.add(r.pid);
    }
  }
  return Array.from(pids);
}

/* ------------------------------------------------------------------ */
/* runParent                                                          */
/* ------------------------------------------------------------------ */

export async function runParent(
  task: TaskDto,
  house: HouseDto,
  deps: OrchestratorDeps,
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  const { db, log } = deps;
  setTaskStatus(db, task.id, "running");
  createExecutionEvent(db, {
    taskId: task.id,
    houseId: house.id,
    rawType: "task_started",
    type: "task_started",
    payload: { title: task.title, planning: true },
  });
  log(`[orchestrator] planning parent task ${task.title}`);

  const roster = buildRoster(listHouses(db, { includeHighLord: true }), house.id);
  if (roster.length === 0) {
    failPlanning(deps, task, house, "No active execution houses exist — found (or create) an active house first");
    return;
  }

  const maxSubtasks = maxSubtasksFor(task);
  // Capture the ORIGINAL user instruction before the planning prompt is staged
  // into the description (M3): by fallback time the description has been
  // overwritten with the roster/constraints dump; buildFallbackPlan must pack
  // the user's real instruction, not the composed prompt.
  const originalInstruction = task.description || task.title;
  // Stage the planning prompt into the description before the first runner call.
  updateTask(db, task.id, {
    description: composePlanningTaskPrompt(task.description || task.title, roster, maxSubtasks),
  });
  let parent = getTask(db, task.id)!;

  // ---- Planning call #1. ----
  let run = await executeTask(
    {
      db,
      raw: deps.raw,
      adapter: deps.adapter,
      client: deps.client,
      task: parent,
      house,
      directory: planningDirectory(parent, house),
      modelId: house.configuration.modelId,
    },
    { signal: opts.signal },
  );
  // executeTask persists the parent terminal; the orchestrator keeps it running.
  setTaskStatus(db, task.id, "running");
  let sessionId = run.sessionId;
  let parsed = parsePlanFromSession(db, sessionId);
  const firstError = parsed.error;

  // ---- Repair retry (#2). ----
  if (!parsed.plan) {
    updateTask(db, task.id, {
      description: composeRepairPrompt(firstError ?? "could not parse plan JSON"),
    });
    run = await executeTask(
      {
        db,
        raw: deps.raw,
        adapter: deps.adapter,
        client: deps.client,
        task: getTask(db, task.id)!,
        house,
        directory: planningDirectory(getTask(db, task.id)!, house),
        modelId: house.configuration.modelId,
      },
      { signal: opts.signal },
    );
    setTaskStatus(db, task.id, "running");
    sessionId = run.sessionId;
    parsed = parsePlanFromSession(db, sessionId);
  }

  if (run.terminalStatus !== "completed") {
    failPlanning(deps, task, house, run.error ?? "Planning session failed");
    return;
  }

  // ---- Fallback single-subtask plan when repair is still unusable. ----
  let plan = parsed.plan;
  if (!plan) {
    plan = buildFallbackPlan({ title: task.title, description: originalInstruction });
    log(`[orchestrator] repair exhausted — single-subtask fallback`);
  }

  parent = getTask(db, task.id)!;
  const resolved = resolveForDelegation(deps, plan, maxSubtasks);
  if (!resolved) {
    failPlanning(deps, task, house, "No eligible destination houses — found an active house first");
    return;
  }

  await persistPlan(deps, parent, house, resolved);
  log(`[orchestrator] plan persisted with ${resolved.subtasks.length} subtasks`);
}

function buildRoster(houses: HouseDto[], hlHouseId: string): RosterHouse[] {
  return houses
    .filter((h) => h.status === "active" && h.kind === "agent" && h.id !== hlHouseId)
    .map((h) => ({
      id: h.id,
      name: h.name,
      description: h.description ?? "",
      agentRole: h.agent.role,
      model: h.configuration.modelId,
    }));
}

function planningDirectory(task: TaskDto, house: HouseDto): string {
  return task.workingDirectory ?? house.configuration.workspaceAllowlist[0] ?? "";
}

/** Parse the newest agent reply of a planning session into a validated Plan. */
function parsePlanFromSession(
  db: VelarisDb,
  sessionId: string,
): { plan?: ReturnType<typeof buildFallbackPlan>; error?: string } {
  const msgs = listAgentMessagesForSession(db, sessionId);
  const agent = [...msgs].reverse().find((m) => m.role === "agent");
  if (!agent) return { error: "no assistant reply" };
  const raw = extractPlanJson(agent.content);
  const res = validatePlan(raw);
  if (!res.ok || !res.plan) return { error: res.error ?? "invalid plan" };
  return { plan: res.plan };
}

/** Resolve the parsed plan to houses; null when no eligible agent house exists. */
function resolveForDelegation(
  deps: OrchestratorDeps,
  plan: ReturnType<typeof buildFallbackPlan>,
  maxSubtasks: number,
): ResolvedPlan | null {
  const houses = listHouses(deps.db, { includeHighLord: true }).filter(
    (h) => h.status === "active" && h.kind === "agent",
  );
  if (houses.length === 0) return null;
  return normalizePlan(plan, houses, maxSubtasks);
}

/** Persist subtask + handoff rows and the plan event. */
async function persistPlan(
  deps: OrchestratorDeps,
  parent: TaskDto,
  hl: HouseDto,
  resolved: ResolvedPlan,
): Promise<void> {
  const { db } = deps;
  const created: SubtaskDto[] = [];

  deps.db.transaction((tx) => {
    resolved.subtasks.forEach((st, idx) => {
      const sub = createSubtask(tx, {
        parentId: parent.id,
        planId: st.planId,
        orderIndex: idx,
        dependsOn: st.dependsOn,
        status: "planned",
        title: st.title,
        instructions: st.instructions,
        completionRequirements: st.completionRequirements,
      });
      createHandoff(tx, {
        parentTaskId: parent.id,
        subtaskId: sub.id,
        sourceHouseId: hl.id,
        destinationHouseId: st.houseId ?? "",
        instructions: st.instructions,
        context: st.context,
        artifacts: st.artifacts,
        completionRequirements: st.completionRequirements,
      });
      created.push(sub);
    });
  });

  emitMessage(deps, parent, hl, {
    plan: true,
    subtasks: resolved.subtasks.map((s) => ({
      planId: s.planId,
      title: s.title,
      house: s.houseId ? houseName(db, s.houseId) : null,
    })),
  });

  await delegateReadySubtasks(deps, parent, hl, created);
}

function houseName(db: VelarisDb, id: string): string | null {
  const h = listHouses(db, { includeHighLord: true }).find((x) => x.id === id);
  return h ? h.name : null;
}

function failPlanning(
  deps: OrchestratorDeps,
  task: TaskDto,
  house: HouseDto,
  reason: string,
): void {
  setTaskStatus(deps.db, task.id, "failed", reason);
  createExecutionEvent(deps.db, {
    taskId: task.id,
    houseId: house.id,
    rawType: "task_failed",
    type: "task_failed",
    payload: { error: reason, planning: true },
  });
  createNotification(deps.db, {
    type: "failure",
    houseId: house.id,
    taskId: task.id,
    title: `Planning failed: ${task.title}`,
    body: reason,
  });
}

/* ------------------------------------------------------------------ */
/* Delegation + DAG scheduling                                        */
/* ------------------------------------------------------------------ */

/**
 * Compute + act on the ready set among planned subtasks, delegating up to the
 * per-directory budget. Per-house concurrency is inherited from the queue (a
 * same-house pair is delegated anyway and serialized by the queue). Per-directory
 * serialization is enforced here: a ready subtask whose directory is already
 * occupied by a delegated/in-flight sibling is held at `ready`.
 */
async function delegateReadySubtasks(
  deps: OrchestratorDeps,
  parent: TaskDto,
  hl: HouseDto,
  subtasks: SubtaskDto[],
): Promise<boolean> {
  const byPlanId = new Map(subtasks.map((s) => [s.planId, s]));

  // Pre-populate directories occupied by subtasks already delegated / in flight
  // so per-directory serialization holds across ticks (plan §5.4.4).
  const busyDirs = new Set<string>();
  for (const s of subtasks) {
    const st = s.status as SubtaskStatus;
    if (st === "delegated" || st === "in_flight") {
      busyDirs.add(childExecutionDir(deps, parent, s));
    }
  }

  for (const s of subtasks) {
    const state = s.status as SubtaskStatus;
    if (state !== "planned" && state !== "ready") continue;

    // All deps terminal-completed?
    const depsMet =
      s.dependsOn.length === 0 ||
      s.dependsOn.every((pid) => {
        const dep = byPlanId.get(pid);
        return dep && dep.status === "completed";
      });
    if (!depsMet) {
      if (state === "ready") setSubtaskStatus(deps.db, s.id, "planned");
      continue;
    }

    const dir = childExecutionDir(deps, parent, s);
    if (busyDirs.has(dir)) {
      if (state === "planned") setSubtaskStatus(deps.db, s.id, "ready");
      continue;
    }

    const child = delegateSubtask(deps, parent, hl, s);
    if (child) {
      busyDirs.add(dir);
      emitMessage(deps, parent, hl, {
        subtask: s.planId,
        state: "delegated",
        house: child.houseId ?? null,
      });
    } else {
      // No eligible destination house — finalize deterministically (D4 abort).
      emitMessage(deps, parent, hl, { subtask: s.planId, state: "no_destination" });
      abortPlan(deps, parent, hl, "no_destination", listSubtasksForParent(deps.db, parent.id));
      return true;
    }
  }
  return false;
}

/**
 * The child's resolved execution directory — used as the per-directory
 * serialization key (§5.4.4) AND the child task's `workingDirectory`.
 *
 * The Court sets a single `workingDirectory` on the parent, but each child runs
 * in its DESTINATION house's own workspace. Two independent subtasks delegated
 * to two distinct houses with distinct workspaces MUST run concurrently; they
 * serialize only when they resolve to the SAME directory. The parent's
 * `workingDirectory` is used only when the child's destination house has no
 * workspace allowlist of its own (i.e. it genuinely executes in the parent dir).
 */
function childExecutionDir(deps: OrchestratorDeps, parent: TaskDto, subtask: SubtaskDto): string {
  const dest = destinationForSubtask(deps, subtask);
  const destWorkspace = dest?.configuration.workspaceAllowlist?.[0];
  if (destWorkspace) return destWorkspace;
  return parent.workingDirectory ?? "";
}

/**
 * Whether a destination house has a usable workspace to delegate into. A child
 * task whose destination has an empty allowlist can never pass the queue's
 * resolveWorkspace at claim time (it would fail → retry → abort), so it is
 * treated as unresolvable at delegation time. Mirrors the queue's `resolveWorkspace`
 * rule: no allowlist → execution is blocked (unless the parent provides a dir).
 */
function destinationHasUsableWorkspace(deps: OrchestratorDeps, parent: TaskDto, dest: HouseDto): boolean {
  // A destination with its own allowlist entry is always usable.
  if (dest.configuration.workspaceAllowlist.length > 0) return true;
  // Otherwise the child would inherit the parent's workingDirectory; that is
  // only usable if the parent actually carries one.
  return Boolean(parent.workingDirectory);
}

/** Create the child task row + link; returns the child task or null (no dest). */
function delegateSubtask(
  deps: OrchestratorDeps,
  parent: TaskDto,
  hl: HouseDto,
  subtask: SubtaskDto,
): TaskDto | null {
  const destination = destinationForSubtask(deps, subtask);
  if (!destination) {
    return null;
  }
  // M2: a destination with no usable workspace can never run — the queue would
  // fail it at claim time. Treat it as unresolvable / deterministic fail-abort
  // rather than delegating a child that is doomed to hang/retry/abort.
  if (!destinationHasUsableWorkspace(deps, parent, destination)) {
    return null;
  }

  const child = createTask(deps.db, {
    title: subtask.title,
    description: composeChildDescription(parent, subtask),
    type: "general",
    priority: parent.priority,
    houseId: destination.id,
    projectId: parent.projectId,
    workingDirectory: childExecutionDir(deps, parent, subtask),
    executionPreferences: { parentTaskId: parent.id },
  });

  linkChildTask(deps.db, subtask.id, child.id);
  setSubtaskStatus(deps.db, subtask.id, "delegated");
  void hl;
  return child;
}

/** Resolve the destination house for a subtask from its handoff row. */
function destinationForSubtask(deps: OrchestratorDeps, subtask: SubtaskDto): HouseDto | null {
  const handoffs = listHandoffsForSubtask(deps.db, subtask.id);
  const destId = handoffs[0]?.destinationHouseId;
  if (!destId) return null;
  const h = listHouses(deps.db, { includeHighLord: true }).find((x) => x.id === destId);
  return h && h.status === "active" && h.kind === "agent" ? h : null;
}

function composeChildDescription(parent: TaskDto, subtask: SubtaskDto): string {
  const parts: string[] = [];
  if (subtask.title) parts.push(`Title: ${subtask.title}`);
  if (subtask.instructions) parts.push(`Instructions:\n${subtask.instructions}`);
  if (subtask.completionRequirements) parts.push(`Completion requirements:\n${subtask.completionRequirements}`);
  parts.push(`This is subtask ${subtask.planId} of parent quest "${parent.title}".`);
  return parts.join("\n\n");
}

/* ------------------------------------------------------------------ */
/* tickActivePlans                                                    */
/* ------------------------------------------------------------------ */

export async function tickActivePlans(deps: OrchestratorDeps): Promise<void> {
  const { db } = deps;
  const hl = findHighLordHouse(db);
  if (!hl) return;

  const parentIds = listActivePlanParentIds(db);
  for (const pid of parentIds) {
    const parent = getTask(db, pid);
    if (!parent) continue;
    if ((TERMINAL_TASK as readonly string[]).includes(parent.status as string)) continue;

    const subtasks = listSubtasksForParent(db, pid);
    if (subtasks.length === 0) continue;

    // 1. Steering pump (may mutate session/subtask rows).
    await handleSteering(deps, parent, hl, subtasks);

    // 2. Mirror child terminal states + retry/abort.
    const aborted = await mirrorChildren(deps, parent, hl, listSubtasksForParent(db, pid));
    if (aborted) continue;

    const afterMirror = listSubtasksForParent(db, pid);

    // 3. Release dependents + delegate ready subtasks. An abort signal from a
    //    no-destination subtask stops this parent (parent already failed).
    const abortedDuringDelegate = await delegateReadySubtasks(deps, parent, hl, afterMirror);
    if (abortedDuringDelegate) continue;

    // 4. Budget check. Guard: a fully-completed plan must consolidate as
    //    `completed` (D4), never be aborted — so skip the budget abort when every
    //    subtask is already terminal. Budget aborts only stop NON-terminal work.
    const final = listSubtasksForParent(db, pid);
    const terminal = allTerminal(final);
    if (!terminal) {
      const budget = tokenBudgetFor(parent);
      const usage = getUsageSummaryForTask(db, pid);
      if (usage.inputTokens + usage.outputTokens > budget) {
        emitMessage(deps, parent, hl, { budget: true, reason: "token_budget_exceeded" });
        abortPlan(deps, parent, hl, "token_budget_exceeded", listSubtasksForParent(db, pid));
        continue;
      }
    }

    // 5. Terminal → consolidate.
    if (terminal) {
      await consolidate(deps, parent, hl, final, latestSessionId(db, pid));
    }
  }
}

/** Mirror child terminal states; re-delegate failed subtasks or abort. */
async function mirrorChildren(
  deps: OrchestratorDeps,
  parent: TaskDto,
  hl: HouseDto,
  subtasks: SubtaskDto[],
): Promise<boolean> {
  for (const s of subtasks) {
    const state = s.status as SubtaskStatus;
    if (state !== "delegated" && state !== "in_flight") continue;
    if (!s.taskId) continue;

    const child = getTask(deps.db, s.taskId);
    if (!child) continue;

    // Mirror: child actively running/awaiting → subtask in_flight.
    if (
      child.status === "running" ||
      child.status === "awaiting_approval" ||
      child.status === "awaiting_input" ||
      child.status === "paused"
    ) {
      if (state !== "in_flight") setSubtaskStatus(deps.db, s.id, "in_flight");
      continue;
    }

    if (child.status === "completed") {
      setSubtaskStatus(deps.db, s.id, "completed");
      emitMessage(deps, parent, hl, {
        subtask: s.planId,
        state: "completed",
        house: child.houseId ?? null,
      });
      continue;
    }

    const childFailed =
      child.status === "failed" || child.status === "cancelled" || child.status === "interrupted";
    if (childFailed) {
      const attempts = incrementSubtaskAttempt(deps.db, s.id);
      emitMessage(deps, parent, hl, { subtask: s.planId, state: `failed_attempt_${attempts}` });
      if (attempts <= ORCHESTRATION_DEFAULTS.MAX_SUBTASK_RETRIES) {
        // Re-delegate a fresh child (subtask re-pointed; old child stays history).
        setSubtaskStatus(deps.db, s.id, "planned");
        const after = listSubtasksForParent(deps.db, parent.id).find((x) => x.id === s.id);
        if (after) {
          const child2 = delegateSubtask(deps, parent, hl, after);
          if (child2) {
            emitMessage(deps, parent, hl, { subtask: s.planId, state: "retrying" });
          } else {
            // Destination became unresolvable mid-plan — abort deterministically.
            emitMessage(deps, parent, hl, { subtask: s.planId, state: "no_destination" });
            abortPlan(deps, parent, hl, "no_destination", listSubtasksForParent(deps.db, parent.id));
            return true;
          }
        }
      } else {
        // Retries exhausted → abort the plan.
        abortPlan(deps, parent, hl, "retries_exhausted", listSubtasksForParent(deps.db, parent.id));
        return true;
      }
    }
  }
  return false;
}

function allTerminal(subtasks: SubtaskDto[]): boolean {
  return (
    subtasks.length > 0 &&
    subtasks.every((s) =>
      ["completed", "cancelled", "failed"].includes(s.status as SubtaskStatus),
    )
  );
}

function latestSessionId(db: VelarisDb, taskId: string): string | null {
  const sessions = listSessionsForTask(db, taskId);
  return sessions.length ? sessions[sessions.length - 1].id : null;
}

/* ------------------------------------------------------------------ */
/* Steering (addendum D2c)                                           */
/* ------------------------------------------------------------------ */

async function handleSteering(
  deps: OrchestratorDeps,
  parent: TaskDto,
  hl: HouseDto,
  subtasks: SubtaskDto[],
): Promise<void> {
  const sessionId = latestSessionId(deps.db, parent.id);
  if (!sessionId) return;
  const session = getExecutionSession(deps.db, sessionId);
  if (!session) return;

  const pending = findPendingUserMessage(deps.raw, sessionId, null);
  const isSteeringBusy = session.status === "running";

  // (a) Relay a pending user message into the (terminal or quiet) planning
  //     session; flip it to `running` for the steer exchange.
  if (pending && !isSteeringBusy) {
    if (!session.providerSessionId) return;
    setSessionStatus(deps.db, sessionId, "running");
    try {
      await deps.adapter.sendMessage({
        sessionId,
        providerSessionId: session.providerSessionId,
        aiProvider: hl.configuration.aiProvider,
        modelId: hl.configuration.modelId,
        message: pending.content,
      });
      markAgentMessageRelayed(deps.db, pending.id);
    } catch {
      // Un-relayed row stays for retry next tick.
    }
    return;
  }

  // (b) Steer in flight: wait for quiet, then parse reply → revision or
  //     informational, and flip the session back to `completed`.
  if (isSteeringBusy && session.providerSessionId) {
    const reply = await awaitSteerReply(deps, sessionId, session.providerSessionId);
    if (!reply) return; // not quiet yet, keep session running

    const raw = extractPlanJson(reply.content);
    const res = validatePlan(raw);
    if (res.ok && res.plan) {
      applyRevision(deps, parent, hl, subtasks, res.plan);
    } else {
      // Informational only — no DAG change.
      emitMessage(deps, parent, hl, { plan: false, steer: true });
    }
    setSessionStatus(deps.db, sessionId, "completed");
  }
}

/**
 * Poll the provider session until quiet, INGESTING the steering reply as a new
 * `role='agent'` agent_messages row so the orchestrator parses the fresh reply
 * rather than the original plan JSON.
 *
 * Flow:
 *  1. getSession until its last-activity timestamp is older than `steerQuietMs`
 *     (the runner's quiet heuristic).
 *  2. Once quiet, call the OpenCode client's `listMessages(providerSessionId)`
 *     to fetch the transcript.
 *  3. Persist the newest assistant text that is NOT already stored (dedupe by
 *     provider message id via `upsertAgentMessage`, falling back to a content
 *     sentinel if a message lacks an id).
 *  4. Return the freshly persisted reply text.
 *
 * Returns null while the steer is still active or nothing ingestible arrived.
 */
async function awaitSteerReply(
  deps: OrchestratorDeps,
  sessionId: string,
  providerSessionId: string,
): Promise<{ content: string } | null> {
  let live: { time?: { updated?: number }; id?: string } | null = null;
  try {
    live = (await deps.client.getSession(providerSessionId)) as unknown as {
      time?: { updated?: number };
      id?: string;
    };
  } catch {
    return null;
  }
  if (!live || !live.id || !live.time?.updated) return null;

  const quietMs = deps.steerQuietMs ?? 10_000;
  if (nowMs(deps) - live.time.updated < quietMs) return null; // still active

  // Ingest the provider's transcript for this session as new assistant rows.
  let messages: Array<{ id?: string; text: string }> = [];
  try {
    messages = (await deps.client.listMessages(providerSessionId)) as Array<{
      id?: string;
      text: string;
    }>;
  } catch {
    // listMessages failed — nothing ingestible; keep session running for retry.
    return null;
  }
  if (!messages.length) return null;

  for (const m of messages) {
    upsertAgentMessage(deps.db, {
      sessionId,
      role: "agent",
      content: m.text,
      providerMessageId: m.id ?? null,
    });
  }

  const msgs = listAgentMessagesForSession(deps.db, sessionId);
  const agent = [...msgs].reverse().find((m) => m.role === "agent");
  return agent ? { content: agent.content } : null;
}

function applyRevision(
  deps: OrchestratorDeps,
  parent: TaskDto,
  hl: HouseDto,
  current: SubtaskDto[],
  revision: ReturnType<typeof buildFallbackPlan>,
): void {
  const { db } = deps;
  const rev = computePlanRevision(current, revision);

  let skippedCreates = 0;
  deps.db.transaction((tx) => {
    for (const m of rev.mutations) {
      if (!applyMutation(deps, tx, parent, hl, m)) skippedCreates += 1;
    }
  });

  // A create-mutation whose destination could not be resolved was skipped —
  // never create an undelegatable subtask. Surface as an informational steer
  // event so the Court can reason about it; the plan continues unaffected.
  if (skippedCreates > 0) {
    emitMessage(deps, parent, hl, {
      plan: false,
      steer: true,
      note: `${skippedCreates} new subtask(s) could not be created — no eligible execution house`,
    });
  }

  emitMessage(deps, parent, hl, {
    plan: true,
    revision: true,
    added: rev.added,
    cancelled: rev.cancelled,
    changed: rev.changed,
  });
}

/** Apply a single revision mutation inside the plan's transaction. Returns
 * false when a create-mutation was skipped (no resolvable destination house). */
function applyMutation(
  deps: OrchestratorDeps,
  tx: VelarisDb,
  parent: TaskDto,
  hl: HouseDto,
  m: RevisionMutation,
): boolean {
  const existing = listSubtasksForParent(tx, parent.id);

  if (m.kind === "cancel") {
    setSubtaskStatus(tx, m.id, "cancelled");
    return true;
  }

  if (m.kind === "create") {
    const depends = (m.dependsOn ?? []).filter((d) => depExists(existing, d));
    // Resolve a destination BEFORE creating the subtask — the normal persist
    // path (persistPlan) creates a handoff so `destinationForSubtask` resolves it
    // at delegation time; a revision-created subtask must do the same. If no
    // active agent house can be resolved, do NOT create a subtask that can never
    // be delegated — return false and the caller surfaces an informational steer
    // event. Never create an undelegatable subtask (plan aborts/stalls).
    const resolved = resolveDestinationForPlanSubtask(deps, m);
    if (!resolved) return false;

    const sub = createSubtask(tx, {
      parentId: parent.id,
      planId: m.planId,
      orderIndex: m.orderIndex ?? existing.length,
      dependsOn: depends,
      status: "planned",
      title: m.title,
      instructions: m.instructions ?? "",
      completionRequirements: m.completionRequirements ?? "",
    });
    createHandoff(tx, {
      parentTaskId: parent.id,
      subtaskId: sub.id,
      sourceHouseId: hl.id,
      destinationHouseId: resolved.id,
      instructions: m.instructions ?? "",
      context: m.context ?? {},
      artifacts: m.artifacts ?? [],
      completionRequirements: m.completionRequirements ?? "",
    });
    return true;
  }

  // rewrite — only applies while still planned/ready (advisory otherwise).
  const cur = existing.find((s) => s.id === m.id);
  if (!cur) return true;
  if (cur.status !== "planned" && cur.status !== "ready") return true;

  const depends = (m.dependsOn ?? []).filter((d) => depExists(existing, d));
  // The subtask repo exposes no field updater; do a targeted engine-owned write.
  tx.update(subtasksTable)
    .set({
      title: m.title,
      instructions: m.instructions ?? "",
      completionRequirements: m.completionRequirements ?? "",
      dependsOn: JSON.stringify(depends),
      orderIndex: m.orderIndex ?? cur.orderIndex,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(subtasksTable.id, m.id))
    .run();
  void deps;
  return true;
}

/**
 * Resolve a destination house for a single plan subtask, mirroring the
 * resolution `resolve-plan` performs for a full plan (explicit houseId → hint
 * scoring → first active agent house fallback). Returns null when no active
 * agent house exists at all.
 */
function resolveDestinationForPlanSubtask(
  deps: OrchestratorDeps,
  m: RevisionMutation,
): HouseDto | null {
  const houses = listHouses(deps.db, { includeHighLord: true }).filter(
    (h) => h.status === "active" && h.kind === "agent",
  );
  if (houses.length === 0) return null;

  // Reuse the plan resolver for a single-subtask pseudo-plan to get identical
  // scoring/fallback semantics as the normal persist path.
  const plan = {
    subtasks: [
      {
        id: m.planId,
        title: m.title,
        description: m.description ?? "",
        type: m.type ?? "general",
        houseId: m.houseId ?? null,
        houseHints: "", // revision carries no hints; score by title/type
        dependsOn: m.dependsOn ?? [],
        instructions: m.instructions ?? "",
        context: m.context ?? {},
        artifacts: m.artifacts ?? [],
        completionRequirements: m.completionRequirements ?? "",
      },
    ],
  } as never;
  const resolved = resolvePlan(plan, houses);
  const houseId = resolved.subtasks[0]?.houseId;
  return houseId ? houses.find((h) => h.id === houseId) ?? null : null;
}

function depExists(subtasks: SubtaskDto[], planId: string): boolean {
  return subtasks.some(
    (s) => s.planId === planId || s.title.trim().toLowerCase() === planId.trim().toLowerCase(),
  );
}

/* ------------------------------------------------------------------ */
/* Abort + consolidate                                               */
/* ------------------------------------------------------------------ */

export function abortPlan(
  deps: OrchestratorDeps,
  parent: TaskDto,
  hl: HouseDto,
  reason: string,
  subtasks: SubtaskDto[],
): void {
  const { db } = deps;

  // 1. Cancel non-terminal children + abort their active sessions.
  for (const s of subtasks) {
    if (!s.taskId) continue;
    const child = getTask(db, s.taskId);
    if (!child || isTaskTerminal(child.status)) continue;
    setTaskStatus(db, child.id, "cancelled", `Plan aborted: ${reason}`);
    for (const sess of listSessionsForTask(db, child.id)) {
      if ((ACTIVE_SESSION as readonly SessionStatus[]).includes(sess.status)) {
        setSessionStatus(db, sess.id, "aborted");
      }
    }
  }

  // 2. Subtask rows → cancelled.
  cancelSubtasksForParent(db, parent.id);

  // 3. Parent failed + abortReason persisted.
  setTaskStatus(db, parent.id, "failed", `Plan aborted: ${reason}`);
  writeAbortReason(db, parent.id, reason);

  createExecutionEvent(db, {
    taskId: parent.id,
    houseId: hl.id,
    rawType: "task_failed",
    type: "task_failed",
    payload: { aborted: true, reason },
  });
  createNotification(db, {
    type: "failure",
    houseId: hl.id,
    taskId: parent.id,
    title: `Plan aborted: ${parent.title}`,
    body: describeAbortReason(reason),
  });

  // 4. Partial consolidation for completed children.
  partialConsolidate(deps, parent, hl, subtasks);
}

function describeAbortReason(reason: string): string {
  switch (reason) {
    case "retries_exhausted":
      return "A subtask failed 3 times — the plan collapsed.";
    case "token_budget_exceeded":
      return "The token treasury ran dry — the plan was aborted.";
    default:
      return `Plan aborted (${reason}).`;
  }
}

/** Record the abort reason block in tasks.execution_preferences.plan (D4c). */
function writeAbortReason(db: VelarisDb, taskId: string, reason: string): void {
  writeTaskPlanAbortReason(db, taskId, { abortReason: reason, abortedAt: new Date().toISOString() });
}

/** Consolidate on terminal success: result + diff rollup + parent completed.
 *
 * Under the D4 abort model the parent only reaches `consolidate` while it is
 * still `running` and every subtask is terminal — and any abort (retries/budget/
 * no-destination/user-cancel) flips the parent to `failed` FIRST. A `failed`
 * subtask reaching here is therefore impossible: it would have triggered
 * `abortPlan` already. We never emit a parent `failed` from here.
 */
async function consolidate(
  deps: OrchestratorDeps,
  parent: TaskDto,
  hl: HouseDto,
  subtasks: SubtaskDto[],
  sessionId: string | null,
): Promise<void> {
  const { db } = deps;

  const sid = sessionId ?? latestSessionId(db, parent.id);
  if (sid) {
    createArtifact(db, {
      sessionId: sid,
      taskId: parent.id,
      kind: "result",
      content: composeConsolidationSummary(subtasks),
    });
    rollupDiffArtifacts(db, sid, parent.id, subtasks);
  }

  setTaskStatus(db, parent.id, "completed");
  createExecutionEvent(db, {
    taskId: parent.id,
    houseId: hl.id,
    rawType: "task_completed",
    type: "task_completed",
    payload: {},
  });
  createNotification(db, {
    type: "completion",
    houseId: hl.id,
    taskId: parent.id,
    title: `Quest complete: ${parent.title}`,
    body: `All ${subtasks.length} subtasks completed.`,
  });
}

function composeConsolidationSummary(subtasks: SubtaskDto[]): string {
  const lines = subtasks
    .filter((s) => s.status === "completed")
    .map((s) => `- ${s.title}${s.childTaskStatus ? ` (${s.childTaskStatus})` : ""}`);
  return lines.length
    ? `The quest is complete.\n\nCompleted subtasks:\n${lines.join("\n")}`
    : "The quest is complete.";
}

function rollupDiffArtifacts(
  db: VelarisDb,
  sessionId: string,
  parentId: string,
  subtasks: SubtaskDto[],
): void {
  const sections: string[] = [];
  for (const s of subtasks) {
    if (s.status !== "completed" || !s.taskId) continue;
    const diffs = listArtifactsForTask(db, s.taskId).filter((a) => a.kind === "diff");
    if (!diffs.length) continue;
    sections.push(
      `## Subtask ${s.planId} — ${s.title}\n${diffs.map((d) => d.content).join("\n---\n")}`,
    );
  }
  if (sections.length && sessionId) {
    createArtifact(db, { sessionId, taskId: parentId, kind: "diff", content: sections.join("\n") });
  }
}

function partialConsolidate(
  deps: OrchestratorDeps,
  parent: TaskDto,
  hl: HouseDto,
  subtasks: SubtaskDto[],
): void {
  const sid = latestSessionId(deps.db, parent.id);
  if (!sid) return;
  const done = subtasks.filter((s) => s.status === "completed");
  const body = [
    "The plan did not fully complete.",
    "",
    `Completed subtasks (${done.length}/${subtasks.length}):`,
    ...done.map((s) => `- ${s.title}`),
  ].join("\n");
  createArtifact(deps.db, { sessionId: sid, taskId: parent.id, kind: "result", content: body });
  rollupDiffArtifacts(deps.db, sid, parent.id, done);
  void hl;
}
