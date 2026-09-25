/**
 * Adversarial — pause/resume intent routes edge cases NOT in the author's tests
 * (focus #3). The web routes must record intent ONLY; the engine loop does the
 * suspend/resume.
 *
 * DEFECT FIXED: resuming a task that was paused while STILL QUEUED (no active
 * session yet) used to set the task status to 'running' — but the queue's claim
 * predicate only claims status='queued' (claimQueuedTask / listQueuedTaskIds),
 * so the task was left 'running' with no owner and never executed (stranded).
 *
 * FIX: the resume route now distinguishes the two cases:
 *   - an ACTIVE (paused) session exists → in-place resume (task+session → running);
 *   - NO active session (task was paused before it ever started) → return the
 *     task to 'queued' so the queue re-claims it next tick and starts fresh.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { resetDbForTests, getDb, getRawDb } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";
import { resetBootstrapForTests } from "@/server/bootstrap";
import { createHouse } from "@/server/repositories/house-repo";
import { createTask, getTask, setTaskStatus } from "@/server/repositories/task-repo";
import { claimQueuedTask, listQueuedTaskIds } from "@/server/repositories/task-repo";
import { createExecutionSession } from "@/server/repositories/execution-repo";

import { POST as pause } from "@/app/api/tasks/[id]/pause/route";
import { POST as resume } from "@/app/api/tasks/[id]/resume/route";
import type { HouseConfiguration } from "@/shared/types";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  resetDbForTests();
  resetBootstrapForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-pause-adv-"));
  dbPath = path.join(tmpDir, "test.db");
  process.env.VELARIS_DB_PATH = dbPath;
  migrate();
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function config(): HouseConfiguration {
  return {
    systemPrompt: "sys", executionProvider: "ollama", aiProvider: "ollama-cloud",
    modelId: "m", workspaceAllowlist: [tmpDir], tools: ["fs"],
    permissions: { fileSystem: "allow", shell: "ask", network: "deny", git: "allow" },
    approvalPolicy: "always", concurrency: 1,
  };
}
function url(id: string) { return `http://localhost:3000/api/tasks/${id}/pause`; }

describe("pause/resume intent routes — queued-task reuse edge case", () => {
  it("resuming a QUEUED task (no session) returns it to 'queued' (claimable), not a stranded 'running'", async () => {
    const house = createHouse(getDb(), { name: "H", description: null, agent: { name: "A", role: "R" }, configuration: config() });
    const task = createTask(getDb(), { title: "T", houseId: house.id, workingDirectory: tmpDir });
    // default createTask status is 'queued'
    expect(getTask(getDb(), task.id)?.status).toBe("queued");

    // pause a queued (not-yet-claimed) task — the route documents this is allowed
    const pRes = await pause(new NextRequest(url(task.id)), { params: Promise.resolve({ id: task.id }) });
    expect(pRes.status).toBe(200);
    expect(getTask(getDb(), task.id)?.status).toBe("paused");

    // resume it → no active session exists, so it must go back to 'queued'
    const rRes = await resume(new NextRequest(url(task.id)), { params: Promise.resolve({ id: task.id }) });
    expect(rRes.status).toBe(200);
    const status = getTask(getDb(), task.id)?.status;
    // FIXED: it must be claimable again, not stranded in 'running'.
    expect(status).toBe("queued");

    // The queue's claim predicate lists status='queued' → it is claimable again.
    expect(listQueuedTaskIds(getRawDb())).toContain(task.id);
    // …and claiming it succeeds (transitions queued → running for dispatch).
    expect(claimQueuedTask(getRawDb(), task.id)).toBe(true);
  });

  it("resuming a task with an ACTIVE paused session keeps the in-place resume (task+session → running)", async () => {
    const house = createHouse(getDb(), { name: "H", description: null, agent: { name: "A", role: "R" }, configuration: config() });
    const task = createTask(getDb(), { title: "T", houseId: house.id, workingDirectory: tmpDir });
    // The engine was live and paused it → an active 'paused' session exists.
    const session = createExecutionSession(getDb(), {
      taskId: task.id,
      houseId: house.id,
      provider: "ollama",
      modelId: "m",
      directory: tmpDir,
    });
    // Pause the task (session is active, so this flips task+session to paused).
    const pRes = await pause(new NextRequest(url(task.id)), { params: Promise.resolve({ id: task.id }) });
    expect(pRes.status).toBe(200);
    expect(getTask(getDb(), task.id)?.status).toBe("paused");

    const rRes = await resume(new NextRequest(url(task.id)), { params: Promise.resolve({ id: task.id }) });
    expect(rRes.status).toBe(200);
    // In-place resume: task + session stay 'running' for the loop to observe.
    expect(getTask(getDb(), task.id)?.status).toBe("running");

    const sess = (getRawDb().prepare("SELECT status FROM execution_sessions WHERE id=?").get(session.id) as { status: string }).status;
    expect(sess).toBe("running");
    // The task is running, not claimable (it has an active session owner).
    expect(listQueuedTaskIds(getRawDb())).not.toContain(task.id);
    // Reuse of claimQueuedTask on a running task must not succeed — the loop
    // continues it in place (it has an owner now).
    expect(claimQueuedTask(getRawDb(), task.id)).toBe(false);
  });
});
