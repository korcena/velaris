/**
 * Unit tests — task queue poll loop (src/engine/queue.ts).
 *
 * The queue is the engine's poll loop: health-gate → claim queued tasks →
 * run each via the AgentExecutionProvider. We exercise it against a real
 * temp DB (migrations applied) with a fake OpenCode client and a mocked
 * `executeTask` runner (so no real engine/OpenCode work happens).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, getRawDb, resetDbForTests } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";
import {
  createHouse,
  transitionHouseStatus,
} from "@/server/repositories/house-repo";
import {
  createTask,
  claimQueuedTask,
  getTask,
  setTaskStatus,
  listQueuedTaskIds,
} from "@/server/repositories/task-repo";
import type { AgentExecutionProvider } from "@/server/execution/types";
import type { HouseConfiguration } from "@/shared/types";
import { OpencodeClient } from "@/server/opencode";

// Mock the runner so the queue never performs real OpenCode/SSE work.
vi.mock("@/server/execution/runner", () => ({
  executeTask: () => Promise.resolve({ sessionId: "sess", terminalStatus: "completed" }),
}));

import { TaskQueue } from "@/engine/queue";

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

/** A fake OpenCode client whose health() we control. */
function fakeClient(healthy = true) {
  const client = {
    health: vi.fn(async () => healthy),
  } as unknown as OpencodeClient;
  return client;
}

/** Run one queue pass and then stop. Returns after the first iteration settles. */
async function runOnePass(queue: TaskQueue) {
  const log = vi.fn();
  await queue.start();
  await new Promise((r) => setTimeout(r, 60));
  await queue.stop();
  void log;
}

let logMock: (m: string) => void;

beforeEach(() => {
  resetDbForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-queue-"));
  dbPath = path.join(tmpDir, "test.db");
  process.env.VELARIS_DB_PATH = dbPath;
  migrate();
  logMock = vi.fn();
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeQueue(client: OpencodeClient, adapter: AgentExecutionProvider) {
  const db = getDb();
  const raw = getRawDb();
  return new TaskQueue({ db, raw, adapter, client, log: logMock });
}

describe("TaskQueue", () => {
  it("claims a queued task (status → running) and runs it", async () => {
    const allowlist = [tmpDir];
    const house = createHouse(getDb(), {
      name: "H",
      description: null,
      agent: { name: "A", role: "R" },
      configuration: makeHouseConfig(allowlist),
    });
    const task = createTask(getDb(), {
      title: "T",
      houseId: house.id,
      workingDirectory: tmpDir,
    });

    const adapter = { startTask: vi.fn() } as unknown as AgentExecutionProvider;
    const queue = makeQueue(fakeClient(true), adapter);
    await runOnePass(queue);

    const now = getTask(getDb(), task.id);
    expect(now?.status).toBe("running"); // claimed by the queue (runner mock leaves it running)
  });

  it("does not claim when there are no queued tasks", async () => {
    const adapter = { startTask: vi.fn() } as unknown as AgentExecutionProvider;
    const queue = makeQueue(fakeClient(true), adapter);
    await runOnePass(queue);

    expect(listQueuedTaskIds(getRawDb())).toEqual([]);
  });

  it("health-gates: no claim while OpenCode is unhealthy (task stays queued)", async () => {
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
    const queue = makeQueue(fakeClient(false), adapter);
    await runOnePass(queue);

    expect(getTask(getDb(), task.id)?.status).toBe("queued");
  });

  it("skips a disabled/archived house — task left queued for retry", async () => {
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
    // Disable the house.
    transitionHouseStatus(getDb(), house.id, "disabled");

    const adapter = { startTask: vi.fn() } as unknown as AgentExecutionProvider;
    const queue = makeQueue(fakeClient(true), adapter);
    await runOnePass(queue);

    expect(getTask(getDb(), task.id)?.status).toBe("queued");
  });

  it("respects per-house concurrency: second task for the same active house stays queued", async () => {
    const house = createHouse(getDb(), {
      name: "H",
      description: null,
      agent: { name: "A", role: "R" },
      configuration: makeHouseConfig([tmpDir]),
    });
    const t1 = createTask(getDb(), {
      title: "T1",
      houseId: house.id,
      workingDirectory: tmpDir,
    });
    const t2 = createTask(getDb(), {
      title: "T2",
      houseId: house.id,
      workingDirectory: tmpDir,
    });

    // The runner mock never resolves so the first task stays "in houseBusy".
    const neverAdapter = {
      startTask: vi.fn(() => new Promise(() => {})),
    } as unknown as AgentExecutionProvider;
    const queue = makeQueue(fakeClient(true), neverAdapter);
    await runOnePass(queue);

    // T1 is claimed (running); T2 (same house, house already busy) is requeued.
    expect(getTask(getDb(), t1.id)?.status).toBe("running");
    expect(getTask(getDb(), t2.id)?.status).toBe("queued");
  });

  it("claim is atomic: claimQueuedTask returns false for an already-claimed task", () => {
    const raw = getRawDb();
    const house = createHouse(getDb(), {
      name: "H",
      description: null,
      agent: { name: "A", role: "R" },
      configuration: makeHouseConfig([tmpDir]),
    });
    const task = createTask(getDb(), { title: "T", houseId: house.id });

    expect(claimQueuedTask(raw, task.id)).toBe(true);
    expect(getTask(getDb(), task.id)?.status).toBe("running");
    // Second claim attempt fails (already running).
    expect(claimQueuedTask(raw, task.id)).toBe(false);
    // A non-queued task (e.g. cancelled) is also not claimable.
    setTaskStatus(getDb(), task.id, "cancelled");
    expect(claimQueuedTask(raw, task.id)).toBe(false);
  });
});
