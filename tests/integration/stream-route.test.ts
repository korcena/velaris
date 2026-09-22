/**
 * Integration — GET /api/stream (SSE change-feed).
 *
 * Calls the route handler directly with `new Request(...)` against a temp DB
 * and reads the returned Response body stream:
 *  - content-type: text/event-stream
 *  - a `hello` frame arrives immediately with the cursor
 *  - after inserting an execution_events row + waiting for the ~2s poll tick,
 *    an `event` frame with an `id:` arrives
 *  - aborting the request signal closes the stream (no hang)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

import { resetDbForTests, getDb } from "@/lib/db";
import { resetBootstrapForTests } from "@/server/bootstrap";
import { migrate } from "@/lib/db/migrate";
import { GET as getStream } from "@/app/api/stream/route";
import { createExecutionSession, createExecutionEvent } from "@/server/repositories/execution-repo";
import { createHouse } from "@/server/repositories/house-repo";
import { createTask } from "@/server/repositories/task-repo";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  resetDbForTests();
  resetBootstrapForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-stream-"));
  dbPath = path.join(tmpDir, "test.db");
  process.env.VELARIS_DB_PATH = dbPath;
  migrate();
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Read the first N bytes of the stream until non-empty (keeps reader locked for a single test). */
async function readChunks(reader: ReadableStreamDefaultReader<Uint8Array>, ms: number): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) text += decoder.decode(value, { stream: true });
    if (text.length > 0) break;
  }
  return text;
}

describe("GET /api/stream (SSE)", () => {
  it("emits a hello frame with cursor, then an event frame after a new row (2s tick)", async () => {
    // Seed a house/task/session so execution_events have valid FK targets.
    const db = getDb();
    const house = createHouse(db, {
      name: "H",
      description: "",
      agent: { name: "A", role: "R" },
      configuration: {
        systemPrompt: "p",
        executionProvider: "opencode",
        aiProvider: "ollama-cloud",
        modelId: "m",
        workspaceAllowlist: [tmpDir],
        tools: ["fs"],
        permissions: { fileSystem: "ask", shell: "ask", network: "deny", git: "allow" },
        approvalPolicy: "always",
        concurrency: 1,
      },
    });
    const task = createTask(db, { title: "Q", houseId: house.id, workingDirectory: tmpDir });

    const controller = new AbortController();
    const res = await getStream(
      new NextRequest("http://localhost/api/stream?lastEventId=0", { signal: controller.signal }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    try {
      // 1. hello frame with cursor (no events yet → cursor 0).
      const hello = await readChunks(reader, 300);
      expect(hello).toContain('"hello"');
      expect(hello).toMatch(/data:.*"type":"hello"/);

      // 2. Insert a new execution event while streaming; the ~2s tick must ship it.
      const session = createExecutionSession(db, {
        taskId: task.id,
        houseId: house.id,
        provider: "opencode",
        modelId: "m",
        directory: tmpDir,
      });
      createExecutionEvent(db, {
        sessionId: session.id,
        taskId: task.id,
        houseId: house.id,
        rawType: "message",
        type: "message",
        payload: { text: "hi" },
      });

      const eventFrames = await readChunks(reader, 2600);
      expect(eventFrames).toContain('"type":"event"');
      expect(eventFrames).toMatch(/^id: \d+$/m);
    } finally {
      // 3. Abort → stream closes cleanly (no hang).
      controller.abort();
    }
  });

  it("uses the lastEventId cursor (resume) for the initial cursor value", async () => {
    const db = getDb();
    const house = createHouse(db, {
      name: "H",
      description: "",
      agent: { name: "A", role: "R" },
      configuration: {
        systemPrompt: "p",
        executionProvider: "opencode",
        aiProvider: "ollama-cloud",
        modelId: "m",
        workspaceAllowlist: [tmpDir],
        tools: ["fs"],
        permissions: { fileSystem: "ask", shell: "ask", network: "deny", git: "allow" },
        approvalPolicy: "always",
        concurrency: 1,
      },
    });
    const task = createTask(db, { title: "Q", houseId: house.id, workingDirectory: tmpDir });
    const session = createExecutionSession(db, {
      taskId: task.id,
      houseId: house.id,
      provider: "opencode",
      modelId: "m",
      directory: tmpDir,
    });
    createExecutionEvent(db, { sessionId: session.id, taskId: task.id, houseId: house.id, rawType: "a", type: "task_started" });
    createExecutionEvent(db, { sessionId: session.id, taskId: task.id, houseId: house.id, rawType: "b", type: "message" });

    const controller = new AbortController();
    const res = await getStream(
      new NextRequest("http://localhost/api/stream?lastEventId=1", { signal: controller.signal }),
    );
    const reader = res.body!.getReader();
    try {
      // Resume from id 1 → hello cursor should be 1 (existing events below are skipped).
      const hello = await readChunks(reader, 300);
      expect(hello).toMatch(/"cursor":1/);
    } finally {
      controller.abort();
    }
  });
});
