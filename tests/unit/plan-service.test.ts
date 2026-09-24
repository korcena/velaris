/**
 * Unit tests — plan service (src/server/services/plan-service.ts).
 *
 * Covers:
 *  - `deriveHighLordPlanState` all mapping branches (idle / planning×2 /
 *    active / completed / aborted) per addendum D4f.
 *  - `buildPlanDto` assembly over seeded subtask/handoff/usage rows.
 *  - `buildCourtHistory` over seeded parent sessions + agent_messages.
 *  - PlanState enrichment present on the High Lord's list rows, absent on agents
 *    (via execution-service builders).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, resetDbForTests } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";
import { seedHighLordHouse, createHouse } from "@/server/repositories/house-repo";
import { createTask, setTaskStatus } from "@/server/repositories/task-repo";
import { createSubtask, linkChildTask } from "@/server/repositories/subtask-repo";
import { createHandoff } from "@/server/repositories/handoff-repo";
import {
  createExecutionSession,
  createAgentMessage,
  createArtifact,
} from "@/server/repositories/execution-repo";
import {
  deriveHighLordPlanState,
  buildPlanDto,
  buildCourtHistory,
} from "@/server/services/plan-service";
import { buildHouseListSummary } from "@/server/services/execution-service";
import type { HouseConfiguration } from "@/shared/types";

let tmpDir: string;
let dbPath: string;

function makeConfig(): HouseConfiguration {
  return {
    systemPrompt: "You are an agent.",
    executionProvider: "opencode",
    aiProvider: "ollama-cloud",
    modelId: "glm-5.3",
    workspaceAllowlist: [tmpDir],
    tools: ["fs"],
    permissions: { fileSystem: "ask", shell: "ask", network: "deny", git: "allow" },
    approvalPolicy: "always",
    concurrency: 1,
  };
}

function seedMistHouse() {
  return createHouse(getDb(), {
    name: "House of Mist",
    description: null,
    agent: { name: "A", role: "R" },
    configuration: makeConfig(),
  });
}

beforeEach(() => {
  resetDbForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-plansvc-"));
  dbPath = path.join(tmpDir, "test.db");
  process.env.VELARIS_DB_PATH = dbPath;
  migrate();
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function hlId(): string {
  return seedHighLordHouse(getDb())!.id;
}

describe("deriveHighLordPlanState (addendum D4f)", () => {
  it("maps no-parent → idle", () => {
    expect(deriveHighLordPlanState(getDb(), hlId())).toBe("idle");
  });

  it("maps queued parent → planning", () => {
    const hl = hlId();
    createTask(getDb(), { title: "Quest", houseId: hl });
    expect(deriveHighLordPlanState(getDb(), hl)).toBe("planning");
  });

  it("maps running parent with no subtasks → planning (planner call in flight)", () => {
    const hl = hlId();
    const t = createTask(getDb(), { title: "Quest", houseId: hl });
    setTaskStatus(getDb(), t.id, "running");
    expect(deriveHighLordPlanState(getDb(), hl)).toBe("planning");
  });

  it("maps running parent with subtasks → active", () => {
    const hl = hlId();
    const t = createTask(getDb(), { title: "Quest", houseId: hl });
    setTaskStatus(getDb(), t.id, "running");
    createSubtask(getDb(), { parentId: t.id, planId: "s0", orderIndex: 0, dependsOn: [], title: "A" });
    expect(deriveHighLordPlanState(getDb(), hl)).toBe("active");
  });

  it("maps completed parent → completed", () => {
    const hl = hlId();
    const t = createTask(getDb(), { title: "Quest", houseId: hl });
    setTaskStatus(getDb(), t.id, "completed");
    expect(deriveHighLordPlanState(getDb(), hl)).toBe("completed");
  });

  it("maps failed / cancelled / interrupted parent → aborted (latest wins)", () => {
    const hl = hlId();

    const failed = createTask(getDb(), { title: "Q1", houseId: hl });
    setTaskStatus(getDb(), failed.id, "failed");
    expect(deriveHighLordPlanState(getDb(), hl)).toBe("aborted");

    const cancelled = createTask(getDb(), { title: "Q2", houseId: hl });
    setTaskStatus(getDb(), cancelled.id, "cancelled");
    expect(deriveHighLordPlanState(getDb(), hl)).toBe("aborted");

    const interrupted = createTask(getDb(), { title: "Q3", houseId: hl });
    setTaskStatus(getDb(), interrupted.id, "interrupted");
    expect(deriveHighLordPlanState(getDb(), hl)).toBe("aborted");
  });
});

describe("buildPlanDto", () => {
  it("returns null for an unknown parent task", () => {
    expect(buildPlanDto(getDb(), "00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("assembles subtasks + handoffs + cost; consolidated null while running", () => {
    const hl = hlId();
    const h1 = seedMistHouse();
    const parent = createTask(getDb(), { title: "Quest", houseId: hl });
    setTaskStatus(getDb(), parent.id, "running");

    const s = createSubtask(getDb(), {
      parentId: parent.id,
      planId: "s0",
      orderIndex: 0,
      dependsOn: [],
      title: "Forge the keys",
      instructions: "Do it",
    });
    const child = createTask(getDb(), { title: "child", houseId: h1.id });
    linkChildTask(getDb(), s.id, child.id);
    createHandoff(getDb(), {
      parentTaskId: parent.id,
      subtaskId: s.id,
      sourceHouseId: hl,
      destinationHouseId: h1.id,
      instructions: "Do it",
      completionRequirements: "Keys exist",
    });

    const plan = buildPlanDto(getDb(), parent.id);
    expect(plan).not.toBeNull();
    expect(plan!.parentTask.id).toBe(parent.id);
    expect(plan!.subtasks).toHaveLength(1);
    expect(plan!.subtasks[0].houseId).toBe(h1.id);
    expect(plan!.subtasks[0].houseName).toBe("House of Mist");
    expect(plan!.subtasks[0].childTaskStatus).toBe("queued");
    expect(plan!.handoffs).toHaveLength(1);
    expect(plan!.handoffs[0].destinationHouseId).toBe(h1.id);
    expect(plan!.consolidated).toBeNull();
  });

  it("populates consolidated for a completed parent with a result artifact", () => {
    const hl = hlId();
    const parent = createTask(getDb(), { title: "Quest", houseId: hl });
    setTaskStatus(getDb(), parent.id, "completed");

    const session = createExecutionSession(getDb(), {
      taskId: parent.id,
      houseId: hl,
      provider: "opencode",
      modelId: "glm-5.3",
    });
    createArtifact(getDb(), {
      sessionId: session.id,
      taskId: parent.id,
      kind: "result",
      content: "The wards held.",
    });

    const plan = buildPlanDto(getDb(), parent.id);
    expect(plan!.consolidated).not.toBeNull();
    expect(plan!.consolidated!.summary).toBe("The wards held.");
    expect(plan!.consolidated!.fileCount).toBe(0);
  });
});

describe("buildCourtHistory", () => {
  it("returns [] for a High Lord house with no parent tasks", () => {
    expect(buildCourtHistory(getDb(), hlId(), 20)).toEqual([]);
  });

  it("returns one user + one agent message per High Lord parent task", () => {
    const hl = hlId();
    const parent = createTask(getDb(), { title: "Build a wall", houseId: hl });
    const session = createExecutionSession(getDb(), {
      taskId: parent.id,
      houseId: hl,
      provider: "opencode",
      modelId: "glm-5.3",
    });
    // Two user messages (instruction + a steer) and an agent reply.
    createAgentMessage(getDb(), { sessionId: session.id, role: "user", content: "Build a wall" });
    createAgentMessage(getDb(), { sessionId: session.id, role: "user", content: "Also add tests" });
    createAgentMessage(getDb(), { sessionId: session.id, role: "agent", content: `{"subtasks":[]}` });

    const history = buildCourtHistory(getDb(), hl, 20);
    expect(history).toHaveLength(2); // 1 user + 1 agent (newest user shown)
    expect(history.some((m) => m.role === "agent" && m.content.includes("subtasks"))).toBe(true);
    expect(history.every((m) => m.taskId === parent.id)).toBe(true);
  });
});

describe("planState enrichment on DTOs", () => {
  it("is present on the High Lord list row and absent on an agent row", () => {
    const db = getDb();
    const hl = seedHighLordHouse(db)!;
    const agent = seedMistHouse();

    expect(buildHouseListSummary(db, hl).planState).toBeDefined();
    expect(buildHouseListSummary(db, agent).planState).toBeUndefined();
  });
});
