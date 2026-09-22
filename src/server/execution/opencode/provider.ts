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
    async startTask(input: StartTaskInput): Promise<{ providerSessionId: string | null }> {
      // createSession with the working directory; OpenCode scopes sessions to dirs.
      const created = await client.createSession(input.workingDirectory);
      const providerSessionId = created.id;
      if (!providerSessionId) return { providerSessionId: null };

      await client.initSession(providerSessionId, {
        modelID: input.modelId,
        providerID: input.aiProvider,
      });

      // Compose the task prompt from the house systemPrompt + task content.
      const fullPrompt = composeTaskPrompt(input.systemPrompt, input.taskPrompt);

      await client.prompt(providerSessionId, {
        providerID: input.aiProvider,
        modelID: input.modelId,
        prompt: fullPrompt,
      });

      return { providerSessionId };
    },

    async sendMessage(input: SendMessageInput): Promise<void> {
      await client.prompt(input.providerSessionId, {
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
        // question: approve/select → reply a chosen option; reject → /reject.
        if (input.action === "reject") {
          await client.rejectQuestion(input.providerRequestId);
        } else if (input.selected && input.selected.length > 0) {
          await client.replyQuestion(input.providerRequestId, {
            answers: [{ questionID: input.providerRequestId, selected: input.selected }],
          });
        } else if (input.message) {
          await client.replyQuestion(input.providerRequestId, {
            answers: [{ questionID: input.providerRequestId, selected: [input.message] }],
          });
        } else {
          // Default to the first option if available; else no-op.
          await client.replyQuestion(input.providerRequestId, {
            answers: [{ questionID: input.providerRequestId, selected: [] }],
          });
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
