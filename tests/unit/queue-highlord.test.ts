/**
 * Unit tests — queue high-lord routing regression (plan §8.3).
 *
 * Proves the queue's `runClaimedTask` branch:
 *  - a task on a normal (agent) house still claims and runs via the (mocked)
 *    runner — direct-to-house assignment is untouched;
 *  - a task on a `kind: 'high_lord'` house routes to `orchestrator.runParent`
 *    instead of the runner, proving the branch doesn't leak into direct
 *    assignment.
 *
 * Uses a real temp DB + a fake OpenCode client; both the runner and the
 * orchestrator are mocked via vi.mock so no real engine/OpenCode work happens.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, getRawDb, resetDbForTests } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";
import { createHouse, seedHighLordHouse } from "@/server/repositories/house-repo";
import { createTask, getTask } from "@/server/repositories/task-repo";
import type { AgentExecutionProvider } from "@/server/execution/types";
import type { HouseConfiguration } from "@/shared/types";
import { OpencodeClient } from "@/server/opencode";

// Mock the runner and the orchestrator so we can observe routing.
const runParentMock = vi.fn();
vi.mock("@/engine/orchestrator", () => ({
  runParent: (...args: unknown[]) => runParentMock(...args),
  tickActivePlans: () => Promise.resolve(),
}));
vi.mock("@/server/execution/runner", () => ({
  executeTask: vi.fn(() => Promise.resolve({ sessionId: "sess", terminalStatus: "completed" })),
}));

import { TaskQueue } from "@/engine/queue";
import { runParent } from "@/engine/orchestrator";
import { executeTask } from "@/server/execution/runner";

let tmpDir: string;
let dbPath: string;

function makeHouseConfig(allowlist: string[]): HouseConfiguration {
  return {
    systemPrompt: "You are an agent.",
    executionProvider: "opencode",
    aiProvider: "ollama-cloud",
    modelId: "glm-5.3",
    workspaceAllowlist: allowlist,
    tools: ["fs"],
    permissions: { fileSystem: "ask", shell: "ask", network: "deny", git: "allow" },
    approvalPolicy: "always",
    concurrency: 1,
  };
}

function fakeClient(healthy = true) {
  return {
    health: vi.fn(async () => healthy),
    getSession: vi.fn(async () => ({
      id: "prov-1",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0 },
      model: { id: "", providerID: "" },
      time: { created: 0, updated: Date.now() },
      title: "",
    })),
  } as unknown as OpencodeClient;
}

let logMock: (m: string) => void;

beforeEach(() => {
  resetDbForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-qhl-"));
  dbPath = path.join(tmpDir, "test.db");
  process.env.VELARIS_DB_PATH = dbPath;
  migrate();
  logMock = vi.fn();
  runParentMock.mockClear();
  (executeTask as unknown as ReturnType<typeof vi.fn>).mockClear();
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function runOnePass(queue: TaskQueue) {
  await queue.start();
  await new Promise((r) => setTimeout(r, 80));
  await queue.stop();
}

function makeQueue(client: OpencodeClient, adapter: AgentExecutionProvider) {
  return new TaskQueue({
    db: getDb(),
    raw: getRawDb(),
    adapter,
    client,
    log: logMock,
  });
}

describe("TaskQueue high-lord routing", () => {
  it("routes a task on a high_lord house to the orchestrator, not the runner", async () => {
    const hl = seedHighLordHouse(getDb())!;
    const task = createTask(getDb(), {
      title: "Court instruction",
      houseId: hl.id,
      workingDirectory: tmpDir,
    });

    const adapter = { startTask: vi.fn() } as unknown as AgentExecutionProvider;
    const queue = makeQueue(fakeClient(true), adapter);
    await runOnePass(queue);

    expect(runParentMock).toHaveBeenCalled();
    expect(executeTask).not.toHaveBeenCalled();
    // Task was claimed (running) then the orchestrator handles it.
    expect(getTask(getDb(), task.id)?.status).toBe("running");
  });

  it("still runs a normal agent-house task through the runner (regression)", async () => {
    const house = createHouse(getDb(), {
      name: "H",
      description: null,
      agent: { name: "A", role: "R" },
      configuration: makeHouseConfig([tmpDir]),
    });
    const task = createTask(getDb(), {
      title: "T",
      houseId: house.id,
      workingDirectory: tmpDir,
    });

    const adapter = { startTask: vi.fn() } as unknown as AgentExecutionProvider;
    const queue = makeQueue(fakeClient(true), adapter);
    await runOnePass(queue);

    expect(runParentMock).not.toHaveBeenCalled();
    expect(executeTask).toHaveBeenCalled();
    expect(getTask(getDb(), task.id)?.status).toBe("running");
  });
});
