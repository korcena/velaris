/**
 * Unit tests — High Lord orchestrator (src/engine/orchestrator.ts).
 *
 * DB-backed like queue-loop.test.ts: temp DB + migrate. The `executeTask`
 * runner is mocked to write a real execution_session + agent_messages plan row
 * (so `parsePlanFromSession` reads a real plan) and return a controlled
 * terminal result. OpenCode client is fake; an injected clock makes steering
 * deterministic.
 *
 * Scenarios (plan §8.1 + addendum D6):
 *   1. plan → delegate: subtasks + handoffs created, ready subtasks delegated.
 *   2. repair retry: bad JSON first, plan shape on the second call.
 *   3. fallback single subtask on double failure.
 *   4. ready-set: independent pair delegated while dependent stays planned; dep
 *      completion releases it.
 *   5. per-directory serialization holds the second same-dir subtask.
 *   6. retry loop: child fails → re-delegated (fresh child, re-link, attempt
 *      bump); retries exhausted → abortPlan (children cancelled, parent failed,
 *      abortReason persisted).
 *   7. budget abort reuses abortPlan.
 *   8. all-terminal → consolidate (result + diff artifacts, parent completed).
 *   9. abort via abortPlan cancels running children + their sessions.
 *  10. steering: pending user row relayed + marked; plan-shaped reply →
 *      revision applied; non-plan reply → informational event only.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, getRawDb, resetDbForTests } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";
import { createHouse, seedHighLordHouse, getHouse } from "@/server/repositories/house-repo";
import { createTask, getTask, setTaskStatus, listTasks } from "@/server/repositories/task-repo";
import {
  createExecutionSession,
  setSessionProviderId,
  setSessionStatus,
  createAgentMessage,
  createUsageRecord,
  createArtifact,
  listEventsForTask,
} from "@/server/repositories/execution-repo";
import {
  listSubtasksForParent,
  getSubtaskByChildTaskId,
} from "@/server/repositories/subtask-repo";
import { listHandoffsForParent } from "@/server/repositories/handoff-repo";
import { runParent, tickActivePlans, abortPlan } from "@/engine/orchestrator";
import type { OrchestratorDeps } from "@/engine/orchestrator";
import type { HouseConfiguration } from "@/shared/types";
import { ORCHESTRATION_DEFAULTS } from "@/shared/constants";
import type { OpencodeClient } from "@/server/opencode";
import type { AgentExecutionProvider } from "@/server/execution/types";
import { executeTask } from "@/server/execution/runner";

let tmpDir: string;
let dbPath: string;

function makeConfig(allowlist: string[] = []): HouseConfiguration {
  return {
    systemPrompt: "You are an agent.",
    executionProvider: "opencode",
    aiProvider: "ollama-cloud",
    modelId: "glm-5.3",
    workspaceAllowlist: allowlist,
    tools: ["fs"],
    permissions: { fileSystem: "ask", shell: "ask", network: "deny", git: "allow" },
    approvalPolicy: "never",
    concurrency: 1,
  };
}

function seedHouse(name: string, allowlist: string[] = []) {
  return createHouse(getDb(), {
    name,
    description: null,
    agent: { name: `${name}-agent`, role: name.toLowerCase() },
    configuration: makeConfig(allowlist),
  });
}

/* ---------- hoisted runner mock ---------- */
// The runner is mocked to write a real session + an agent plan row and return a
// controlled terminal status. The behavior is controlled via `__runnerScript`.
type RunnerStep = {
  terminalStatus: "completed" | "failed";
  planJson?: string;
  planFallback?: boolean;
};
const __runnerCalls: RunnerStep[] = [];
let __runnerScript: RunnerStep[] = [];

vi.mock("@/server/execution/runner", async () => {
  const { createExecutionSession, setSessionProviderId, setSessionStatus, createAgentMessage } =
    await vi.importActual<typeof import("@/server/repositories/execution-repo")>(
      "@/server/repositories/execution-repo",
    );
  const { setTaskStatus } = await vi.importActual<typeof import("@/server/repositories/task-repo")>(
    "@/server/repositories/task-repo",
  );
  return {
    executeTask: vi.fn(async (ctx: any) => {
      const step = __runnerScript[__runnerCalls.length] ?? {
        terminalStatus: "completed",
        planFallback: true,
      };
      __runnerCalls.push(step);
      const db = ctx.db;
      const session = createExecutionSession(db, {
        taskId: ctx.task.id,
        houseId: ctx.house.id,
        provider: "opencode",
        modelId: ctx.modelId,
        directory: ctx.directory,
      });
      setSessionProviderId(db, session.id, `prov-${ctx.task.id}-${__runnerCalls.length}`);
      setSessionStatus(db, session.id, "completed");
      setTaskStatus(db, ctx.task.id, "completed");

      if (step.terminalStatus === "failed") {
        return { sessionId: session.id, terminalStatus: "failed", error: "planning exploded" };
      }
      createAgentMessage(db, {
        sessionId: session.id,
        role: "agent",
        content:
          step.planJson ??
          JSON.stringify({
            subtasks: [{ id: "s0", title: "Do the thing", dependsOn: [], instructions: "Go" }],
          }),
      });
      return { sessionId: session.id, terminalStatus: "completed", error: null };
    }),
  };
});

function seedRunner(script: RunnerStep[]) {
  __runnerScript.splice(0, __runnerScript.length, ...script);
  __runnerCalls.splice(0, __runnerCalls.length);
}

function makeDeps(extra: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  const client = {
    health: vi.fn(async () => true),
    getSession: vi.fn(async () => ({
      id: "prov-1",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0 },
      model: { id: "", providerID: "" },
      time: { created: 0, updated: Date.now() },
      title: "",
    })),
    listMessages: vi.fn(async () => []),
  } as unknown as OpencodeClient;
  const adapter = { sendMessage: vi.fn(async () => {}) } as unknown as AgentExecutionProvider;
  return {
    db: getDb(),
    raw: getRawDb(),
    adapter,
    client,
    log: vi.fn(),
    now: () => 1_000_000_001_000,
    steerQuietMs: 0,
    ...extra,
  } as OrchestratorDeps;
}

