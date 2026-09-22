/**
 * Pure event → activity-item describe function (Phase 3).
 * React-free so it unit-tests cleanly. Maps an ExecutionEventDto into a human
 * readable activity item for the house Activity timeline. Payload shapes follow
 * src/server/execution/opencode/events/mapper.ts + src/server/execution/runner.ts.
 */

import type { ExecutionEventDto } from "@/shared/types";

export type ActivityItemKind =
  | "quest"
  | "text"
  | "tool"
  | "approval"
  | "system"
  | "error";

export type ActivityTone = "default" | "gold" | "crimson" | "muted";

export interface ActivityItem {
  kind: ActivityItemKind;
  tone: ActivityTone;
  /** Short title / label for the timeline row. */
  label: string;
  /** Optional free text body (bubble) or detail. */
  text?: string;
  /** Optional monospace chip content (e.g. tool name + input). */
  mono?: string;
}

/** Extract a string field from a payload defensively. */
function str(payload: Record<string, unknown>, key: string): string | undefined {
  const v = payload[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Truncate a potentially long string for a compact chip. */
function truncate(s: string, max = 140): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Describe an execution event into an activity item. Returns null for event
 * types we don't surface (unknown), and never throws on empty payloads.
 */
export function describeExecutionEvent(ev: ExecutionEventDto): ActivityItem | null {
  const p = ev.payload ?? {};

  switch (ev.type) {
    case "task_started":
      return { kind: "quest", tone: "gold", label: "Quest began", text: str(p, "title") };
    case "session_started":
      return { kind: "system", tone: "muted", label: "Session opened" };
    case "message":
      return { kind: "text", tone: "default", label: "Message", text: str(p, "text") };
    case "tool_call": {
      const tool = p.tool as Record<string, unknown> | undefined;
      const toolName = typeof tool?.tool === "string" ? tool.tool : "tool";
      const input = typeof tool?.input === "string" ? tool.input : "";
      return {
        kind: "tool",
        tone: "default",
        label: "Tool call",
        mono: `[${toolName}] ${truncate(input)}`,
      };
    }
    case "tool_result":
      return { kind: "system", tone: "muted", label: "Tool result" };
    case "approval_requested": {
      const q = str(p, "question");
      const perm = str(p, "permission");
      return { kind: "approval", tone: "gold", label: "Approval requested", text: q ?? perm };
    }
    case "approval_resolved":
      return { kind: "approval", tone: "muted", label: "Approval resolved" };
    case "task_completed":
      return { kind: "quest", tone: "gold", label: "Quest completed" };
    case "task_failed":
      return { kind: "error", tone: "crimson", label: "Quest failed", text: str(p, "error") };
    case "error":
      return { kind: "error", tone: "crimson", label: "Error", text: str(p, "error") };
    case "usage": {
      const cost = typeof p.cost === "number" ? p.cost : undefined;
      return {
        kind: "system",
        tone: "muted",
        label: "Usage tick",
        text: cost !== undefined ? `$${cost.toFixed(4)}` : undefined,
      };
    }
    case "session_aborted":
      return { kind: "system", tone: "muted", label: "Session aborted" };
    case "unknown":
    default:
      return null;
  }
}
