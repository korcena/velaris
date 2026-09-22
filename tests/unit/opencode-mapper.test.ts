/**
 * Unit tests — OpenCode SSE event mapper (src/server/execution/opencode/events/mapper.ts).
 *
 * The mapper converts a raw OpenCode ProviderEvent into a Velaris-normalized
 * MappedEvent. These tests pin the mapping rules from AGENT_ORCHESTRATION §3:
 *  1. known event types map to the expected ExecutionEvent-ish shape
 *  2. unknown event types are tolerated (mapped to `unknown`, never throw)
 *  3. chain-of-thought / reasoning parts are NOT surfaced as message content
 *  4. provider message id extraction (used for agent-message dedupe)
 */

import { describe, it, expect } from "vitest";
import { mapProviderEvent } from "@/server/execution/opencode/events/mapper";
import type { ProviderEvent } from "@/server/opencode";

/** Build a ProviderEvent helper. */
function ev(type: string, props: Record<string, unknown> = {}): ProviderEvent {
  return { id: "e1", type, properties: props };
}

describe("mapProviderEvent — session lifecycle", () => {
  it("maps session.created / next.prompted → session_started", () => {
    for (const t of ["session.created", "session.next.prompted", "session.created.v2"]) {
      const m = mapProviderEvent(ev(t, { sessionID: "s1" }));
      expect(m).not.toBeNull();
      expect(m!.type).toBe("session_started");
      expect(m!.providerSessionID).toBe("s1");
    }
  });

  it("session.updated → usage with cost/tokens snapshot", () => {
    const m = mapProviderEvent(
      ev("session.updated", {
        sessionID: "s1",
        info: {
          cost: 1.25,
          tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3 } },
        },
      }),
    );
    expect(m!.type).toBe("usage");
    expect(m!.usage).toEqual({
      cost: 1.25,
      input: 10,
      output: 5,
      reasoning: 2,
      cacheRead: 3,
    });
  });
});

describe("mapProviderEvent — assistant messages", () => {
  it("message.updated (assistant with text) → message + providerMessageId", () => {
    const m = mapProviderEvent(
      ev("message.updated", {
        sessionID: "s1",
        messageID: "msg-1",
        part: { kind: "text", type: "text", text: "Hello world" },
        info: { role: "assistant" },
      }),
    );
    expect(m!.type).toBe("message");
    expect(m!.assistantText).toBe("Hello world");
    expect(m!.providerMessageId).toBe("msg-1");
  });

  it("message.updated (user role) is dropped into `unknown` (not surfaced)", () => {
    const m = mapProviderEvent(
      ev("message.updated", {
        sessionID: "s1",
        part: { type: "text", text: "user's own prompt mirror" },
        info: { role: "user" },
      }),
    );
    // Non-assistant text is not new assistant content.
    expect(m!.type).toBe("unknown");
    expect(m!.assistantText).toBeUndefined();
  });

  it("message.part.updated (text) → message with messageID extraction from props/part", () => {
    const viaProps = mapProviderEvent(
      ev("message.part.updated", {
        sessionID: "s1",
        messageID: "m-a",
        part: { type: "text", text: "delta A" },
      }),
    );
    expect(viaProps!.type).toBe("message");
    expect(viaProps!.assistantText).toBe("delta A");
    expect(viaProps!.providerMessageId).toBe("m-a");

    const viaPart = mapProviderEvent(
      ev("message.part.updated", {
        sessionID: "s1",
        part: { type: "text", text: "delta B", messageID: "m-b" },
      }),
    );
    expect(viaPart!.providerMessageId).toBe("m-b");
  });
});

describe("mapProviderEvent — chain-of-thought / structural parts are NOT surfaced", () => {
  it.each(["reasoning", "step-start", "compaction"])(
    "part type %s → mapped to unknown (never message content)",
    (partType) => {
      const m = mapProviderEvent(
        ev("message.part.updated", {
          sessionID: "s1",
          part: { type: partType, text: "internal chain-of-thought" },
        }),
      );
      expect(m!.type).toBe("unknown");
      expect(m!.assistantText).toBeUndefined();
      // The reason is recorded so nothing surfaces as a user-visible message.
      expect(String(m!.payload.reason)).toBe("cot_or_structural");
    },
  );

  it("message.part.updated with empty text → dropped (unknown)", () => {
    const m = mapProviderEvent(
      ev("message.part.updated", { sessionID: "s1", part: { type: "text", text: "" } }),
    );
    expect(m!.type).toBe("unknown");
    expect(m!.assistantText).toBeUndefined();
  });
});

