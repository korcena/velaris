/**
 * Unit tests — engine boot reconciliation (src/engine/reconcile.ts).
 *
 * On engine restart, in-flight (running/awaiting_*) tasks are reconciled:
 *  - no live session → requeued
 *  - live provider session still alive (GET /session returns an id) but no
 *    owning runner → session aborted + marked interrupted + task requeued
 *    (the orphaned-session bug fix)
 *  - stale/unreachable session → interrupted + requeued
 *  - errors are logged, not thrown
 *
 * Uses a real temp DB + a fake OpenCode client.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, getRawDb, resetDbForTests } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";
import { createHouse, seedHighLordHouse } from "@/server/repositories/house-repo";
import { createTask, getTask, setTaskStatus } from "@/server/repositories/task-repo";
import {
  createExecutionSession,
  setSessionProviderId,
  setSessionStatus,
  getExecutionSession,
} from "@/server/repositories/execution-repo";
import { createSubtask } from "@/server/repositories/subtask-repo";
import type { HouseConfiguration } from "@/shared/types";
import { OpencodeClient } from "@/server/opencode";

import { reconcile } from "@/engine/reconcile";

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

beforeEach(() => {
  resetDbForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-reconcile-"));
  dbPath = path.join(tmpDir, "test.db");
  process.env.VELARIS_DB_PATH = dbPath;
  migrate();
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeClient(overrides: Partial<OpencodeClient> = {}): OpencodeClient {
  const base = {
    getSession: vi.fn(async () => ({ id: "" })),
    abortSession: vi.fn(async () => {}),
    listPendingPermissions: vi.fn(async () => []),
    listPendingQuestions: vi.fn(async () => []),
  } as unknown as OpencodeClient;
  Object.assign(base, overrides);
  return base;
}

/** Seed an in-flight task + a session row. */
function seedInflight() {
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
  setTaskStatus(getDb(), task.id, "running");
  const session = createExecutionSession(getDb(), {
    taskId: task.id,
    houseId: house.id,
    provider: "opencode",
    modelId: "glm-5.3",
    directory: tmpDir,
  });
  return { house, task, session };
}

describe("reconcile", () => {
  it("requeues an in-flight task with no live session", async () => {
    const { task } = seedInflight();
    const client = makeClient();
    await expect(reconcile(getDb(), getRawDb(), client, () => {})).resolves.toBeUndefined();
    expect(getTask(getDb(), task.id)?.status).toBe("queued");
  });

  it("aborts + interrupts + requeues an in-flight task with a LIVE provider session (orphaned-session fix)", async () => {
    const { task, session } = seedInflight();
    setSessionProviderId(getDb(), session.id, "prov-123");

    const abort = vi.fn(async () => {});
    const client = makeClient();
    (client.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "prov-123",
      title: "",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0 },
      model: { id: "", providerID: "" },
      time: { created: 0, updated: 0 },
    });
    (client.abortSession as ReturnType<typeof vi.fn>).mockImplementation(abort);

    await reconcile(getDb(), getRawDb(), client, () => {});

    // Provider session aborted.
    expect(abort).toHaveBeenCalledWith("prov-123");
    // Session interrupted.
    expect(getExecutionSession(getDb(), session.id)?.status).toBe("interrupted");
    // Task requeued.
    expect(getTask(getDb(), task.id)?.status).toBe("queued");
  });

  it("interrupts + requeues an in-flight task with a stale/unreachable provider session", async () => {
    const { task, session } = seedInflight();
    setSessionProviderId(getDb(), session.id, "prov-456");

    // getSession throws (provider gone).
    const client = makeClient();
    (client.getSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("provider down"));

    await reconcile(getDb(), getRawDb(), client, () => {});
    expect(getExecutionSession(getDb(), session.id)?.status).toBe("interrupted");
    expect(getTask(getDb(), task.id)?.status).toBe("queued");
  });

  it("is a no-op when there are no in-flight tasks", async () => {
    const client = makeClient();
    await expect(reconcile(getDb(), getRawDb(), client, () => {})).resolves.toBeUndefined();
    // No crash, no writes.
  });

  it("logs (not throws) when approval re-sync fails", async () => {
    seedInflight();
    const client = makeClient();
    (client.listPendingPermissions as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("perms down"),
    );
    const log = vi.fn();
    await expect(reconcile(getDb(), getRawDb(), client, log)).resolves.toBeUndefined();
    expect(log.mock.calls.join(" ")).toMatch(/failed|complete/i);
  });

  it("M3: does NOT requeue a user-paused Ollama task after an engine restart — the session is marked interrupted but the TASK stays paused", async () => {
    // A native Ollama task was user-paused (session + task both `paused`). On
    // engine restart, reconcile must NOT silently re-execute it as fresh work.
    const ll = [tmpDir];
    const house = createHouse(getDb(), {
      name: "H",
      description: null,
      agent: { name: "A", role: "R" },
      configuration: { ...makeHouseConfig(ll), executionProvider: "ollama", modelId: "llama3.1:8b" },
    });
    const task = createTask(getDb(), { title: "T", houseId: house.id, workingDirectory: tmpDir });
    setTaskStatus(getDb(), task.id, "paused");
    const session = createExecutionSession(getDb(), {
      taskId: task.id,
      houseId: house.id,
      provider: "ollama",
      modelId: "llama3.1:8b",
      directory: tmpDir,
    });
    setSessionStatus(getDb(), session.id, "paused");

    // Ollama sessions have providerSessionId null → reconcile takes the stale
    // path (marks interrupted). But the task must NOT be requeued as fresh work.
    const client = makeClient();
    await reconcile(getDb(), getRawDb(), client, () => {});

    expect(getExecutionSession(getDb(), session.id)?.status).toBe("interrupted");
    // M3: the user's pause intent is preserved — the task stays PAUSED (not
    // requeued to a fresh run), so resume can continue in place on the next boot.
    expect(getTask(getDb(), task.id)?.status).toBe("paused");
  });

  it("M3: reconcile behavior for a paused OpenCode session is UNCHANGED (requeued as fresh work — OpenCode cannot resume in place)", async () => {
    // OpenCode has no native pause; a `paused` status is not expected there, but
    // we must not regress Phase 4 behavior. With a stale OpenCode session, the
    // task is requeued for a fresh run (as before).
    const { task, session } = seedInflight(); // OpenCode provider
    setSessionStatus(getDb(), session.id, "paused");
    const client = makeClient();
    await reconcile(getDb(), getRawDb(), client, () => {});
    expect(getExecutionSession(getDb(), session.id)?.status).toBe("interrupted");
    expect(getTask(getDb(), task.id)?.status).toBe("queued");
  });
});

