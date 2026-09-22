/**
 * U4 — unit tests for describeExecutionEvent (src/components/houses/activity/describe-event.ts).
 */

import { describe, it, expect } from "vitest";
import { describeExecutionEvent } from "@/components/houses/activity/describe-event";
import type { ExecutionEventDto, ExecutionEventType } from "@/shared/types";

function ev(type: ExecutionEventType, payload: Record<string, unknown> = {}): ExecutionEventDto {
  return {
    id: 1,
    sessionId: "s1",
    taskId: "t1",
    houseId: "h1",
    rawType: type,
    type,
    payload,
    createdAt: "2024-01-01T00:00:00.000Z",
  };
}

describe("describeExecutionEvent mapping", () => {
  const cases: Array<{
    type: ExecutionEventType;
    payload?: Record<string, unknown>;
    label: string;
    tone: string;
    kind: string;
    text?: string;
    mono?: string;
  }> = [
    { type: "task_started", payload: { title: "Build the wall" }, label: "Quest began", tone: "gold", kind: "quest", text: "Build the wall" },
    { type: "session_started", label: "Session opened", tone: "muted", kind: "system" },
    { type: "message", payload: { text: "Catalog done." }, label: "Message", tone: "default", kind: "text", text: "Catalog done." },
    { type: "tool_call", payload: { tool: { tool: "fs", input: "write /a" } }, label: "Tool call", tone: "default", kind: "tool", mono: "[fs] write /a" },
    { type: "tool_result", label: "Tool result", tone: "muted", kind: "system" },
    { type: "approval_requested", payload: { permission: "run" }, label: "Approval requested", tone: "gold", kind: "approval", text: "run" },
    { type: "approval_requested", payload: { question: "Which stack?" }, label: "Approval requested", tone: "gold", kind: "approval", text: "Which stack?" },
    { type: "approval_resolved", label: "Approval resolved", tone: "muted", kind: "approval" },
    { type: "task_completed", label: "Quest completed", tone: "gold", kind: "quest" },
    { type: "task_failed", payload: { error: "build broke" }, label: "Quest failed", tone: "crimson", kind: "error", text: "build broke" },
    { type: "error", payload: { error: "boom" }, label: "Error", tone: "crimson", kind: "error", text: "boom" },
    { type: "usage", payload: { cost: 1.2345 }, label: "Usage tick", tone: "muted", kind: "system", text: "$1.2345" },
    { type: "session_aborted", label: "Session aborted", tone: "muted", kind: "system" },
  ];

  it.each(cases)("describes $type as '$label'", (c) => {
    const item = describeExecutionEvent(ev(c.type, c.payload));
    expect(item).not.toBeNull();
    expect(item!.label).toBe(c.label);
    expect(item!.tone).toBe(c.tone as never);
    expect(item!.kind).toBe(c.kind as never);
    if (c.text !== undefined) expect(item!.text).toBe(c.text);
    if (c.mono !== undefined) expect(item!.mono).toBe(c.mono);
  });

  it("returns null for unknown types", () => {
    expect(describeExecutionEvent(ev("unknown"))).toBeNull();
  });

  it("does not throw on empty/odd payloads", () => {
    for (const type of [
      "task_started",
      "session_started",
      "message",
      "tool_call",
      "tool_result",
      "approval_requested",
      "approval_resolved",
      "task_completed",
      "task_failed",
      "error",
      "usage",
      "session_aborted",
      "unknown",
    ] as ExecutionEventType[]) {
      expect(() => describeExecutionEvent(ev(type, {}))).not.toThrow();
    }
  });

  it("yields a muted usage item without cost when payload lacks it", () => {
    const item = describeExecutionEvent(ev("usage", {}));
    expect(item!.label).toBe("Usage tick");
    expect(item!.text).toBeUndefined();
  });

  it("yields a null-text message when the payload has no text", () => {
    const item = describeExecutionEvent(ev("message", {}));
    expect(item!.kind).toBe("text");
    expect(item!.text).toBeUndefined();
  });

  it("falls back to a generic tool chip when the tool shape is unexpected", () => {
    const item = describeExecutionEvent(ev("tool_call", {}));
    expect(item!.mono).toMatch(/\[tool\]/);
  });

  it("prefers question over permission text for approval_requested", () => {
    const item = describeExecutionEvent(
      ev("approval_requested", { question: "Q?", permission: "run" }),
    );
    expect(item!.text).toBe("Q?");
  });
});
