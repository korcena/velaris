/**
 * Unit tests — execution service (src/server/services/execution-service.ts).
 *
 * Covers the pure-ish `deriveRuntimeStatus` mapping and the `buildHouseDetail`
 * / `buildHouseListSummary` DTO shapes against a temp DB with a seeded
 * active session + task + pending approval.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, getRawDb, resetDbForTests } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";
import { createHouse } from "@/server/repositories/house-repo";
import { createTask, setTaskStatus } from "@/server/repositories/task-repo";
import {
  createExecutionSession,
  setSessionStatus,
  createApprovalRequest,
  createNotification,
  getActiveSessionForHouse,
} from "@/server/repositories/execution-repo";
import type { HouseConfiguration } from "@/shared/types";
import {
  deriveRuntimeStatus,
  buildHouseDetail,
  buildHouseListSummary,
} from "@/server/services/execution-service";
import { getUsageSummaryForTask, createUsageRecord } from "@/server/repositories/execution-repo";
import { createSubtask, linkChildTask } from "@/server/repositories/subtask-repo";

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

beforeEach(() => {
  resetDbForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-execsvc-"));
  dbPath = path.join(tmpDir, "test.db");
  process.env.VELARIS_DB_PATH = dbPath;
  migrate();
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seed() {
  const house = createHouse(getDb(), {
    name: "H",
    description: null,
    agent: { name: "A", role: "R" },
    configuration: makeConfig(),
  });
  return { house };
}

describe("deriveRuntimeStatus", () => {
  it("maps session statuses to house runtime statuses", () => {
    // no session → idle
    expect(deriveRuntimeStatus(null)).toBe("idle");
    expect(deriveRuntimeStatus({ status: "running" })).toBe("working");
    expect(deriveRuntimeStatus({ status: "awaiting_approval" })).toBe("awaiting_approval");
    expect(deriveRuntimeStatus({ status: "awaiting_input" })).toBe("awaiting_input");
    expect(deriveRuntimeStatus({ status: "paused" })).toBe("paused");
    expect(deriveRuntimeStatus({ status: "pending" })).toBe("planning");
    // terminal / unknown statuses derive to idle
    expect(deriveRuntimeStatus({ status: "completed" })).toBe("idle");
    expect(deriveRuntimeStatus({ status: "something_else" })).toBe("idle");
  });
});

describe("buildHouseDetail", () => {
  it("idle house: runtimeStatus idle, activeTask null, pendingApprovals 0", () => {
    const { house } = seed();
    const detail = buildHouseDetail(getDb(), house);
    expect(detail.runtimeStatus).toBe("idle");
    expect(detail.activeTask).toEqual({ id: null, title: null, status: null });
    expect(detail.pendingApprovals).toBe(0);
    // Phase 1 house fields preserved.
    expect(detail.name).toBe("H");
    expect(detail.agent.name).toBe("A");
  });

  it("house with a running session + task: activeTask populated, status working", () => {
    const { house } = seed();
    const task = createTask(getDb(), { title: "Quest", houseId: house.id });
    setTaskStatus(getDb(), task.id, "running");
    const session = createExecutionSession(getDb(), {
      taskId: task.id,
      houseId: house.id,
      provider: "opencode",
      modelId: "glm-5.3",
      directory: tmpDir,
    });
    setSessionStatus(getDb(), session.id, "running");

    const detail = buildHouseDetail(getDb(), house);
    expect(detail.runtimeStatus).toBe("working");
    expect(detail.activeTask).toEqual({ id: task.id, title: "Quest", status: "running" });
    expect(detail.pendingApprovals).toBe(0);
  });

  it("house with an awaiting_approval session + pending approval: pendingApprovals > 0", () => {
    const { house } = seed();
    const task = createTask(getDb(), { title: "Quest", houseId: house.id });
    setTaskStatus(getDb(), task.id, "awaiting_approval");
    const session = createExecutionSession(getDb(), {
      taskId: task.id,
      houseId: house.id,
      provider: "opencode",
      modelId: "glm-5.3",
    });
    setSessionStatus(getDb(), session.id, "awaiting_approval");
    createApprovalRequest(getDb(), {
      sessionId: session.id,
      taskId: task.id,
      houseId: house.id,
      providerRequestId: "per-1",
      kind: "permission",
      title: "Permission: write",
      message: "write",
    });

    const detail = buildHouseDetail(getDb(), house);
    expect(detail.runtimeStatus).toBe("awaiting_approval");
    expect(detail.pendingApprovals).toBe(1);
    expect(detail.activeTask.status).toBe("awaiting_approval");
  });

  it("a paused session is an active session (risk 9) and derives to 'paused'", () => {
    const { house } = seed();
    const task = createTask(getDb(), { title: "Quest", houseId: house.id });
    setTaskStatus(getDb(), task.id, "paused");
    const session = createExecutionSession(getDb(), {
      taskId: task.id,
      houseId: house.id,
      provider: "ollama",
      modelId: "llama3.1:8b",
    });
    setSessionStatus(getDb(), session.id, "paused");

    // getActiveSessionForHouse must treat a paused session as active — the
    // queue relies on it to never start a second task for the same house.
    expect(getActiveSessionForHouse(getDb(), house.id)?.status).toBe("paused");

    const detail = buildHouseDetail(getDb(), house);
    expect(detail.runtimeStatus).toBe("paused");
    expect(detail.activeTask.status).toBe("paused");
  });
});

describe("buildHouseListSummary", () => {
  it("returns runtimeStatus + pendingApprovals without the heavier detail", () => {
    const { house } = seed();
    const summary = buildHouseListSummary(getDb(), house);
    expect(summary).toHaveProperty("runtimeStatus");
    expect(summary).toHaveProperty("pendingApprovals");
    expect(summary.runtimeStatus).toBe("idle");
    expect(summary.pendingApprovals).toBe(0);
  });

  it("reflects a pending approval in the list summary count", () => {
    const { house } = seed();
    const task = createTask(getDb(), { title: "Quest", houseId: house.id });
    const session = createExecutionSession(getDb(), {
      taskId: task.id,
      houseId: house.id,
      provider: "opencode",
      modelId: "m",
    });
    setSessionStatus(getDb(), session.id, "awaiting_approval");
    createNotification(getDb(), {
      type: "approval",
      houseId: house.id,
      taskId: task.id,
      title: "x",
      body: "y",
    });
    createApprovalRequest(getDb(), {
      sessionId: session.id,
      taskId: task.id,
      houseId: house.id,
      providerRequestId: "per-2",
      kind: "permission",
      title: "Permission: run",
      message: "run",
    });
    expect(buildHouseListSummary(getDb(), house).pendingApprovals).toBe(1);
  });
});

/* ================================================================== */
/* getUsageSummaryForTask — High Lord parent usage rollup               */
/* ================================================================== */

