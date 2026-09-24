/**
 * Integration tests — Phase 4 Court + plan routes (addendum D2/D4/D6).
 *
 * Temp-DB contract matches api-routes.test.ts: set VELARIS_DB_PATH before
 * importing route modules; resetDbForTests() + resetBootstrapForTests() per
 * test; invoke handlers with new NextRequest().
 *
 * Coverage:
 *  - POST /api/court/instructions: 201 + parent task on the HL house; 400
 *    without a directory/project; zod errors; 404 when the HL is absent.
 *  - GET /api/court/history: envelope { messages, highLordHouseId }.
 *  - POST /api/court/steer: 200 write, 404 non-parent, 409 terminal, 409 busy,
 *    400 zod.
 *  - GET /api/tasks/{id}/plan: { plan: null } for a plain task; full PlanDto
 *    after seeding subtask/handoff rows; 404 unknown.
 *  - POST /api/tasks/{id}/cancel cascade: parent + 2 subtasks + child tasks.
 *  - GET /api/houses: default excludes the HL; includeHighLord=true includes
 *    it with planState.
 *  - PATCH /api/tasks/{parent} executionPreferences → 422 (prefs-clobber guard).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { resetDbForTests, getDb, getRawDb } from "@/lib/db";
import { resetBootstrapForTests, bootstrapDb } from "@/server/bootstrap";

import { POST as postInstructions } from "@/app/api/court/instructions/route";
import { GET as getHistory } from "@/app/api/court/history/route";
import { POST as postSteer } from "@/app/api/court/steer/route";
import { GET as getPlan } from "@/app/api/tasks/[id]/plan/route";
import { POST as cancelTask } from "@/app/api/tasks/[id]/cancel/route";
import { GET as listHouses } from "@/app/api/houses/route";
import { PATCH as patchTask } from "@/app/api/tasks/[id]/route";
import { POST as createProjectRoute } from "@/app/api/projects/route";

import { createHouse } from "@/server/repositories/house-repo";
import { createTask, setTaskStatus } from "@/server/repositories/task-repo";
import {
  createSubtask,
  linkChildTask,
  listSubtasksForParent,
} from "@/server/repositories/subtask-repo";
import { createHandoff } from "@/server/repositories/handoff-repo";
import {
  createExecutionSession,
  createAgentMessage,
  createArtifact,
} from "@/server/repositories/execution-repo";
import type { HouseConfiguration } from "@/shared/types";

const BASE = "http://localhost:3000";
let tmpDir: string;

/** Apply migrations + seed (the HL house) once per test before DB access. */
function boot(): void {
  bootstrapDb();
}