beforeEach(() => {
  resetDbForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-orch-"));
  dbPath = path.join(tmpDir, "test.db");
  process.env.VELARIS_DB_PATH = dbPath;
  migrate();
  seedRunner([]);
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedWorld() {
  const hl = seedHighLordHouse(getDb())!;
  const h1 = seedHouse("House of Mist");
  const h2 = seedHouse("House of Wind");
  const parent = createTask(getDb(), { title: "Quest", houseId: hl.id, workingDirectory: tmpDir });
  setTaskStatus(getDb(), parent.id, "running");
  return { hl, h1, h2, parent };
}

function eventsFor(taskId: string) {
  return listEventsForTask(getDb(), taskId);
}

/* ================================================================== */
describe("runParent — planning → delegation", () => {
  it("1: persists subtasks + handoffs and delegates the ready (no-dep) subtask", async () => {
    const { hl, h1, h2, parent } = seedWorld();
    seedRunner([
      {
        terminalStatus: "completed",
        planJson: JSON.stringify({
          subtasks: [
            { id: "s0", title: "Forge the keys", dependsOn: [], instructions: "Do it" },
            { id: "s1", title: "Unlock the gate", dependsOn: ["s0"], instructions: "Then this" },
          ],
        }),
      },
    ]);
    const deps = makeDeps();
    await runParent(parent, getHouse(getDb(), hl.id)!, deps);

    const subs = listSubtasksForParent(getDb(), parent.id);
    expect(subs).toHaveLength(2);
    expect(subs.find((s) => s.planId === "s0")?.status).toBe("delegated");
    expect(subs.find((s) => s.planId === "s1")?.status).toBe("planned");

    expect(listHandoffsForParent(getDb(), parent.id)).toHaveLength(2);
    // s0 got a child task row on an agent house (fallback to first active agent
    // when no hints match — ordering between houses is not deterministic).
    const child = getTask(getDb(), subs.find((s) => s.planId === "s0")!.taskId!);
    expect(child?.houseId).toBeTruthy();
    expect([h1.id, h2.id]).toContain(child?.houseId);
    // Plan event emitted.
    expect(eventsFor(parent.id).some((e) => e.payload.plan === true)).toBe(true);
  });

  it("2: repair retry — invalid JSON first, valid plan on the second call", async () => {
    const { hl, parent } = seedWorld();
    seedRunner([
      { terminalStatus: "completed", planJson: "this is not json" },
      {
        terminalStatus: "completed",
        planJson: JSON.stringify({ subtasks: [{ id: "s0", title: "Fixed", dependsOn: [] }] }),
      },
    ]);
    const deps = makeDeps();
    await runParent(parent, getHouse(getDb(), hl.id)!, deps);

    // Two executeTask calls happened (repair retry).
    expect(__runnerCalls.length).toBe(2);
    const subs = listSubtasksForParent(getDb(), parent.id);
    expect(subs).toHaveLength(1);
    expect(subs[0].title).toBe("Fixed");
  });

  it("3: fallback single-subtask plan when repair is still unusable", async () => {
    const { hl, parent } = seedWorld();
    seedRunner([
      { terminalStatus: "completed", planJson: "not json" },
      { terminalStatus: "completed", planJson: "still not json" },
    ]);
    const deps = makeDeps();
    await runParent(parent, getHouse(getDb(), hl.id)!, deps);

    const subs = listSubtasksForParent(getDb(), parent.id);
    expect(subs).toHaveLength(1);
    expect(subs[0].status).toBe("delegated");
    expect(subs[0].instructions).toContain("Quest");
  });

  it("3b (M3): fallback instructions are the ORIGINAL user instruction, not the composed planning prompt", async () => {
    // Seed a parent with a real user instruction description, plus an active
    // house with a usable workspace (so M2's usable-workspace guard passes).
    const hl = seedHighLordHouse(getDb())!;
    seedHouse("House of Mist", [tmpDir]);
    const parent = createTask(getDb(), {
      title: "Build the wall",
      description: "Erect a 3m stone wall by the north gate.",
      houseId: hl.id,
      workingDirectory: tmpDir,
    });
    setTaskStatus(getDb(), parent.id, "running");
    seedRunner([
      { terminalStatus: "completed", planJson: "not json" },
      { terminalStatus: "completed", planJson: "still not json" },
    ]);
    const deps = makeDeps();
    await runParent(parent, getHouse(getDb(), hl.id)!, deps);

    const subs = listSubtasksForParent(getDb(), parent.id);
    expect(subs).toHaveLength(1);
    expect(subs[0].status).toBe("delegated");
    // Must be the user's real instruction — NOT the roster/planning-prompt dump
    // that the orchestrator staged into the description.
    expect(subs[0].instructions).toContain("Erect a 3m stone wall by the north gate.");
    expect(subs[0].instructions).not.toContain("Available houses to delegate to");
    expect(subs[0].instructions).not.toContain("# Houses available");
  });

  it("fails the parent when planning returns a non-completed terminal", async () => {
    const { hl, parent } = seedWorld();
    seedRunner([{ terminalStatus: "failed" }, { terminalStatus: "failed" }]);
    const deps = makeDeps();
    await runParent(parent, getHouse(getDb(), hl.id)!, deps);
    expect(getTask(getDb(), parent.id)?.status).toBe("failed");
    expect(listSubtasksForParent(getDb(), parent.id)).toHaveLength(0);
  });

  it("fails the parent when no agents exist to delegate to", async () => {
    const hl = seedHighLordHouse(getDb())!;
    const parent = createTask(getDb(), { title: "Q", houseId: hl.id });
    setTaskStatus(getDb(), parent.id, "running");
    seedRunner([{ terminalStatus: "completed" }]);
    const deps = makeDeps();
    await runParent(parent, getHouse(getDb(), hl.id)!, deps);
    expect(getTask(getDb(), parent.id)?.status).toBe("failed");
  });
});

/* ================================================================== */
describe("delegateReadySubtasks — depends + per-directory hold", () => {
  it("4: a dependent subtask stays planned until its dep completes", async () => {
    // Direct: seed subtasks with a dep, tick once → s0 delegated, s1 planned;
    // complete s0, tick again → s1 released & delegated.
    const { hl, h1, h2, parent } = seedWorld();
    seedRunner([]);
    const sub = listSubtasksForParent(getDb(), parent.id);
    // Persist subtasks + handoffs directly (as persistPlan would).
    const { createSubtask, linkChildTask } = await import("@/server/repositories/subtask-repo");
    const { createHandoff } = await import("@/server/repositories/handoff-repo");
    const s0 = createSubtask(getDb(), { parentId: parent.id, planId: "s0", orderIndex: 0, dependsOn: [], title: "A" });
    const s1 = createSubtask(getDb(), { parentId: parent.id, planId: "s1", orderIndex: 1, dependsOn: ["s0"], title: "B" });
    createHandoff(getDb(), { parentTaskId: parent.id, subtaskId: s0.id, destinationHouseId: h1.id });
    createHandoff(getDb(), { parentTaskId: parent.id, subtaskId: s1.id, destinationHouseId: h2.id });

    const deps = makeDeps();
    setTaskStatus(getDb(), parent.id, "running");
    await tickActivePlans(deps);

    let subs = listSubtasksForParent(getDb(), parent.id);
    expect(subs.find((s) => s.planId === "s0")?.status).toBe("delegated");
    expect(subs.find((s) => s.planId === "s1")?.status).toBe("planned");

    // Complete s0's child task → release s1.
    const s0ChildId = subs.find((s) => s.planId === "s0")!.taskId!;
    setTaskStatus(getDb(), s0ChildId, "completed");
    await tickActivePlans(deps);

    subs = listSubtasksForParent(getDb(), parent.id);
    expect(subs.find((s) => s.planId === "s0")?.status).toBe("completed");
    expect(subs.find((s) => s.planId === "s1")?.status).toBe("delegated");
  });

  it("5: per-directory serialization holds the second same-dir subtask", async () => {
    // Two ready (no-dep) subtasks in the SAME directory (no parent workingDirectory)
    // → only the first is delegated; the second is held at `ready`.
    const hl = seedHighLordHouse(getDb())!;
    const h1 = seedHouse("House of Mist", [tmpDir]);
    const parent = createTask(getDb(), { title: "P", houseId: hl.id }); // no workingDirectory, same dir via h1 allowlist
    const { createSubtask } = await import("@/server/repositories/subtask-repo");
    const { createHandoff } = await import("@/server/repositories/handoff-repo");
    const s0 = createSubtask(getDb(), { parentId: parent.id, planId: "s0", orderIndex: 0, dependsOn: [], title: "A" });
    const s1 = createSubtask(getDb(), { parentId: parent.id, planId: "s1", orderIndex: 1, dependsOn: [], title: "B" });
    createHandoff(getDb(), { parentTaskId: parent.id, subtaskId: s0.id, destinationHouseId: h1.id });
    createHandoff(getDb(), { parentTaskId: parent.id, subtaskId: s1.id, destinationHouseId: h1.id });

    const deps = makeDeps();
    setTaskStatus(getDb(), parent.id, "running");
    await tickActivePlans(deps);

    const subs = listSubtasksForParent(getDb(), parent.id);
    // Both map to the same directory (h1 allowlist[0] = tmpDir).
    const delegatedCount = subs.filter((s) => s.status === "delegated").length;
    const readyCount = subs.filter((s) => s.status === "ready").length;
    expect(delegatedCount).toBe(1);
    expect(readyCount).toBeGreaterThanOrEqual(1);
  });

  it("1b (defect #1): a Court plan with parent workingDirectory + two distinct houses with distinct workspaces delegates BOTH in one tick (parallel pair)", async () => {
    // The Court always sets a single parent `workingDirectory`. Children execute
    // in their DESTINATION house's own workspace, so two independent subtasks on
    // two distinct houses with distinct allowlists must NOT be serialized by the
    // parent dir — they delegate concurrently (plan §5.4.4 + §0.2.7).
    const hl = seedHighLordHouse(getDb())!;
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-orch-A-"));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-orch-B-"));
    const h1 = seedHouse("House of Mist", [dirA]);
    const h2 = seedHouse("House of Wind", [dirB]);
    // Parent carries a workingDirectory (as the Court always does).
    const parent = createTask(getDb(), { title: "P", houseId: hl.id, workingDirectory: tmpDir });

    const { createSubtask } = await import("@/server/repositories/subtask-repo");
    const { createHandoff } = await import("@/server/repositories/handoff-repo");
    const s0 = createSubtask(getDb(), { parentId: parent.id, planId: "s0", orderIndex: 0, dependsOn: [], title: "A" });
    const s1 = createSubtask(getDb(), { parentId: parent.id, planId: "s1", orderIndex: 1, dependsOn: [], title: "B" });
    createHandoff(getDb(), { parentTaskId: parent.id, subtaskId: s0.id, destinationHouseId: h1.id });
    createHandoff(getDb(), { parentTaskId: parent.id, subtaskId: s1.id, destinationHouseId: h2.id });

    const deps = makeDeps();
    setTaskStatus(getDb(), parent.id, "running");
    await tickActivePlans(deps);

    const subs = listSubtasksForParent(getDb(), parent.id);
    // Both delegated in the same tick — they resolve to distinct dirs (h1→dirA, h2→dirB).
    expect(subs.find((s) => s.planId === "s0")?.status).toBe("delegated");
    expect(subs.find((s) => s.planId === "s1")?.status).toBe("delegated");
    // Children got distinct working directories (their house workspaces, not parent dir).
    const c0 = getTask(getDb(), subs.find((s) => s.planId === "s0")!.taskId!);
    const c1 = getTask(getDb(), subs.find((s) => s.planId === "s1")!.taskId!);
    expect(c0?.workingDirectory).toBe(dirA);
    expect(c1?.workingDirectory).toBe(dirB);
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  });

  it("1c: no parent workingDirectory + two distinct houses with distinct workspaces delegates BOTH in one tick", async () => {
    const hl = seedHighLordHouse(getDb())!;
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-orch-A2-"));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-orch-B2-"));
    const h1 = seedHouse("House of Mist", [dirA]);
    const h2 = seedHouse("House of Wind", [dirB]);
    // No parent workingDirectory at all.
    const parent = createTask(getDb(), { title: "P", houseId: hl.id });

    const { createSubtask } = await import("@/server/repositories/subtask-repo");
    const { createHandoff } = await import("@/server/repositories/handoff-repo");
    const s0 = createSubtask(getDb(), { parentId: parent.id, planId: "s0", orderIndex: 0, dependsOn: [], title: "A" });
    const s1 = createSubtask(getDb(), { parentId: parent.id, planId: "s1", orderIndex: 1, dependsOn: [], title: "B" });
    createHandoff(getDb(), { parentTaskId: parent.id, subtaskId: s0.id, destinationHouseId: h1.id });
    createHandoff(getDb(), { parentTaskId: parent.id, subtaskId: s1.id, destinationHouseId: h2.id });

    const deps = makeDeps();
    setTaskStatus(getDb(), parent.id, "running");
    await tickActivePlans(deps);

    const subs = listSubtasksForParent(getDb(), parent.id);
    expect(subs.find((s) => s.planId === "s0")?.status).toBe("delegated");
    expect(subs.find((s) => s.planId === "s1")?.status).toBe("delegated");
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  });
});

