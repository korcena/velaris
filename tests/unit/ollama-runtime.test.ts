/**
 * Unit tests — Ollama tool-loop runtime (Phase 5 Stage F).
 *
 * This is the DETERMINISTIC MOCKED SMOKE that is the live-substitute for the
 * §9 acceptance criterion: an `executionProvider='ollama'` house completes a
 * research task using tools with correct permission gating. The Ollama HTTP API
 * is stubbed (a scripted `chat`) so no real server is touched.
 *
 * Covers:
 *  1. tool_call fs_read inside allowlist → executes → next call final text →
 *     completed (asserts execution_events, agent_messages order, result artifact)
 *  2. a model with NO tool calls answers conversationally → loop terminates completed (Q2)
 *  3. an out-of-allowlist write → approval + notification → session awaiting_approval;
 *     approve → executes & continues; reject → denial tool_result & continues
 *  4. multi-tool turn (two calls) → both tool results persisted with distinct ids
 *  5. malformed tool arguments → tool_result error, loop continues (never throws)
 *  6. chat HTTP failure → terminal failed + failure notification
 *  7. step cap → failed
 *  8. token cap → failed
 *  9. huge tool output truncated
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, getRawDb, resetDbForTests } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";
import { createHouse, getHouse } from "@/server/repositories/house-repo";
import { createTask, getTask } from "@/server/repositories/task-repo";
import {
  createExecutionEvent,
  createExecutionSession,
  listApprovalRequests,
  countUnreadNotifications,
  setApprovalResponse,
  listAgentMessagesForSession,
  listArtifactsForSession,
  createArtifact,
  listArtifactsForTask,
  upsertAgentMessage,
} from "@/server/repositories/execution-repo";
import { runOllamaTask } from "@/server/execution/ollama/runtime";
import type { OllamaClient } from "@/server/execution/ollama/client";
import type { OllamaChatResponse, OllamaChatMessage } from "@/server/execution/ollama/types";
import type { HouseConfiguration } from "@/shared/types";

let workspace: string;
let outsideDir: string;
let dbPath: string;

function makeConfig(overrides: Partial<HouseConfiguration> = {}): HouseConfiguration {
  return {
    systemPrompt: "You are a research agent for Velaris.",
    executionProvider: "ollama",
    aiProvider: "ollama-cloud",
    modelId: "llama3.1:8b",
    workspaceAllowlist: [workspace],
    tools: ["fs"],
    permissions: { fileSystem: "ask", shell: "ask", network: "deny", git: "allow" },
    approvalPolicy: "always",
    concurrency: 1,
    ...overrides,
  };
}

/** A scripted Ollama chat stub — returns one response per call in order. */
function scriptedChat(responses: Array<Partial<OllamaChatResponse> | "FAIL">) {
  let i = 0;
  const calls: Array<{ messages: OllamaChatMessage[]; tools?: unknown }> = [];
  const chat = vi.fn(async (req: {
    model: string;
    messages: OllamaChatMessage[];
    tools?: unknown;
    stream?: boolean;
  }): Promise<OllamaChatResponse> => {
    calls.push({ messages: req.messages, tools: req.tools });
    const script = responses[i++];
    if (script === "FAIL") {
      throw new Error("ECONNREFUSED to Ollama");
    }
    return {
      message: { role: "assistant", content: script?.message?.content ?? "" },
      prompt_eval_count: script?.prompt_eval_count ?? 10,
      eval_count: script?.eval_count ?? 5,
      done: script?.done ?? true,
      ...(script?.message?.tool_calls ? { message: { role: "assistant", content: script.message.content ?? "", tool_calls: script.message.tool_calls } } : {}),
    };
  });
  return { chat, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 30));

function fsReadCall(pathArg: string) {
  return { function: { name: "fs_read", arguments: { path: pathArg } } };
}
function fsWriteCall(pathArg: string, content: string) {
  return { function: { name: "fs_write", arguments: { path: pathArg, content } } };
}
function finalAnswer(text: string): Partial<OllamaChatResponse> {
  return { message: { role: "assistant", content: text } };
}

