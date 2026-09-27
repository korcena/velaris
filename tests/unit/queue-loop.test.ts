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
import { createProject } from "@/server/repositories/project-repo";
import { listEventsForTask, listNotifications } from "@/server/repositories/execution-repo";
import { WORKSPACE_UNREGISTERED_MESSAGE } from "@/server/repositories/workspace";
import type { AgentExecutionProvider } from "@/server/execution/types";
import type { HouseConfiguration } from "@/shared/types";
import { OpencodeClient } from "@/server/opencode";

// Mock the runner so the queue never performs real OpenCode/SSE work.
vi.mock("@/server/execution/runner", () => ({
  executeTask: vi.fn(() => Promise.resolve({ sessionId: "sess", terminalStatus: "completed" })),
}));

import { TaskQueue } from "@/engine/queue";
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
  (executeTask as unknown as ReturnType<typeof vi.fn>).mockClear();
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

  it("house-less task with no houses fails cleanly with the actionable message, runner NOT called", async () => {
    const task = createTask(getDb(), {
      title: "T",
      houseId: null,
      workingDirectory: tmpDir,
    });

    const adapter = { startTask: vi.fn() } as unknown as AgentExecutionProvider;
    const queue = makeQueue(fakeClient(true), adapter);
    await runOnePass(queue);

    // No agent houses and no High Lord → terminal no_high_lord failure.
    expect(getTask(getDb(), task.id)?.status).toBe("failed");
    const failure = listEventsForTask(getDb(), task.id).find((e) => e.type === "task_failed");
    expect(failure?.payload.error).toBe(
      "No house can run this quest: create an active house or restore the High Lord.",
    );
    // A terminal routing failure also raises a `failure` notification.
    const notification = listNotifications(getDb()).find((n) => n.taskId === task.id);
    expect(notification?.type).toBe("failure");
    expect(notification?.body).toBe(
      "No house can run this quest: create an active house or restore the High Lord.",
    );
    expect(executeTask).not.toHaveBeenCalled();
  });

  it("house-less task with a meaningful house match routes to it and runs", async () => {
    const house = createHouse(getDb(), {
      name: "Research Hall",
      description: "research analysis",
      agent: { name: "Scholar", role: "Researcher" },
      configuration: makeHouseConfig([tmpDir]),
    });
    const task = createTask(getDb(), {
      title: "Research analysis quest",
      description: "research analysis",
      houseId: null,
      workingDirectory: tmpDir,
    });

    const adapter = { startTask: vi.fn() } as unknown as AgentExecutionProvider;
    const queue = makeQueue(fakeClient(true), adapter);
    await runOnePass(queue);

    const after = getTask(getDb(), task.id)!;
    expect(after.houseId).toBe(house.id);
    expect(after.status).toBe("running");
    expect(executeTask).toHaveBeenCalled();
    // Routing provenance is emitted on a reused `message` event.
    const routing = listEventsForTask(getDb(), task.id).find((e) => e.type === "message");
    expect((routing?.payload.routing as { houseId: string }).houseId).toBe(house.id);
  });

  it("default Board flow: matched empty-allowlist house with no dir/project is NOT routed — escalates to no_high_lord failure", async () => {
    // A registered project makes the empty-allowlist house's EFFECTIVE allowlist
    // non-empty (the exact bug condition). The task has neither a working
    // directory nor a project, so `resolveWorkspace` would fail at claim.
    createProject(getDb(), {
      name: "Some Other Project",
      directory: tmpDir,
      gitInfo: { branch: null, remote: null, dirty: false },
    });
    createHouse(getDb(), {
      name: "Research Hall",
      description: "research analysis",
      agent: { name: "Scholar", role: "Researcher" },
      configuration: makeHouseConfig([]),
    });
    const task = createTask(getDb(), {
      title: "Research analysis quest",
      description: "research analysis",
      houseId: null,
      workingDirectory: null,
    });

    const adapter = { startTask: vi.fn() } as unknown as AgentExecutionProvider;
    const queue = makeQueue(fakeClient(true), adapter);
    await runOnePass(queue);

    // No viable house and no High Lord → terminal, not a route-then-fail.
    const after = getTask(getDb(), task.id)!;
    expect(after.houseId).toBeNull();
    expect(after.status).toBe("failed");
    const failure = listEventsForTask(getDb(), task.id).find((e) => e.type === "task_failed");
    expect(failure?.payload.error).toBe(
      "No house can run this quest: create an active house or restore the High Lord.",
    );
    // Never even emitted a routing `message` event.
    expect(listEventsForTask(getDb(), task.id).some((e) => e.type === "message")).toBe(false);
    expect(executeTask).not.toHaveBeenCalled();
  });

  it("does not claim when there are no queued tasks", async () => {
    const adapter = { startTask: vi.fn() } as unknown as AgentExecutionProvider;
    const queue = makeQueue(fakeClient(true), adapter);
    await runOnePass(queue);

    expect(listQueuedTaskIds(getRawDb())).toEqual([]);
  });

  it("empty house allowlist + task dir registered as a project → claimed and executed", async () => {
    // An empty allowlist means "bounded by the registered projects". Register
    // this task's directory as a project; the task must run.
    createProject(getDb(), {
      name: "Quest Project",
      directory: tmpDir,
      gitInfo: { branch: null, remote: null, dirty: false },
    });
    const house = createHouse(getDb(), {
      name: "H",
      description: null,
      agent: { name: "A", role: "R" },
      configuration: makeHouseConfig([]),
    });
    const task = createTask(getDb(), {
      title: "T",
      houseId: house.id,
      workingDirectory: tmpDir,
    });

    const adapter = { startTask: vi.fn() } as unknown as AgentExecutionProvider;
    const queue = makeQueue(fakeClient(true), adapter);
    await runOnePass(queue);

    expect(executeTask).toHaveBeenCalled();
    expect(getTask(getDb(), task.id)?.status).toBe("running");
  });

  it("empty house allowlist + unregistered task dir → failed with the actionable message, runner NOT called", async () => {
    const house = createHouse(getDb(), {
      name: "H",
      description: null,
      agent: { name: "A", role: "R" },
      configuration: makeHouseConfig([]),
    });
    const task = createTask(getDb(), {
      title: "T",
      houseId: house.id,
      workingDirectory: tmpDir, // not registered as a project
    });

    const adapter = { startTask: vi.fn() } as unknown as AgentExecutionProvider;
    const queue = makeQueue(fakeClient(true), adapter);
    await runOnePass(queue);

    const after = getTask(getDb(), task.id)!;
    expect(after.status).toBe("failed");
    // The task_failed event's error equals the exact actionable message.
    const failure = listEventsForTask(getDb(), task.id).find((e) => e.type === "task_failed");
    expect(failure?.payload.error).toBe(WORKSPACE_UNREGISTERED_MESSAGE);
    expect(executeTask).not.toHaveBeenCalled();
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