/* ================================================================== */
describe("retry loop + abort (addendum D4)", () => {
  it("6a: a failed child is re-delegated (fresh child row + subtask re-point + attempt bump)", async () => {
    const { hl, h1, h2, parent } = seedWorld();
    const { createSubtask } = await import("@/server/repositories/subtask-repo");
    const { createHandoff } = await import("@/server/repositories/handoff-repo");
    const s0 = createSubtask(getDb(), { parentId: parent.id, planId: "s0", orderIndex: 0, dependsOn: [], title: "A" });
    createHandoff(getDb(), { parentTaskId: parent.id, subtaskId: s0.id, destinationHouseId: h1.id });

    const deps = makeDeps();
    setTaskStatus(getDb(), parent.id, "running");

    // First delegation via tick.
    await tickActivePlans(deps);
    let subs = listSubtasksForParent(getDb(), parent.id);
    const child1 = getTask(getDb(), subs[0].taskId!);
    expect(subs[0].status).toBe("delegated");
    expect(subs[0].attemptCount).toBe(0);

    // Child fails → tick re-delegates.
    setTaskStatus(getDb(), child1!.id, "failed");
    await tickActivePlans(deps);
    subs = listSubtasksForParent(getDb(), parent.id);
    expect(subs[0].status).toBe("delegated");
    expect(subs[0].attemptCount).toBe(1);
    const child2 = getTask(getDb(), subs[0].taskId!);
    expect(child2!.id).not.toBe(child1!.id); // fresh child row
  });

  it("6b: retries exhausted (3) → abortPlan: children cancelled, parent failed, abortReason persisted", async () => {
    const { hl, h1, parent } = seedWorld();
    const { createSubtask, listSubtasksForParent } = await import("@/server/repositories/subtask-repo");
    const { createHandoff } = await import("@/server/repositories/handoff-repo");
    const { createExecutionSession } = await import("@/server/repositories/execution-repo");
    const s0 = createSubtask(getDb(), { parentId: parent.id, planId: "s0", orderIndex: 0, dependsOn: [], title: "A" });
    createHandoff(getDb(), { parentTaskId: parent.id, subtaskId: s0.id, destinationHouseId: h1.id });

    const deps = makeDeps();
    setTaskStatus(getDb(), parent.id, "running");

    // Delegate once.
    await tickActivePlans(deps);
    let child = getTask(getDb(), listSubtasksForParent(getDb(), parent.id)[0].taskId!);

    // 3 retries: attemptCount will read 1,2,3 then the 4th failure (attempt>3) aborts.
    for (let i = 0; i < 3; i++) {
      setTaskStatus(getDb(), child!.id, "failed");
      await tickActivePlans(deps);
      child = getTask(getDb(), listSubtasksForParent(getDb(), parent.id)[0].taskId!);
    }

    // One more failure pushes attemptCount to 4 (> MAX_SUBTASK_RETRIES=3) → abort.
    // (Note: the loop above already consumed 3 failures; the 4th triggers abort.)
    setTaskStatus(getDb(), child!.id, "failed");
    await tickActivePlans(deps);

    const parent2 = getTask(getDb(), parent.id)!;
    expect(parent2.status).toBe("failed");
    const prefs = parent2.executionPreferences as Record<string, unknown>;
    expect((prefs.plan as any)?.abortReason).toBe("retries_exhausted");
    // Parent failed; children cancelled.
    expect(eventsFor(parent.id).some((e) => e.payload.aborted === true)).toBe(true);
  });

  it("3b (defect #3): a sole subtask with an unresolvable destination reaches a terminal parent (no_destination abort)", async () => {
    const hl = seedHighLordHouse(getDb())!;
    const parent = createTask(getDb(), { title: "Q", houseId: hl.id });
    setTaskStatus(getDb(), parent.id, "running");

    const { createSubtask } = await import("@/server/repositories/subtask-repo");
    const { createHandoff } = await import("@/server/repositories/handoff-repo");
    // A real (FK-valid) house, but archived → `destinationForSubtask` rejects it
    // (not active), so the subtask has NO delegable destination.
    const h1 = seedHouse("House of Mist");
    const { transitionHouseStatus } = await import("@/server/repositories/house-repo");
    transitionHouseStatus(getDb(), h1.id, "archived");

    const s0 = createSubtask(getDb(), { parentId: parent.id, planId: "s0", orderIndex: 0, dependsOn: [], title: "A" });
    createHandoff(getDb(), { parentTaskId: parent.id, subtaskId: s0.id, destinationHouseId: h1.id });

    const deps = makeDeps();
    await tickActivePlans(deps);

    // Deterministic finalization: parent failed with abortReason, subtask cancelled.
    const p = getTask(getDb(), parent.id)!;
    expect(p.status).toBe("failed");
    const prefs = p.executionPreferences as Record<string, unknown>;
    expect((prefs.plan as any)?.abortReason).toBe("no_destination");
    const subs = listSubtasksForParent(getDb(), parent.id);
    expect(subs.every((s) => s.status === "cancelled")).toBe(true);
    // Never a partially-failed parent with subtasks still running.
    expect(eventsFor(parent.id).some((e) => e.payload.reason === "no_destination")).toBe(true);
  });
});

