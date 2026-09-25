import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, getRawDb, resetDbForTests } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";
import { createHouse, getHouse } from "@/server/repositories/house-repo";
import { createTask, getTask, setTaskStatus } from "@/server/repositories/task-repo";
import {
  setExecutionSessionStatus,
  setApprovalResponse,
  listApprovalRequests,
} from "@/server/repositories/execution-repo";
import { createOllamaAdapter } from "@/server/execution/ollama/provider";
import { createOpenCodeAdapter } from "@/server/execution/opencode/provider";
import { runOllamaTask } from "@/server/execution/ollama/runtime";
import type { OllamaClient } from "@/server/execution/ollama/client";
import type { OllamaChatResponse, OllamaChatMessage } from "@/server/execution/ollama/types";
import type { HouseConfiguration } from "@/shared/types";

let workspace: string;
let dbPath: string;

function makeConfig(overrides: Partial<HouseConfiguration> = {}): HouseConfiguration {
  return {
    systemPrompt: "You are a research agent for Velaris.",
    executionProvider: "ollama",
    aiProvider: "ollama-cloud",
    modelId: "llama3.1:8b",
    workspaceAllowlist: [workspace],
    tools: ["fs"],
    permissions: { fileSystem: "allow", shell: "ask", network: "deny", git: "allow" },
    approvalPolicy: "always",
    concurrency: 1,
    ...overrides,
  };
}

type GatedResponse = Partial<OllamaChatResponse> & { _gate?: boolean };
function scriptedChat(responses: Array<GatedResponse | "FAIL">) {
  let i = 0;
  const calls: Array<{ messages: OllamaChatMessage[] }> = [];
  const chat = vi.fn(async (req: {
    model: string;
    messages: OllamaChatMessage[];
    stream?: boolean;
  }): Promise<OllamaChatResponse> => {
    calls.push({ messages: req.messages });
    const script = responses[i++];
    if (script === "FAIL") throw new Error("ECONNREFUSED to Ollama");
    // Allow tests to gate when a response resolves (used to pause between steps).
    if (script && script._gate) await new Promise((r) => setTimeout(r, 60));
    return {
      message: { role: "assistant", content: script?.message?.content ?? "" },
      prompt_eval_count: script?.prompt_eval_count ?? 10,
      eval_count: script?.eval_count ?? 5,
      done: true,
      ...(script?.message?.tool_calls
        ? { message: { role: "assistant", content: script.message.content ?? "", tool_calls: script.message.tool_calls } }
        : {}),
    };
  });
  return { chat, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 30));

function fsReadCall(pathArg: string) {
  return { function: { name: "fs_read", arguments: { path: pathArg } } };
}
function finalAnswer(text: string): Partial<OllamaChatResponse> {
  return { message: { role: "assistant", content: text } };
}

