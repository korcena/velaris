/**
 * Unit tests — queue routes Ollama vs OpenCode house tasks (Phase 5 Stage F).
 *
 * Proves the queue branch: an `executionProvider='ollama'` house task routes to
 * `runOllamaTask` (and NOT `executeTask`); an OpenCode house task still calls
 * `executeTask`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, getRawDb, resetDbForTests } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";
import { createHouse, getHouse } from "@/server/repositories/house-repo";
import { createTask } from "@/server/repositories/task-repo";
import type { AgentExecutionProvider } from "@/server/execution/types";
import { OpencodeClient } from "@/server/opencode";
import { OllamaClient } from "@/server/execution/ollama/client";
import type { HouseConfiguration } from "@/shared/types";

vi.mock("@/server/execution/runner", () => ({
  executeTask: vi.fn(() => Promise.resolve({ sessionId: "sess", terminalStatus: "completed" })),
}));
vi.mock("@/server/execution/ollama/runtime", () => ({
  runOllamaTask: vi.fn((ctx, opts) => Promise.resolve({ sessionId: "osess", terminalStatus: "completed" })),
}));

import { TaskQueue } from "@/engine/queue";
import { executeTask } from "@/server/execution/runner";
import { runOllamaTask } from "@/server/execution/ollama/runtime";

let tmpDir: string;
let dbPath: string;

function makeConfig(executionProvider: "opencode" | "ollama"): HouseConfiguration {
  return {
    systemPrompt: "You are an agent.",
    executionProvider,
    aiProvider: "ollama-cloud",
    modelId: "m",
    workspaceAllowlist: [tmpDir],
    tools: ["fs"],
    permissions: { fileSystem: "ask", shell: "ask", network: "deny", git: "allow" },
    approvalPolicy: "always",
    concurrency: 1,
  };
}

function fakeOcClient(healthy = true) {
  return { health: vi.fn(async () => healthy) } as unknown as OpencodeClient;
}
function fakeOllamaClient() {
  return { health: vi.fn(async () => true) } as unknown as OllamaClient;
}

let logMock: (m: string) => void;

beforeEach(() => {
  resetDbForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-queueollama-"));
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

describe("queue provider dispatch", () => {
  it("routes an Ollama house task to runOllamaTask (NOT executeTask)", async () => {
    const house = createHouse(getDb(), { name: "H", description: null, agent: { name: "A", role: "R" }, configuration: makeConfig("ollama") });
    const task = createTask(getDb(), { title: "T", houseId: house.id, workingDirectory: tmpDir });
    const queue = new TaskQueue({
      db: getDb(),
      raw: getRawDb(),
      adapter: {} as unknown as AgentExecutionProvider,
      client: fakeOcClient(true),
      ollamaClient: fakeOllamaClient(),
      log: logMock,
    });
    await runOnePass(queue);
    // The task was claimed (running) and routed to the Ollama runtime, never
    // the OpenCode executeTask path.
    expect(executeTask).not.toHaveBeenCalled();
    expect(runOllamaTask).toHaveBeenCalledTimes(1);
    expect((runOllamaTask as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      modelId: "m",
    });
    // (runOllamaTask is mocked so it does not write the DB — the routing is the
    // assertion here.)
  });

  it("OpenCode house task still routes to executeTask (not runOllamaTask)", async () => {
    const house = createHouse(getDb(), { name: "H2", description: null, agent: { name: "B", role: "R" }, configuration: makeConfig("opencode") });
    const task = createTask(getDb(), { title: "T", houseId: house.id, workingDirectory: tmpDir });
    const adapter = { startTask: vi.fn() } as unknown as AgentExecutionProvider;
    const queue = new TaskQueue({
      db: getDb(),
      raw: getRawDb(),
      adapter,
      client: fakeOcClient(true),
      ollamaClient: fakeOllamaClient(),
      log: logMock,
    });
    await runOnePass(queue);
    expect(executeTask).toHaveBeenCalled();
    expect(runOllamaTask).not.toHaveBeenCalled();
  });
});