describe("getUsageSummaryForTask", () => {
  function seedSession(taskId: string): { sessionId: string; houseId: string } {
    const h = createHouse(getDb(), {
      name: "H",
      description: null,
      agent: { name: "A", role: "R" },
      configuration: makeConfig(),
    });
    const session = createExecutionSession(getDb(), {
      taskId,
      houseId: h.id,
      provider: "opencode",
      modelId: "glm-5.3",
    });
    return { sessionId: session.id, houseId: h.id };
  }

  it("rolls up the parent planning session + all child task usage rows", () => {
    // Parent task with its own (planning) session usage.
    const hlHouse = createHouse(getDb(), {
      name: "HL",
      description: null,
      agent: { name: "HL", role: "HL" },
      configuration: makeConfig(),
    });
    const parent = createTask(getDb(), { title: "Parent quest", houseId: hlHouse.id });
    const parentSession = seedSession(parent.id);
    createUsageRecord(getDb(), {
      sessionId: parentSession.sessionId,
      taskId: parent.id,
      houseId: parentSession.houseId,
      modelId: "glm-5.3",
      provider: "opencode",
      cost: { cost: 10, inputTokens: 1000, outputTokens: 500 },
    });

    // Two child tasks via subtasks linkage, each with usage rows (retries add rows).
    const childA = createTask(getDb(), { title: "childA", houseId: hlHouse.id });
    const childB = createTask(getDb(), { title: "childB", houseId: hlHouse.id });

    const childASession = seedSession(childA.id);
    createUsageRecord(getDb(), {
      sessionId: childASession.sessionId,
      taskId: childA.id,
      houseId: childASession.houseId,
      modelId: "glm-5.3",
      provider: "opencode",
      cost: { cost: 5, inputTokens: 500, outputTokens: 300 },
    });

    const childBSession = seedSession(childB.id);
    createUsageRecord(getDb(), {
      sessionId: childBSession.sessionId,
      taskId: childB.id,
      houseId: childBSession.houseId,
      modelId: "glm-5.3",
      provider: "opencode",
      cost: { cost: 2, inputTokens: 200, outputTokens: 100 },
    });

    const sA = createSubtask(getDb(), {
      parentId: parent.id,
      planId: "s0",
      orderIndex: 0,
      dependsOn: [],
      title: "A",
    });
    linkChildTask(getDb(), sA.id, childA.id);
    const sB = createSubtask(getDb(), {
      parentId: parent.id,
      planId: "s1",
      orderIndex: 1,
      dependsOn: [],
      title: "B",
    });
    linkChildTask(getDb(), sB.id, childB.id);

    const summary = getUsageSummaryForTask(getDb(), parent.id);
    expect(summary.total).toBe(17); // 10 parent + 5 childA + 2 childB
    expect(summary.inputTokens).toBe(1700);
    expect(summary.outputTokens).toBe(900);
    expect(summary.reasoningTokens).toBe(0);
    expect(summary.cacheReadTokens).toBe(0);
  });

  it("returns a zeroed summary when the parent has no usage and no children", () => {
    const hlHouse = createHouse(getDb(), {
      name: "HL",
      description: null,
      agent: { name: "HL", role: "HL" },
      configuration: makeConfig(),
    });
    const parent = createTask(getDb(), { title: "Parent quest", houseId: hlHouse.id });
    const summary = getUsageSummaryForTask(getDb(), parent.id);
    expect(summary).toEqual({
      total: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      estimated: false,
    });
  });

  it("flags estimated=true when any aggregated row is an Ollama estimate (Q12)", () => {
    const hlHouse = createHouse(getDb(), {
      name: "HL",
      description: null,
      agent: { name: "HL", role: "HL" },
      configuration: makeConfig(),
    });
    const parent = createTask(getDb(), { title: "Parent quest", houseId: hlHouse.id });
    const parentSession = seedSession(parent.id);
    // One provider-reported OpenCode row (estimated=false)…
    createUsageRecord(getDb(), {
      sessionId: parentSession.sessionId,
      taskId: parent.id,
      houseId: parentSession.houseId,
      modelId: "glm-5.3",
      provider: "opencode",
      cost: { cost: 10, inputTokens: 1000, outputTokens: 500 },
      estimated: false,
    });

    // …and one estimated Ollama row → rollup must be estimated.
    const child = createTask(getDb(), { title: "child", houseId: hlHouse.id });
    const childSession = seedSession(child.id);
    createUsageRecord(getDb(), {
      sessionId: childSession.sessionId,
      taskId: child.id,
      houseId: childSession.houseId,
      modelId: "llama3.1:8b",
      provider: "ollama",
      cost: { cost: 0, inputTokens: 10, outputTokens: 5 },
      estimated: true,
    });
    const s = createSubtask(getDb(), { parentId: parent.id, planId: "s0", orderIndex: 0, dependsOn: [], title: "A" });
    linkChildTask(getDb(), s.id, child.id);

    const summary = getUsageSummaryForTask(getDb(), parent.id);
    expect(summary.estimated).toBe(true);
  });

  it("all provider-reported rows ⇒ estimated=false", () => {
    const hlHouse = createHouse(getDb(), {
      name: "HL",
      description: null,
      agent: { name: "HL", role: "HL" },
      configuration: makeConfig(),
    });
    const parent = createTask(getDb(), { title: "Parent", houseId: hlHouse.id });
    const s = seedSession(parent.id);
    createUsageRecord(getDb(), {
      sessionId: s.sessionId,
      taskId: parent.id,
      houseId: s.houseId,
      modelId: "glm-5.3",
      provider: "opencode",
      cost: { cost: 1, inputTokens: 10, outputTokens: 5 },
      estimated: false,
    });
    expect(getUsageSummaryForTask(getDb(), parent.id).estimated).toBe(false);
  });
});