describe("mapProviderEvent — tool events", () => {
  it("message.part.updated tool part → tool_call", () => {
    const m = mapProviderEvent(
      ev("message.part.updated", {
        sessionID: "s1",
        part: { type: "tool", tool: "fs", callID: "c1", input: { path: "/x" } },
      }),
    );
    expect(m!.type).toBe("tool_call");
    expect(m!.payload.tool).toEqual({
      callID: "c1",
      tool: "fs",
      input: JSON.stringify({ path: "/x" }),
    });
  });

  it("session.next.tool.called → tool_call", () => {
    const m = mapProviderEvent(
      ev("session.next.tool.called", { sessionID: "s1", tool: "bash", callID: "c2", input: "ls" }),
    );
    expect(m!.type).toBe("tool_call");
    const call = m!.payload.tool as { tool: string };
    expect(call.tool).toBe("bash");
  });

  it("tool input/result + shell + step-ended → tool_result", () => {
    for (const t of [
      "session.next.tool.input.ended",
      "session.next.tool.result",
      "session.next.step.ended",
      "session.next.shell.started",
      "session.next.shell.ended",
    ]) {
      expect(mapProviderEvent(ev(t, { sessionID: "s1" }))!.type).toBe("tool_result");
    }
  });
});

describe("mapProviderEvent — failures", () => {
  it("session.next.step.failed → error with failed:true", () => {
    const m = mapProviderEvent(
      ev("session.next.step.failed", {
        sessionID: "s1",
        error: { message: "boom" },
      }),
    );
    expect(m!.type).toBe("error");
    expect(m!.failed).toBe(true);
    expect(m!.payload.error).toBe("boom");
  });

  it("session.next.step.failed without an error object → generic message", () => {
    const m = mapProviderEvent(ev("session.next.step.failed", { sessionID: "s1" }));
    expect(m!.failed).toBe(true);
    expect(m!.payload.error).toBe("step failed");
  });
});

describe("mapProviderEvent — permissions & questions", () => {
  it("permission.updated with a pending request → approval_requested + PendingApproval", () => {
    const m = mapProviderEvent(
      ev("permission.updated", {
        sessionID: "s1",
        request: { id: "per-1", permission: "write", patterns: ["/a", "/b"] },
      }),
    );
    expect(m!.type).toBe("approval_requested");
    expect(m!.approval).toEqual({
      kind: "permission",
      providerRequestId: "per-1",
      title: "Permission: write",
      message: "write — /a, /b",
      options: [],
    });
  });

  it("permission.updated resolved (no request) → approval_resolved", () => {
    const m = mapProviderEvent(ev("permission.updated", { sessionID: "s1" }));
    expect(m!.type).toBe("approval_resolved");
  });

  it("question.updated → approval_requested with options", () => {
    const m = mapProviderEvent(
      ev("question.updated", {
        sessionID: "s1",
        request: {
          id: "q-1",
          questions: [
            {
              header: "Which stack?",
              question: "Choose a language",
              options: [{ id: "ts", label: "TypeScript" }, { id: "py", label: "Python" }],
            },
          ],
        },
      }),
    );
    expect(m!.type).toBe("approval_requested");
    expect(m!.approval!.kind).toBe("question");
    expect(m!.approval!.providerRequestId).toBe("q-1");
    expect(m!.approval!.title).toBe("Which stack?");
    expect(m!.approval!.options).toEqual([
      { id: "ts", label: "TypeScript" },
      { id: "py", label: "Python" },
    ]);
  });
});

describe("mapProviderEvent — unknown tolerance", () => {
  it("unknown event types are tolerated (mapped to unknown, no throw)", () => {
    const m = mapProviderEvent(ev("some.future.event.type", { sessionID: "s1" }));
    expect(m).not.toBeNull();
    expect(m!.type).toBe("unknown");
    expect(m!.rawType).toBe("some.future.event.type");
    // Raw payload preserved so nothing is dropped.
    expect((m!.payload.providerEvent as { type: string }).type).toBe("some.future.event.type");
  });

  it("tolerates a non-string event type (no throw)", () => {
    const weird = { id: "e", type: 42 } as unknown as ProviderEvent;
    const m = mapProviderEvent(weird);
    expect(m).not.toBeNull();
    expect(m!.type).toBe("unknown");
  });
});
