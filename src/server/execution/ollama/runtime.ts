/**
 * Ollama tool-loop runtime — runOllamaTask (Phase 5 Stage F).
 *
 * The engine-side agent loop for `executionProvider='ollama'` houses:
 *   persist session → loop { call model → tool_calls → permission-gate →
 *   execute → tool_result → repeat } → final answer → terminal.
 *
 * Runs IN THE ENGINE (single-writer for execution tables). The web process
 * never calls this.
 *
 * Design points:
 *  - Every turn is persisted to `agent_messages` BEFORE the next model call
 *    (crash-recoverable).
 *  - Permission gating reuses the existing approval_requests + notifications
 *    pipeline; the loop polls the DB for the user's reply (same pattern as the
 *    OpenCode runner). Synthetic provider_request_id `ollama:<session>:<call>`
 *    dedupes retries via the UNIQUE constraint.
 *  - Hard caps (plan §17 risk 3): step cap, wall-clock timeout (2h mirroring the
 *    runner), per-session token cap → breach = failed + a clear event.
 *  - Huge tool results truncated on persist (risk 8).
 */

import type Database from "better-sqlite3";
import type { VelarisDb } from "@/lib/db";
import type { HouseAgentDto, HouseConfiguration, HouseDto, TaskDto } from "@/shared/types";
import type { OllamaClient } from "./client";
import type { OllamaTool } from "./tools/types";
import type { OllamaChatResponse } from "./types";
import type { TerminalStatus } from "@/server/execution/runner";
import { resolveSafePath } from "@/lib/paths";
import { buildToolRegistry, toOllamaToolDefs } from "./tools/registry";
import { gateToolCall, shouldAutoExecute, type GateDecision } from "./tools/permissions";
import { buildOllamaMessages, persistAssistantTurn } from "./memory";
import { resolveWriteTarget } from "./tools/fs";
import { toolCallIdFor } from "./tools/types";
import {
  createExecutionEvent,
  createExecutionSession,
  upsertAgentMessage,
  createApprovalRequest,
  createNotification,
  createUsageRecord,
  setSessionStatus,
  getExecutionSession,
  listSessionsForTask,
  listRespondedApprovalsForSession,
  cancelPendingApprovalsForSession,
  createArtifact,
  markApprovalRelayed,
  findPendingUserMessage,
  markAgentMessageRelayed,
} from "@/server/repositories/execution-repo";
import { setTaskStatus, getTask } from "@/server/repositories/task-repo";
import { listProviderConfigs } from "@/server/repositories/provider-config-repo";
import { parsePricing, estimateCost, type ModelPricing } from "./pricing";

/** Loop safeguards (plan §17 risk 3) — OLLAMA_DEFAULTS. */
export const OLLAMA_DEFAULTS = {
  MAX_TOOL_STEPS: 20,
  TIMEOUT_MS: 2 * 60 * 60 * 1000, // mirror the OpenCode runner's 2h wall-clock
  TOKEN_BUDGET: 200_000, // per-session token cap
  MAX_TOOL_OUTPUT: 16_000, // persisted tool-result cap (truncate + note)
  POLL_MS: 1500,
} as const;

export interface OllamaRunContext {
  db: VelarisDb;
  raw: Database.Database;
  ollama: OllamaClient;
  task: TaskDto;
  house: HouseDto;
  /**
   * Phase 6 Stage B routed agent (present only for an explicit non-default
   * target). Its configuration drives the loop; absent ⇒ house configuration as
   * before (single-agent path unchanged).
   */
  agent?: HouseAgentDto | null;
  directory: string;
  modelId: string;
  log?: (msg: string) => void;
}

export interface OllamaRunOptions {
  pollMs?: number;
  timeoutMs?: number;
  maxToolSteps?: number;
  tokenBudget?: number;
  maxToolOutput?: number;
  signal?: AbortSignal;
  onTerminal?: (result: OllamaRunResult) => void;
}

export interface OllamaRunResult {
  sessionId: string;
  terminalStatus: TerminalStatus;
  error?: string | null;
}

interface TokenTotals { input: number; output: number; total: number }

