/**
 * OpenCode SSE event mapper (AGENT_ORCHESTRATION §3).
 *
 * Converts a raw OpenCode event into a Velaris-normalized ExecutionEvent type
 * + metadata used by the runner to update execution_events, agent_messages,
 * approval_requests, usage and task/house status.
 *
 * Mapping rules (from the doc):
 *  1. Unknown event types are tolerated → map to `unknown` with raw payload
 *     preserved. Never crash, never drop.
 *  2. Assistant TEXT and TOOL CALLS only surface to users — chain-of-thought is
 *     OpenCode-internal and never surfaced. Reasoning parts → unknown.
 *  3. Pending permission/question may also be discovered via GET /permission +
 *     GET /question on reconnect; dedupe by provider_request_id (UNIQUE constraint).
 */

import type { ProviderEvent } from "@/server/opencode";
import type { ExecutionEventType } from "@/shared/types";

export interface MappedEvent {
  type: ExecutionEventType;
  /** Provider original event type. */
  rawType: string;
  /** Session id from the provider event (for matching to our session row). */
  providerSessionID?: string;
  payload: Record<string, unknown>;
  /** Assistant-visible text (may be empty — e.g. a tool call with no text). */
  assistantText?: string;
  /** Whether this is a pending permission / question request. */
  approval?: PendingApproval;
  /** Cost/tokens snapshot on session.updated (final usage for completion). */
  usage?: { cost: number; input: number; output: number; reasoning: number; cacheRead: number };
  /** Whether the event indicates session completion (session.updated idle). */
  completed?: boolean;
  failed?: boolean;
  /** Provider message id — dedupe key for streaming deltas (message.updated /
   * part.updated for the same assistant message upsert one agent_messages row). */
  providerMessageId?: string;
}

export interface PendingApproval {
  kind: "permission" | "question";
  providerRequestId: string;
  title: string;
  message: string;
  options: Array<{ id: string; label: string }>;
}

/**
 * Map a raw provider event to a Velaris normalized event. Pure & synchronous —
 * easy to unit test. Returns null only if the event has no recognized shape.
 */
export function mapProviderEvent(ev: ProviderEvent): MappedEvent | null {
  const type = typeof ev.type === "string" ? ev.type : "";
  const props = (ev.properties ?? {}) as Record<string, unknown>;
  const sessionID =
    typeof props.sessionID === "string"
      ? props.sessionID
      : typeof props.session_id === "string"
        ? (props.session_id as string)
        : undefined;

  const base: MappedEvent = {
    type: "unknown",
    rawType: type,
    providerSessionID: sessionID,
    payload: { providerEvent: ev },
  };

  switch (type) {
    case "session.created":
    case "session.next.prompted":
    case "session.created.v2":
      return { ...base, type: "session_started" };

    case "message.updated": {
      const info = (props.info ?? {}) as Record<string, unknown>;
      const role = typeof info.role === "string" ? info.role : "";
      const text = extractMessageText((props.part ?? info) as Record<string, unknown> | undefined);
      // user messages mirror back the user's own prompt; only assistant text is new.
      if (role === "assistant" && text) {
        return {
          ...base,
          type: "message",
          assistantText: text,
          providerMessageId: extractMessageId(props),
          payload: { text },
        };
      }
      return base; // drop non-assistant text
    }

    case "message.part.updated": {
      const partRaw = props.part as Record<string, unknown> | undefined;
      const part = partRaw ?? {};
      const partType = typeof part.type === "string" ? part.type : "";
      if (partType === "text") {
        const t = typeof part.text === "string" ? part.text : "";
        if (t) {
          const providerMessageId =
            typeof props.messageID === "string"
              ? props.messageID
              : typeof props.message_id === "string"
                ? (props.message_id as string)
                : typeof part.messageID === "string"
                  ? (part.messageID as string)
                  : undefined;
          return {
            ...base,
            type: "message",
            assistantText: t,
            providerMessageId,
            payload: { text: t },
          };
        }
        return base;
      }
      if (partType === "reasoning" || partType === "step-start" || partType === "compaction") {
        // chain-of-thought / structural parts — never surface.
        return { ...base, type: "unknown", payload: { reason: "cot_or_structural", partType } };
      }
      if (partType === "tool") {
        const call = extractToolCall(part);
        if (call) return { ...base, type: "tool_call", payload: { tool: call } };
        return base;
      }
      if (partType === "snapshot" || partType === "patch") {
        // Results/patches are reflected in the final diff + artifacts.
        return { ...base, type: "tool_result", payload: { kind: partType } };
      }
      return base; // tolerate any other part type as generic work
    }

    case "session.next.tool.called": {
      const call = extractToolCallDirect(props);
      return { ...base, type: "tool_call", payload: { tool: call } };
    }

    case "session.next.step.failed": {
      const err = props.error as Record<string, unknown> | undefined;
      const msg = typeof err?.message === "string" ? err.message : "step failed";
      return { ...base, type: "error", failed: true, payload: { error: msg } };
    }

    case "session.next.tool.input.ended":
    case "session.next.tool.result": {
      return { ...base, type: "tool_result" };
    }

    case "permission.updated": {
      const parsed = parsePermissionEvent(props);
      if (parsed) {
        return {
          ...base,
          type: "approval_requested",
          approval: parsed.approval,
          payload: parsed.payload,
        };
      }
      // A resolved permission (no pending) → treat as approval_resolved.
      return { ...base, type: "approval_resolved" };
    }

    case "question.updated": {
      const parsed = parseQuestionEvent(props);
      if (parsed) {
        return {
          ...base,
          type: "approval_requested",
          approval: parsed.approval,
          payload: parsed.payload,
        };
      }
      return { ...base, type: "approval_resolved" };
    }

    case "session.updated": {
      const info = props.info as Record<string, unknown> | undefined;
      const usage = extractUsage(info);
      return {
        ...base,
        type: "usage",
        usage,
        payload: { cost: info?.cost ?? 0 },
      };
    }

    case "session.next.step.ended":
      return { ...base, type: "tool_result" };

    case "session.next.shell.started":
    case "session.next.shell.ended":
      return { ...base, type: "tool_result" };

    default:
      return base; // unknown tolerated
  }
}

