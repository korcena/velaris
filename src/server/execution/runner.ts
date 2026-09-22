/**
 * TaskRunner — executes one task through the agent provider, owns the SSE
 * ingest for the task's directory, ingests events, relays approvals, sends
 * queued user messages, detects completion, and persists usage.
 *
 * This is the engine's per-task execution loop and the SINGLE WRITER of
 * execution_sessions / execution_events / agent_messages / artifacts /
 * usage_records and the approval_requests *create + relay* states. The web
 * process only writes approval *responses* and notification read state.
 *
 * Crash-recoverability: every decision is persisted as a row BEFORE a provider
 * call, and engine boot reconciliation uses those rows (ARCHITECTURE §9).
 *
 * Completion detection: OpenCode has no explicit terminal payload, so we treat a
 * session as complete when it has produced at least one assistant token and the
 * provider reports no activity for `completionQuietMs` (quiet watchdog). This is
 * consistent with "session.updated … → reconcile cost/tokens via GET /session/{id}".
 */

import type Database from "better-sqlite3";
import type { VelarisDb } from "@/lib/db";
import type { AgentExecutionProvider } from "./types";
import type { ProviderEvent, SessionInfo } from "@/server/opencode";
import { OpencodeClient } from "@/server/opencode";
import { mapProviderEvent } from "./opencode/events/mapper";
import {
  createExecutionEvent,
  createExecutionSession,
  upsertAgentMessage,
  createApprovalRequest,
  createNotification,
  createUsageRecord,
  setSessionProviderId,
  setSessionStatus,
  getExecutionSession,
  listRespondedApprovalsForSession,
  cancelPendingApprovalsForSession,
  createArtifact,
  markApprovalRelayed,
  findPendingUserMessage,
  markAgentMessageRelayed,
} from "@/server/repositories/execution-repo";
import { setTaskStatus, getTask } from "@/server/repositories/task-repo";
import type { HouseDto, SessionStatus, TaskDto } from "@/shared/types";

export interface RunContext {
  db: VelarisDb;
  raw: Database.Database;
  adapter: AgentExecutionProvider;
  client: OpencodeClient;
  task: TaskDto;
  house: HouseDto;
  directory: string;
  modelId: string;
}

export type TerminalStatus = "completed" | "failed" | "aborted" | "interrupted";

export interface RunResult {
  sessionId: string;
  terminalStatus: TerminalStatus;
  error?: string | null;
}

export interface RunOptions {
  /** Poll interval for status reconciliation + approval relay + user messages. */
  pollMs?: number;
  /** Quiet-period (ms) after which a session with a produced message is declared complete. */
  completionQuietMs?: number;
  /** Hard timeout (ms) → session marked interrupted if no terminal reached. */
  timeoutMs?: number;
  /** Abort signal to stop the run (engine shutdown / task cancel). */
  signal?: AbortSignal;
  /** Called when the run reaches a terminal state. */
  onTerminal?: (result: RunResult) => void;
}

const DEFAULT_POLL_MS = 1500;
const DEFAULT_COMPLETION_QUIET_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2h

/**
 * Execute one task end-to-end. Returns a promise resolved with the terminal result.
 * Owns its SSE subscription for the working directory; unsubscribes on return.
 */
