/**
 * Ollama HTTP client types — the native `/api/chat` (stream:false) surface
 * plus `GET /api/version` (health) and `GET /api/tags` (models).
 *
 * Phase 5 decision Q1: raw `fetch`, no new dependency. These shapes mirror the
 * Ollama HTTP API as documented. Fields are tolerantly typed so parsing never
 * throws on a field the server omits or the model returns with a slightly
 * different shape — the caller decides what to do with a missing field.
 */

export type OllamaChatRole = "system" | "user" | "assistant" | "tool";

/**
 * A single tool call the model requested (native tool-calling, Q2). Arguments
 * are an unvalidated JSON object here — the tool registry validates them against
 * its zod schema before execution.
 */
export interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

/** A chat message sent to /api/chat. `tool_calls` belong to assistant turns;
 * `tool_name` correlates a `role:'tool'` result to the call that produced it. */
export interface OllamaChatMessage {
  role: OllamaChatRole;
  content: string;
  images?: string[];
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

/** A function tool definition for the `tools[]` array. */
export interface OllamaToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

/** Request payload for POST /api/chat (always stream:false in this runtime). */
export interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  tools?: OllamaToolDef[];
  stream?: boolean;
  options?: Record<string, unknown>;
}

/** Parsed response from POST /api/chat. `error` is present on a 200-with-error. */
export interface OllamaChatResponse {
  message: OllamaChatMessage;
  prompt_eval_count?: number;
  eval_count?: number;
  done: boolean;
  error?: string;
}

/** One entry in GET /api/tags → `models[].name`. */
export interface OllamaTag {
  name: string;
  model?: string;
  modified_at?: string;
  size?: number;
  digest?: string;
  details?: Record<string, unknown>;
}
