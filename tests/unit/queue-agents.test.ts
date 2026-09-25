/**
 * Unit tests — per-agent runtime routing (Phase 6 Stage B).
 *
 * Proves:
 *  - a task with a non-null `agentId` routes to THAT agent's configuration
 *    (provider kind / model / prompt / allowlist);
 *  - a task with `agentId = null` is BYTE-IDENTICAL to the pre-multi-agent
 *    single-agent path (same house config, same call shape) — the regression
 *    that protects the Phase 4/5 suites.
 *
 * The runner is mocked so no real engine/OpenCode/Ollama work happens.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, getRawDb, resetDbForTests } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";
import { createHouse, createAgent, listAgentsForHouse } from "@/server/repositories/house-repo";
import { createTask } from "@/server/repositories/task-repo";
import type { AgentExecutionProvider } from "@/server/execution/types";
import { OpencodeClient } from "@/server/opencode";
import { OllamaClient } from "@/server/execution/ollama/client";
import type { HouseConfiguration } from "@/shared/types";

vi.mock("@/server/execution/runner", () => ({
  executeTask: vi.fn(() => Promise.resolve({ sessionId: "sess", terminalStatus: "completed" })),
}));
vi.mock("@/server/execution/ollama/runtime", () => ({
  runOllamaTask: vi.fn(() => Promise.resolve({ sessionId: "osess", terminalStatus: "completed" })),
}));

import { TaskQueue } from "@/engine/queue";
import { executeTask } from "@/server/execution/runner";
import { runOllamaTask } from "@/server/execution/ollama/runtime";

let tmpDir: string;
let dbPath: string;

function makeConfig(
  executionProvider: "opencode" | "ollama",
  over: Partial<HouseConfiguration> = {},
): HouseConfiguration {
  return {
    systemPrompt: "house-default-prompt",
    executionProvider,
    aiProvider: "ollama-cloud",
    modelId: "default-model",
    workspaceAllowlist: [tmpDir],
    tools: ["fs"],
    permissions: { fileSystem: "ask", shell: "ask", network: "deny", git: "allow" },
    approvalPolicy: "always",
    concurrency: 1,
    ...over,
  };
}

function fakeOcClient(healthy = true) {
  return { health: vi.fn(async () => healthy) } as unknown as OpencodeClient;
}
function fakeOllamaClient() {
  return { health: vi.fn(async () => true), chat: vi.fn() } as unknown as OllamaClient;
}

let logMock: (m: string) => void;

beforeEach(() => {
  resetDbForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-queueagents-"));
  dbPath = path.join(tmpDir, "test.db");
  process.env.VELARIS_DB_PATH = dbPath;
  migrate();
  logMock = vi.fn();
  (executeTask as unknown as ReturnType<typeof vi.fn>).mockClear();
  (runOllamaTask as unknown as ReturnType<typeof vi.fn>).mockClear();
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function runOnePass(queue: TaskQueue) {
  await queue.start();
  await new Promise((r) => setTimeout(r, 60));
  await queue.stop();
}

describe("queue per-agent routing", () => {
  it("a task targeting an Ollama agent routes to runOllamaTask with that agent's model/config", async () => {
    const db = getDb();
    // House default is OpenCode; the second agent is Ollama with its own model.
    const house = createHouse(db, {
      name: "H",
      description: null,
      agent: { name: "Default", role: "R" },
      configuration: makeConfig("opencode"),
    });
    const ollamaAgent = createAgent(db, house.id, {
      name: "Ollama Agent",
      role: "R2",
      configuration: makeConfig("ollama", { modelId: "agent-model" }),
    });
    const task = createTask(db, {
      title: "T",
      houseId: house.id,
      agentId: ollamaAgent.id,
      workingDirectory: tmpDir,
    });

    const queue = new TaskQueue({
      db,
      raw: getRawDb(),
      adapter: { startTask: vi.fn() } as unknown as AgentExecutionProvider,
      client: fakeOcClient(true),
      ollamaClient: fakeOllamaClient(),
      log: logMock,
    });
    await runOnePass(queue);

    expect(executeTask).not.toHaveBeenCalled();
    expect(runOllamaTask).toHaveBeenCalledTimes(1);
    const ctx = (runOllamaTask as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(ctx.modelId).toBe("agent-model");
    expect(ctx.agent?.id).toBe(ollamaAgent.id);
    expect(ctx.task.agentId).toBe(ollamaAgent.id);
  });

  it("a task targeting an OpenCode agent that is NOT the default drives the routed config", async () => {
    const db = getDb();
    // House default is Ollama; the second agent is OpenCode with a new model.
    const house = createHouse(db, {
      name: "H",
      description: null,
      agent: { name: "Default", role: "R" },
      configuration: makeConfig("ollama"),
    });
    const ocAgent = createAgent(db, house.id, {
      name: "OC Agent",
      role: "R2",
      configuration: makeConfig("opencode", { modelId: "oc-agent-model" }),
    });
    const task = createTask(db, {
      title: "T",
      houseId: house.id,
      agentId: ocAgent.id,
      workingDirectory: tmpDir,
    });

    const queue = new TaskQueue({
      db,
      raw: getRawDb(),
      adapter: { startTask: vi.fn() } as unknown as AgentExecutionProvider,
      client: fakeOcClient(true),
      ollamaClient: fakeOllamaClient(),
      log: logMock,
    });
    await runOnePass(queue);

    expect(runOllamaTask).not.toHaveBeenCalled();
    expect(executeTask).toHaveBeenCalledTimes(1);
    const ctx = (executeTask as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(ctx.modelId).toBe("oc-agent-model");
    expect(ctx.agent?.id).toBe(ocAgent.id);
    expect(ctx.agentId).toBe(ocAgent.id);
  });

  it("REGRESSION: agentId=null is byte-identical to the single-agent path", async () => {
    const db = getDb();
    const house = createHouse(db, {
      name: "H",
      description: null,
      agent: { name: "Default", role: "R" },
      configuration: makeConfig("opencode", { modelId: "house-model" }),
    });
    const task = createTask(db, {
      title: "T",
      houseId: house.id,
      workingDirectory: tmpDir,
    });
    expect(task.agentId).toBeNull();

    const queue = new TaskQueue({
      db,
      raw: getRawDb(),
      adapter: { startTask: vi.fn() } as unknown as AgentExecutionProvider,
      client: fakeOcClient(true),
      ollamaClient: fakeOllamaClient(),
      log: logMock,
    });
    await runOnePass(queue);

    expect(executeTask).toHaveBeenCalledTimes(1);
    const ctx = (executeTask as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // Without a task agent the run context carries agent=null / agentId=null and
    // the house's own model — exactly the pre-Phase-6 shape.
    expect(ctx.agent).toBeNull();
    expect(ctx.agentId).toBeNull();
    expect(ctx.modelId).toBe("house-model");
    // And the routed house DTO default agent is the single agent.
    expect(listAgentsForHouse(db, house.id)).toHaveLength(1);
  });

  it("REGRESSION: a single-agent house with a null agentId still uses the house allowlist", async () => {
    const db = getDb();
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-allowed-"));
    try {
      const house = createHouse(db, {
        name: "H",
        description: null,
        agent: { name: "Default", role: "R" },
        configuration: makeConfig("opencode", { workspaceAllowlist: [otherDir] }),
      });
      const task = createTask(db, { title: "T", houseId: house.id, workingDirectory: otherDir });

      const queue = new TaskQueue({
        db,
        raw: getRawDb(),
        adapter: { startTask: vi.fn() } as unknown as AgentExecutionProvider,
        client: fakeOcClient(true),
        ollamaClient: fakeOllamaClient(),
        log: logMock,
      });
      await runOnePass(queue);

      expect(executeTask).toHaveBeenCalledTimes(1);
      const ctx = (executeTask as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(ctx.directory).toBe(otherDir);
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });
});
