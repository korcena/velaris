/**
 * OpenCode AgentExecutionProvider implementation (AGENT_ORCHESTRATION §2–§4).
 *
 * Thin wrapper over the OpenCode client with the exact prompt/abort/status/diff
 * semantics the engine needs. All side effects happen in the engine process —
 * this module must never be imported from the web (src/app) side.
 *
 * Explicit limitation (documented, never simulated): OpenCode has no
 * pause/resume. `cancelTask` maps to abort; a "pause" is represented as an
 * aborted session + persisted context, resumable via a new session + sendMessage.
 */

import type { VelarisDb } from "@/lib/db";
import type {
  AgentExecutionProvider,
  StartTaskInput,
  SendMessageInput,
  SessionStatusInfo,
} from "@/server/execution/types";
import { OpencodeClient } from "@/server/opencode";

/**
 * The `db` handle is kept for future adapter needs (persisting provider session
 * mapping). The runner currently owns the execution_session row writes.
 */
export interface OpenCodeAdapterDeps {
  client: OpencodeClient;
  db: VelarisDb;
}

export function createOpenCodeAdapter(deps: OpenCodeAdapterDeps): AgentExecutionProvider {
  const { client } = deps;

  return {
    kind: "opencode",
    supportsNativePause: false,
    async startTask(input: StartTaskInput): Promise<{ providerSessionId: string | null }> {
      // createSession with the working directory; OpenCode scopes sessions to dirs.
      const created = await client.createSession(input.workingDirectory);
      const providerSessionId = created.id;
      if (!providerSessionId) return { providerSessionId: null };

      // NOTE (1.18.32): `init` is NOT required to prompt a fresh session. A new
      // session answers /message and /prompt_async directly, and init would
      // require an invented `^msg` messageID. We skip it.
      // Compose the task prompt from the house systemPrompt + task content.
      const fullPrompt = composeTaskPrompt(input.systemPrompt, input.taskPrompt);

      // Fire-and-forget: the model runs and streams over the /event SSE; the
      // runner's quiet-watchdog + SSE ingest drives completion detection.
      await client.promptAsync(providerSessionId, {
        providerID: input.aiProvider,
        modelID: input.modelId,
        prompt: fullPrompt,
      });

      return { providerSessionId };
    },

    async sendMessage(input: SendMessageInput): Promise<void> {
      // Fire-and-forget for same reason as startTask (streaming over SSE).
      await client.promptAsync(input.providerSessionId, {
        providerID: input.aiProvider,
        modelID: input.modelId,
        prompt: input.message,
        messageID: input.messageID ?? undefined,
      });
    },

    async cancelTask(providerSessionId: string): Promise<void> {
      await client.abortSession(providerSessionId);
    },

    async getStatus(providerSessionId: string): Promise<SessionStatusInfo> {
      const info = await client.getSession(providerSessionId);
      return {
        providerSessionId: info.id || providerSessionId,
        status: "running",
        cost: info.cost,
        inputTokens: info.tokens.input,
        outputTokens: info.tokens.output,
        reasoningTokens: info.tokens.reasoning,
        cacheReadTokens: info.tokens.cacheRead,
        lastActivityMs: info.time.updated,
        createdMs: info.time.created,
      };
    },

    async respondToApproval(input): Promise<void> {
      if (input.kind === "permission") {
        const reply = input.action === "approve" ? "once" : "reject";
        await client.replyPermission(input.providerRequestId, {
          reply,
          message: input.message,
        });
      } else {
        // question: 1.18.32 `answers` is `string[][]` (one array per question, in
        // order). There is exactly one question per approval_request in our flow,
        // so we always send a single inner array.
        if (input.action === "reject") {
          await client.rejectQuestion(input.providerRequestId);
        } else if (input.selected && input.selected.length > 0) {
          await client.replyQuestion(input.providerRequestId, [input.selected]);
        } else if (input.message) {
          // A free-text reply is sent as the single answer for that question.
          await client.replyQuestion(input.providerRequestId, [[input.message]]);
        } else {
          // Default to the first option if available; else no-op.
          await client.replyQuestion(input.providerRequestId, [[]]);
        }
      }
    },

    async getDiff(providerSessionId: string) {
      return client.getSessionDiff(providerSessionId);
    },

    async listModels() {
      return client.listModels();
    },

    async health() {
      return client.health();
    },
  };
}

/**
 * Compose the initial prompt sent to the model: a system-contextualized task
 * brief. We keep the systemPrompt as context and the task as the actionable
 * instruction so the agent works within the house's identity/persona.
 */
function composeTaskPrompt(systemPrompt: string, taskPrompt: string): string {
  const sections: string[] = [];
  if (systemPrompt.trim()) sections.push(`# System\n${systemPrompt.trim()}`);
  sections.push(`# Task\n${taskPrompt.trim() || "(no additional task detail provided)"}`);
  sections.push(
    "Proceed and produce concrete results. If you need a clarification or a file/shell permission, request it via the available approval mechanism.",
  );
  return sections.join("\n\n");
}
