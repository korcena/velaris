/**
 * AgentExecutionProvider interface per AGENT_ORCHESTRATION §2.
 *
 * One interface, two implementations (OpenCode now, Ollama-direct in Phase 5).
 * The engine codes against this interface only.
 *
 * Explicit limitations (never simulated — AGENT_ORCHESTRATION §2.1):
 *  - OpenCode has NO pause/resume endpoints; `cancelTask` (POST .../abort) is
 *    the only interruption primitive. A "pause" on an OpenCode house is modeled
 *    as abort + persisted context; resume = a new session + sendMessage.
 *  - Sessions are directory-scoped; the queue serializes per working directory.
 */

import type { SessionStatus } from "@/shared/types";

export interface StartTaskInput {
  taskId: string;
  /** Velaris execution_session id (the engine creates the row first). */
  sessionId: string;
  /** Validated against the allowlist before we get here. */
  workingDirectory: string;
  systemPrompt: string;
  taskPrompt: string;
  aiProvider: string;
  modelId: string;
  approvalPolicy: "never" | "always" | "risky_only";
}

export interface SendMessageInput {
  /** Velaris execution_session id. */
  sessionId: string;
  /** OpenCode provider session id. */
  providerSessionId: string;
  aiProvider: string;
  modelId: string;
  message: string;
  /** Optional continuation message id from the last assistant message. */
  messageID?: string | null;
}

export interface SessionStatusInfo {
  providerSessionId: string | null;
  status: SessionStatus;
  /** Provider-reported cost/tokens (from GET /session/{id}). */
  cost?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  /** Epoch ms of the provider's last activity (`time.updated`). */
  lastActivityMs?: number;
  /** Epoch ms of session creation (`time.created`). */
  createdMs?: number;
}

/**
 * Discriminator for runtime dispatch + health gating (Phase 5 §4).
 * Mirrors `agent_configurations.execution_provider` / `EXECUTION_PROVIDERS`.
 */
export type ProviderKind = "opencode" | "ollama";

export interface AgentExecutionProvider {
  /** Discriminator for runtime dispatch + health gating. */
  readonly kind: ProviderKind;
  /** True when the provider can truly suspend a running loop in place
   * (native pause/resume — the Phase-5 Ollama runtime). OpenCode is always
   * false: its only interruption primitive is abort. */
  readonly supportsNativePause: boolean;
  /** Create + init a provider session and send the initial prompt. */
  startTask(input: StartTaskInput): Promise<{ providerSessionId: string | null }>;
  /** Send a follow-up message (chat / resume-after-abort). */
  sendMessage(input: SendMessageInput): Promise<void>;
  /** Abort the running session (OpenCode: POST /session/{id}/abort). */
  cancelTask(providerSessionId: string): Promise<void>;
  /** Fetch live session status (OpenCode: GET /session/{id}). */
  getStatus(providerSessionId: string): Promise<SessionStatusInfo>;
  /** Respond to a pending permission/question (AGENT_ORCHESTRATION §5). */
  respondToApproval(input: {
    kind: "permission" | "question";
    providerRequestId: string;
    action: "approve" | "reject" | "reply";
    message?: string;
    /** For question "reply": one-or-more option labels to select. */
    selected?: string[];
  }): Promise<void>;
  /** Fetch the session diff (OpenCode: GET /session/{id}/diff). */
  getDiff(providerSessionId: string): Promise<Array<{ file?: string; patch?: string; status?: string; additions?: number; deletions?: number }>>;
  /** List available models (OpenCode: GET /api/model). */
  listModels(): Promise<Array<{ id: string; providerID: string }>>;
  /** Provider health probe (OpenCode: GET /api/health). */
  health(): Promise<boolean>;
}