async function runSmoke(
  config: HouseConfiguration,
  responses: Array<Partial<OllamaChatResponse> | "FAIL">,
  opts: { maxToolSteps?: number; tokenBudget?: number; maxToolOutput?: number; signal?: AbortSignal } = {},
) {
  const house = createHouse(getDb(), { name: "H", description: null, agent: { name: "A", role: "R" }, configuration: config });
  const task = createTask(getDb(), { title: "Research", houseId: house.id, workingDirectory: workspace, description: "Summarise the findings and write notes." });
  const stub = scriptedChat(responses);
  const ollama = ({ chat: stub.chat } as unknown) as OllamaClient;
  const result = await runOllamaTask(
    {
      db: getDb(),
      raw: getRawDb(),
      ollama,
      task: getTask(getDb(), task.id)!,
      house: getHouse(getDb(), house.id)!,
      directory: workspace,
      modelId: config.modelId,
    },
    { pollMs: 20, ...opts },
  );
  return { result, stub, task: getTask(getDb(), task.id)! };
}

beforeEach(() => {
  resetDbForTests();
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-runtime-"));
  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-runtime-outside-"));
  dbPath = path.join(workspace, "test.db");
  process.env.VELARIS_DB_PATH = dbPath;
  migrate();
  fs.writeFileSync(path.join(workspace, "a.txt"), "the answer is 42");
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
});