/** Extract the assistant-facing text from a message/part payload. */
function extractMessageText(thing: Record<string, unknown> | undefined): string {  if (!thing) return "";
  if (typeof thing.text === "string") return thing.text;
  const parts = thing.parts;
  if (Array.isArray(parts)) {
    return parts
      .map((p) => (p && typeof (p as Record<string, unknown>).text === "string" ? (p as Record<string, unknown>).text as string : ""))
      .join("\n");
  }
  return "";
}

/** A provider message id from a `message.updated` event's properties. */
function extractMessageId(props: Record<string, unknown>): string | undefined {
  const id =
    props.messageID ??
    props.message_id ??
    (props.info as Record<string, unknown> | undefined)?.messageID ??
    (props.info as Record<string, unknown> | undefined)?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** A tool call from a part object {type:'tool', ...}. */
function extractToolCall(part: Record<string, unknown>): Record<string, unknown> | null {
  const callID = typeof part.callID === "string" ? part.callID : "";
  // OpenCode tool parts carry the tool name under various keys.
  const tool =
    typeof part.tool === "string"
      ? part.tool
      : typeof part.toolID === "string"
        ? (part.toolID as string)
        : typeof part.name === "string"
          ? (part.name as string)
          : "";
  const input = part.input ?? part.arguments ?? {};
  return { callID, tool, input: typeof input === "string" ? input : JSON.stringify(input ?? "") };
}

/** A tool call from a direct event (session.next.tool.called). */
function extractToolCallDirect(props: Record<string, unknown>): Record<string, unknown> | null {
  const tool = typeof props.tool === "string" ? props.tool : "";
  const callID = typeof props.callID === "string" ? props.callID : "";
  const input = props.input ?? {};
  return {
    callID,
    tool,
    input: typeof input === "string" ? input : JSON.stringify(input ?? ""),
  };
}

function parsePermissionEvent(
  props: Record<string, unknown>,
): { approval: PendingApproval; payload: Record<string, unknown> } | null {
  const req = props.request as Record<string, unknown> | undefined;
  if (!req) return null;
  const id = typeof req.id === "string" ? req.id : "";
  const permission = typeof req.permission === "string" ? req.permission : "permission";
  const patterns = Array.isArray(req.patterns) ? (req.patterns as string[]).join(", ") : "";
  if (!id) return null;
  const title = `Permission: ${permission}`;
  const message = patterns ? `${permission} — ${patterns}` : permission;
  return {
    approval: { kind: "permission", providerRequestId: id, title, message, options: [] },
    payload: { permission, patterns },
  };
}

function parseQuestionEvent(
  props: Record<string, unknown>,
): { approval: PendingApproval; payload: Record<string, unknown> } | null {
  const req = props.request as Record<string, unknown> | undefined;
  if (!req) return null;
  const id = typeof req.id === "string" ? req.id : "";
  const questions = Array.isArray(req.questions) ? (req.questions as Record<string, unknown>[]) : [];
  if (!id || questions.length === 0) return null;
  const first = questions[0] ?? {};
  const qText = typeof first.question === "string" ? first.question : "Clarification needed";
  const header = typeof first.header === "string" ? first.header : "Question";
  const rawOptions = Array.isArray(first.options) ? (first.options as Record<string, unknown>[]) : [];
  const options = rawOptions
    .map((o) => ({ id: String(o.id ?? o.label ?? ""), label: String(o.label ?? o.id ?? "") }))
    .filter((o) => o.label);
  return {
    approval: {
      kind: "question",
      providerRequestId: id,
      title: header,
      message: qText,
      options,
    },
    payload: { question: qText, options },
  };
}

function extractUsage(
  info: Record<string, unknown> | undefined,
): { cost: number; input: number; output: number; reasoning: number; cacheRead: number } | undefined {
  if (!info) return undefined;
  const cost = typeof info.cost === "number" ? info.cost : 0;
  const tokens = (info.tokens ?? {}) as Record<string, unknown>;
  const input = typeof tokens.input === "number" ? tokens.input : 0;
  const output = typeof tokens.output === "number" ? tokens.output : 0;
  const reasoning = typeof tokens.reasoning === "number" ? tokens.reasoning : 0;
  const cache = (tokens.cache ?? 0) as number | Record<string, unknown>;
  const cacheRead =
    typeof cache === "number" ? cache : typeof cache.read === "number" ? cache.read : 0;
  return { cost, input, output, reasoning, cacheRead };
}
