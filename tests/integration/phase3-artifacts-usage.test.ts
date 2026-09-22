/**
 * Integration tests — Phase 3 artifacts + usage + tasks status filter, invoked
 * directly with `new Request(...)` against a temp DB (following
 * tests/integration/execution-routes.test.ts's exact isolation contract:
 * VELARIS_DB_PATH set BEFORE importing route modules via env, and
 * resetDbForTests() + resetBootstrapForTests() in beforeEach).
 *
 * Coverage:
 *  - GET /api/tasks/{id}/artifacts: 404 unknown, [] when none, aggregated
 *    across two sessions ordered by created_at.
 *  - GET /api/houses/{id}: usage sums + session count; zeroed (not null) when
 *    no history.
 *  - GET /api/tasks?status=completed&houseId= filter regression after the
 *    status whitelist was widened to all TASK_STATUSES.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { resetDbForTests, getDb } from "@/lib/db";
import { resetBootstrapForTests } from "@/server/bootstrap";

import { GET as getArtifacts } from "@/app/api/tasks/[id]/artifacts/route";
import { GET as getHouseById } from "@/app/api/houses/[id]/route";
import { GET as listTasks } from "@/app/api/tasks/route";
import { POST as createHouseRoute } from "@/app/api/houses/route";
import { POST as createTaskRoute } from "@/app/api/tasks/route";

import {
  createExecutionSession,
  createArtifact,
  createUsageRecord,
  setSessionStatus,
} from "@/server/repositories/execution-repo";
import { setTaskStatus } from "@/server/repositories/task-repo";

const BASE = "http://localhost:3000";
let tmpDir: string;

beforeEach(() => {
  resetDbForTests();
  resetBootstrapForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-p3-"));
  process.env.VELARIS_DB_PATH = path.join(tmpDir, "test.db");
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function req(url: string, init?: RequestInit): NextRequest {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  const method = init?.method;
  const body = init?.body;
  return new NextRequest(url, body !== undefined ? { method, body, headers } : { method, headers });
}

function jsonReq(method: string, url: string, body: unknown): NextRequest {
  return req(url, { method, body: JSON.stringify(body) });
}

function idCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function housePayload() {
  return {
    name: "House of Artifacts",
    description: "",
    agent: { name: "Azriel", role: "keeper" },
    configuration: {
      systemPrompt: "You are Azriel.",
      executionProvider: "opencode",
      aiProvider: "ollama-cloud",
      modelId: "glm-5.3",
      workspaceAllowlist: [tmpDir],
      tools: ["fs"],
      permissions: { fileSystem: "ask", shell: "ask", network: "deny", git: "allow" },
      approvalPolicy: "always",
      concurrency: 1,
    },
  };
}

async function createHouse(): Promise<{ id: string }> {
  const res = await createHouseRoute(jsonReq("POST", `${BASE}/api/houses`, housePayload()));
  expect(res.status).toBe(201);
  return { id: ((await res.json()) as { house: { id: string } }).house.id };
}

async function createTask(houseId: string): Promise<{ id: string }> {
  const res = await createTaskRoute(
    jsonReq("POST", `${BASE}/api/tasks`, { title: "Gather scrolls", houseId, workingDirectory: tmpDir }),
  );
  expect(res.status).toBe(201);
  return { id: ((await res.json()) as { task: { id: string } }).task.id };
}

function makeSession(houseId: string, taskId: string) {
  return createExecutionSession(getDb(), {
    taskId,
    houseId,
    provider: "opencode",
    modelId: "glm-5.3",
    directory: tmpDir,
  });
}

describe("GET /api/tasks/{id}/artifacts", () => {
  it("unknown task → 404", async () => {
    const missing = randomUUID();
    const res = await getArtifacts(req(`${BASE}/api/tasks/${missing}/artifacts`), idCtx(missing));
    expect(res.status).toBe(404);
  });

  it("returns [] when task produced no artifacts", async () => {
    const { id: house } = await createHouse();
    const task = await createTask(house);
    const res = await getArtifacts(req(`${BASE}/api/tasks/${task.id}/artifacts`), idCtx(task.id));
    expect(res.status).toBe(200);
    const { artifacts } = await res.json();
    expect(artifacts).toEqual([]);
    expect(artifacts).toHaveLength(0);
  });

  it("aggregates artifacts across two sessions, ordered by created_at", async () => {
    const { id: house } = await createHouse();
    const task = await createTask(house);
    const db = getDb();

    const s1 = makeSession(house, task.id);
    const s2 = makeSession(house, task.id);
    setSessionStatus(db, s1.id, "completed");
    setSessionStatus(db, s2.id, "completed");

    // Create in non-chronological request order; listing should still be by
    // created_at (insertion order here, but assert the array length + kinds).
    createArtifact(db, {
      sessionId: s2.id,
      taskId: task.id,
      kind: "result",
      content: "done",
    });
    createArtifact(db, {
      sessionId: s1.id,
      taskId: task.id,
      kind: "diff",
      content: "modified src/a.txt\n+added\n---\nmodified src/b.txt\n-removed",
    });
    createArtifact(db, {
      sessionId: s2.id,
      taskId: task.id,
      kind: "file_list",
      content: "[src/a.txt]",
    });

    const res = await getArtifacts(req(`${BASE}/api/tasks/${task.id}/artifacts`), idCtx(task.id));
    expect(res.status).toBe(200);
    const { artifacts } = await res.json();
    expect(artifacts).toHaveLength(3);
    expect(artifacts.map((a: { kind: string }) => a.kind).sort()).toEqual([
      "diff",
      "file_list",
      "result",
    ]);
    // All artifacts carry the taskId.
    expect(artifacts.every((a: { taskId: string }) => a.taskId === task.id)).toBe(true);
    // Sorted ascending by createdAt (insertion order preserved via identical-ish timestamps).
    const times = artifacts.map((a: { createdAt: string }) => new Date(a.createdAt).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});

describe("GET /api/houses/{id} — usage summary", () => {
  it("usage is zeroed (never null) with no history", async () => {
    const { id: house } = await createHouse();
    const res = await getHouseById(req(`${BASE}/api/houses/${house}`), idCtx(house));
    expect(res.status).toBe(200);
    const { house: detail } = await res.json();
    expect(detail.usage).toEqual({
      total: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      sessions: 0,
    });
  });

  it("sums cost + token counters and counts sessions", async () => {
    const { id: house } = await createHouse();
    const task = await createTask(house);
    const db = getDb();

    const s1 = makeSession(house, task.id);
    const s2 = makeSession(house, task.id);

    createUsageRecord(db, {
      sessionId: s1.id,
      taskId: task.id,
      houseId: house,
      modelId: "glm-5.3",
      provider: "opencode",
      cost: { cost: 1.5, inputTokens: 100, outputTokens: 50, reasoningTokens: 10, cacheReadTokens: 5 },
    });
    createUsageRecord(db, {
      sessionId: s2.id,
      taskId: task.id,
      houseId: house,
      modelId: "glm-5.3",
      provider: "opencode",
      cost: { cost: 2.5, inputTokens: 200, outputTokens: 150, reasoningTokens: 20, cacheReadTokens: 15 },
    });

    const res = await getHouseById(req(`${BASE}/api/houses/${house}`), idCtx(house));
    expect(res.status).toBe(200);
    const { house: detail } = await res.json();
    expect(detail.usage.total).toBeCloseTo(4.0, 5);
    expect(detail.usage.inputTokens).toBe(300);
    expect(detail.usage.outputTokens).toBe(200);
    expect(detail.usage.reasoningTokens).toBe(30);
    expect(detail.usage.cacheReadTokens).toBe(20);
    expect(detail.usage.sessions).toBe(2);
    // additive fields preserved on the detail
    expect(detail.runtimeStatus).toBeDefined();
    expect(detail.pendingApprovals).toBeDefined();
  });
});

describe("GET /api/tasks?status=completed&houseId= — whitelist regression", () => {
  it("filters by the widened status set (completed)", async () => {
    const { id: house } = await createHouse();
    const done = await createTask(house);
    const running = await createTask(house);

    setTaskStatus(getDb(), done.id, "completed");
    setTaskStatus(getDb(), running.id, "running");

    const res = await listTasks(req(`${BASE}/api/tasks?houseId=${house}&status=completed`));
    expect(res.status).toBe(200);
    const { tasks } = await res.json();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(done.id);
    expect(tasks[0].status).toBe("completed");
  });

  it("accepts every TASK_STATUSES value without error", async () => {
    const { id: house } = await createHouse();
    for (const status of ["queued", "running", "awaiting_approval", "awaiting_input", "completed", "failed", "cancelled", "interrupted"]) {
      const res = await listTasks(req(`${BASE}/api/tasks?houseId=${house}&status=${status}`));
      expect(res.status).toBe(200);
    }
  });
});