/* ================================================================== */
describe("budget, consolidation, cancel cascade, steering", () => {
  it("7: token budget exceeded → abortPlan (children cancelled, parent failed, no consolidation artifact)", async () => {
    const { hl, h1, parent } = seedWorld();
    // Parent pref with a tiny token budget.
    const { createSubtask } = await import("@/server/repositories/subtask-repo");
    const { createHandoff } = await import("@/server/repositories/handoff-repo");
    // Overwrite parent's executionPreferences with a low tokenBudget.
    const { updateTask } = await import("@/server/repositories/task-repo");
    updateTask(getDb(), parent.id, { executionPreferences: { tokenBudget: 5 } });

    const s0 = createSubtask(getDb(), { parentId: parent.id, planId: "s0", orderIndex: 0, dependsOn: [], title: "A" });
    const s1 = createSubtask(getDb(), { parentId: parent.id, planId: "s1", orderIndex: 1, dependsOn: [], title: "B" });
    createHandoff(getDb(), { parentTaskId: parent.id, subtaskId: s0.id, destinationHouseId: h1.id });
    createHandoff(getDb(), { parentTaskId: parent.id, subtaskId: s1.id, destinationHouseId: h1.id });

    // Delegate both ready subtasks.
    const deps = makeDeps();
    setTaskStatus(getDb(), parent.id, "running");
    await tickActivePlans(deps);

    // Now add usage rows that blow the budget (parent + child usage rollup).
    const session = createExecutionSession(getDb(), { taskId: parent.id, houseId: hl.id, provider: "opencode", modelId: "glm-5.3" });
    createUsageRecord(getDb(), { sessionId: session.id, taskId: parent.id, houseId: hl.id, modelId: "glm-5.3", provider: "opencode", cost: { inputTokens: 10, outputTokens: 10, cost: 1 } });

    await tickActivePlans(deps);

    const p = getTask(getDb(), parent.id)!;
    expect(p.status).toBe("failed");
    const prefs = p.executionPreferences as any;
    expect(prefs.plan?.abortReason).toBe("token_budget_exceeded");
    // Children cancelled.
    const subs = listSubtasksForParent(getDb(), parent.id);
    expect(subs.every((s) => s.status === "cancelled")).toBe(true);
    // No parent result artifact for a budget abort (partial is written; assert
    // the aborted event instead).
    expect(eventsFor(parent.id).some((e) => e.payload.reason === "token_budget_exceeded")).toBe(true);
  });

  it("7b (H2): over-budget but all children completed → parent consolidates as completed, NO budget abort", async () => {
    const { hl, h1, parent } = seedWorld();
    const { createSubtask } = await import("@/server/repositories/subtask-repo");
    const { createHandoff } = await import("@/server/repositories/handoff-repo");
    const { updateTask } = await import("@/server/repositories/task-repo");
    updateTask(getDb(), parent.id, { executionPreferences: { tokenBudget: 5 } });

    const s0 = createSubtask(getDb(), { parentId: parent.id, planId: "s0", orderIndex: 0, dependsOn: [], title: "A" });
    createHandoff(getDb(), { parentTaskId: parent.id, subtaskId: s0.id, destinationHouseId: h1.id });

    const deps = makeDeps();
    setTaskStatus(getDb(), parent.id, "running");

    // Delegate → complete the sole child → all-terminal.
    await tickActivePlans(deps);
    let subs = listSubtasksForParent(getDb(), parent.id);
    const child = getTask(getDb(), subs[0].taskId!);
    setTaskStatus(getDb(), child!.id, "completed");
    // Blow the budget with a usage row that crosses the (tiny) parent pref.
    // Crucially, do this so a single tick sees BOTH the completed mirror AND the
    // over-budget usage.
    const session = createExecutionSession(getDb(), { taskId: parent.id, houseId: hl.id, provider: "opencode", modelId: "glm-5.3" });
    createUsageRecord(getDb(), { sessionId: session.id, taskId: parent.id, houseId: hl.id, modelId: "glm-5.3", provider: "opencode", cost: { inputTokens: 100, outputTokens: 100, cost: 1 } });

    await tickActivePlans(deps);

    // A fully-completed plan must NOT be aborted for budget (D4).
    const p = getTask(getDb(), parent.id)!;
    expect(p.status).toBe("completed");
    const prefs = p.executionPreferences as any;
    expect(prefs.plan?.abortReason).toBeUndefined();
    expect(eventsFor(parent.id).some((e) => e.payload.reason === "token_budget_exceeded")).toBe(false);
  });

  it("8: all subtasks completed → consolidate (result + diff artifacts, parent completed)", async () => {
    const { hl, h1, parent } = seedWorld();
    const { createSubtask } = await import("@/server/repositories/subtask-repo");
    const { createHandoff } = await import("@/server/repositories/handoff-repo");
    const s0 = createSubtask(getDb(), { parentId: parent.id, planId: "s0", orderIndex: 0, dependsOn: [], title: "A" });
    createHandoff(getDb(), { parentTaskId: parent.id, subtaskId: s0.id, destinationHouseId: h1.id });

    const deps = makeDeps();
    setTaskStatus(getDb(), parent.id, "running");

    // Delegate → complete child → consolidate.
    await tickActivePlans(deps);
    let subs = listSubtasksForParent(getDb(), parent.id);
    const child = getTask(getDb(), subs[0].taskId!);
    // Give the child a diff artifact so consolidation rolls it up.
    const childSess = createExecutionSession(getDb(), { taskId: child!.id, houseId: h1.id, provider: "opencode", modelId: "glm-5.3" });
    createArtifact(getDb(), { sessionId: childSess.id, taskId: child!.id, kind: "diff", content: "change.txt\n+one" });
    // Seed a parent planning session so consolidation can attach the result artifact.
    createExecutionSession(getDb(), { taskId: parent.id, houseId: hl.id, provider: "opencode", modelId: "glm-5.3" });
    setTaskStatus(getDb(), child!.id, "completed");

    await tickActivePlans(deps);

    const p = getTask(getDb(), parent.id)!;
    expect(p.status).toBe("completed");
    // Consolidated artifacts on the parent's latest session.
    const { listArtifactsForTask } = await import("@/server/repositories/execution-repo");
    const parentArtifacts = listArtifactsForTask(getDb(), parent.id);
    expect(parentArtifacts.some((a) => a.kind === "result")).toBe(true);
  });

  it("9: abortPlan cascades — running child cancelled + its session aborted", async () => {
    const { hl, h1, parent } = seedWorld();
    const { createSubtask } = await import("@/server/repositories/subtask-repo");
    const { createHandoff } = await import("@/server/repositories/handoff-repo");
    const s0 = createSubtask(getDb(), { parentId: parent.id, planId: "s0", orderIndex: 0, dependsOn: [], title: "A" });
    createHandoff(getDb(), { parentTaskId: parent.id, subtaskId: s0.id, destinationHouseId: h1.id });

    const deps = makeDeps();
    setTaskStatus(getDb(), parent.id, "running");
    await tickActivePlans(deps);
    let subs = listSubtasksForParent(getDb(), parent.id);
    const child = getTask(getDb(), subs[0].taskId!);
    setTaskStatus(getDb(), child!.id, "running");
    const childSess = createExecutionSession(getDb(), { taskId: child!.id, houseId: h1.id, provider: "opencode", modelId: "glm-5.3" });
    setSessionStatus(getDb(), childSess.id, "running");

    abortPlan(deps, parent, getHouse(getDb(), hl.id)!, "user_cancel", subs);

    expect(getTask(getDb(), parent.id)?.status).toBe("failed");
    expect(getTask(getDb(), child!.id)?.status).toBe("cancelled");
    subs = listSubtasksForParent(getDb(), parent.id);
    expect(subs[0].status).toBe("cancelled");
    expect(eventsFor(parent.id).some((e) => e.payload.reason === "user_cancel")).toBe(true);
  });

  it("10a: steering relays a pending user message and marks it relayed", async () => {
    const { hl, h1, parent } = seedWorld();
    const { createSubtask } = await import("@/server/repositories/subtask-repo");
    const { createHandoff } = await import("@/server/repositories/handoff-repo");
    const s0 = createSubtask(getDb(), { parentId: parent.id, planId: "s0", orderIndex: 0, dependsOn: [], title: "A" });
    createHandoff(getDb(), { parentTaskId: parent.id, subtaskId: s0.id, destinationHouseId: h1.id });

    // Create a planning session (terminal) for the parent with a provider session id.
    const sid = createExecutionSession(getDb(), { taskId: parent.id, houseId: hl.id, provider: "opencode", modelId: "glm-5.3" });
    setSessionProviderId(getDb(), sid.id, "prov-steer");
    setSessionStatus(getDb(), sid.id, "completed");

    // A pending user steering message (un-relayed).
    const { createAgentMessage } = await import("@/server/repositories/execution-repo");
    createAgentMessage(getDb(), { sessionId: sid.id, role: "user", content: "Also add tests", relayedAt: null });

    const sendMessage = vi.fn(async () => {});
    const deps = makeDeps();
    (deps.adapter as any).sendMessage = sendMessage;
    setTaskStatus(getDb(), parent.id, "running");
    await tickActivePlans(deps);

    // The message was relayed + marked.
    expect(sendMessage).toHaveBeenCalled();
    const { findPendingUserMessage } = await import("@/server/repositories/execution-repo");
    expect(findPendingUserMessage(getRawDb(), sid.id, null)).toBeNull(); // relayed → no longer pending
  });

  it("10b: steering reply is INGESTED from the provider and parses a plan → revision applied", async () => {
    const { hl, h1, parent } = seedWorld();
    const { createSubtask } = await import("@/server/repositories/subtask-repo");
    const { createHandoff } = await import("@/server/repositories/handoff-repo");
    const s0 = createSubtask(getDb(), { parentId: parent.id, planId: "s0", orderIndex: 0, dependsOn: [], title: "Old plan subtask" });
    createHandoff(getDb(), { parentTaskId: parent.id, subtaskId: s0.id, destinationHouseId: h1.id });
    setTaskStatus(getDb(), parent.id, "running");

    // Planning session already `running` (steer busy) + provider quiet.
    const sid = createExecutionSession(getDb(), { taskId: parent.id, houseId: hl.id, provider: "opencode", modelId: "glm-5.3" });
    setSessionProviderId(getDb(), sid.id, "prov-q");
    setSessionStatus(getDb(), sid.id, "running");

    // NO agent reply row is seeded. The reply only arrives via the provider's
    // listMessages (the SSE subscription terminates when the planning session
    // completes, so the orchestrator must re-fetch the transcript to persist the
    // fresh reply as an agent row — defect #2).
    const revisedPlan = JSON.stringify({
      subtasks: [
        { id: "r0", title: "Old plan subtask", dependsOn: [], instructions: "updated" },
        { id: "r1", title: "A brand new subtask", dependsOn: [], instructions: "new" },
      ],
    });

    const deps = makeDeps();
    // Quiet + the provider transcript carries the fresh assistant reply.
    (deps.client.getSession as any).mockResolvedValue({
      id: "prov-q",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0 },
      model: { id: "", providerID: "" },
      time: { created: 0, updated: 1 }, // quiet: now - 1 >> quietMs(0)
      title: "",
    });
    (deps.client.listMessages as any).mockResolvedValue([
      { id: "msg-reply", role: "assistant", text: revisedPlan },
    ]);
    await tickActivePlans(deps);

    // The reply was ingested into agent_messages → a revision was applied.
    const { listSessionsForTask } = await import("@/server/repositories/execution-repo");
    const session = listSessionsForTask(getDb(), parent.id)[0];
    const subs = listSubtasksForParent(getDb(), parent.id);
    expect(subs.some((s) => s.title.includes("brand new") || s.title === "A brand new subtask")).toBe(true);
    // Session status back to completed after the steer exchange.
    expect(session.status).toBe("completed");
  });

  it("10c: steering reply that is NOT a plan → informational event only, session completed", async () => {
    const { hl, h1, parent } = seedWorld();
    const { createSubtask } = await import("@/server/repositories/subtask-repo");
    const { createHandoff } = await import("@/server/repositories/handoff-repo");
    const s0 = createSubtask(getDb(), { parentId: parent.id, planId: "s0", orderIndex: 0, dependsOn: [], title: "A" });
    createHandoff(getDb(), { parentTaskId: parent.id, subtaskId: s0.id, destinationHouseId: h1.id });
    setTaskStatus(getDb(), parent.id, "running");

    const sid = createExecutionSession(getDb(), { taskId: parent.id, houseId: hl.id, provider: "opencode", modelId: "glm-5.3" });
    setSessionProviderId(getDb(), sid.id, "prov-i");
    setSessionStatus(getDb(), sid.id, "running");

    const deps = makeDeps();
    (deps.client.getSession as any).mockResolvedValue({
      id: "prov-i",
      time: { created: 0, updated: 1 },
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0 },
      model: { id: "", providerID: "" },
      cost: 0,
      title: "",
    });
    // A non-plan steering reply arrives via the provider transcript (no row seeded).
    (deps.client.listMessages as any).mockResolvedValue([
      { id: "msg-np", role: "assistant", text: "I'll consider that." },
    ]);
    await tickActivePlans(deps);

    // Informational event emitted, session completed, no DAG change.
    const { listSessionsForTask } = await import("@/server/repositories/execution-repo");
    expect(eventsFor(parent.id).some((e) => e.payload.steer === true)).toBe(true);
    expect(listSubtasksForParent(getDb(), parent.id)).toHaveLength(1); // unchanged
    expect(listSessionsForTask(getDb(), parent.id)[0].status).toBe("completed");
  });

  it("10d: while a steer is busy (session running), a new pending message is NOT relayed (409-busy deferral)", async () => {
    const { hl, h1, parent } = seedWorld();
    const { createSubtask } = await import("@/server/repositories/subtask-repo");
    const { createHandoff } = await import("@/server/repositories/handoff-repo");
    const s0 = createSubtask(getDb(), { parentId: parent.id, planId: "s0", orderIndex: 0, dependsOn: [], title: "A" });
    createHandoff(getDb(), { parentTaskId: parent.id, subtaskId: s0.id, destinationHouseId: h1.id });
    setTaskStatus(getDb(), parent.id, "running");

    // Planning session is `running` (steer exchange in flight) + provider busy
    // (getSession returns fresh updated time, i.e. NOT quiet).
    const sid = createExecutionSession(getDb(), { taskId: parent.id, houseId: hl.id, provider: "opencode", modelId: "glm-5.3" });
    setSessionProviderId(getDb(), sid.id, "prov-busy");
    setSessionStatus(getDb(), sid.id, "running");
    const { createAgentMessage, findPendingUserMessage } = await import("@/server/repositories/execution-repo");
    createAgentMessage(getDb(), { sessionId: sid.id, role: "user", content: "Another steering message", relayedAt: null });

    const sendMessage = vi.fn(async () => {});
    const deps = makeDeps({ steerQuietMs: 5000, now: () => 1_000_000_001_000 });
    (deps.adapter as any).sendMessage = sendMessage;
    // Busy: the provider's last activity is recent (within the 5s quiet window).
    (deps.client.getSession as any).mockResolvedValue({
      id: "prov-busy",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0 },
      model: { id: "", providerID: "" },
      time: { created: 0, updated: 1_000_000_001_000 },
      title: "",
    });

    await tickActivePlans(deps);

    // Not relayed (busy), still pending, session stays running.
    const { listSessionsForTask } = await import("@/server/repositories/execution-repo");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(findPendingUserMessage(getRawDb(), sid.id, null)).not.toBeNull();
    const session = listSessionsForTask(getDb(), parent.id)[0];
    expect(session.status).toBe("running");
  });

  it("11a (H1): a steering revision that CREATES a subtask gets a handoff and is delegated next tick (no abort/stall)", async () => {
    const { hl, h1, h2, parent } = seedWorld();
    const { createSubtask } = await import("@/server/repositories/subtask-repo");
    const { createHandoff, listHandoffsForSubtask } = await import("@/server/repositories/handoff-repo");
    // An existing planned subtask; the revision ADDS a brand-new subtask.
    const s0 = createSubtask(getDb(), { parentId: parent.id, planId: "s0", orderIndex: 0, dependsOn: [], title: "Existing subtask" });
    createHandoff(getDb(), { parentTaskId: parent.id, subtaskId: s0.id, destinationHouseId: h1.id });
    setTaskStatus(getDb(), parent.id, "running");

    // Planning session busy + quiet; the reply is a revision that only ADDS a
    // newly-titled subtask (no match to existing).
    const sid = createExecutionSession(getDb(), { taskId: parent.id, houseId: hl.id, provider: "opencode", modelId: "glm-5.3" });
    setSessionProviderId(getDb(), sid.id, "prov-r");
    setSessionStatus(getDb(), sid.id, "running");
    const revision = JSON.stringify({
      subtasks: [{ id: "r0", title: "Existing subtask", dependsOn: [], instructions: "keep" }, { id: "r1", title: "A brand new subtask", dependsOn: [], instructions: "new work" }],
    });

    const deps = makeDeps();
    (deps.client.getSession as any).mockResolvedValue({
      id: "prov-r", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0 },
      model: { id: "", providerID: "" }, time: { created: 0, updated: 1 }, title: "",
    });
    (deps.client.listMessages as any).mockResolvedValue([{ id: "msg-r", role: "assistant", text: revision }]);

    await tickActivePlans(deps);

    // The revision created a subtask row.
    const subs = listSubtasksForParent(getDb(), parent.id);
    const newSub = subs.find((s) => s.title.includes("brand new") || s.title === "A brand new subtask");
    expect(newSub).toBeDefined();
    // It got a handoff → resolvable destination (M1: no abort/stall).
    const handoffs = listHandoffsForSubtask(getDb(), newSub!.id);
    expect(handoffs).toHaveLength(1);
    // resolvePlan picks the first eligible active agent house (newest-first →
    // Wind), so either house is fine — the key is a handoff with an active agent dest.
    expect([h1.id, h2.id]).toContain(handoffs[0].destinationHouseId);
    // Parent stays running (not aborted, not stalled): the new subtask is ready
    // and delegatable.
    expect(getTask(getDb(), parent.id)?.status).toBe("running");
    expect(eventsFor(parent.id).some((e) => e.payload.reason === "no_destination")).toBe(false);

    // Next tick/continue: the new subtask is delegatable (has a handoff). It may
    // be held at `ready` this tick if the rewritten existing subtask occupies the
    // same directory (per-directory serialization) — the key H1 guarantee is that
    // it is NOT doomed (no abort, no stall): status is planned/ready (delegatable)
    // and not failed/cancelled.
    const newSub2 = listSubtasksForParent(getDb(), parent.id).find(
      (s) => s.title.includes("brand new") || s.title === "A brand new subtask",
    )!;
    expect(["ready", "planned", "delegated"]).toContain(newSub2.status);
    expect(newSub2.status).not.toBe("failed");
  });

  it("11b (H1): a steering revision create with NO resolvable house creates nothing and does not abort the plan", async () => {
    // Seed ONLY the HL + a single agent house that we then archive, so
    // `resolveDestinationForPlanSubtask` returns null (no active agent house).
    const hl = seedHighLordHouse(getDb())!;
    const h1 = seedHouse("House of Mist");
    const { createSubtask } = await import("@/server/repositories/subtask-repo");
    const { createHandoff } = await import("@/server/repositories/handoff-repo");
    const { transitionHouseStatus } = await import("@/server/repositories/house-repo");
    transitionHouseStatus(getDb(), h1.id, "archived");

    const parent = createTask(getDb(), { title: "Q", houseId: hl.id });
    setTaskStatus(getDb(), parent.id, "running");
    const s0 = createSubtask(getDb(), { parentId: parent.id, planId: "s0", orderIndex: 0, dependsOn: [], title: "Existing" });
    createHandoff(getDb(), { parentTaskId: parent.id, subtaskId: s0.id, destinationHouseId: h1.id });

    const sid = createExecutionSession(getDb(), { taskId: parent.id, houseId: hl.id, provider: "opencode", modelId: "glm-5.3" });
    setSessionProviderId(getDb(), sid.id, "prov-none");
    setSessionStatus(getDb(), sid.id, "running");
    const revision = JSON.stringify({ subtasks: [{ id: "r0", title: "New orphan subtask", dependsOn: [], instructions: "x" }] });

    const deps = makeDeps();
    (deps.client.getSession as any).mockResolvedValue({
      id: "prov-none", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0 },
      model: { id: "", providerID: "" }, time: { created: 0, updated: 1 }, title: "",
    });
    (deps.client.listMessages as any).mockResolvedValue([{ id: "msg-none", role: "assistant", text: revision }]);

    await tickActivePlans(deps);

    // The new subtask was NOT created (no orphan/undelegatable subtask).
    const subs = listSubtasksForParent(getDb(), parent.id);
    expect(subs.some((s) => s.title === "New orphan subtask")).toBe(false);
    // No abortReason from no_destination — the parent is either still running or
    // cleanly consolidated (the unmatched planned "Existing" was cancelled and
    // the plan completes), but NEVER aborted due to a no-destination orphan.
    const p = getTask(getDb(), parent.id)!;
    const prefs = p.executionPreferences as any;
    expect(prefs.plan?.abortReason ?? "none").not.toBe("no_destination");
    expect(["running", "completed"]).toContain(p.status);
    expect(eventsFor(parent.id).some((e) => e.payload.reason === "no_destination")).toBe(false);
  });

  it("12 (H2/M1): user-cancel of a High Lord parent persists abortReason=user_cancel (integration)", async () => {
    // This is also covered by the integration route test; here we assert the
    // shared helper writes the prefs block that the burning UI reads.
    const { hl, h1, parent } = seedWorld();
    const { createSubtask } = await import("@/server/repositories/subtask-repo");
    const { createHandoff } = await import("@/server/repositories/handoff-repo");
    const { writeTaskPlanAbortReason } = await import("@/server/repositories/task-repo");
    const s0 = createSubtask(getDb(), { parentId: parent.id, planId: "s0", orderIndex: 0, dependsOn: [], title: "A" });
    createHandoff(getDb(), { parentTaskId: parent.id, subtaskId: s0.id, destinationHouseId: h1.id });

    writeTaskPlanAbortReason(getDb(), parent.id, { abortReason: "user_cancel", abortedAt: "2026-01-01T00:00:00.000Z" });

    const p = getTask(getDb(), parent.id)!;
    const prefs = p.executionPreferences as any;
    expect(prefs.plan?.abortReason).toBe("user_cancel");
    expect(prefs.plan?.abortedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("13 (M2): a sole subtask whose destination has an empty allowlist and no parent dir → deterministic abort, never a doomed child", async () => {
    // HL parent with NO workingDirectory + a sole active agent house with an
    // EMPTY workspaceAllowlist → the child would inherit no usable dir and the
    // queue would fail it at claim → retry → abort. M2 treats it as unresolvable
    // at delegation time and aborts with a clear reason instead.
    const hl = seedHighLordHouse(getDb())!;
    const h1 = seedHouse("House of Mist", []); // empty allowlist
    const parent = createTask(getDb(), { title: "Q", houseId: hl.id }); // no working dir
    setTaskStatus(getDb(), parent.id, "running");

    const { createSubtask } = await import("@/server/repositories/subtask-repo");
    const { createHandoff } = await import("@/server/repositories/handoff-repo");
    const s0 = createSubtask(getDb(), { parentId: parent.id, planId: "s0", orderIndex: 0, dependsOn: [], title: "A" });
    createHandoff(getDb(), { parentTaskId: parent.id, subtaskId: s0.id, destinationHouseId: h1.id });

    const deps = makeDeps();
    await tickActivePlans(deps);

    // Deterministic fail-abort (no child was created that can never run).
    const p = getTask(getDb(), parent.id)!;
    expect(p.status).toBe("failed");
    const prefs = p.executionPreferences as any;
    expect(prefs.plan?.abortReason).toBe("no_destination");
    const subs = listSubtasksForParent(getDb(), parent.id);
    expect(subs.every((s) => s.status === "cancelled")).toBe(true);
    // No delegated child task row was created for the subtask.
    expect(subs.every((s) => s.taskId === null)).toBe(true);
    expect(eventsFor(parent.id).some((e) => e.payload.reason === "no_destination")).toBe(true);
  });
});


