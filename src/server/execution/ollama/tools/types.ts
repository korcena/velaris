/**
 * Tool registry types — the declarative tool contract for the Ollama runtime
 * (Phase 5 Stage D).
 *
 * Each tool declares:
 *  - a zod input schema (engine-local) it validates model-supplied arguments
 *    against BEFORE execution;
 *  - a JSON-Schema description for the Ollama `/api/chat` `tools[]` payload;
 *  - a permission class the gating layer (Stage E) maps to a per-house
 *    permission mode + approval policy.
 *
 * ZOD SCHEMA PLACEMENT DECISION (documented):
 * AGENTS.md keeps zod schemas for API input validation in `src/shared/schemas`.
 * Tool argument schemas are NOT API input — they describe the model↔executor
 * contract inside the engine. Keeping them colocated with each tool (here)
 * keeps the schema, the JSON-Schema description and the executor that uses both
 * in one place, and avoids `src/shared` reaching into engine-only concerns.
 * The `/api/chat` request shape is still validated upstream by the client's
 * own parser/tests, so nothing on the API surface is bypassed.
 */

import { z } from "zod";

/** Permission classes the gating layer (Stage E) reasons over. */
export type PermissionClass = "fs_read" | "fs_write" | "shell" | "network" | "git";

/** Execution context handed to every tool. */
export interface ToolContext {
  /** The house's resolved working directory (already allowlist-validated). */
  workingDirectory: string;
  /** The house's workspace allowlist (defensive re-check at execution time). */
  allowlist: string[];
}

/** Normalized tool result — always a string for `agent_messages.content`. */
export interface ToolResult {
  ok: boolean;
  output: string;
  error?: string;
  /** Paths the tool wrote/touched (feeds a `file_list` artifact on completion). */
  filesTouched?: string[];
}

export interface OllamaTool {
  name: string;
  description: string;
  permissionClass: PermissionClass;
  /** True for mutating operations (currently only used for git gating parity). */
  readonly mutating?: boolean;
  /** JSON-Schema shape for the Ollama tools[] payload. */
  parameters: Record<string, unknown>;
  /** Engine-local zod schema — validates model-supplied args before execute. */
  argsSchema: z.ZodTypeAny;
  /** Execute the tool against validated args, enforcing the allowlist. */
  execute(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult>;
}

/**
 * Convert a small zod schema to a JSON-Schema for the Ollama `tools[]` payload.
 *
 * Supports the argument-schema subset the tool registry uses (object / string /
 * number / boolean / enum / array / optional) — sufficient for fs/shell/git/
 * network tools. Kept hand-rolled so no `zod-to-json-schema` dependency is
 * introduced (AGENTS.md forbids dependency bumps).
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value);
      if (!(value instanceof z.ZodOptional)) required.push(key);
    }
    const out: Record<string, unknown> = { type: "object", properties };
    if (required.length) out.required = required;
    return out;
  }
  if (schema instanceof z.ZodOptional) {
    return zodToJsonSchema(schema._def.innerType as z.ZodTypeAny);
  }
  if (schema instanceof z.ZodString) return { type: "string" };
  if (schema instanceof z.ZodNumber) return { type: "number" };
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodArray) {
    return { type: "array", items: zodToJsonSchema(schema._def.type as z.ZodTypeAny) };
  }
  if (schema instanceof z.ZodEnum) {
    return { type: "string", enum: (schema._def.values as string[]) };
  }
  return {};
}

/** Join a tool result to its assistant call id (opaque; name preserved for rebuild). */
export function toolCallIdFor(name: string, index: number): string {
  return `${name}::${index}`;
}

/** Recover the tool name from a tool_call_id persisted by the runtime. */
export function toolNameFromCallId(toolCallId: string | null | undefined): string | undefined {
  if (!toolCallId) return undefined;
  const i = toolCallId.indexOf("::");
  return i >= 0 ? toolCallId.slice(0, i) : toolCallId;
}