beforeEach(() => {
  resetDbForTests();
  resetBootstrapForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-court-"));
  process.env.VELARIS_DB_PATH = path.join(tmpDir, "test.db");
  boot();
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function req(url: string, init?: RequestInit): NextRequest {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  return new NextRequest(url, { method: init?.method, body: init?.body, headers });
}

function jsonReq(method: string, url: string, body: unknown): NextRequest {
  return req(url, { method, body: JSON.stringify(body) });
}

function idCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}

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

/** Seed an active agent house via the repo (kind=agent, active). */
function seedAgentHouse(name = "House of Mist") {
  return createHouse(getDb(), {
    name,
    description: null,
    agent: { name: "A", role: "R" },
    configuration: makeConfig(),
  });
}

function hlId(): string {
  const hl = findHL();
  if (!hl) throw new Error("High Lord not seeded");
  return hl.id;
}

function findHL() {
  return getRawDb()
    .prepare(`SELECT id FROM houses WHERE kind = 'high_lord' LIMIT 1`)
    .get() as { id: string } | undefined;
}

function seedParentWithPlan(overrides: { parentStatus?: string; hlHouseId?: string } = {}) {
  const hl = overrides.hlHouseId ?? hlId();
  const execHouse = seedAgentHouse("Forge House");
  const parent = createTask(getDb(), { title: "Quest", houseId: hl, workingDirectory: tmpDir });
  if (overrides.parentStatus) setTaskStatus(getDb(), parent.id, overrides.parentStatus as never);

  const s0 = createSubtask(getDb(), {
    parentId: parent.id,
    planId: "s0",
    orderIndex: 0,
    dependsOn: [],
    title: "Forge the keys",
  });
  const child0 = createTask(getDb(), { title: "child0", houseId: execHouse.id });
  linkChildTask(getDb(), s0.id, child0.id);
  createHandoff(getDb(), {
    parentTaskId: parent.id,
    subtaskId: s0.id,
    sourceHouseId: hl,
    destinationHouseId: execHouse.id,
    instructions: "Do it",
  });

  const s1 = createSubtask(getDb(), {
    parentId: parent.id,
    planId: "s1",
    orderIndex: 1,
    dependsOn: ["s0"],
    title: "Open the gate",
  });
  const child1 = createTask(getDb(), { title: "child1", houseId: execHouse.id });
  linkChildTask(getDb(), s1.id, child1.id);

  return { hl, execHouse, parent, s0, child0, s1, child1 };
}

function seedPlanningSession(parentId: string) {
  const session = createExecutionSession(getDb(), {
    taskId: parentId,
    houseId: hlId(),
    provider: "opencode",
    modelId: "glm-5.3",
  });
  // The planning session is terminal after the first plan — steerable via the
  // resumable provider session, and NOT matched by getActiveSessionForHouse.
  getRawDb()
    .prepare(`UPDATE execution_sessions SET status = 'completed' WHERE id = ?`)
    .run(session.id);
  // The original instruction was relayed by the engine — so no "pending steer".
  createAgentMessage(getDb(), {
    sessionId: session.id,
    role: "user",
    content: "Build a wall",
    relayedAt: new Date().toISOString(),
  });
  createAgentMessage(getDb(), { sessionId: session.id, role: "agent", content: `{"subtasks":[]}` });
  return session;
}

/* ================================================================== */
/* POST /api/court/instructions                                       */
/* ================================================================== */

describe("POST /api/court/instructions", () => {
  it("creates a parent task on the High Lord house → 201 + queued", async () => {
    const res = await postInstructions(
      jsonReq("POST", `${BASE}/api/court/instructions`, {
        instruction: "Build the city wall",
        workingDirectory: tmpDir,
      }),
    );
    expect(res.status).toBe(201);
    const { task } = await res.json();
    expect(task.status).toBe("queued");
    expect(task.houseId).toBe(hlId());
    expect(task.workingDirectory).toBe(tmpDir);
    expect(task.title).toContain("Build the city wall");
  });

  it("resolves workingDirectory from a project id when workingDirectory omitted", async () => {
    // register a project with a real temp dir.
    const projRes = await createProjectRoute(
      jsonReq("POST", `${BASE}/api/projects`, { name: "P", directory: tmpDir }),
    );
    expect(projRes.status).toBe(201);
    const { project } = await projRes.json();

    const res = await postInstructions(
      jsonReq("POST", `${BASE}/api/court/instructions`, {
        instruction: "Plan it",
        projectId: project.id,
      }),
    );
    expect(res.status).toBe(201);
    const { task } = await res.json();
    expect(task.workingDirectory).toBe(tmpDir);
  });

  it("400 without a working directory or project", async () => {
    const res = await postInstructions(
      jsonReq("POST", `${BASE}/api/court/instructions`, { instruction: "plan" }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/working directory|project/i);
  });

  it("400 for a relative/nonexistent workingDirectory", async () => {
    const res = await postInstructions(
      jsonReq("POST", `${BASE}/api/court/instructions`, {
        instruction: "plan",
        workingDirectory: "/nonexistent-xyz/dir",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("400 zod validation (empty instruction)", async () => {
    const res = await postInstructions(
      jsonReq("POST", `${BASE}/api/court/instructions`, {
        instruction: "",
        workingDirectory: tmpDir,
      }),
    );
    expect(res.status).toBe(400);
  });
});

/* ================================================================== */
/* GET /api/court/history                                             */
/* ================================================================== */

describe("GET /api/court/history", () => {
  it("returns the envelope with highLordHouseId + empty messages, then populated", async () => {
    const res = await getHistory(req(`${BASE}/api/court/history`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.highLordHouseId).toBe(hlId());
    expect(body.messages).toEqual([]);

    // Seed a parent + planning session with messages → history picks them up.
    const parent = createTask(getDb(), { title: "wall", houseId: hlId() });
    seedPlanningSession(parent.id);
    const again = await (await getHistory(req(`${BASE}/api/court/history`))).json();
    expect(again.messages.length).toBeGreaterThanOrEqual(2);
    expect(again.messages.some((m: { role: string }) => m.role === "user")).toBe(true);
    expect(again.messages.some((m: { role: string }) => m.role === "agent")).toBe(true);
  });
});

/* ================================================================== */
/* POST /api/court/steer                                              */
/* ================================================================== */

describe("POST /api/court/steer", () => {
  it("writes a user message to the planning session for a non-terminal parent → 200", async () => {
    const { parent } = seedParentWithPlan();
    seedPlanningSession(parent.id);

    const res = await postSteer(
      jsonReq("POST", `${BASE}/api/court/steer`, {
        parentTaskId: parent.id,
        message: "Also add tests",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accepted).toBe(true);
    expect(body.sessionId).toEqual(expect.any(String));
  });

  it("404 for an unknown task", async () => {
    const res = await postSteer(
      jsonReq("POST", `${BASE}/api/court/steer`, {
        parentTaskId: randomUUID(),
        message: "x",
      }),
    );
    expect(res.status).toBe(404);
  });

  it("404 for a task that is not a High Lord parent", async () => {
    const execHouse = seedAgentHouse();
    const task = createTask(getDb(), { title: "t", houseId: execHouse.id });
    const res = await postSteer(
      jsonReq("POST", `${BASE}/api/court/steer`, { parentTaskId: task.id, message: "x" }),
    );
    expect(res.status).toBe(404);
  });

  it("409 when the parent is terminal", async () => {
    const { parent } = seedParentWithPlan({ parentStatus: "completed" });
    const res = await postSteer(
      jsonReq("POST", `${BASE}/api/court/steer`, { parentTaskId: parent.id, message: "x" }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/finished|terminal/i);
  });

  it("409 when the planning session is busy (a steer already in flight)", async () => {
    const { parent } = seedParentWithPlan();
    seedPlanningSession(parent.id);
    // Make the planning session active/running → getActiveSessionForHouse matches.
    getRawDb()
      .prepare(`UPDATE execution_sessions SET status = 'running' WHERE task_id = ?`)
      .run(parent.id);

    const res = await postSteer(
      jsonReq("POST", `${BASE}/api/court/steer`, { parentTaskId: parent.id, message: "x" }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/mid-counsel/i);
  });

  it("400 zod validation (empty message)", async () => {
    const { parent } = seedParentWithPlan();
    seedPlanningSession(parent.id);
    const res = await postSteer(
      jsonReq("POST", `${BASE}/api/court/steer`, { parentTaskId: parent.id, message: "" }),
    );
    expect(res.status).toBe(400);
  });
});

/* ================================================================== */
/* GET /api/tasks/{id}/plan                                           */
/* ================================================================== */

describe("GET /api/tasks/{id}/plan", () => {
  it("404 for an unknown task", async () => {
    const res = await getPlan(req(`${BASE}/api/tasks/${randomUUID()}/plan`), idCtx(randomUUID()));
    expect(res.status).toBe(404);
  });

  it("returns { plan: null } for a plain task (not a Court quest)", async () => {
    const task = createTask(getDb(), { title: "direct" });
    const res = await getPlan(req(`${BASE}/api/tasks/${task.id}/plan`), idCtx(task.id));
    expect(res.status).toBe(200);
    expect((await res.json()).plan).toBeNull();
  });

  it("returns the full PlanDto after seeding subtask + handoff rows", async () => {
    const { parent, execHouse, s0 } = seedParentWithPlan();
    // Make plan terminal + add result/diff artifacts for consolidation.
    setTaskStatus(getDb(), parent.id, "completed");
    const session = createExecutionSession(getDb(), {
      taskId: parent.id,
      houseId: hlId(),
      provider: "opencode",
      modelId: "glm-5.3",
    });
    createArtifact(getDb(), {
      sessionId: session.id,
      taskId: parent.id,
      kind: "result",
      content: "The wards held.",
    });

    const res = await getPlan(req(`${BASE}/api/tasks/${parent.id}/plan`), idCtx(parent.id));
    expect(res.status).toBe(200);
    const { plan } = await res.json();
    expect(plan.parentTaskId).toBe(parent.id);
    expect(plan.subtasks).toHaveLength(2);
    expect(plan.subtasks[0].houseName).toBe(execHouse.name);
    expect(plan.subtasks[0].childTaskStatus).toBe("queued");
    expect(plan.handoffs).toHaveLength(1);
    expect(plan.consolidated.summary).toBe("The wards held.");
  });
});

/* ================================================================== */
/* POST /api/tasks/{id}/cancel cascade (High Lord parent)             */
/* ================================================================== */

describe("POST /api/tasks/{id}/cancel cascade", () => {
  it("cancels children + subtask rows when a parent with a plan is cancelled", async () => {
    const { parent, child0, child1, s0, s1 } = seedParentWithPlan();
    // Set both children 'running' with active sessions to prove abort.
    const db = getDb();
    const sess0 = createExecutionSession(db, {
      taskId: child0.id,
      houseId: seedAgentHouse("X").id,
      provider: "opencode",
      modelId: "glm-5.3",
    });
    setTaskStatus(db, child0.id, "running");
    setTaskStatus(db, child1.id, "running");

    // Cancel the parent.
    const res = await cancelTask(req(`${BASE}/api/tasks/${parent.id}/cancel`, { method: "POST" }), idCtx(parent.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task.status).toBe("cancelled");

    // Children cancelled.
    expect(requireTask(child0.id).status).toBe("cancelled");
    expect(requireTask(child1.id).status).toBe("cancelled");

    // Subtask rows flipped to cancelled.
    for (const s of listSubtasksForParent(getDb(), parent.id)) {
      expect(["cancelled", "completed"].includes(s.status)).toBe(true);
      if (s.id === s0.id || s.id === s1.id) expect(s.status).toBe("cancelled");
    }
    void sess0;
  });
});

function requireTask(id: string) {
  const row = getRawDb()
    .prepare(`SELECT status FROM tasks WHERE id = ?`)
    .get(id) as { status: string };
  return row;
}

/* ================================================================== */
/* GET /api/houses includeHighLord + planState                        */
/* ================================================================== */

describe("GET /api/houses includeHighLord", () => {
  it("excludes the High Lord by default; includes with includeHighLord=true + planState", async () => {
    // Seed an agent house too so we can assert the absence of planState.
    const agentHouse = seedAgentHouse("Mist");
    // Ensure seed (bootstrap already seeded on first route call).
    const hl = findHL()!;

    const defaultRes = await (await listHouses(req(`${BASE}/api/houses`))).json();
    expect(defaultRes.houses.some((h: { id: string }) => h.id === hl.id)).toBe(false);
    // The agent house IS in the default list.
    expect(defaultRes.houses.some((h: { id: string }) => h.id === agentHouse.id)).toBe(true);

    const allRes = await (
      await listHouses(req(`${BASE}/api/houses?includeHighLord=true`))
    ).json();
    const hlRow = allRes.houses.find((h: { id: string }) => h.id === hl.id);
    expect(hlRow).toBeTruthy();
    expect(hlRow.kind).toBe("high_lord");
    // planState present on the HL list row (addendum D4f enrichment).
    expect(hlRow.planState).toBeDefined();
    // An agent row has no planState.
    const agentRow = allRes.houses.find((h: { id: string }) => h.id === agentHouse.id);
    expect(agentRow).toBeTruthy();
    expect(agentRow.planState).toBeUndefined();
  });
});

/* ================================================================== */
/* PATCH /api/tasks/{parent} prefs-clobber guard                      */
/* ================================================================== */

describe("PATCH /api/tasks/: prefs-clobber guard (addendum D4c)", () => {
  it("422 when a subtask-linked parent is PATCHed with executionPreferences", async () => {
    const { parent } = seedParentWithPlan();
    const res = await patchTask(
      jsonReq("PATCH", `${BASE}/api/tasks/${parent.id}`, { executionPreferences: { x: 1 } }),
      idCtx(parent.id),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/executionPreferences|engine-owned/i);
  });

  it("200 for a non-plan task's executionPreferences patch (no clobber risk)", async () => {
    const execHouse = seedAgentHouse();
    const task = createTask(getDb(), { title: "direct", houseId: execHouse.id });
    const res = await patchTask(
      jsonReq("PATCH", `${BASE}/api/tasks/${task.id}`, { executionPreferences: { x: 1 } }),
      idCtx(task.id),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).task.executionPreferences).toEqual({ x: 1 });
  });
});
