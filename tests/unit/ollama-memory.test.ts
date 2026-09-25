/**
 * Unit tests — Ollama conversation memory rebuild + trimming (Phase 5 Stage F).
 *
 * Covers buildOllamaMessages: role mapping (user→user, agent→assistant with
 * re-attached tool_calls, tool→tool with tool_name), context-budget trimming,
 * and that assistant tool_calls are never split from their following tool
 * results.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, getRawDb, resetDbForTests } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";
import { createHouse } from "@/server/repositories/house-repo";
import { createTask } from "@/server/repositories/task-repo";
import { createExecutionSession, upsertAgentMessage } from "@/server/repositories/execution-repo";
import { buildOllamaMessages } from "@/server/execution/ollama/memory";
import type { HouseConfiguration } from "@/shared/types";

let tmpDir: string;
let dbPath: string;

function makeConfig(): HouseConfiguration {
  return {
    systemPrompt: "sys",
    executionProvider: "ollama",
    aiProvider: "ollama-cloud",
    modelId: "m",
    workspaceAllowlist: [tmpDir],
    tools: ["fs"],
    permissions: { fileSystem: "ask", shell: "ask", network: "deny", git: "allow" },
    approvalPolicy: "always",
    concurrency: 1,
  };
}

beforeEach(() => {
  resetDbForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-memory-"));
  dbPath = path.join(tmpDir, "test.db");
  process.env.VELARIS_DB_PATH = dbPath;
  migrate();
  const house = createHouse(getDb(), { name: "H", description: null, agent: { name: "A", role: "R" }, configuration: makeConfig() });
  const task = createTask(getDb(), { title: "T", houseId: house.id });
  sessionId = createExecutionSession(getDb(), { taskId: task.id, houseId: house.id, provider: "ollama", modelId: "m", directory: tmpDir }).id;
});

let sessionId: string;

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("buildOllamaMessages", () => {
  it("maps roles and re-attaches tool_calls on assistant turns", () => {
    upsertAgentMessage(getDb(), { sessionId, role: "user", content: "q1" });
    upsertAgentMessage(getDb(), { sessionId, role: "agent", content: "reading", toolCalls: JSON.stringify([{ function: { name: "fs_read", arguments: { path: "/a" } } }]) });
    upsertAgentMessage(getDb(), { sessionId, role: "tool", content: "fs_read: content", toolCallId: "fs_read::0" });

    const msgs = buildOllamaMessages(getDb(), sessionId, "sys-prompt", "task-brief");
    expect(msgs[0]).toEqual({ role: "system", content: "sys-prompt" });
    expect(msgs[1]).toEqual({ role: "user", content: "task-brief" });
    expect(msgs[2]).toEqual({ role: "user", content: "q1" });
    expect(msgs[3].role).toBe("assistant");
    expect((msgs[3] as { tool_calls?: unknown[] }).tool_calls).toHaveLength(1);
    const tool = msgs.find((m) => m.role === "tool");
    expect(tool).toBeDefined();
    expect((tool as { tool_name?: string }).tool_name).toBe("fs_read");
    expect(tool?.content).toBe("fs_read: content");
  });

  it("trims to the context budget but NEVER splits an assistant tool_calls from its tool results", () => {
    // Persist a long series: user/agent/tool triples, with very large user messages.
    for (let i = 0; i < 10; i++) {
      upsertAgentMessage(getDb(), { sessionId, role: "user", content: `big message ${i} ` + "x".repeat(2000) });
      upsertAgentMessage(getDb(), { sessionId, role: "agent", content: `call ${i}`, toolCalls: JSON.stringify([{ function: { name: "fs_read", arguments: { path: "/a" } } }]) });
      upsertAgentMessage(getDb(), { sessionId, role: "tool", content: `result ${i}`, toolCallId: `fs_read::${i}` });
    }

    const msgs = buildOllamaMessages(getDb(), sessionId, "sys", "brief", { maxContextChars: 1500 });
    const allToolMsgs = msgs.filter((m) => m.role === "tool");
    const allAssistantCalls = msgs.filter((m) => m.role === "assistant" && Array.isArray((m as { tool_calls?: unknown[] }).tool_calls) && ((m as { tool_calls?: unknown[] }).tool_calls!.length > 0));
    // Sanity: we kept SOME messages and all tool msgs pair with an assistant call.
    expect(allToolMsgs.length).toBeGreaterThan(0);
    expect(allAssistantCalls.length).toBeGreaterThan(0);
    // A trimmed context must never have a tool result without its assistant
    // tool_calls turn (they are kept together by the budget walker).
    const assistantIndices = msgs.map((m, i) => ({ m, i })).filter((x) => x.m.role === "assistant" && Array.isArray((x.m as { tool_calls?: unknown[] }).tool_calls) && ((x.m as { tool_calls?: unknown[] }).tool_calls!.length > 0)).map((x) => x.i);
    for (const toolMsg of msgs.filter((m) => m.role === "tool")) {
      const idx = msgs.indexOf(toolMsg);
      const nearestPriorAssistant = assistantIndices.filter((i) => i < idx).pop();
      expect(nearestPriorAssistant).toBeDefined();
    }
  });

  it("system + task prompt are always prepended even when trimming drops all turns", () => {
    const msgs = buildOllamaMessages(getDb(), sessionId, "sys", "brief", { maxContextChars: 1 });
    expect(msgs[0]).toEqual({ role: "system", content: "sys" });
    expect(msgs[1]).toEqual({ role: "user", content: "brief" });
  });
});