export async function runOllamaTask(
  ctx: OllamaRunContext,
  opts: OllamaRunOptions = {},
): Promise<OllamaRunResult> {
  const { db, raw, ollama, task, house, directory, modelId } = ctx;
  // Phase 6 Stage B: routed agent config when present; otherwise the same house
  // configuration object as before (single-agent path unchanged).
  const configuration: HouseConfiguration = ctx.agent?.configuration ?? house.configuration;
  const agentId: string | null = ctx.agent?.id ?? null;
  const pollMs = opts.pollMs ?? OLLAMA_DEFAULTS.POLL_MS;
  const timeoutMs = opts.timeoutMs ?? OLLAMA_DEFAULTS.TIMEOUT_MS;
  const maxToolSteps = opts.maxToolSteps ?? OLLAMA_DEFAULTS.MAX_TOOL_STEPS;
  const tokenBudget = opts.tokenBudget ?? OLLAMA_DEFAULTS.TOKEN_BUDGET;
  const maxToolOutput = opts.maxToolOutput ?? OLLAMA_DEFAULTS.MAX_TOOL_OUTPUT;
  const signal = opts.signal;
  const startedAt = Date.now();

  const registry = buildToolRegistry(configuration);
  const toolMap: Map<string, OllamaTool> = new Map(registry.map((t) => [t.name, t]));
  const toolDefs = toOllamaToolDefs(registry);
  const allowlist = configuration.workspaceAllowlist;

  const taskPrompt = composeTaskPrompt(task);

  // ---------- Session + task bootstrap (crash-recoverable) ----------
  //
  // Phase 5 M3 resume/recovery: if this task already has an existing
  // non-terminal Ollama session (paused / running / awaiting_* — left over from a
  // pause or an engine restart), CONTINUE it in place by rebuilding the agent
  // context from persisted `agent_messages` instead of starting a fresh session.
  // This is how the resume route's "continue in place" doc becomes true across
  // an engine restart, and how a user-paused task is not silently re-executed.
  //
  // We deliberately reuse the last candidate session rather than creating a new
  // one. A fresh task (no existing session) falls through to a brand-new session.
  const existingSession =
    listSessionsForTask(db, task.id).find((s) => s.provider === "ollama" && isResumableSessionStatus(s.status)) ?? null;

  const isFreshRun = existingSession === null;
  const sessionId = isFreshRun ? createExecutionSession(db, {
    taskId: task.id,
    houseId: house.id,
    agentId,
    provider: "ollama",
    modelId,
    directory,
  }).id : existingSession.id;

  if (isFreshRun) {
    createExecutionEvent(db, {
      sessionId,
      taskId: task.id,
      houseId: house.id,
      rawType: "task_started",
      type: "task_started",
      payload: { title: task.title },
    });
    createExecutionEvent(db, {
      sessionId,
      taskId: task.id,
      houseId: house.id,
      rawType: "session_started",
      type: "session_started",
      payload: { provider: "ollama", resumed: false },
    });
    // Persist the initial user brief so memory rebuilds are stable.
    upsertAgentMessage(db, { sessionId, role: "user", content: taskPrompt });
  } else {
    // Resumed run: keep the existing memory. Emit an informational message event
    // so the activity feed reflects the in-place continuation (the queue's
    // houseBusy guard ensures only one runner claims this task at a time).
    createExecutionEvent(db, {
      sessionId,
      taskId: task.id,
      houseId: house.id,
      rawType: "session_started",
      type: "session_started",
      payload: { provider: "ollama", resumed: true },
    });
  }

  setTaskStatus(db, task.id, "running");
  setSessionStatus(db, sessionId, "running");

  const fileTouched = new Set<string>();
  const tokenTotals: TokenTotals = { input: 0, output: 0, total: 0 };
  // Stage H: pricing table from the default Ollama provider config's `extra`
  // (seeded empty — unknown local pricing). `estimated` is always true for Ollama.
  const pricing: Record<string, ModelPricing> = loadModelPricing(db);
  let stepCount = 0; // grows across calls; used for stable tool_call_ids

  const persistTerminal = async (
    status: TerminalStatus,
    error: string | null,
  ): Promise<OllamaRunResult> => {
    const result: OllamaRunResult = { sessionId, terminalStatus: status, error };
    writeTerminal(ctx, sessionId, result, tokenTotals);
    opts.onTerminal?.(result);
    return result;
  };

  try {
    for (;;) {
      if (signal?.aborted) return await persistTerminal("aborted", "Cancelled by signal");

      // External intents between steps (cancel / approval replies already handled
      // in the approval watcher; here we catch task/session flips + user messages).
      const stopped = await checkExternalIntents(ctx, sessionId, persistTerminal, pollMs);
      if (stopped) return stopped;

      if (Date.now() - startedAt > timeoutMs) {
        return await persistTerminal("failed", "Exceeded Ollama execution timeout");
      }
      if (stepCount >= maxToolSteps) {
        return await persistTerminal("failed", `Exceeded max tool steps (${maxToolSteps}) — possible runaway loop`);
      }

      // Rebuild messages from persisted memory (trimmed).
      const messages = buildOllamaMessages(db, sessionId, configuration.systemPrompt, taskPrompt);

      // ---- Model call ----
      let resp: OllamaChatResponse;
      try {
        resp = await ollama.chat({ model: modelId, messages, tools: toolDefs, stream: false });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return await persistTerminal("failed", `Ollama chat failed: ${msg}`);
      }
      if (resp.error) {
        return await persistTerminal("failed", `Ollama error: ${resp.error}`);
      }

      if (typeof resp.prompt_eval_count === "number") tokenTotals.input += resp.prompt_eval_count;
      if (typeof resp.eval_count === "number") tokenTotals.output += resp.eval_count;
      // Stage H: cumulative estimated cost (tokens × pricing). Missing price ⇒
      // 0 but the row/aggregate still flags estimated=true (honest).
      const respCost = estimateCost(modelId, { input: tokenTotals.input, output: tokenTotals.output }, pricing);
      tokenTotals.total = respCost;
      emitUsageEvent(db, sessionId, task.id, house.id, { input: tokenTotals.input, output: tokenTotals.output, total: respCost });
      if (tokenTotals.input + tokenTotals.output > tokenBudget) {
        return await persistTerminal("failed", `Exceeded session token budget (${tokenBudget} tokens)`);
      }

      const assistantContent = resp.message?.content ?? "";
      const toolCalls = resp.message?.tool_calls ?? [];

      // Persist the assistant turn BEFORE executing tools (crash-recoverable).
      persistAssistantTurn(db, sessionId, assistantContent, toolCalls);
      if (assistantContent.trim()) {
        createExecutionEvent(db, {
          sessionId,
          taskId: task.id,
          houseId: house.id,
          rawType: "message",
          type: "message",
          payload: { text: assistantContent.trim() },
        });
      }

      // No tool calls → final answer → complete (decision Q2).
      if (!toolCalls.length) {
        createArtifact(db, {
          sessionId,
          taskId: task.id,
          kind: "result",
          content: assistantContent || "(no text)",
        });
        if (fileTouched.size) {
          createArtifact(db, {
            sessionId,
            taskId: task.id,
            kind: "file_list",
            content: Array.from(fileTouched).join("\n"),
          });
        }
        return await persistTerminal("completed", null);
      }

      // ---- Execute tool calls ----
      for (const call of toolCalls) {
        if (signal?.aborted) return await persistTerminal("aborted", "Cancelled by signal");

        const name = call?.function?.name ?? "";
        const callId = toolCallIdFor(name, stepCount++);
        if (stepCount >= maxToolSteps) {
          // Step cap reached mid-turn → fail clearly.
          return await persistTerminal("failed", `Exceeded max tool steps (${maxToolSteps}) — possible runaway loop`);
        }

        const tool = toolMap.get(name);
        if (!tool) {
          const denial = `Unknown tool requested: ${name}`;
          persistToolResult(db, sessionId, callId, `tool_result for ${name}: ${denial}`);
          createExecutionEvent(db, {
            sessionId, taskId: task.id, houseId: house.id,
            rawType: "tool_result", type: "tool_result",
            payload: { tool: { tool: name }, ok: false, error: denial },
          });
          continue;
        }

        createExecutionEvent(db, {
          sessionId,
          taskId: task.id,
          houseId: house.id,
          rawType: "tool_call",
          type: "tool_call",
          payload: { tool: { tool: name, input: redactToolArgsForEvent(name, call.function.arguments ?? {}) } },
        });

        // Validate args against the tool's zod schema.
        const parsed = tool.argsSchema.safeParse(call.function.arguments ?? {});
        if (!parsed.success) {
          const err = `Invalid arguments for ${name}: ${parsed.error.issues.map((i) => i.message).join("; ")}`;
          persistToolResult(db, sessionId, callId, `${name}: ${err}`);
          createExecutionEvent(db, {
            sessionId, taskId: task.id, houseId: house.id,
            rawType: "tool_result", type: "tool_result",
            payload: { tool: { tool: name }, ok: false, error: err },
          });
          continue;
        }

        // Compute path containment for fs tools (fs_write resolves the PARENT
        // for new files — plan §17 risk 4).
        const pathInside = computePathInside(allowlist, name, parsed.data);

        // Permission gate (Stage E).
        const gate: GateDecision = gateToolCall(tool, {
          permissions: configuration.permissions,
          approvalPolicy: configuration.approvalPolicy,
          pathInsideAllowlist: pathInside,
        });
        const autoExecute = shouldAutoExecute(gate, {
          permissions: configuration.permissions,
          approvalPolicy: configuration.approvalPolicy,
          pathInsideAllowlist: pathInside,
        });

        if (gate.action === "deny") {
          const denial = gate.reason;
          persistToolResult(db, sessionId, callId, `${name}: ${denial}`);
          createExecutionEvent(db, {
            sessionId, taskId: task.id, houseId: house.id,
            rawType: "tool_result", type: "tool_result",
            payload: { tool: { tool: name }, ok: false, error: denial, denied: true },
          });
          continue;
        }

        if (gate.action === "ask" && !autoExecute) {
          // Approval-gated tool call.
          const providerRequestId = `ollama:${sessionId}:${callId}`;
          const created = createApprovalRequest(db, {
            sessionId,
            taskId: task.id,
            houseId: house.id,
            providerRequestId,
            kind: "permission",
            title: gate.title,
            message: gate.message,
            options: [],
          });
          if (created) {
            createExecutionEvent(db, {
              sessionId, taskId: task.id, houseId: house.id,
              rawType: "approval_requested", type: "approval_requested",
              payload: { question: gate.message, providerRequestId },
            });
            createNotification(db, {
              type: "approval",
              houseId: house.id,
              taskId: task.id,
              approvalRequestId: created.id,
              title: created.title,
              body: created.message,
            });
            setSessionStatus(db, sessionId, "awaiting_approval");
            setTaskStatus(db, task.id, "awaiting_approval");

            // Wait (poll DB) for the user's reply.
            const awaited = await awaitApprovalReplay(
              ctx, sessionId, providerRequestId, task.id, house.id,
              startedAt, timeoutMs, tokenTotals, persistTerminal, signal, pollMs,
            );
            if (awaited.terminal) return awaited.terminal;
            if (awaited.decision === "deny-reply") {
              persistToolResult(db, sessionId, callId, `${name}: ${awaited.reason}`);
              createExecutionEvent(db, {
                sessionId, taskId: task.id, houseId: house.id,
                rawType: "tool_result", type: "tool_result",
                payload: { tool: { tool: name }, ok: false, error: awaited.reason, denied: true },
              });
              continue; // denied → model learns and adapts
            }
            // Approved → fall through to execute.
          }
        }

        // ---- Execute the tool ----
        const tc = { workingDirectory: directory, allowlist };
        let toolResult: { ok: boolean; output: string; error?: string; filesTouched?: string[] };
        try {
          toolResult = await tool.execute(tc, parsed.data);
        } catch (err) {
          toolResult = { ok: false, output: "", error: `${name}: ${err instanceof Error ? err.message : String(err)}` };
        }
        if (toolResult.filesTouched) for (const f of toolResult.filesTouched) fileTouched.add(f);
        const capped = truncateOutput(
          toolResult.ok ? toolResult.output : (toolResult.error ?? "failed"),
          maxToolOutput,
        );
        persistToolResult(db, sessionId, callId, `${name}: ${capped.content}`);
        createExecutionEvent(db, {
          sessionId, taskId: task.id, houseId: house.id,
          rawType: "tool_result", type: "tool_result",
          payload: { tool: { tool: name }, ok: toolResult.ok, output: truncateEventOutput(capped.content) },
        });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return await persistTerminal("failed", msg);
  }
}

function composeTaskPrompt(task: TaskDto): string {
  const parts: string[] = [];
  if (task.title) parts.push(`Title: ${task.title}`);
  if (task.description) parts.push(`Description:\n${task.description}`);
  if (task.workingDirectory) parts.push(`Working directory: ${task.workingDirectory}`);
  return parts.join("\n\n") || "(no task detail provided)";
}

function truncateOutput(output: string, max: number): { content: string } {
  if (output.length <= max) return { content: output };
  return { content: `${output.slice(0, max)}\n…(tool result truncated at ${max} chars)` };
}

function truncateEventOutput(output: string): string {
  return output.length > 500 ? `${output.slice(0, 500)}…` : output;
}

/**
 * Redact/truncate a tool's arguments for the USER-FACING `tool_call` execution
 * event and Activity feed (Phase 5 M1). A model may embed secret-looking content
 * (e.g. `fs_write.content` containing `.env`/credentials) in its arguments; we
 * must NEVER leak that into execution_events streamed to the browser.
 *
 * Redaction policy:
 *  - `fs_write`: show the path + a byte count; DROP the content entirely.
 *  - any other argument whose value is a long / opaque blob is truncated to a
 *    short preview (the describe-event chip already caps at 140 chars).
 *
 * NOTE (M1 distinction): the MODEL-MEMORY copy in `agent_messages` retains the
 * FULL tool arguments (persistAssistantTurn persists `tool_calls` JSON intact)
 * because the loop must re-send them unchanged to the model on the next calls.
 * Only this UI/event copy is redacted.
 */
export function redactToolArgsForEvent(toolName: string, args: Record<string, unknown>): string {
  const safe = { ...args };
  if (toolName === "fs_write") {
    if ("path" in safe) safe.path = String(safe.path);
    if ("content" in safe) {
      const len = typeof safe.content === "string" ? (safe.content as string).length : 0;
      safe.content = `[redacted: ${len} bytes]`;
    }
  }
  return JSON.stringify(safe, (key, value) => {
    if (typeof value === "string" && value.length > 120) {
      return `${value.slice(0, 120)}…(${value.length} chars)`;
    }
    return value;
  });
}

/** Persist a role='tool' agent_messages row linked to its call id. */
function persistToolResult(db: VelarisDb, sessionId: string, toolCallId: string, content: string): void {
  upsertAgentMessage(db, { sessionId, role: "tool", content, toolCallId });
}

/** Compute path containment for fs tools (handles new-file writes). */
function computePathInside(allowlist: string[], toolName: string, args: Record<string, unknown>): boolean {
  const isWrite = toolName === "fs_write";
  const isPathTool = toolName === "fs_read" || toolName === "fs_list" || isWrite;
  if (!isPathTool) return true; // non-fs tools have no path → treat as inside
  const p = args?.path;
  if (typeof p !== "string" || !p) return true;
  try {
    if (isWrite) return resolveWriteTarget(p, allowlist).inside;
    resolveSafePath(p, allowlist);
    return true;
  } catch {
    return false;
  }
}

/**
 * Poll the DB for the user's reply to a pending permission. Returns a terminal
 * result (stop the run) or a decision to execute / deny the gated tool.
 */
async function awaitApprovalReplay(
  ctx: OllamaRunContext,
  sessionId: string,
  providerRequestId: string,
  taskId: string,
  houseId: string,
  startedAt: number,
  timeoutMs: number,
  tokenTotals: TokenTotals,
  persistTerminal: (s: TerminalStatus, e: string | null) => Promise<OllamaRunResult>,
  signal: AbortSignal | undefined,
  pollMs: number,
): Promise<{ terminal?: OllamaRunResult; decision: "execute" | "deny-reply"; reason?: string }> {
  const db = ctx.db;
  for (;;) {
    if (signal?.aborted) return { terminal: await persistTerminal("aborted", "Cancelled by signal"), decision: "deny-reply", reason: "cancelled" };
    if (Date.now() - startedAt > timeoutMs) return { terminal: await persistTerminal("failed", "Timed out awaiting approval"), decision: "deny-reply", reason: "timeout" };

    const liveTask = getTask(db, taskId);
    if (liveTask?.status === "cancelled") return { terminal: await persistTerminal("aborted", "Cancelled by user"), decision: "deny-reply", reason: "cancelled" };
    const liveSession = getExecutionSession(db, sessionId);
    if (liveSession?.status === "aborted") return { terminal: await persistTerminal("aborted", liveSession.lastError ?? "Aborted"), decision: "deny-reply", reason: "aborted" };
    if (liveSession?.status === "failed") return { terminal: await persistTerminal("failed", liveSession.lastError ?? "Agent step failed"), decision: "deny-reply", reason: "failed" };
    // Native pause while a permission is pending: keep waiting IN PLACE — the
    // approval row survives; only the user (post-resume) reply advances it.
    if (liveSession?.status === "paused") {
      await sleep(pollMs);
      continue;
    }

    const responded = listRespondedApprovalsForSession(db, sessionId).find((a) => a.providerRequestId === providerRequestId);
    if (responded) {
      markApprovalRelayed(db, providerRequestId);
      createExecutionEvent(db, {
        sessionId,
        taskId,
        houseId,
        rawType: "approval_resolved",
        type: "approval_resolved",
        payload: { providerRequestId, action: responded.status },
      });
      setSessionStatus(db, sessionId, "running");
      setTaskStatus(db, taskId, "running");
      if (responded.status === "approved") {
        return { decision: "execute" };
      }
      return { decision: "deny-reply", reason: responded.response ? `Permission rejected: ${responded.response}` : "Permission rejected by user" };
    }

    void tokenTotals;
    await sleep(pollMs);
  }
}

/** Check task/session flips + relay user messages between loop steps. */
async function checkExternalIntents(
  ctx: OllamaRunContext,
  sessionId: string,
  persistTerminal: (s: TerminalStatus, e: string | null) => Promise<OllamaRunResult>,
  pollMs?: number,
): Promise<OllamaRunResult | undefined> {
  const { db, raw } = ctx;
  const liveSession = getExecutionSession(db, sessionId);
  if (liveSession?.status === "aborted") return await persistTerminal("aborted", liveSession.lastError ?? "Aborted");
  if (liveSession?.status === "failed") return await persistTerminal("failed", liveSession.lastError ?? "Agent step failed");
  const liveTask = getTask(db, ctx.task.id);
  if (liveTask?.status === "cancelled") return await persistTerminal("aborted", "Cancelled by user");

  // NATIVE PAUSE (Stage G): the web flipped the session/task to `paused`. The
  // loop SUSPENDS in place between steps — no new model call or tool execution
  // starts. It waits until the session flips back to `running` (resume route),
  // or a terminal state appears. Every turn was already persisted before the
  // previous call, so resume continues from DB memory with no step lost.
  if (liveSession?.status === "paused") {
    const resumed = await awaitResumeOrTerminal(ctx, sessionId, persistTerminal, pollMs ?? OLLAMA_DEFAULTS.POLL_MS);
    if (resumed) return resumed; // paused → aborted/failed/cancelled
  }

  // Relay pending user chat messages (they join memory on the next rebuild).
  const pending = findPendingUserMessage(raw, sessionId, null);
  if (pending) markAgentMessageRelayed(db, pending.id);
  return undefined;
}

/**
 * Block the loop while the session is `paused`. Returns a terminal result when
 * the task/session is cancelled, failed or aborted mid-pause (crash-recoverable
 * via the existing reconcile pass, and a pause never blocks a user cancel).
 */
async function awaitResumeOrTerminal(
  ctx: OllamaRunContext,
  sessionId: string,
  persistTerminal: (s: TerminalStatus, e: string | null) => Promise<OllamaRunResult>,
  pollMs: number,
): Promise<OllamaRunResult | undefined> {
  const db = ctx.db;
  for (;;) {
    const liveSession = getExecutionSession(db, sessionId);
    if (liveSession?.status === "aborted") return await persistTerminal("aborted", liveSession.lastError ?? "Aborted");
    if (liveSession?.status === "failed") return await persistTerminal("failed", liveSession.lastError ?? "Agent step failed");
    const liveTask = getTask(db, ctx.task.id);
    if (liveTask?.status === "cancelled") return await persistTerminal("aborted", "Cancelled by user");
    if (liveSession?.status === "running") return undefined; // resumed in place
    await sleep(pollMs);
  }
}

function emitUsageEvent(
  db: VelarisDb,
  sessionId: string,
  taskId: string,
  houseId: string,
  totals: { input: number; output: number; total: number },
): void {
  const { input, output, total } = totals;
  // LIVE-ONLY usage tick (B1): we emit a `usage` execution_event per model call
  // so the Activity feed / stream shows progress, but we do NOT persist a
  // usage_records row here. The persisted row is written ONCE at terminal with
  // the FINAL cumulative totals — otherwise per-call rows would each hold the
  // cumulative totals and `getUsageSummaryFor*`'s SUM() would overcount ~N×.
  createExecutionEvent(db, {
    sessionId,
    taskId,
    houseId,
    rawType: "usage",
    type: "usage",
    payload: { input, output, cost: total, estimated: true },
  });
}

/** Write the terminal state, mirroring the OpenCode runner's persistTerminal. */
function writeTerminal(
  ctx: OllamaRunContext,
  sessionId: string,
  result: OllamaRunResult,
  tokenTotals: TokenTotals,
): void {
  const { db, task, house, modelId } = ctx;
  const now = new Date().toISOString();

  // Phase 5 Stage H / B1: persist EXACTLY ONE usage_records row per session at
  // terminal, holding the FINAL cumulative token totals and estimated cost.
  // Per-call `usage` events (emitUsageEvent) were live-only so the SUM() in
  // getUsageSummaryForHouse / getUsageSummaryForTask reflects real totals, not an
  // N× over count, and `sessions: count()` stays an honest session count.
  createUsageRecord(db, {
    sessionId,
    taskId: task.id,
    houseId: house.id,
    modelId,
    provider: "ollama",
    cost: {
      inputTokens: tokenTotals.input,
      outputTokens: tokenTotals.output,
      total: tokenTotals.total,
    },
    estimated: true, // Ollama cost is ALWAYS an estimate (decision Q5/Q12)
  });
  const sessionStatus =
    result.terminalStatus === "completed" ? "completed"
    : result.terminalStatus === "aborted" ? "aborted"
    : result.terminalStatus === "interrupted" ? "interrupted"
    : "failed";

  setSessionStatus(db, sessionId, sessionStatus, {
    lastError: result.error ?? undefined,
    finishedAt: now,
    costTotal: tokenTotals.total,
    inputTokens: tokenTotals.input,
    outputTokens: tokenTotals.output,
  });

  cancelPendingApprovalsForSession(db, sessionId);

  if (result.terminalStatus === "completed") {
    createExecutionEvent(db, { sessionId, taskId: task.id, houseId: house.id, rawType: "task_completed", type: "task_completed", payload: {} });
    setTaskStatus(db, task.id, "completed");
    createNotification(db, {
      type: "completion",
      houseId: house.id,
      taskId: task.id,
      title: `Task completed: ${task.title}`,
      body: "The house finished its quest.",
    });
  } else if (result.terminalStatus === "failed") {
    createExecutionEvent(db, { sessionId, taskId: task.id, houseId: house.id, rawType: "task_failed", type: "task_failed", payload: { error: result.error } });
    createArtifact(db, { sessionId, taskId: task.id, kind: "other", content: result.error ?? "Task failed" });
    createNotification(db, {
      type: "failure",
      houseId: house.id,
      taskId: task.id,
      title: `Task failed: ${task.title}`,
      body: result.error ?? "Task failed with no error detail",
    });
    setTaskStatus(db, task.id, "failed", result.error ?? "Task failed");
  } else {
    createExecutionEvent(db, {
      sessionId,
      taskId: task.id,
      houseId: house.id,
      rawType: "session_aborted",
      type: "session_aborted",
      payload: { reason: result.error },
    });
    setTaskStatus(db, task.id, result.terminalStatus === "aborted" ? "cancelled" : "interrupted", result.error ?? "");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * A session status that can be resumed in place by `runOllamaTask`.
 *
 * Terminal COMPLETED sessions are never resumed — the task would be re-run from a
 * fresh session via the normal queue/requeue path. But an `interrupted` session
 * (set by reconcile when the engine restarted while the task was running/paused)
 * IS resumable for Ollama: Ollama is stateless, so the persisted `agent_messages`
 * bound to that session are the ONLY source of its context, and re-running the
 * task should CONTINUE that conversation rather than orphan it (Phase 4/5 M3
 * across-restart continuation). `failed`/`aborted`/`completed` are genuinely
 * terminal and never resumed.
 */
function isResumableSessionStatus(status: string): boolean {
  return ["pending", "running", "awaiting_approval", "awaiting_input", "paused", "interrupted"].includes(status);
}

/**
 * Load the model pricing table from the DEFAULT Ollama provider config's
 * `extra.modelPricing`. Source of truth per decision Q5. Returns {} when the
 * table is absent/empty so cost stays 0 but rows remain flagged `estimated`.
 */
function loadModelPricing(db: VelarisDb): Record<string, ModelPricing> {
  const configs = listProviderConfigs(db);
  const def = configs.find((c) => c.type === "ollama" && c.isDefault);
  return parsePricing(def?.extra ?? {});
}