export async function executeTask(ctx: RunContext, opts: RunOptions = {}): Promise<RunResult> {
  const { db, raw, adapter, client, task, house, directory, modelId } = ctx;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const quietMs = opts.completionQuietMs ?? DEFAULT_COMPLETION_QUIET_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = opts.signal;
  const startedAt = Date.now();

  // ---- Persist session row first (crash-recoverable). ----
  const session = createExecutionSession(db, {
    taskId: task.id,
    houseId: house.id,
    provider: "opencode",
    modelId,
    directory,
  });
  const sessionId = session.id;

  createExecutionEvent(db, {
    sessionId,
    taskId: task.id,
    houseId: house.id,
    rawType: "task_started",
    type: "task_started",
    payload: { title: task.title },
  });
  setTaskStatus(db, task.id, "running");

  let providerSessionId: string | null = null;
  let lastCost: { cost: number; input: number; output: number; reasoning: number; cacheRead: number } | null = null;

  // In-memory state for completion detection.
  let producedMessage = false;

  const persistTerminalNow = async (status: SessionStatus, error: string | null): Promise<RunResult> => {
    const terminalStatus: TerminalStatus =
      status === "completed" ? "completed"
      : status === "failed" ? "failed"
      : status === "aborted" ? "aborted"
      : "interrupted";
    const result: RunResult = { sessionId, terminalStatus, error };
    await persistTerminal(ctx, sessionId, providerSessionId, result, lastCost);
    opts.onTerminal?.(result);
    return result;
  };

  try {
    // ---- Start the provider session. ----
    const started = await adapter.startTask({
      taskId: task.id,
      sessionId,
      workingDirectory: directory,
      systemPrompt: house.configuration.systemPrompt,
      taskPrompt: composeTaskPrompt(task),
      aiProvider: house.configuration.aiProvider,
      modelId,
      approvalPolicy: house.configuration.approvalPolicy,
    });
    providerSessionId = started.providerSessionId;
    if (!providerSessionId) {
      return await persistTerminalNow("failed", "OpenCode did not return a session id");
    }
    setSessionProviderId(db, sessionId, providerSessionId);
    setSessionStatus(db, sessionId, "running");
    createExecutionEvent(db, {
      sessionId,
      taskId: task.id,
      houseId: house.id,
      rawType: "session_started",
      type: "session_started",
      payload: { providerSessionId },
    });

    // ---- Subscribe to the directory's SSE stream. ----
    let unsubscribe: (() => void) | null = null;
    let streamOpen = false;
    unsubscribe = client.subscribeEvents(directory, {
      signal,
      onEvent: (ev) => {
        streamOpen = true;
        // handleProviderEvent maps internally — do NOT map again here (bug 8:
        // the redundant second mapProviderEvent caused double event-mapping).
        void handleProviderEvent(ctx, sessionId, providerSessionId, ev, {
          onMessage: () => { producedMessage = true; },
          onCost: (c) => { lastCost = c; },
          producedMessage,
        });
      },
      onStatus: () => {},
    });

    // ---- Poll loop: approve relay, user messages, quiet-completion, timeout. ----
    let lastActivity = Date.now();
    const terminalState: { status: SessionStatus | null; error: string | null } = { status: null, error: null };

    while (!terminalState.status) {
      if (signal?.aborted) {
        terminalState.status = "aborted";
        terminalState.error = "Cancelled by signal";
        break;
      }

      // 0. User-initiated cancel or provider-reported failure.
      //    (a) Web POST /api/tasks/{id}/cancel flips the session row to `aborted`.
      //        The runner must notice it promptly and STOP.
      //    (b) A `session.next.step.failed` event set the session row to `failed`
      //        (see handleProviderEvent). Without this check the quiet-completion
      //        watchdog below would later mark the task `completed`, overwriting
      //        the failure (bug 1). We break out with the failure instead.
      const liveSession = getExecutionSession(db, sessionId);
      if (liveSession) {
        if (liveSession.status === "aborted") {
          terminalState.status = "aborted";
          terminalState.error = liveSession.lastError ?? "Cancelled by user";
          break;
        }
        if (liveSession.status === "failed") {
          terminalState.status = "failed";
          terminalState.error = liveSession.lastError ?? "Agent step failed";
          break;
        }
      }

      // (c) A user cancel that races with startTask(): the web cancel route
      //     sets the task to `cancelled` right after we claimed it, but our
      //     own setSessionStatus(running) above may have clobbered the session's
      //     `aborted` marker back to `running`. The task row is the authoritative
      //     user-intent signal, so check it directly — otherwise the quiet-completion
      //     watchdog (step 3) could later mark the task `completed`, overwriting a
      //     user-initiated cancellation (bug 1 family # cancel-vs-startTask race).
      const liveTask = getTask(db, task.id);
      if (liveTask?.status === "cancelled") {
        terminalState.status = "aborted";
        terminalState.error = "Cancelled by user";
        break;
      }

      // 1. Relay responded approvals.
      const responded = listRespondedApprovalsForSession(db, sessionId);
      for (const ap of responded) {
        try {
          await adapter.respondToApproval({
            kind: ap.kind,
            providerRequestId: ap.providerRequestId,
            action: ap.status === "approved" ? "approve" : ap.status === "rejected" ? "reject" : "reply",
            message: ap.response ?? undefined,
          });
          createExecutionEvent(db, {
            sessionId,
            taskId: task.id,
            houseId: house.id,
            rawType: "approval_resolved",
            type: "approval_resolved",
            payload: { providerRequestId: ap.providerRequestId, action: ap.status },
          });
          // Mark relayed WITHOUT touching the user's chosen status (bug 5):
          // relayed_at is the single "sent to provider" marker.
          markApprovalRelayed(db, ap.providerRequestId);
          if (ap.kind === "permission") {
            if (ap.status === "approved") {
              // Approved permission → resume execution (bug 6). Reset BOTH the
              // task and the session so the quiet-completion watchdog (which is
              // suppressed while awaiting_user) can fire once work resumes.
              setTaskStatus(db, task.id, "running");
              setSessionStatus(db, sessionId, "running");
            } else {
              // REJECTED permission → the work cannot proceed. Per plan §6 the
              // engine aborts the provider session and fails the task (bug 6).
              terminalState.status = "failed";
              terminalState.error = ap.response
                ? `Permission rejected: ${ap.response}`
                : "Permission rejected by user — task can't proceed";
              break; // break the for-loop; the poll loop sees terminalState below
            }
          } else {
            // A QUESTION was answered (reply/select/reject). Unlike a rejected
            // permission, a clarification refusal does NOT fail the task — the
            // agent adapts and continues. Resume so the quiet-completion
            // watchdog (suppressed while awaiting_input) can fire once the agent
            // resumes producing output. Without this the task would hang in
            // awaiting_input forever after any question is answered.
            setSessionStatus(db, sessionId, "running");
            setTaskStatus(db, task.id, "running");
          }
        } catch {
          // Relay failed — retry next tick (markApprovalRelayed not yet called
          // because we only call it on success above).
        }
      }
      // A permission rejection set the terminal state — stop the poll loop.
      if (terminalState.status) {
        break;
      }

      // 2. Send any queued user messages (bug 2: never re-send the same prompt).
      //    findPendingUserMessage only returns messages with relayed_at IS NULL,
      //    and we set relayed_at on the row immediately after sending, so a slow
      //    agent reply never receives the same prompt more than once.
      const pending = findPendingUserMessage(raw, sessionId, null);
      if (pending && providerSessionId) {
        try {
          await adapter.sendMessage({
            sessionId,
            providerSessionId,
            aiProvider: house.configuration.aiProvider,
            modelId,
            message: pending.content,
          });
          markAgentMessageRelayed(db, pending.id);
          setSessionStatus(db, sessionId, "running");
        } catch { /* retry next tick */ }
      }

      // 3. Reconcile live provider status + quiet-completion.
      if (providerSessionId) {
        let live: SessionInfo | null = null;
        try {
          live = await client.getSession(providerSessionId);
          if (live) {
            const tokens = live.tokens;
            lastCost = {
              cost: live.cost,
              input: tokens.input,
              output: tokens.output,
              reasoning: tokens.reasoning,
              cacheRead: tokens.cacheRead,
            };
            lastActivity = live.time.updated || lastActivity;
          }
        } catch {
          // getSession transient failure — keep polling.
        }

        // Quiet-completion heuristic: a message was produced, and the provider's
        // last activity timestamp is older than quietMs.
        // IMPORTANT: do NOT fire while a permission/question is pending — a
        // pending approval blocks the agent, so `time.updated` (and our
        // lastActivity) go quiet. Without this guard the watchdog would mark the
        // task `completed` and overwrite the awaiting_approval / awaiting_input
        // state, stranding the in-flight approval (bug 1 family # quiet-vs-approval).
        const sessionStatusForQuiet = liveSession?.status ?? "running";
        const awaitingUser =
          sessionStatusForQuiet === "awaiting_approval" || sessionStatusForQuiet === "awaiting_input";
        if (
          producedMessage &&
          !awaitingUser &&
          live &&
          live.time.updated > 0 &&
          Date.now() - live.time.updated > quietMs
        ) {
          terminalState.status = "completed";
          break;
        }
        // Also handle when the stream went idle with activity having stopped.
        if (producedMessage && !awaitingUser && streamOpen && Date.now() - lastActivity > quietMs) {
          // Only fire if the provider session itself stopped advancing.
          terminalState.status = "completed";
          break;
        }
      }

      // 4. Timeout watchdog.
      if (Date.now() - startedAt > timeoutMs) {
        terminalState.status = "interrupted";
        terminalState.error = "Exceeded execution timeout";
        break;
      }

      await sleep(pollMs);
    }

    // Unsubscribe before finalizing.
    unsubscribe?.();
    unsubscribe = null;

    if (terminalState.status === "completed") {
      return await persistTerminalNow("completed", null);
    }
    if (terminalState.status === "aborted" && providerSessionId) {
      try { await adapter.cancelTask(providerSessionId); } catch { /* best-effort */ }
      return await persistTerminalNow("aborted", terminalState.error);
    }
    // interrupted / failed
    if (providerSessionId) {
      try { await adapter.cancelTask(providerSessionId); } catch { /* best-effort */ }
    }
    return await persistTerminalNow(
      terminalState.status === "failed" ? "failed" : "interrupted",
      terminalState.error ?? "Execution interrupted",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (providerSessionId) {
      try { await adapter.cancelTask(providerSessionId); } catch { /* best-effort */ }
    }
    return await persistTerminalNow("failed", message);
  }
}

/** Ingest one provider event into execution_events / messages / approvals. */
async function handleProviderEvent(
  ctx: RunContext,
  sessionId: string,
  providerSessionId: string | null,
  ev: ProviderEvent,
  hooks: {
    onMessage: () => void;
    onCost: (c: { cost: number; input: number; output: number; reasoning: number; cacheRead: number }) => void;
    producedMessage: boolean;
  },
): Promise<void> {
  const { db, task, house } = ctx;
  const mapped = mapProviderEvent(ev);
  if (!mapped) return;
  if (mapped.providerSessionID && providerSessionId && mapped.providerSessionID !== providerSessionId) {
    return; // event for a different session
  }

  createExecutionEvent(db, {
    sessionId,
    taskId: task.id,
    houseId: house.id,
    rawType: mapped.rawType,
    type: mapped.type,
    payload: mapped.payload,
  });

  if (mapped.assistantText) {
    // Bug 7: streaming deltas for the same provider message id are upserted
    // into one agent_messages row (dedup), never inserted per-delta. If the
    // provider supplies no message id, this falls back to an insert.
    upsertAgentMessage(db, {
      sessionId,
      role: "agent",
      content: mapped.assistantText,
      providerMessageId: mapped.providerMessageId ?? null,
    });
    hooks.onMessage();
  }

  if (mapped.approval) {
    // Approval policy enforcement (bug 9 / AGENT_ORCHESTRATION §5). A house with
    // `approval_policy = 'never'` auto-approves incoming PERMISSION requests —
    // no approval_request row, no bird; the engine replies "allow"/accept
    // immediately. Questions cannot be auto-answered (they need human text), so
    // they always bird regardless of policy.
    //
    // `risky_only` granularity is deferred (Phase 2): the OpenCode permission
    // payload doesn't reliably carry risk classification, so for now `risky_only`
    // is treated like `always` (bird everything) — see AGENT_ORCHESTRATION §2.1.
    const policy = house.configuration.approvalPolicy;
    const autoApprove =
      policy === "never" && mapped.approval.kind === "permission";

    if (autoApprove) {
      try {
        await ctx.adapter.respondToApproval({
          kind: "permission",
          providerRequestId: mapped.approval.providerRequestId,
          action: "approve",
        });
        createExecutionEvent(db, {
          sessionId,
          taskId: task.id,
          houseId: house.id,
          rawType: "approval_resolved",
          type: "approval_resolved",
          payload: {
            providerRequestId: mapped.approval.providerRequestId,
            action: "approved",
            autoApproved: true,
            reason: "approval_policy=never",
          },
        });
      } catch {
        // Auto-approve relay failed — nothing to persist; the provider will
        // resurface the permission if still unanswered.
      }
    } else {
      const created = createApprovalRequest(db, {
        sessionId,
        taskId: task.id,
        houseId: house.id,
        providerRequestId: mapped.approval.providerRequestId,
        kind: mapped.approval.kind,
        title: mapped.approval.title,
        message: mapped.approval.message,
        options: mapped.approval.options,
      });
      if (created) {
        const next = mapped.approval.kind === "permission" ? "awaiting_approval" as const : "awaiting_input" as const;
        setSessionStatus(db, sessionId, next);
        setTaskStatus(db, task.id, next);
        createNotification(db, {
          type: "approval",
          houseId: house.id,
          taskId: task.id,
          approvalRequestId: created.id,
          title: created.title,
          body: created.message,
        });
      }
    }
  }

  if (mapped.usage) {
    hooks.onCost(mapped.usage);
  }

  if (mapped.failed) {
    const msg = typeof mapped.payload.error === "string" ? mapped.payload.error : "agent step failed";
    setSessionStatus(db, sessionId, "failed", { lastError: msg, finishedAt: new Date().toISOString() });
    createExecutionEvent(db, {
      sessionId,
      taskId: task.id,
      houseId: house.id,
      rawType: "task_failed",
      type: "task_failed",
      payload: { error: msg },
    });
  }
}

/** Persist the terminal state: session/cost, usage, diff artifact, task, notification. */
async function persistTerminal(
  ctx: RunContext,
  sessionId: string,
  providerSessionId: string | null,
  result: RunResult,
  cost: { cost: number; input: number; output: number; reasoning: number; cacheRead: number } | null,
): Promise<void> {
  const { db, adapter, task, house } = ctx;
  const now = new Date().toISOString();
  const usageCost = cost ?? { cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0 };

  // Cost/token usage row (provider-reported for OpenCode → estimated=false).
  createUsageRecord(db, {
    sessionId,
    taskId: task.id,
    houseId: house.id,
    modelId: house.configuration.modelId,
    provider: "opencode",
    cost: usageCost,
    estimated: false,
  });

  // Diff artifact on completion (AGENT_ORCHESTRATION §9.5).
  if (result.terminalStatus === "completed" && providerSessionId) {
    try {
      const diff = await adapter.getDiff(providerSessionId);
      if (diff && diff.length > 0) {
        createArtifact(db, {
          sessionId,
          taskId: task.id,
          kind: "diff",
          content: diff
            .map((d) => `${d.status ?? "modified"} ${d.file ?? ""}\n${d.patch ?? ""}`)
            .join("\n---\n"),
        });
      }
    } catch { /* non-fatal */ }
  }

  const sessionStatus: SessionStatus =
    result.terminalStatus === "completed" ? "completed"
    : result.terminalStatus === "aborted" ? "aborted"
    : result.terminalStatus === "interrupted" ? "interrupted"
    : "failed";

  setSessionStatus(db, sessionId, sessionStatus, {
    lastError: result.error ?? undefined,
    finishedAt: now,
    costTotal: usageCost.cost,
    inputTokens: usageCost.input,
    outputTokens: usageCost.output,
    reasoningTokens: usageCost.reasoning,
    cacheReadTokens: usageCost.cacheRead,
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
    setTaskStatus(db, task.id, "failed", result.error);
  } else {
    // aborted / interrupted → task returns to a recoverable state.
    createExecutionEvent(db, {
      sessionId,
      taskId: task.id,
      houseId: house.id,
      rawType: result.terminalStatus,
      type: result.terminalStatus === "aborted" ? "session_aborted" : "session_aborted",
      payload: { reason: result.error },
    });
    setTaskStatus(
      db,
      task.id,
      result.terminalStatus === "aborted" ? "cancelled" : "interrupted",
      result.error,
    );
  }
}

function composeTaskPrompt(task: TaskDto): string {
  const parts: string[] = [];
  if (task.title) parts.push(`Title: ${task.title}`);
  if (task.description) parts.push(`Description:\n${task.description}`);
  return parts.join("\n\n") || "(no task detail provided)";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
