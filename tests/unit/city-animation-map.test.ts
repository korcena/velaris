/**
 * U1 — unit tests for the pure city animation-map (src/components/city/animation-map.ts).
 */

import { describe, it, expect } from "vitest";
import {
  statusToVisualState,
  celebrationFromFrame,
  createCelebrationGuard,
  type CityVisualState,
} from "@/components/city/animation-map";
import type { HouseRuntimeStatus, HouseStatus, ExecutionEventDto, NotificationDto } from "@/shared/types";

const RUNTIME_STATUSES: HouseRuntimeStatus[] = [
  "idle",
  "planning",
  "working",
  "awaiting_approval",
  "awaiting_input",
];

describe("statusToVisualState", () => {
  it("maps active runtime statuses straight through", () => {
    for (const runtime of RUNTIME_STATUSES) {
      expect(statusToVisualState({ status: "active", runtimeStatus: runtime })).toBe(runtime);
    }
  });

  it("dimms disabled houses regardless of runtime", () => {
    for (const runtime of RUNTIME_STATUSES) {
      expect(statusToVisualState({ status: "disabled", runtimeStatus: runtime })).toBe("dimmed");
    }
  });

  it("dimms archived houses regardless of runtime", () => {
    for (const runtime of RUNTIME_STATUSES) {
      expect(statusToVisualState({ status: "archived", runtimeStatus: runtime })).toBe("dimmed");
    }
  });

  it("never returns 'dimmed' for an active house", () => {
    for (const runtime of RUNTIME_STATUSES) {
      expect(statusToVisualState({ status: "active", runtimeStatus: runtime })).not.toBe("dimmed");
    }
  });

  it("all outputs are valid CityVisualState values", () => {
    const valid: CityVisualState[] = ["idle", "planning", "working", "awaiting_approval", "awaiting_input", "dimmed"];
    for (const status of ["active", "disabled", "archived"] as HouseStatus[]) {
      for (const runtime of RUNTIME_STATUSES) {
        expect(valid).toContain(statusToVisualState({ status, runtimeStatus: runtime }));
      }
    }
  });
});

function eventFrame(type: string, houseId?: string, taskId?: string | null, payload: Record<string, unknown> = {}) {
  const ev: ExecutionEventDto = {
    id: 1,
    sessionId: null,
    taskId: taskId ?? null,
    houseId: houseId ?? null,
    rawType: type,
    type: type as ExecutionEventDto["type"],
    payload,
    createdAt: new Date().toISOString(),
  };
  return { type: "event", event: ev } as const;
}

function notifFrame(type: string, houseId?: string, taskId?: string | null) {
  const n: NotificationDto = {
    id: "n-1",
    type: type as NotificationDto["type"],
    title: "t",
    body: "b",
    houseId: houseId ?? null,
    taskId: taskId ?? null,
    approvalRequestId: null,
    read: false,
    createdAt: new Date().toISOString(),
  };
  return { type: "notification", notification: n } as const;
}

describe("celebrationFromFrame — event frames", () => {
  it("maps task_completed → completed", () => {
    expect(celebrationFromFrame(eventFrame("task_completed", "h1", "t1"))).toEqual({
      houseId: "h1",
      taskId: "t1",
      kind: "completed",
    });
  });
  it("maps task_failed → failed", () => {
    expect(celebrationFromFrame(eventFrame("task_failed", "h1", "t1"))).toEqual({
      houseId: "h1",
      taskId: "t1",
      kind: "failed",
    });
  });
  it("maps session_aborted → aborted", () => {
    expect(celebrationFromFrame(eventFrame("session_aborted", "h1", "t1"))).toEqual({
      houseId: "h1",
      taskId: "t1",
      kind: "aborted",
    });
  });
  it("returns null when houseId is missing", () => {
    expect(celebrationFromFrame(eventFrame("task_completed", undefined, "t1"))).toBeNull();
  });
  it("returns null when taskId is missing", () => {
    expect(celebrationFromFrame(eventFrame("task_completed", "h1", null))).toBeNull();
  });
  it("returns null for non-trigger event types", () => {
    for (const t of ["task_started", "session_started", "message", "tool_call", "tool_result", "approval_requested", "approval_resolved", "task_started", "error", "usage", "unknown"]) {
      expect(celebrationFromFrame(eventFrame(t, "h1", "t1"))).toBeNull();
    }
  });
});

describe("celebrationFromFrame — notification frames", () => {
  it("maps completion → completed", () => {
    expect(celebrationFromFrame(notifFrame("completion", "h1", "t1"))).toEqual({
      houseId: "h1",
      taskId: "t1",
      kind: "completed",
    });
  });
  it("maps failure → failed", () => {
    expect(celebrationFromFrame(notifFrame("failure", "h1", "t1"))).toEqual({
      houseId: "h1",
      taskId: "t1",
      kind: "failed",
    });
  });
  it("returns null for approval/system notifications", () => {
    expect(celebrationFromFrame(notifFrame("approval", "h1", "t1"))).toBeNull();
    expect(celebrationFromFrame(notifFrame("system", "h1", "t1"))).toBeNull();
  });
  it("returns null when ids missing", () => {
    expect(celebrationFromFrame(notifFrame("completion", undefined, "t1"))).toBeNull();
    expect(celebrationFromFrame(notifFrame("completion", "h1", null))).toBeNull();
  });
});

describe("celebrationFromFrame — other frames", () => {
  it("returns null for hello frames", () => {
    expect(celebrationFromFrame({ type: "hello", cursor: 0 })).toBeNull();
  });
});

describe("createCelebrationGuard", () => {
  it("true first time per taskId, false thereafter", () => {
    const guard = createCelebrationGuard();
    expect(guard.consume({ houseId: "h", taskId: "t1", kind: "completed" })).toBe(true);
    expect(guard.consume({ houseId: "h", taskId: "t1", kind: "completed" })).toBe(false);
  });

  it("false repeat even when kind differs", () => {
    const guard = createCelebrationGuard();
    expect(guard.consume({ houseId: "h", taskId: "t1", kind: "completed" })).toBe(true);
    expect(guard.consume({ houseId: "h", taskId: "t1", kind: "failed" })).toBe(false);
  });

  it("true for a different taskId", () => {
    const guard = createCelebrationGuard();
    expect(guard.consume({ houseId: "h", taskId: "t1", kind: "completed" })).toBe(true);
    expect(guard.consume({ houseId: "h", taskId: "t2", kind: "completed" })).toBe(true);
  });
});
