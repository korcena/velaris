/**
 * Unit tests — subtask + handoff repositories (Phase 4 High Lord orchestration).
 *
 * Covers creation, the unique child-task link, status transitions, attempt
 * bump, child-task re-pointing, parent listing with the tasks/houses join
 * (childTaskStatus/houseName), and handoff CRUD — all against a temp DB.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getDb, getRawDb, resetDbForTests } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";
import { createHouse } from "@/server/repositories/house-repo";
import { createTask, setTaskStatus } from "@/server/repositories/task-repo";
import {
  createSubtask,
  getSubtask,
  getSubtaskByChildTaskId,
  listSubtasksForParent,
  listSubtasksForParentByStatus,
  setSubtaskStatus,
  incrementSubtaskAttempt,
  linkChildTask,
  cancelSubtasksForParent,
  SubtaskNotFoundError,
} from "@/server/repositories/subtask-repo";
import {
  createHandoff,
  listHandoffsForParent,
  getHandoff,
} from "@/server/repositories/handoff-repo";
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

function seedHouse(name: string) {
  return createHouse(getDb(), {
    name,
    description: null,
    agent: { name: `${name}-agent`, role: "agent" },
    configuration: makeConfig(),
  });
}

beforeEach(() => {
  resetDbForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-subtask-"));
  dbPath = path.join(tmpDir, "test.db");
  process.env.VELARIS_DB_PATH = dbPath;
  migrate();
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ================================================================== */
/* subtasks                                                           */
/* ================================================================== */