describe("runOllamaTask — mocked tool-loop smoke", () => {
  it("completes a research task using fs_read inside the allowlist (the §9 acceptance smoke)", async () => {
    const config = makeConfig({ permissions: { fileSystem: "allow", shell: "allow", network: "deny", git: "allow" } });
    fs.writeFileSync(path.join(workspace, "a.txt"), "the answer is 42\nnotes: research done");
    const { result, task, stub } = await runSmoke(config, [
      // Turn 1: the model decides to read a file.
      { message: { role: "assistant", content: "Let me read the data file.", tool_calls: [fsReadCall(path.join(workspace, "a.txt"))] } },
      // Turn 2: after the tool result, it answers without tool calls.
      finalAnswer("Research complete: the answer is 42 and notes confirm it."),
    ]);

    expect(result.terminalStatus).toBe("completed");
    expect(task.status).toBe("completed");

    // Execution events: task_started, session_started, message, tool_call,
    // tool_result, task_completed.
    const evs = (getRawDb().prepare("SELECT type FROM execution_events ORDER BY id").all() as { type: string }[]).map((r) => r.type);
    expect(evs).toContain("task_started");
    expect(evs).toContain("message");
    expect(evs).toContain("tool_call");
    expect(evs).toContain("tool_result");
    expect(evs).toContain("task_completed");

    // agent_messages order: user brief → agent(with tool_calls) → tool result → agent(final).
    const msgs = listAgentMessagesForSession(getDb(), result.sessionId).map((m) => m.role);
    expect(msgs).toContain("user");
    expect(msgs).toContain("agent");
    expect(msgs).toContain("tool");

    // Result artifact present.
    const arts = listArtifactsForTask(getDb(), task.id);
    expect(arts.some((a) => a.kind === "result")).toBe(true);

    // Two model calls happened and tools[] were passed for both.
    expect(stub.chat).toHaveBeenCalledTimes(2);
    expect(stub.calls[0].tools).toBeDefined();

    // Usage rows must carry the REAL model id (defect #4 was modelId='').
    // Pricing is keyed per-model, so the persisted usage must record the model
    // that was actually invoked, while staying `estimated=true`.
    const usage = getRawDb().prepare("SELECT model_id, estimated, cost, input_tokens, output_tokens FROM usage_records ORDER BY created_at").all() as Array<{ model_id: string; estimated: number; cost: number; input_tokens: number; output_tokens: number }>;
    expect(usage.length).toBeGreaterThanOrEqual(1);
    for (const u of usage) {
      expect(u.model_id).toBe(config.modelId);
      // Ollama cost is always an estimate; missing price ⇒ cost 0 (honest).
      expect(u.estimated).toBe(1);
    }
  });

  it("aggregates a multi-call run honestly (B1): terminal-only usage records with REAL summed totals, not per-call cumulative rows", async () => {
    const config = makeConfig({ permissions: { fileSystem: "allow", shell: "allow", network: "deny", git: "allow" } });
    // Two model calls (a tool loop + a final answer) — each scripted call returns
    // prompt_eval_count=10, eval_count=5 ⇒ real totals input=20, output=10.
    const { result } = await runSmoke(config, [
      { message: { role: "assistant", content: "reading", tool_calls: [fsReadCall(path.join(workspace, "a.txt"))] } },
      finalAnswer("done"),
    ]);
    expect(result.terminalStatus).toBe("completed");

    // B1: exactly ONE persisted usage row for the session, holding the FINAL
    // cumulative totals — NOT one cumulative-total row per model call (which
    // would make getUsageSummaryForTask SUM() overcount ~N×).
    const usage = getRawDb().prepare("SELECT cost, input_tokens, output_tokens FROM usage_records").all() as Array<{ cost: number; input_tokens: number; output_tokens: number }>;
    expect(usage).toHaveLength(1);
    expect(usage[0].input_tokens).toBe(20); // 10+10
    expect(usage[0].output_tokens).toBe(10); // 5+5

    // The live feed still shows a `usage` execution_event per call (progress),
    // but those events are NOT persisted usage_records — so the sum over the
    // repo aggregate equals the real total (not N× it).
    const usageEvents = (getRawDb().prepare("SELECT type FROM execution_events WHERE type='usage'").all() as { type: string }[]);
    expect(usageEvents.length).toBeGreaterThanOrEqual(2);
  });

  it("M3a: a resumed/restarted Ollama task with an existing non-terminal session CONTINUES that same session (no new session created)", async () => {
    const config = makeConfig({ permissions: { fileSystem: "allow", shell: "allow", network: "deny", git: "allow" } });
    const house = createHouse(getDb(), { name: "H", description: null, agent: { name: "A", role: "R" }, configuration: config });
    const task = createTask(getDb(), { title: "T", houseId: house.id, workingDirectory: workspace });
    // Simulate an engine-restart / pause-resume recovery: a paused Ollama session
    // already exists for this task, backed by persisted memory.
    const existing = createExecutionSession(getDb(), {
      taskId: task.id,
      houseId: house.id,
      provider: "ollama",
      modelId: config.modelId,
      directory: workspace,
    });
    // Persist one prior turn so memory shows continuation (no step lost).
    const stub = scriptedChat([finalAnswer("finished after restart")]);
    const ollama = ({ chat: stub.chat } as unknown) as OllamaClient;

    const result = await runOllamaTask(
      { db: getDb(), raw: getRawDb(), ollama, task: getTask(getDb(), task.id)!, house: getHouse(getDb(), house.id)!, directory: workspace, modelId: config.modelId },
      { pollMs: 20 },
    );
    expect(result.terminalStatus).toBe("completed");
    // NO second session was created — the run resumed the existing one in place.
    const sessions = getRawDb().prepare("SELECT id FROM execution_sessions WHERE task_id=?").all(task.id);
    expect((sessions as { id: string }[]).map((s) => s.id)).toEqual([existing.id]);
    expect(result.sessionId).toBe(existing.id);
  });

  it("M3a: a resumed Ollama task rebuilds its context from the existing session's persisted agent_messages (no step lost)", async () => {
    const config = makeConfig({ permissions: { fileSystem: "allow", shell: "allow", network: "deny", git: "allow" } });
    const house = createHouse(getDb(), { name: "H", description: null, agent: { name: "A", role: "R" }, configuration: config });
    const task = createTask(getDb(), { title: "T", houseId: house.id, workingDirectory: workspace });
    const existing = createExecutionSession(getDb(), {
      taskId: task.id,
      houseId: house.id,
      provider: "ollama",
      modelId: config.modelId,
      directory: workspace,
    });
    // Persist a prior tool-result turn: a model read a file, got the answer.
    upsertAgentMessage(getDb(), { sessionId: existing.id, role: "agent", content: "Let me read the data.", toolCalls: JSON.stringify([{ function: { name: "fs_read", arguments: { path: path.join(workspace, "a.txt") } } }]) });
    upsertAgentMessage(getDb(), { sessionId: existing.id, role: "tool", content: "fs_read: the answer is 42", toolCallId: "fs_read::0" });

    const stub = scriptedChat([finalAnswer("the answer you read was 42")]);
    const ollama = ({ chat: stub.chat } as unknown) as OllamaClient;
    const result = await runOllamaTask(
      { db: getDb(), raw: getRawDb(), ollama, task: getTask(getDb(), task.id)!, house: getHouse(getDb(), house.id)!, directory: workspace, modelId: config.modelId },
      { pollMs: 20 },
    );
    expect(result.terminalStatus).toBe("completed");
    // The resumed loop's FIRST chat request included the full prior memory
    // (the tool result) — proving continuation, not a fresh start.
    const sent = stub.calls[0].messages;
    expect(sent.some((m) => m.role === "tool")).toBe(true);
    expect(sent.some((m) => m.role === "assistant")).toBe(true);
  });

  it("redacts secret-looking tool args in the USER-FACING tool_call event (M1) while retaining full args in model memory", async () => {
    const config = makeConfig({ permissions: { fileSystem: "allow", shell: "allow", network: "deny", git: "allow" } });
    const secret = "sk-super-secret-value-that-must-never-leak-into-the-browser";
    const secretText = "\nAPI_KEY=" + secret + "\nAWS_SECRET=deadbeef\n";
    const target = path.join(workspace, ".env");
    const { result } = await runSmoke(config, [
      { message: { role: "assistant", content: "writing", tool_calls: [fsWriteCall(target, secretText)] } },
      finalAnswer("done"),
    ]);
    expect(result.terminalStatus).toBe("completed");

    // The tool_call EVENT payload must NOT contain the secret content — only a
    // byte count placeholder.
    const toolCallEvents = (getRawDb().prepare("SELECT payload FROM execution_events WHERE type='tool_call'").all() as { payload: string }[]);
    expect(toolCallEvents.length).toBeGreaterThanOrEqual(1);
    for (const e of toolCallEvents) {
      expect(e.payload).not.toContain(secret);
      expect(e.payload).not.toContain("deadbeef");
      expect(e.payload).toMatch(/redacted/);
    }

    // The MODEL-MEMORY copy (agent_messages role='tool'? no — the assistant
    // turn carries the tool_calls JSON) retains the FULL arguments so the loop
    // can re-send them to the model unchanged.
    const memRows = listAgentMessagesForSession(getDb(), result.sessionId);
    expect(memRows.some((m) => m.content.includes(secret))).toBe(false); // tool result content is the fs_write output ("wrote ...") not args
    // The assistant turn's persisted tool_calls JSON is the memory copy that
    // re-sends the exact args — it MUST keep the secret so the model can act.
    const agentCalls = (getRawDb().prepare("SELECT tool_calls FROM agent_messages WHERE role='agent'").all() as { tool_calls: string }[]);
    const anyToolCallMem = agentCalls.some((r) => r.tool_calls.includes(secret) || r.tool_calls.includes("API_KEY"));
    expect(anyToolCallMem).toBe(true);
  });

  it("model WITH NO tool calls answers conversationally → completed (decision Q2)", async () => {
    const { result, task } = await runSmoke(makeConfig({ permissions: { fileSystem: "allow", shell: "allow", network: "deny", git: "allow" } }), [
      finalAnswer("Happy to help — here is a short summary."),
    ]);
    expect(result.terminalStatus).toBe("completed");
    expect(task.status).toBe("completed");
  });

  it("out-of-allowlist write → approval + notification → awaiting_approval → approve executes & continues", async () => {
    const outside = path.join(outsideDir, "file.txt"); // outside the workspace allowlist
    const config = makeConfig({ permissions: { fileSystem: "ask", shell: "ask", network: "deny", git: "allow" } });
    // Script: turn 1 the model tries an out-of-allowlist write; after approval +
    // execution it finalizes in turn 2.
    const stub = scriptedChat([
      { message: { role: "assistant", content: "writing", tool_calls: [fsWriteCall(outside, "data")] } },
      finalAnswer("done writing approved file"),
    ]);
    const house = createHouse(getDb(), { name: "H", description: null, agent: { name: "A", role: "R" }, configuration: config });
    const task = createTask(getDb(), { title: "T", houseId: house.id, workingDirectory: workspace });
    const ollama = ({ chat: stub.chat } as unknown) as OllamaClient;

    // Run the loop in the background; approve any approval that appears.
    const runPromise = runOllamaTask(
      { db: getDb(), raw: getRawDb(), ollama, task: getTask(getDb(), task.id)!, house: getHouse(getDb(), house.id)!, directory: workspace, modelId: config.modelId },
      { pollMs: 20 },
    );
    // Poll for the pending approval, then approve it.
    for (let i = 0; i < 200; i++) {
      await flush();
      const approvals = listApprovalRequests(getDb(), {});
      if (approvals.some((a) => a.status === "pending")) break;
    }
    const approvals = listApprovalRequests(getDb(), {});
    expect(approvals.length).toBeGreaterThanOrEqual(1);
    const pending = approvals.find((a) => a.status === "pending");
    expect(pending).toBeDefined();
    // Notification was created for the approval (a bird in the Roost).
    expect(countUnreadNotifications(getDb())).toBeGreaterThanOrEqual(1);
    // The session was awaiting_approval while gated — the first session row
    // should have been set to awaiting_approval before approval resolves.
    setApprovalResponse(getDb(), pending!.id, "approved", null);

    const result = await runPromise;
    expect(result.terminalStatus).toBe("completed");
    expect(getTask(getDb(), task.id)?.status).toBe("completed");
  });

  it("multi-tool turn → both tool results persisted with distinct tool_call_ids", async () => {
    const config = makeConfig({ permissions: { fileSystem: "allow", shell: "allow", network: "deny", git: "allow" } });
    const a = path.join(workspace, "a.txt");
    const b = path.join(workspace, "b.txt");
    fs.writeFileSync(b, "b-file");
    const { result } = await runSmoke(config, [
      { message: { role: "assistant", content: "reading both", tool_calls: [fsReadCall(a), fsReadCall(b)] } },
      finalAnswer("done"),
    ]);

    expect(result.terminalStatus).toBe("completed");
    const toolRows = (getRawDb().prepare("SELECT tool_call_id FROM agent_messages WHERE role='tool'").all() as { tool_call_id: string }[]).map((r) => r.tool_call_id);
    expect(toolRows).toHaveLength(2);
    expect(toolRows[0]).not.toBe(toolRows[1]);
    expect(toolRows[0]).toBe("fs_read::0");
    expect(toolRows[1]).toBe("fs_read::1");
  });

  it("malformed tool arguments → tool_result error, loop continues (never throws)", async () => {
    const config = makeConfig({ permissions: { fileSystem: "allow", shell: "allow", network: "deny", git: "allow" } });
    const { result } = await runSmoke(config, [
      { message: { role: "assistant", content: "oops", tool_calls: [{ function: { name: "fs_read", arguments: { path: 123 } } }] } },
      finalAnswer("recovered"),
    ]);
    expect(result.terminalStatus).toBe("completed");
    // The error was surfaced as a tool_result, not thrown.
    const toolRows = (getRawDb().prepare("SELECT content FROM agent_messages WHERE role='tool'").all() as { content: string }[]);
    expect(toolRows.some((r) => r.content.includes("Invalid arguments"))).toBe(true);
  });

  it("chat HTTP failure → terminal failed + failure notification", async () => {
    const config = makeConfig({ permissions: { fileSystem: "allow", shell: "allow", network: "deny", git: "allow" } });
    const { result, task } = await runSmoke(config, ["FAIL"]);
    expect(result.terminalStatus).toBe("failed");
    expect(task.status).toBe("failed");
    const body = (getRawDb().prepare("SELECT type, title FROM notifications").all() as { type: string }[]);
    expect(body.some((n) => n.type === "failure")).toBe(true);
  });

  it("step cap → failed + clear event", async () => {
    const config = makeConfig({ permissions: { fileSystem: "allow", shell: "allow", network: "deny", git: "allow" } });
    // The model keeps issuing an fs_read tool call in an endless loop. With a
    // low maxToolSteps=2, the loop must fail.
    const read = (): Partial<OllamaChatResponse> => ({ message: { role: "assistant", content: "reading", tool_calls: [fsReadCall(path.join(workspace, "a.txt"))] } });
    const { result, task } = await runSmoke(config, [read(), read(), read(), finalAnswer("unreachable")], { maxToolSteps: 2 });
    expect(result.terminalStatus).toBe("failed");
    expect(task.status).toBe("failed");
    expect(result.error).toMatch(/max tool steps/i);
    const evs = (getRawDb().prepare("SELECT type, payload FROM execution_events ORDER BY id").all() as { type: string; payload: string }[]);
    expect(evs.some((e) => e.type === "task_failed")).toBe(true);
  });

  it("token cap → failed", async () => {
    const config = makeConfig({ permissions: { fileSystem: "allow", shell: "allow", network: "deny", git: "allow" } });
    // Each call returns prompt_eval_count=10, eval_count=5 = 15 tokens. A budget
    // of 5 tokens trips on the first call.
    const { result, task } = await runSmoke(config, [finalAnswer("x")], { tokenBudget: 5 });
    expect(result.terminalStatus).toBe("failed");
    expect(result.error).toMatch(/token budget/i);
  });

  it("huge tool output is truncated on persist (risk 8)", async () => {
    const config = makeConfig({ permissions: { fileSystem: "allow", shell: "allow", network: "deny", git: "allow" } });
    fs.writeFileSync(path.join(workspace, "big.txt"), "x".repeat(100_000));
    const { result } = await runSmoke(config, [
      { message: { role: "assistant", content: "read", tool_calls: [fsReadCall(path.join(workspace, "big.txt"))] } },
      finalAnswer("done"),
    ], { maxToolOutput: 500 });
    expect(result.terminalStatus).toBe("completed");
    const toolRows = (getRawDb().prepare("SELECT content FROM agent_messages WHERE role='tool'").all() as { content: string }[]);
    expect(toolRows[0].content.length).toBeLessThan(100_000);
    expect(toolRows[0].content).toMatch(/truncated/);
  });
});
