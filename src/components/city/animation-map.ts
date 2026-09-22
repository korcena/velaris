/**
 * Pure city animation mapping & celebration logic (Phase 3).
 *
 * This module is intentionally React-free so it can be unit-tested in the
 * node environment without any DOM. It maps house config + derived runtime
 * status to a visual state for the city skyline, and derives celebration
 * triggers from realtime stream frames.
 */

import type {
  RealtimeEvent,
  HouseStatus,
  HouseRuntimeStatus,
  ExecutionEventType,
  NotificationType,
} from "@/shared/types";

/**
 * Visual state a single city building should render.
 * All statuses are driven by CSS `[data-state]` selectors (see globals.css);
 * `dimmed` is for disabled/archived houses.
 */
export type CityVisualState =
  | "idle"
  | "planning"
  | "working"
  | "awaiting_approval"
  | "awaiting_input"
  | "dimmed";

/**
 * Map a house's config + runtime status to a city visual state.
 * Archived/disabled houses render dimmed (no animations); active houses are
 * driven by their derived runtime status.
 */
export function statusToVisualState(house: {
  status: HouseStatus;
  runtimeStatus: HouseRuntimeStatus;
}): CityVisualState {
  if (house.status === "disabled" || house.status === "archived") return "dimmed";
  return house.runtimeStatus;
}

/** The kind of celebration to render for a finished / failed / aborted quest. */
export type CelebrationKind = "completed" | "failed" | "aborted";

/** A celebration trigger for a specific house + task. */
export interface CelebrationTrigger {
  houseId: string;
  taskId: string;
  kind: CelebrationKind;
}

type EventTriggerType = Extract<
  ExecutionEventType,
  "task_completed" | "task_failed" | "session_aborted"
>;

const EVENT_KIND: Record<EventTriggerType, CelebrationKind> = {
  task_completed: "completed",
  task_failed: "failed",
  session_aborted: "aborted",
};

type NotificationTriggerType = Extract<NotificationType, "completion" | "failure">;

const NOTIFICATION_KIND: Record<NotificationTriggerType, CelebrationKind> = {
  completion: "completed",
  failure: "failed",
};

/**
 * Derive a celebration trigger from a realtime stream frame, or null if the
 * frame is not a celebration-bearing event/notification.
 *
 * Event frames: task_completed → completed, task_failed → failed,
 * session_aborted → aborted. Notification frames: completion → completed,
 * failure → failed. Returns null when the frame type is unrelated or when the
 * house/task ids are missing.
 */
export function celebrationFromFrame(frame: RealtimeEvent): CelebrationTrigger | null {
  if (frame.type === "event") {
    const ev = frame.event;
    const kind = EVENT_KIND[ev.type as EventTriggerType];
    if (!kind) return null;
    if (!ev.houseId || !ev.taskId) return null;
    return { houseId: ev.houseId, taskId: ev.taskId, kind };
  }
  if (frame.type === "notification") {
    const n = frame.notification;
    const kind = NOTIFICATION_KIND[n.type as NotificationTriggerType];
    if (!kind) return null;
    if (!n.houseId || !n.taskId) return null;
    return { houseId: n.houseId, taskId: n.taskId, kind };
  }
  // hello frames carry nothing to celebrate.
  return null;
}

/**
 * In-memory per-page-load guard that ensures each taskId only celebrates once.
 * Refresh-safe because /api/stream starts at the latest cursor and never
 * replays history, so the guard only ever sees NEW task completions.
 */
export interface CelebrationGuard {
  /** Returns true the first time a taskId is seen, false thereafter. */
  consume(t: CelebrationTrigger): boolean;
}

export function createCelebrationGuard(): CelebrationGuard {
  const seen = new Set<string>();
  return {
    consume(t: CelebrationTrigger): boolean {
      if (seen.has(t.taskId)) return false;
      seen.add(t.taskId);
      return true;
    },
  };
}
