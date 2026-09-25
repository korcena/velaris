/**
 * Integration tests — POST /api/tasks/{id}/pause + /api/tasks/{id}/resume.
 *
 * Direct invocation of route handlers against a temp DB (the api-routes.test.ts
 * contract). Verifies the web records PAUSE/RESUME INTENT only — it never runs
 * an agent task; the engine's Ollama loop does the actual suspend/resume by
 * observing the flipped session/task rows.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

import { resetDbForTests, getDb } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";
import { resetBootstrapForTests } from "@/server/bootstrap";
import { createHouse } from "@/server/repositories/house-repo";
import { createTask, getTask, setTaskStatus } from "@/server/repositories/task-repo";
import { createExecutionSession, setExecutionSessionStatus, getActiveSessionForHouse } from "@/server/repositories/execution-repo";

import { POST as pause } from "@/app/api/tasks/[id]/pause/route";
import { POST as resume } from "@/app/api/tasks/[id]/resume/route";
import type { HouseConfiguration } from "@/shared/types";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  resetDbForTests();
  resetBootstrapForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-pause-routes-"));
  dbPath = path.join(tmpDir, "test.db");
  process.env.VELARIS_DB_PATH = dbPath;
  migrate();
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function config(executionProvider: "opencode" | "ollama"): HouseConfiguration {
  return {
    systemPrompt: "sys",
    executionProvider,
    aiProvider: "ollama-cloud",
    modelId: "m",
    workspaceAllowlist: [tmpDir],
    tools: ["fs"],
    permissions: { fileSystem: "allow", shell: "ask", network: "deny", git: "allow" },
    approvalPolicy: "always",
    concurrency: 1,
  };
}

function url(id: string) {
  return `http://localhost:3000/api/tasks/${id}/pause`;
}

describe("POST /api/tasks/{id}/pause + /resume", () => {
  it("pauses an Ollama task (session + task → paused); resume flips both back to running", async () => {
    const house = createHouse(getDb(), { name: "H", description: null, agent: { name: "A", role: "R" }, configuration: config("ollama") });
    const taskId = "task-ollama"; // fixed id for the handler ctx
    const task = createTask(getDb(), { id: taskId, title: "T", houseId: house.id, workingDirectory: tmpDir });
    // A running session so the active-session predicate matches.
    createExecutionSession(getDb(), { taskId: task.id, houseId: house.id, provider: "ollama", modelId: "m", directory: tmpDir });
    setExecutionSessionStatus(getDb(), getActiveSessionForHouse(getDb(), house.id)!.id, "running");

    // Pause
    const pauseRes = await pause(new NextRequest(url(task.id)), { params: Promise.resolve({ id: task.id }) });
    expect(pauseRes.status).toBe(200);
    const pauseBody = await pauseRes.json();
    expect(pauseBody.task.status).toBe("paused");
    const active = getActiveSessionForHouse(getDb(), house.id);
    expect(active?.status).toBe("paused");

    // Resume
    const resumeRes = await resume(new NextRequest(url(task.id)), { params: Promise.resolve({ id: task.id }) });
    expect(resumeRes.status).toBe(200);
    const resumeBody = await resumeRes.json();
    expect(resumeBody.task.status).toBe("running");
    expect(getActiveSessionForHouse(getDb(), house.id)?.status).toBe("running");
  });

  it("409 on an OpenCode house task (cannot pause)", async () => {
    const house = createHouse(getDb(), { name: "H", description: null, agent: { name: "A", role: "R" }, configuration: config("opencode") });
    const task = createTask(getDb(), { title: "T", houseId: house.id });
    const res = await pause(new NextRequest(url(task.id)), { params: Promise.resolve({ id: task.id }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/cannot pause/i);
  });

  it("404 on an unknown task", async () => {
    const res = await pause(new NextRequest(url("missing-id")), { params: Promise.resolve({ id: "missing-id" }) });
    expect(res.status).toBe(404);
  });

  it("409 pausing a terminal task", async () => {
    const house = createHouse(getDb(), { name: "H", description: null, agent: { name: "A", role: "R" }, configuration: config("ollama") });
    const task = createTask(getDb(), { title: "T", houseId: house.id });
    setTaskStatus(getDb(), task.id, "completed");
    const res = await pause(new NextRequest(url(task.id)), { params: Promise.resolve({ id: task.id }) });
    expect(res.status).toBe(409);
  });

  it("409 resuming a task that is not paused", async () => {
    const house = createHouse(getDb(), { name: "H", description: null, agent: { name: "A", role: "R" }, configuration: config("ollama") });
    const task = createTask(getDb(), { title: "T", houseId: house.id });
    const res = await resume(new NextRequest(url(task.id)), { params: Promise.resolve({ id: task.id }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/not paused/i);
  });

  it("records intent only — no agent execution rows are created by the web handler", async () => {
    const house = createHouse(getDb(), { name: "H", description: null, agent: { name: "A", role: "R" }, configuration: config("ollama") });
    const task = createTask(getDb(), { title: "T", houseId: house.id });
    await pause(new NextRequest(url(task.id)), { params: Promise.resolve({ id: task.id }) });
    // Pausing a queued task flips the task to paused WITHOUT creating a session
    // (no runner). This proves the web does not execute — it only records intent
    // and the engine loop performs the real (no-op here) suspension.
    expect(getTask(getDb(), task.id)?.status).toBe("paused");
    expect(getActiveSessionForHouse(getDb(), house.id)).toBeNull();
  });
});
