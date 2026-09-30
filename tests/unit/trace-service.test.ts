/**
 * Unit tests — trace service (src/server/services/trace-service.ts).
 *
 * Covers:
 *  - aggregation across a quest tree: parent + live child events AND messages,
 *    tagged with the right taskId/subtaskId/planId/agentId/agentName;
 *  - soft-deleted children excluded from the rollup;
 *  - ascending createdAt ordering with a deterministic id tie-break;
 *  - the merged cap (`limit`) and `truncated` flag;
 *  - a non-Court quest (no children) degrades to its own rows;
 *  - unknown id → null.
 *
 * Fresh temp DB per test.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, getRawDb, resetDbForTests } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";
import { createHouse, seedHighLordHouse } from "@/server/repositories/house-repo";
import { createTask, softDeleteTask } from "@/server/repositories/task-repo";
import { createSubtask, linkChildTask } from "@/server/repositories/subtask-repo";
import {
  createExecutionSession,
  createExecutionEvent,
  createAgentMessage,
} from "@/server/repositories/execution-repo";
import { buildTaskTrace } from "@/server/services/trace-service";
import type { HouseConfiguration } from "@/shared/types";

let tmpDir: string;

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-trace-"));
  process.env.VELARIS_DB_PATH = path.join(tmpDir, "test.db");
  migrate();
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Seed an event + a message on a task, returning the session id. */
function seedActivity(taskId: string, houseId: string, content: string) {
  const session = createExecutionSession(getDb(), {
    taskId,
    houseId,
    provider: "opencode",
    modelId: "glm-5.3",
  });
  createExecutionEvent(getDb(), {
    sessionId: session.id,
    taskId,
    houseId,
    rawType: "task_started",
    type: "task_started",
    payload: { title: content },
  });
  createAgentMessage(getDb(), { sessionId: session.id, role: "agent", content });
  return session.id;
}

/** Force a deterministic createdAt on the newest event/message/session row. */
function setCreatedAt(table: "execution_events" | "agent_messages", at: string) {
  const db = getRawDb();
  const row = db.prepare(`SELECT id FROM ${table} ORDER BY rowid DESC LIMIT 1`).get() as
    | { id: string | number }
    | undefined;
  if (row) db.prepare(`UPDATE ${table} SET created_at = ? WHERE id = ?`).run(at, row.id);
}

describe("buildTaskTrace", () => {
  it("returns null for an unknown task", () => {
    expect(buildTaskTrace(getDb(), "00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("non-Court quest degrades to its own events + messages", () => {
    const house = createHouse(getDb(), {
      name: "House",
      description: null,
      agent: { name: "A", role: "R" },
      configuration: makeConfig(),
    });
    const task = createTask(getDb(), { title: "Solo", houseId: house.id });
    seedActivity(task.id, house.id, "hello");

    const trace = buildTaskTrace(getDb(), task.id)!;
    expect(trace.taskId).toBe(task.id);
    expect(trace.entries).toHaveLength(2); // one event + one message
    expect(trace.entries.every((e) => e.taskId === task.id)).toBe(true);
    expect(trace.entries.every((e) => e.subtaskId === null && e.planId === null)).toBe(true);
    expect(trace.entries.every((e) => e.agentName === "A")).toBe(true);
  });

  it("merges parent + live child, tags steps/agents, and excludes deleted children", () => {
    const hl = seedHighLordHouse(getDb())!;
    const exec = createHouse(getDb(), {
      name: "Forge",
      description: null,
      agent: { name: "Hephaestus", role: "smith" },
      configuration: makeConfig(),
    });

    const parent = createTask(getDb(), { title: "Quest", houseId: hl.id });
    seedActivity(parent.id, hl.id, "parent msg");

    // Live child.
    const s0 = createSubtask(getDb(), {
      parentId: parent.id,
      planId: "s0",
      orderIndex: 0,
      dependsOn: [],
      title: "Forge keys",
    });
    const child0 = createTask(getDb(), { title: "child0", houseId: exec.id });
    linkChildTask(getDb(), s0.id, child0.id);
    seedActivity(child0.id, exec.id, "child msg");

    // Soft-deleted child — must be absent.
    const s1 = createSubtask(getDb(), {
      parentId: parent.id,
      planId: "s1",
      orderIndex: 1,
      dependsOn: [],
      title: "Dead step",
    });
    const child1 = createTask(getDb(), { title: "child1", houseId: exec.id });
    linkChildTask(getDb(), s1.id, child1.id);
    seedActivity(child1.id, exec.id, "deleted msg");
    softDeleteTask(getDb(), child1.id);

    const trace = buildTaskTrace(getDb(), parent.id)!;
    const taskIds = new Set(trace.entries.map((e) => e.taskId));
    expect(taskIds.has(parent.id)).toBe(true);
    expect(taskIds.has(child0.id)).toBe(true);
    expect(taskIds.has(child1.id)).toBe(false);

    const childEntries = trace.entries.filter((e) => e.taskId === child0.id);
    expect(childEntries).toHaveLength(2);
    expect(childEntries.every((e) => e.subtaskId === s0.id)).toBe(true);
    expect(childEntries.every((e) => e.planId === "s0")).toBe(true);
    expect(childEntries.every((e) => e.agentName === "Hephaestus")).toBe(true);

    const parentEntries = trace.entries.filter((e) => e.taskId === parent.id);
    expect(parentEntries).toHaveLength(2);
    expect(parentEntries.every((e) => e.subtaskId === null)).toBe(true);
    // The HL house's default agent is its seeded one.
    expect(parentEntries.every((e) => e.agentId !== null)).toBe(true);
  });

  it("orders entries ascending by createdAt", () => {
    const house = createHouse(getDb(), {
      name: "House",
      description: null,
      agent: { name: "A", role: "R" },
      configuration: makeConfig(),
    });
    const task = createTask(getDb(), { title: "Solo", houseId: house.id });
    seedActivity(task.id, house.id, "first"); // event then message
    setCreatedAt("execution_events", "2026-01-01T00:00:00.000Z");
    setCreatedAt("agent_messages", "2026-01-01T01:00:00.000Z");

    const trace = buildTaskTrace(getDb(), task.id)!;
    expect(trace.entries.map((e) => e.kind)).toEqual(["event", "message"]);
    expect(trace.entries[0].createdAt < trace.entries[1].createdAt).toBe(true);
  });

  it("caps merged entries and sets truncated", () => {
    const house = createHouse(getDb(), {
      name: "House",
      description: null,
      agent: { name: "A", role: "R" },
      configuration: makeConfig(),
    });
    const task = createTask(getDb(), { title: "Solo", houseId: house.id });
    const sessionId = seedActivity(task.id, house.id, "x"); // 2 entries
    // A third entry so the merged list exceeds the cap of 2.
    createExecutionEvent(getDb(), {
      sessionId,
      taskId: task.id,
      houseId: house.id,
      rawType: "task_completed",
      type: "task_completed",
      payload: {},
    });

    const trace = buildTaskTrace(getDb(), task.id, { limit: 2 })!;
    expect(trace.entries).toHaveLength(2);
    expect(trace.truncated).toBe(true);
  });
});