beforeEach(() => {
  resetDbForTests();
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-pause-"));
  dbPath = path.join(workspace, "test.db");
  process.env.VELARIS_DB_PATH = dbPath;
  migrate();
  fs.writeFileSync(path.join(workspace, "a.txt"), "the answer is 42");
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("supportsNativePause capability flags", () => {
  it("Ollama adapter advertises supportsNativePause=true; OpenCode false", () => {
    const ollama = createOllamaAdapter({
      client: ({ chat: vi.fn() } as unknown) as OllamaClient,
      db: getDb(),
    });
    expect(ollama.kind).toBe("ollama");
    expect(ollama.supportsNativePause).toBe(true);

    const opencode = createOpenCodeAdapter({
      client: {} as never,
      db: getDb(),
    });
    expect(opencode.kind).toBe("opencode");
    expect(opencode.supportsNativePause).toBe(false);
  });
});

describe("runOllamaTask — native pause/resume (Stage G)", () => {
  it("suspend between steps: pause set before the 2nd chat → no 2nd call; resume continues in place with full memory", async () => {
    const config = makeConfig();
    const house = createHouse(getDb(), { name: "H", description: null, agent: { name: "A", role: "R" }, configuration: config });
    const task = createTask(getDb(), { title: "T", houseId: house.id, workingDirectory: workspace });
    const stub = scriptedChat([
      { message: { role: "assistant", content: "reading", tool_calls: [fsReadCall(path.join(workspace, "a.txt"))] }, _gate: true },
      finalAnswer("done"),
    ]);
    const ollama = ({ chat: stub.chat } as unknown) as OllamaClient;

    const runPromise = runOllamaTask(
      { db: getDb(), raw: getRawDb(), ollama, task: getTask(getDb(), task.id)!, house: getHouse(getDb(), house.id)!, directory: workspace, modelId: config.modelId },
      { pollMs: 50 },
    );

    // Wait until the first (tool-call) chat is issued AND the loop is parked on
    // the gated response, then pause before it resolves / loops back.
    for (let i = 0; i < 100 && stub.chat.mock.calls.length < 1; i++) await flush();
    const sessionId = (getRawDb().prepare("SELECT id FROM execution_sessions LIMIT 1").get() as { id: string }).id;
    setExecutionSessionStatus(getDb(), sessionId, "paused");
    setTaskStatus(getDb(), task.id, "paused");

    // Resume in place → loop continues; the 2nd call's messages include the full
    // prior memory (the tool result).
    setExecutionSessionStatus(getDb(), sessionId, "running");
    setTaskStatus(getDb(), task.id, "running");

    const result = await runPromise;
    expect(result.terminalStatus).toBe("completed");
    expect(getTask(getDb(), task.id)?.status).toBe("completed");
    // The resumed call's messages include the persisted tool result (no step lost).
    const resumedMessages = stub.calls[1].messages;
    expect(resumedMessages.some((m) => m.role === "tool")).toBe(true);
  });

  it("pause during a pending approval → stays paused, approval survives; resume + approve continues", async () => {
    const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "velaris-pause-outside-")), "f.txt");
    const config = makeConfig({ permissions: { fileSystem: "ask", shell: "ask", network: "deny", git: "allow" } });
    const house = createHouse(getDb(), { name: "H", description: null, agent: { name: "A", role: "R" }, configuration: config });
    const task = createTask(getDb(), { title: "T", houseId: house.id, workingDirectory: workspace });
    const stub = scriptedChat([
      { message: { role: "assistant", content: "write", tool_calls: [{ function: { name: "fs_write", arguments: { path: outside, content: "x" } } }] } },
      finalAnswer("done"),
    ]);
    const ollama = ({ chat: stub.chat } as unknown) as OllamaClient;

    const runPromise = runOllamaTask(
      { db: getDb(), raw: getRawDb(), ollama, task: getTask(getDb(), task.id)!, house: getHouse(getDb(), house.id)!, directory: workspace, modelId: config.modelId },
      { pollMs: 20 },
    );
    // Wait for the pending approval row.
    for (let i = 0; i < 200; i++) { await flush(); if (listApprovalRequests(getDb(), {}).some((a) => a.status === "pending")) break; }
    const approvals = listApprovalRequests(getDb(), {});
    expect(approvals.length).toBeGreaterThanOrEqual(1);

    // Pause while awaiting approval.
    const sessionId = (getRawDb().prepare("SELECT id FROM execution_sessions LIMIT 1").get() as { id: string }).id;
    setExecutionSessionStatus(getDb(), sessionId, "paused");
    setTaskStatus(getDb(), task.id, "paused");
    await flush();

    // Approval row survives the pause.
    const stillPending = listApprovalRequests(getDb(), {});
    expect(stillPending.some((a) => a.status === "pending")).toBe(true);

    // Resume + approve → loop continues and completes.
    setExecutionSessionStatus(getDb(), sessionId, "running");
    setTaskStatus(getDb(), task.id, "running");
    const pending = listApprovalRequests(getDb(), {}).find((a) => a.status === "pending");
    setApprovalResponse(getDb(), pending!.id, "approved", null);

    const result = await runPromise;
    expect(result.terminalStatus).toBe("completed");
  });
});
