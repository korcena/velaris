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
      return describePlanMessage(p);
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

/**
 * Describe a High Lord plan-flavored `message` event (Phase 4 §6). The
 * orchestrator writes execution_events of type `message` with structured
 * payload keys (plan / subtask / revision / budget / steer) so the Court board
 * and the High Lord's house Activity tab read well. Non-plan messages fall
 * back to the generic text label.
 */
function describePlanMessage(
  p: Record<string, unknown>,
): ActivityItem {
  if (p.plan === true) {
    // A plan was drafted / revised.
    const subtasks = p.subtasks as Array<{ planId?: string; title?: string; house?: unknown }> | undefined;
    if (subtasks && subtasks.length > 0) {
      return {
        kind: "text",
        tone: "gold",
        label: `Plan drafted — ${subtasks.length} subtask${subtasks.length === 1 ? "" : "s"}`,
        text: subtasks.map((s) => `${s.planId ?? "?"}: ${s.title ?? ""}`).join("\n"),
      };
    }
    if (p.revision === true) {
      const added = Array.isArray(p.added) ? (p.added as string[]).length : 0;
      const cancelled = Array.isArray(p.cancelled) ? (p.cancelled as string[]).length : 0;
      const changed = Array.isArray(p.changed) ? (p.changed as string[]).length : 0;
      return {
        kind: "text",
        tone: "gold",
        label: "Plan revised",
        text: `${added} added · ${cancelled} cancelled · ${changed} changed`,
      };
    }
    return { kind: "text", tone: "gold", label: "Plan drafted" };
  }

  if (typeof p.subtask === "string") {
    // A subtask state change: { subtask: planId, state: "..." }.
    const state = str(p, "state") ?? "updated";
    return {
      kind: "text",
      tone: "default",
      label: `Subtask ${p.subtask} ${state}`,
    };
  }

  if (p.budget === true) {
    return { kind: "text", tone: "crimson", label: "Token budget exceeded", text: str(p, "reason") };
  }

  if (p.steer === true) {
    return { kind: "text", tone: "muted", label: "Steering reply (no plan change)" };
  }

  // Phase 5 native pause/resume message events ({ pause: true/false }) — the
  // Ollama runtime emits these on the pause/resume routes so the Activity feed
  // reads well.
  if (p.pause === true) {
    return { kind: "system", tone: "gold", label: "Quest paused", text: str(p, "note") };
  }
  if (p.pause === false) {
    return { kind: "system", tone: "default", label: "Quest resumed", text: str(p, "note") };
  }

  return { kind: "text", tone: "default", label: "Message", text: str(p, "text") };
}