/* ================================================================== */
/* High Lord orchestrator reconcile pass (phase 4 §5.9 / D10.1)       */
/* ================================================================== */

describe("reconcile — High Lord pass", () => {
  it("requeues a running HL parent that died before planning (no subtasks, no live session)", async () => {
    const hl = seedHighLordHouse(getDb())!;
    const parent = createTask(getDb(), { title: "Q", houseId: hl.id });
    setTaskStatus(getDb(), parent.id, "running");

    const client = makeClient();
    await reconcile(getDb(), getRawDb(), client, () => {});
    expect(getTask(getDb(), parent.id)?.status).toBe("queued");
  });

  it("leaves a running HL parent with a live plan (subtask rows) untouched", async () => {
    const hl = seedHighLordHouse(getDb())!;
    const parent = createTask(getDb(), { title: "Q", houseId: hl.id });
    setTaskStatus(getDb(), parent.id, "running");
    createSubtask(getDb(), { parentId: parent.id, planId: "s0", orderIndex: 0, dependsOn: [], title: "A" });

    const client = makeClient();
    await reconcile(getDb(), getRawDb(), client, () => {});
    // The supervised plan is NOT requeued or interrupted by the generic handler.
    expect(getTask(getDb(), parent.id)?.status).toBe("running");
  });

  it("flips a steering-busy HL planning session back to completed on restart", async () => {
    const hl = seedHighLordHouse(getDb())!;
    const parent = createTask(getDb(), { title: "Q", houseId: hl.id });
    setTaskStatus(getDb(), parent.id, "running");
    createSubtask(getDb(), { parentId: parent.id, planId: "s0", orderIndex: 0, dependsOn: [], title: "A" });

    const session = createExecutionSession(getDb(), {
      taskId: parent.id,
      houseId: hl.id,
      provider: "opencode",
      modelId: "glm-5.3",
    });
    setSessionStatus(getDb(), session.id, "running"); // steering-busy

    const client = makeClient();
    await reconcile(getDb(), getRawDb(), client, () => {});
    expect(getExecutionSession(getDb(), session.id)?.status).toBe("completed");
    // Parent stays running (live plan) so the supervisor can continue.
    expect(getTask(getDb(), parent.id)?.status).toBe("running");
  });
});
