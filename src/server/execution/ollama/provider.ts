/**
 * Ollama AgentExecutionProvider implementation (Phase 5 Stage F).
 *
 * Implements `AgentExecutionProvider` with `kind:'ollama'` /
 * `supportsNativePause:true` so the engine seam (provider-factory.ts) can
 * dispatch an Ollama house to this adapter. The heavy lifting happens in
 * `runOllamaTask` (runtime.ts) which owns the tool loop; this adapter mostly
 * provides the no-op / passthrough method bodies:
 *  - `startTask`: the runtime owns session bootstrap, so this is a handshake
 *    no-op returning the Velaris session id as the (opaque) provider handle.
 *  - `respondToApproval`: documented no-op — the runtime polls the DB for gating
 *    and never routes Ollama approvals through the OpenCode relay.
 *  - `getDiff`: returns `[]` — Ollama produces no provider diff; the runtime
 *    emits a `file_list` artifact instead.
 */

import type { VelarisDb } from "@/lib/db";
import type {
  AgentExecutionProvider,
  SendMessageInput,
  SessionStatusInfo,
  StartTaskInput,
} from "@/server/execution/types";
import type { OllamaClient } from "./client";
import {
  upsertAgentMessage,
  getExecutionSession,
} from "@/server/repositories/execution-repo";

export interface OllamaAdapterDeps {
  client: OllamaClient;
  db: VelarisDb;
}

export function createOllamaAdapter(deps: OllamaAdapterDeps): AgentExecutionProvider {
  const { client, db } = deps;

  return {
    kind: "ollama",
    supportsNativePause: true,
    async startTask(input: StartTaskInput): Promise<{ providerSessionId: string | null }> {
      // The runtime owns the loop; session bootstrap happens in runOllamaTask.
      // The Velaris session id is the stable handle (Ollama is stateless).
      return { providerSessionId: input.sessionId };
    },

    async sendMessage(input: SendMessageInput): Promise<void> {
      // Append a user message to the session's memory. The runtime's next
      // rebuild picks it up. This is used by chat / steering.
      upsertAgentMessage(db, {
        sessionId: input.sessionId,
        role: "user",
        content: input.message,
      });
    },

    async cancelTask(providerSessionId: string): Promise<void> {
      // The runtime observes the task/session row; nothing provider-side to kill.
      void providerSessionId;
    },

    async getStatus(providerSessionId: string): Promise<SessionStatusInfo> {
      // Derive from the persisted session row.
      const session = getExecutionSession(db, providerSessionId);
      return {
        providerSessionId,
        status: session?.status ?? "running",
        cost: session?.costTotal ?? 0,
        inputTokens: session?.inputTokens ?? 0,
        outputTokens: session?.outputTokens ?? 0,
        createdMs: session?.createdAt ? new Date(session.createdAt).getTime() : undefined,
      };
    },

    async respondToApproval(): Promise<void> {
      // Documented no-op: the Ollama runtime owns gating in the DB (polled by
      // the loop). Do NOT route Ollama approvals through the OpenCode relay.
    },

    async getDiff() {
      // Ollama produces no provider diff; runtime emits a file_list artifact.
      return [];
    },

    async listModels() {
      const names = await client.listModels();
      return names.map((id) => ({ id, providerID: "ollama" }));
    },

    async health() {
      return client.health();
    },
  };
}