describe("subtask repository", () => {
  it("creates a planned subtask linked to a parent with defaults", () => {
    const db = getDb();
    const parent = createTask(db, { title: "Quest", houseId: seedHouse("HL").id });

    const s = createSubtask(db, {
      parentId: parent.id,
      planId: "s0",
      orderIndex: 0,
      dependsOn: [],
      title: "Research the gate",
      instructions: "Investigate the wards.",
      completionRequirements: "A report.",
    });

    expect(s.id).toBeTruthy();
    expect(s.parentTaskId).toBe(parent.id);
    expect(s.planId).toBe("s0");
    expect(s.status).toBe("planned");
    expect(s.attemptCount).toBe(0);
    expect(s.taskId).toBeNull();
    expect(s.dependsOn).toEqual([]);
    expect(s.title).toBe("Research the gate");
  });

  it("enforces the 1:1 child-task unique index (unique task_id)", () => {
    const db = getDb();
    const parent = createTask(db, { title: "P", houseId: seedHouse("HL").id });
    const childTask = createTask(db, { title: "child", houseId: seedHouse("H1").id });

    const s1 = createSubtask(db, {
      parentId: parent.id,
      planId: "s0",
      orderIndex: 0,
      dependsOn: [],
      title: "A",
    });
    linkChildTask(db, s1.id, childTask.id);

    // A second subtask cannot claim the same child task row.
    const s2 = createSubtask(db, {
      parentId: parent.id,
      planId: "s1",
      orderIndex: 1,
      dependsOn: [],
      title: "B",
    });
    expect(() => linkChildTask(db, s2.id, childTask.id)).toThrow(/SQLITE_CONSTRAINT|UNIQUE/);
  });

  it("getSubtaskByChildTaskId is one-indexed probe (is-a-child-task)", () => {
    const db = getDb();
    const parent = createTask(db, { title: "P", houseId: seedHouse("HL").id });
    const childTask = createTask(db, { title: "child", houseId: seedHouse("H1").id });

    expect(getSubtaskByChildTaskId(db, childTask.id)).toBeNull();

    const s = createSubtask(db, {
      parentId: parent.id,
      planId: "s0",
      orderIndex: 0,
      dependsOn: [],
      title: "A",
    });
    linkChildTask(db, s.id, childTask.id);

    const probe = getSubtaskByChildTaskId(db, childTask.id);
    expect(probe?.id).toBe(s.id);
  });

  it("setSubtaskStatus transitions status freely (engine-owned, no guard)", () => {
    const db = getDb();
    const parent = createTask(db, { title: "P", houseId: seedHouse("HL").id });
    const s = createSubtask(db, {
      parentId: parent.id,
      planId: "s0",
      orderIndex: 0,
      dependsOn: [],
      title: "A",
    });

    expect(setSubtaskStatus(db, s.id, "ready")?.status).toBe("ready");
    expect(setSubtaskStatus(db, s.id, "delegated")?.status).toBe("delegated");
    expect(setSubtaskStatus(db, s.id, "completed")?.status).toBe("completed");
    // Unknown id → null
    expect(setSubtaskStatus(db, randomUUID(), "ready")).toBeNull();
  });

  it("incrementSubtaskAttempt bumps the count", () => {
    const db = getDb();
    const parent = createTask(db, { title: "P", houseId: seedHouse("HL").id });
    const s = createSubtask(db, {
      parentId: parent.id,
      planId: "s0",
      orderIndex: 0,
      dependsOn: [],
      title: "A",
    });

    expect(incrementSubtaskAttempt(db, s.id)).toBe(1);
    expect(incrementSubtaskAttempt(db, s.id)).toBe(2);
    expect(getSubtask(db, s.id)?.attemptCount).toBe(2);
    expect(() => incrementSubtaskAttempt(db, randomUUID())).toThrow(SubtaskNotFoundError);
  });

  it("linkChildTask re-points a subtask to a fresh child (retry flow)", () => {
    const db = getDb();
    const hl = seedHouse("HL");
    const h1 = seedHouse("H1");
    const parent = createTask(db, { title: "P", houseId: hl.id });
    const s = createSubtask(db, {
      parentId: parent.id,
      planId: "s0",
      orderIndex: 0,
      dependsOn: [],
      title: "A",
    });

    const child1 = createTask(db, { title: "c1", houseId: h1.id });
    linkChildTask(db, s.id, child1.id);
    expect(getSubtask(db, s.id)?.taskId).toBe(child1.id);

    // Old child stays terminal as history; re-point to a fresh child.
    setTaskStatus(db, child1.id, "failed");
    const child2 = createTask(db, { title: "c2", houseId: h1.id });
    linkChildTask(db, s.id, child2.id);
    expect(getSubtask(db, s.id)?.taskId).toBe(child2.id);
  });

  it("listSubtasksForParent orders by order_index and joins childTaskStatus + houseName", () => {
    const db = getDb();
    const hl = seedHouse("HL");
    const h1 = seedHouse("H1");
    const parent = createTask(db, { title: "P", houseId: hl.id });

    const s0 = createSubtask(db, {
      parentId: parent.id,
      planId: "s0",
      orderIndex: 0,
      dependsOn: [],
      title: "first",
    });
    const s1 = createSubtask(db, {
      parentId: parent.id,
      planId: "s1",
      orderIndex: 1,
      dependsOn: ["s0"],
      title: "second",
    });

    // Delegate s0 to H1 and mark its child running.
    const c0 = createTask(db, { title: "c0", houseId: h1.id, workingDirectory: tmpDir });
    linkChildTask(db, s0.id, c0.id);
    setTaskStatus(db, c0.id, "running");

    const listed = listSubtasksForParent(db, parent.id);
    expect(listed.map((s) => s.planId)).toEqual(["s0", "s1"]);
    expect(listed[0].childTaskStatus).toBe("running");
    expect(listed[0].houseId).toBe(h1.id);
    expect(listed[0].houseName).toBe("H1");
    // s1 not yet delegated → no child status/house.
    expect(listed[1].childTaskStatus).toBeNull();
    expect(listed[1].houseId).toBeNull();
    expect(listed[1].dependsOn).toEqual(["s0"]);
  });

  it("listSubtasksForParentByStatus filters the ready-set", () => {
    const db = getDb();
    const parent = createTask(db, { title: "P", houseId: seedHouse("HL").id });

    createSubtask(db, { parentId: parent.id, planId: "s0", orderIndex: 0, dependsOn: [], title: "a", status: "planned" });
    createSubtask(db, { parentId: parent.id, planId: "s1", orderIndex: 1, dependsOn: [], title: "b", status: "ready" });

    const ready = listSubtasksForParentByStatus(db, parent.id, ["ready"]);
    expect(ready.map((s) => s.planId)).toEqual(["s1"]);
  });

  it("cancelSubtasksForParent flips non-terminal subtasks to cancelled, leaves terminal alone", () => {
    const db = getDb();
    const parent = createTask(db, { title: "P", houseId: seedHouse("HL").id });

    const planned = createSubtask(db, { parentId: parent.id, planId: "s0", orderIndex: 0, dependsOn: [], title: "a", status: "planned" });
    const delegated = createSubtask(db, { parentId: parent.id, planId: "s1", orderIndex: 1, dependsOn: [], title: "b", status: "delegated" });
    const completed = createSubtask(db, { parentId: parent.id, planId: "s2", orderIndex: 2, dependsOn: [], title: "c", status: "completed" });

    const flipped = cancelSubtasksForParent(db, parent.id);
    expect(flipped.sort()).toEqual([planned.id, delegated.id].sort());

    const listed = listSubtasksForParent(db, parent.id);
    expect(listed.find((s) => s.id === planned.id)?.status).toBe("cancelled");
    expect(listed.find((s) => s.id === delegated.id)?.status).toBe("cancelled");
    // Terminal subtask untouched.
    expect(listed.find((s) => s.id === completed.id)?.status).toBe("completed");
  });
});

/* ================================================================== */
/* handoffs                                                           */
/* ================================================================== */

describe("handoff repository", () => {
  it("creates a handoff and lists by parent", () => {
    const db = getDb();
    const hl = seedHouse("HL");
    const h1 = seedHouse("H1");
    const parent = createTask(db, { title: "P", houseId: hl.id });
    const s = createSubtask(db, {
      parentId: parent.id,
      planId: "s0",
      orderIndex: 0,
      dependsOn: [],
      title: "A",
    });

    const h = createHandoff(db, {
      parentTaskId: parent.id,
      subtaskId: s.id,
      sourceHouseId: hl.id,
      destinationHouseId: h1.id,
      instructions: "Do the thing",
      context: { key: "value" },
      artifacts: ["report.md"],
      completionRequirements: "A report",
    });

    expect(h.sourceHouseId).toBe(hl.id);
    expect(h.destinationHouseId).toBe(h1.id);
    expect(h.context).toEqual({ key: "value" });
    expect(h.artifacts).toEqual(["report.md"]);

    const listed = listHandoffsForParent(db, parent.id);
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(h.id);

    expect(getHandoff(db, h.id)?.subtaskId).toBe(s.id);
    expect(getHandoff(db, randomUUID())).toBeNull();
  });
});
