/**
 * Conversation memory — rebuild + trim the Ollama messages array from the
 * persisted `agent_messages` rows (Phase 5 Stage F).
 *
 * Every turn is persisted to `agent_messages` BEFORE the next model call
 * (crash-recoverable): assistant turns carry `tool_calls` (JSON) and tool
 * results are role='tool' rows linked by `toolCallId`. This module reconstructs
 * the `/api/chat` `messages[]` array:
 *   - role 'user'   → 'user'
 *   - role 'agent'  → 'assistant' + re-attached tool_calls JSON
 *   - role 'tool'   → 'tool' + tool_name (derived from the call id prefix)
 *
 * Trimming (plan §17 risk 8): tool results can be huge and the context can grow
 * without bound. We trim to a character budget, keeping the system prompt and
 * the MOST RECENT turns, and we NEVER split an assistant tool_calls turn from
 * the tool results that follow it.
 */

import type { VelarisDb } from "@/lib/db";
import { agentMessages } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { OllamaChatMessage } from "./types";
import { parseJson } from "@/shared/schemas/common";
import { upsertAgentMessage } from "@/server/repositories/execution-repo";

export interface MemoryOptions {
  /** Rough character budget for the trimmed conversation (not token-exact). */
  maxContextChars?: number;
  /** Guard against splitting an assistant's tool results from its tool_calls. */
  maxTurns?: number;
}

export const DEFAULT_MAX_CONTEXT_CHARS = 40_000;
export const DEFAULT_MAX_TURNS = 60;

export interface OllamaMemoryRow {
  id: string;
  role: "user" | "agent" | "tool";
  content: string;
  createdAt: string;
  toolCalls: string; // JSON string ('' for the tool_calls column default "[]")
  toolCallId: string | null;
}

/** Load + map + trim the persisted messages into an Ollama messages array. */
export function buildOllamaMessages(
  db: VelarisDb,
  sessionId: string,
  systemPrompt: string,
  taskPrompt: string,
  opts: MemoryOptions = {},
): OllamaChatMessage[] {
  const maxChars = opts.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS;
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;

  const rows = db
    .select()
    .from(agentMessages)
    .where(eq(agentMessages.sessionId, sessionId))
    .orderBy(agentMessages.createdAt)
    .all()
    .map((r): OllamaMemoryRow => ({
      id: r.id,
      role: r.role as "user" | "agent" | "tool",
      content: r.content,
      createdAt: r.createdAt,
      toolCalls: r.toolCalls,
      toolCallId: r.toolCallId,
    }));

  // Trim to a maxTurns window (always keep the LAST maxTurns turns).
  let window = rows;
  if (rows.length > maxTurns) {
    window = rows.slice(rows.length - maxTurns);
  }

  // Apply the character budget while keeping assistant tool_calls together with
  // their following tool results. Walk backwards, marking a kept prefix that
  // never splits an assistant(tool_calls) → tool result chain.
  let budget = maxChars;
  const kept: Set<string> = new Set();
  for (let i = window.length - 1; i >= 0; i--) {
    const r = window[i];
    budget -= r.content.length + 16;
    if (budget < 0) break;
    kept.add(r.id);
    // If this is an assistant row with tool_calls, all immediately-following
    // tool rows belong to it — keep them together.
    if (r.role === "agent" && hasToolCalls(r)) {
      for (let j = i + 1; j < window.length && window[j].role === "tool"; j++) {
        kept.add(window[j].id);
      }
    }
  }
  const finalRows = window.filter((r) => kept.has(r.id));

  const msgs: OllamaChatMessage[] = [];
  if (systemPrompt.trim()) {
    msgs.push({ role: "system", content: systemPrompt.trim() });
  }
  if (taskPrompt.trim()) {
    msgs.push({ role: "user", content: taskPrompt.trim() });
  }
  for (const r of finalRows) {
    msgs.push(rowToMessage(r));
  }
  return msgs;
}

/** Persist one assistant turn with its tool_calls (JSON), returning the row. */
export function persistAssistantTurn(
  db: VelarisDb,
  sessionId: string,
  content: string,
  toolCalls: unknown[],
): void {
  upsertAgentMessage(db, {
    sessionId,
    role: "agent",
    content,
    toolCalls: JSON.stringify(toolCalls ?? []),
  });
}

export function rowToMessage(r: OllamaMemoryRow): OllamaChatMessage {
  if (r.role === "tool") {
    return {
      role: "tool",
      tool_name: toolNameFromCallId(r.toolCallId),
      content: r.content,
    };
  }
  if (r.role === "user") {
    return { role: "user", content: r.content };
  }
  const toolCalls = parseJson<unknown[]>(r.toolCalls, []);
  return {
    role: "assistant",
    content: r.content,
    ...(Array.isArray(toolCalls) && toolCalls.length ? { tool_calls: toolCalls as never } : {}),
  };
}

export function hasToolCalls(r: { toolCalls: string }): boolean {
  try {
    const parsed = JSON.parse(r.toolCalls || "[]");
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

function toolNameFromCallId(callId: string | null): string | undefined {
  if (!callId) return undefined;
  const i = callId.indexOf("::");
  return i >= 0 ? callId.slice(0, i) : callId;
}
