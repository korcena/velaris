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
import { listEventsForTask } from "@/server/repositories/execution-repo";
import { createProject } from "@/server/repositories/project-repo";
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

  it("re-homes a weakly-matching house-less quest onto the High Lord", async () => {
    const hl = seedHighLordHouse(getDb())!;
    // A viable agent house that scores only 1 word → weak match → escalate.
    createHouse(getDb(), {
      name: "House of Night",
      description: "Starlight",
      agent: { name: "Nyx", role: "Watcher" },
      configuration: makeHouseConfig([tmpDir]),
    });
    const task = createTask(getDb(), {
      title: "Quest",
      type: "general",
      description: "starlight",
      houseId: null,
      workingDirectory: tmpDir,
    });

    const adapter = { startTask: vi.fn() } as unknown as AgentExecutionProvider;
    const queue = makeQueue(fakeClient(true), adapter);
    await runOnePass(queue);

    const after = getTask(getDb(), task.id)!;
    expect(after.houseId).toBe(hl.id);
    expect(after.status).toBe("running");
    expect(runParentMock).toHaveBeenCalled();
  });

  it("keeps a weak-match escalation queued when OpenCode is down", async () => {
    const hl = seedHighLordHouse(getDb())!;
    createHouse(getDb(), {
      name: "House of Night",
      description: "Starlight",
      agent: { name: "Nyx", role: "Watcher" },
      configuration: makeHouseConfig([tmpDir]),
    });
    const task = createTask(getDb(), {
      title: "Quest",
      type: "general",
      description: "starlight",
      houseId: null,
      workingDirectory: tmpDir,
    });

    const adapter = { startTask: vi.fn() } as unknown as AgentExecutionProvider;
    const queue = makeQueue(fakeClient(false), adapter);
    await runOnePass(queue);

    const after = getTask(getDb(), task.id)!;
    // Routing ran (house resolved to the HL); the health gate held the claim.
    expect(after.houseId).toBe(hl.id);
    expect(after.status).toBe("queued");
    expect(runParentMock).not.toHaveBeenCalled();
  });

  it("escalates instead of routing when the only matching agent house is not workspace-viable", async () => {
    const hl = seedHighLordHouse(getDb())!;
    // Scores >= 2 on the quest text, but empty allowlist + no registered
    // project for a null working directory → NOT viable → must not route.
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
      workingDirectory: tmpDir,
    });

    const adapter = { startTask: vi.fn() } as unknown as AgentExecutionProvider;
    const queue = makeQueue(fakeClient(true), adapter);
    await runOnePass(queue);

    const after = getTask(getDb(), task.id)!;
    // The matched-but-unviable house is excluded; the quest re-homes to the HL.
    expect(after.houseId).toBe(hl.id);
    expect(runParentMock).toHaveBeenCalled();
  });

  it("default Board flow regression: matching empty-allowlist house with null workingDirectory and no project never routes", async () => {
    // A registered project makes the agent house's EFFECTIVE allowlist non-empty
    // (the exact condition the old filter wrongly treated as viable). The quest
    // itself has no dir and no project, so `resolveWorkspace` would fail at
    // claim; routing must exclude the house and escalate instead.
    createProject(getDb(), {
      name: "Some Other Project",
      directory: tmpDir,
      gitInfo: { branch: null, remote: null, dirty: false },
    });
    // Seeded HL has an empty allowlist and the quest has no directory, so the
    // terminal no_directory path fires — but critically the quest is never
    // assigned to the (non-viable) matching agent house that would fail at claim.
    seedHighLordHouse(getDb());
    const matching = createHouse(getDb(), {
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

    const after = getTask(getDb(), task.id)!;
    expect(after.houseId).not.toBe(matching.id);
    expect(after.houseId).toBeNull();
    expect(after.status).toBe("failed");
    expect(runParentMock).not.toHaveBeenCalled();
    expect(executeTask).not.toHaveBeenCalled();
    const failure = listEventsForTask(getDb(), task.id).find((e) => e.type === "task_failed");
    expect(failure?.payload.error).toBe(
      "This quest has no working directory and no project directory — set one before the court can plan it.",
    );
  });

  it("does not route a null-dir quest whose matching house has a non-existent first allowlist entry (true resolveWorkspace mirror)", async () => {
    // The house scores >= 2 on the quest text and has a NON-EMPTY allowlist,
    // but its FIRST entry does not exist on disk. `resolveWorkspace`'s fallback
    // is `fallback && isPathAllowed(fallback, …)`, so this house would fail at
    // claim — the filter must exclude it and escalate instead of route-then-fail.
    // The High Lord carries a real allowlist so escalation has a directory.
    const hl = createHouse(getDb(), {
      name: "High Lord",
      kind: "high_lord",
      agent: { name: "Rhysand", role: "High Lord" },
      configuration: makeHouseConfig([tmpDir]),
    });
    const missingDir = path.join(
      os.tmpdir(),
      `velaris-qhl-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    createHouse(getDb(), {
      name: "Research Hall",
      description: "research analysis",
      agent: { name: "Scholar", role: "Researcher" },
      // Non-empty allowlist whose first (fallback) entry does not exist.
      configuration: makeHouseConfig([missingDir, tmpDir]),
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

    const after = getTask(getDb(), task.id)!;
    // The matched-but-unviable house is excluded; the quest re-homes to the HL.
    expect(after.houseId).toBe(hl.id);
    expect(runParentMock).toHaveBeenCalled();
    expect(executeTask).not.toHaveBeenCalled();
  });
});
