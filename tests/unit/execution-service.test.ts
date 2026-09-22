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
} from "@/server/repositories/execution-repo";
import type { HouseConfiguration } from "@/shared/types";
import {
  deriveRuntimeStatus,
  buildHouseDetail,
  buildHouseListSummary,
} from "@/server/services/execution-service";

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
