/**
 * Unit tests — task runner status machine (src/server/execution/runner.ts).
 *
 * Drives the real `executeTask` against a temp DB with a fake OpenCode client
 * and adapter (no real SSE/HTTP). Covers the status transitions and the
 * regression fixes:
 *  - queued → running → completed
 *  - a session.next.step.failed event fails the task and is NOT overwritten to
 *    completed by the quiet-completion watchdog (bug 1)
 *  - permission.updated → approval_request + notification + task awaiting_approval
 *  - a rejected permission → task failed, provider session NOT left running (bug 6)
 *  - approvalPolicy 'never' auto-approves without creating an approval_request
 *  - chat relay sends a pending user message exactly once (relay marker)
 *  - a rejected approval keeps status 'rejected' after being relayed (markRelayed
 *    fix — bug 5)
 *
 * Timing: the fake client subscribes the runner's SSE onEvent synchronously
 * when `subscribeEvents` is called. Tests first wait for that subscription to
 * register (waitForSubscribed), then emit events and let poll ticks settle.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, getRawDb, resetDbForTests } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";
import { createHouse, getHouse } from "@/server/repositories/house-repo";
import { createTask, getTask, setTaskStatus } from "@/server/repositories/task-repo";
import {
  createAgentMessage,
  listApprovalRequests,
  countUnreadNotifications,
  setApprovalResponse,
  getActiveSessionForHouse,
  findPendingUserMessage,
} from "@/server/repositories/execution-repo";
import { executeTask } from "@/server/execution/runner";
import type { HouseConfiguration } from "@/shared/types";

let tmpDir: string;
let dbPath: string;

function makeConfig(approvalPolicy: "never" | "always" | "risky_only" = "always"): HouseConfiguration {
  return {
    systemPrompt: "You are an agent.",
    executionProvider: "opencode",
    aiProvider: "ollama-cloud",
    modelId: "glm-5.3",
    workspaceAllowlist: [tmpDir],
    tools: ["fs"],
    permissions: { fileSystem: "ask", shell: "ask", network: "deny", git: "allow" },
    approvalPolicy,
    concurrency: 1,
  };
}

type FakeClient = ReturnType<typeof makeFakeClient>;

function makeFakeClient(getSession: () => Promise<unknown> = async () => ({
  id: "prov-1",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0 },
  model: { id: "", providerID: "" },
  time: { created: 0, updated: Date.now() },
  title: "",
})) {
  const cbs: Array<(ev: unknown) => void> = [];
  const client = {
    subscribeEvents: vi.fn((_dir: string, opts: { onEvent: (ev: unknown) => void }) => {
      cbs.push(opts.onEvent);
      return () => {};
    }),
    getSession: vi.fn(getSession),
    abortSession: vi.fn(async () => {}),
    listPendingPermissions: vi.fn(async () => []),
    listPendingQuestions: vi.fn(async () => []),
    request: vi.fn(),
  };
  return {
    client,
    emit: (ev: unknown) => cbs.forEach((cb) => cb(ev)),
    subscribed: () => cbs.length > 0,
  };
}

function makeFakeAdapter() {
  return {
    startTask: vi.fn(async () => ({ providerSessionId: "prov-1" })),
    sendMessage: vi.fn(async () => {}),
    cancelTask: vi.fn(async () => {}),
    getStatus: vi.fn(async () => ({ providerSessionId: "prov-1", status: "running" })),
    respondToApproval: vi.fn(async () => {}),
    getDiff: vi.fn(async () => []),
    listModels: vi.fn(async () => []),
    health: vi.fn(async () => true),
  };
}

function seedRun(policy: "never" | "always" | "risky_only" = "always") {
  const house = createHouse(getDb(), {
    name: "H",
    description: null,
    agent: { name: "A", role: "R" },
    configuration: makeConfig(policy),
  });
  const task = createTask(getDb(), {
    title: "Quest",
    houseId: house.id,
    workingDirectory: tmpDir,
  });
  const db = getDb();
  const raw = getRawDb();
  return {
    db,
    raw,
    house: getHouse(db, house.id)!,
    task: getTask(db, task.id)!,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 40));

/** Resolve once the runner has registered its SSE onEvent callback. */
async function waitForSubscribed(fc: ReturnType<typeof makeFakeClient>): Promise<void> {
  const start = Date.now();
  while (!fc.subscribed()) {
    if (Date.now() - start > 4000) throw new Error("runner never subscribed to SSE");
    await flush();
  }
  // Give the poll loop a moment to reach a stable state.
  await flush();
}

function messageEvent(text: string) {
  return {
    id: "e",
    type: "message.updated",
    properties: { sessionID: "prov-1", messageID: "msg-1", info: { role: "assistant" }, part: { type: "text", text } },
  };
}

function stepFailedEvent() {
  return { id: "e", type: "session.next.step.failed", properties: { sessionID: "prov-1", error: { message: "boom" } } };
}

function permissionEvent(providerRequestId = "per-1") {
  return {
    id: "e",
    type: "permission.updated",
    properties: { sessionID: "prov-1", request: { id: providerRequestId, permission: "write", patterns: ["/x"] } },
  };
}

function questionEvent(providerRequestId = "q-1", header = "Which stack?", qText = "Choose", options: Array<{ id: string; label: string }> = [{ id: "ts", label: "TypeScript" }]) {
  return {
    id: "e",
    type: "question.updated",
    properties: {
      sessionID: "prov-1",
      request: { id: providerRequestId, questions: [{ header, question: qText, options }] },
    },
  };
}

// Quiet session used to let the completed watchdog fire quickly.
function quietSession(now = Date.now()) {
  return async () => ({
    id: "prov-1",
    cost: 0.5,
    tokens: { input: 10, output: 5, reasoning: 1, cacheRead: 2 },
    model: { id: "", providerID: "" },
    time: { created: now - 100, updated: now - 5000 },
    title: "",
  });
}

beforeEach(() => {
  resetDbForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-runner-"));
  dbPath = path.join(tmpDir, "test.db");
  process.env.VELARIS_DB_PATH = dbPath;
  migrate();
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("executeTask — status machine", () => {
  it("queued → running → completed after producing a message (quiet watchdog)", async () => {
    const { db, raw, house, task } = seedRun();
    const fc = makeFakeClient(quietSession());
    const adapter = makeFakeAdapter();

    const ac = new AbortController();
    const promise = executeTask(
      { db, raw, adapter: adapter as never, client: fc.client as never, task, house, directory: tmpDir, modelId: "m" },
      { pollMs: 20, completionQuietMs: 100, timeoutMs: 30_000, signal: ac.signal },
    );

    await waitForSubscribed(fc);
    fc.emit(messageEvent("Done!"));

    const result = await promise;
    expect(result.terminalStatus).toBe("completed");
    expect(getTask(db, task.id)?.status).toBe("completed");

    const evs = (raw.prepare("SELECT type FROM execution_events ORDER BY id").all() as { type: string }[]).map((r) => r.type);
    expect(evs).toContain("task_started");
    expect(evs).toContain("message");
    expect(evs).toContain("task_completed");
  });

  it("a session.next.step.failed event fails the task; the run is never marked completed (bug 1 regression)", async () => {
    const { db, raw, house, task } = seedRun();
    // A fresh (non-quiet) session: the ONLY path to a terminal state must be
    // the failure — a failed run must never be overwritten to completed by the
    // quiet-completion watchdog (bug 1).
    const fc = makeFakeClient(async () => ({
      id: "prov-1",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0 },
      model: { id: "", providerID: "" },
      time: { created: Date.now(), updated: Date.now() },
      title: "",
    }));
    const adapter = makeFakeAdapter();

    const ac = new AbortController();
    const promise = executeTask(
      { db, raw, adapter: adapter as never, client: fc.client as never, task, house, directory: tmpDir, modelId: "m" },
      { pollMs: 20, completionQuietMs: 100, timeoutMs: 30_000, signal: ac.signal },
    );

    await waitForSubscribed(fc);
    // Produce a message AND a step failure. The failure must drive the terminal
    // state — never a completion.
    fc.emit(messageEvent("working…"));
    fc.emit(stepFailedEvent());
    await flush();

    const result = await promise;
    expect(result.terminalStatus).toBe("failed");
    expect(getTask(db, task.id)?.status).toBe("failed");

    // Regression assertion: completed must NOT appear.
    const evs = (raw.prepare("SELECT type FROM execution_events ORDER BY id").all() as { type: string }[]).map((r) => r.type);
    expect(evs).toContain("task_failed");
    expect(evs).not.toContain("task_completed");
    ac.abort();
  });

  it("permission.updated → creates approval_request + notification and sets task awaiting_approval", async () => {
    const { db, house, task } = seedRun();
    const fc = makeFakeClient();
    const adapter = makeFakeAdapter();

    const ac = new AbortController();
    const promise = executeTask(
      { db, raw: getRawDb(), adapter: adapter as never, client: fc.client as never, task, house, directory: tmpDir, modelId: "m" },
      { pollMs: 20, completionQuietMs: 10_000, timeoutMs: 60_000, signal: ac.signal },
    );

    await waitForSubscribed(fc);
    fc.emit(permissionEvent("per-1"));
    await flush();

    const approvals = listApprovalRequests(db, {});
    expect(approvals).toHaveLength(1);
    expect(approvals[0].providerRequestId).toBe("per-1");
    expect(approvals[0].status).toBe("pending");
    expect(approvals[0].kind).toBe("permission");
    expect(countUnreadNotifications(db)).toBe(1);
    expect(getTask(db, task.id)?.status).toBe("awaiting_approval");

    ac.abort();
    await promise;
  });

  it("approvalPolicy 'never' auto-approves without creating an approval_request (auto-approve)", async () => {
    const { db, house, task } = seedRun("never");
    const fc = makeFakeClient();
    const adapter = makeFakeAdapter();

    const ac = new AbortController();
    const promise = executeTask(
      { db, raw: getRawDb(), adapter: adapter as never, client: fc.client as never, task, house, directory: tmpDir, modelId: "m" },
      { pollMs: 20, completionQuietMs: 10_000, timeoutMs: 60_000, signal: ac.signal },
    );

    await waitForSubscribed(fc);
    fc.emit(permissionEvent("per-2"));
    await flush();

    // No approval_request row created; the provider got an approve reply.
    expect(listApprovalRequests(db, {})).toHaveLength(0);
    expect(adapter.respondToApproval).toHaveBeenCalledWith(
      expect.objectContaining({ action: "approve", providerRequestId: "per-2", kind: "permission" }),
    );

    ac.abort();
    await promise;
  });

  it("a rejected permission → task failed + provider session cancelled (bug 6 regression)", async () => {
    const { db, house, task } = seedRun();
    const fc = makeFakeClient();
    const adapter = makeFakeAdapter();

    const ac = new AbortController();
    const promise = executeTask(
      { db, raw: getRawDb(), adapter: adapter as never, client: fc.client as never, task, house, directory: tmpDir, modelId: "m" },
      { pollMs: 20, completionQuietMs: 10_000, timeoutMs: 60_000, signal: ac.signal },
    );

    // Create a pending approval via an event, then flip it to rejected.
    await waitForSubscribed(fc);
    fc.emit(permissionEvent("per-3"));
    await flush();
    const appr = listApprovalRequests(db, { status: "pending" })[0];
    setApprovalResponse(db, appr.id, "rejected", "no");

    // Let the poll loop relay the rejection → task fails + provider aborted.
    const result = await promise;
    expect(result.terminalStatus).toBe("failed");
    expect(getTask(db, task.id)?.status).toBe("failed");
    expect(adapter.cancelTask).toHaveBeenCalledWith("prov-1");
    ac.abort();
  });

  it("chat relay sends a pending user message exactly once (relay marker, bug 2 regression)", async () => {
    const { db, house, task } = seedRun();
    const fc = makeFakeClient();
    const adapter = makeFakeAdapter();

    const ac = new AbortController();
    const promise = executeTask(
      { db, raw: getRawDb(), adapter: adapter as never, client: fc.client as never, task, house, directory: tmpDir, modelId: "m" },
      { pollMs: 20, completionQuietMs: 10_000, timeoutMs: 60_000, signal: ac.signal },
    );

    await waitForSubscribed(fc);
    const session = getActiveSessionForHouse(db, house.id)!;
    createAgentMessage(db, { sessionId: session.id, role: "user", content: "hello" });

    // Let several poll ticks elapse; the message should relay only once.
    await flush();
    await flush();

    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    const sendCall = (adapter.sendMessage.mock.calls[0] as unknown as [{ message: string }])[0];
    expect(sendCall.message).toBe("hello");

    // relayed_at marker is set so it's never re-sent.
    expect(findPendingUserMessage(getRawDb(), session.id, null)).toBeNull();

    ac.abort();
    await promise;
  });

  it("a rejected approval keeps status 'rejected' after being relayed (markRelayed fix, bug 5 regression)", async () => {
    const { db, house, task } = seedRun();
    const fc = makeFakeClient();
    const adapter = makeFakeAdapter();

    const ac = new AbortController();
    const promise = executeTask(
      { db, raw: getRawDb(), adapter: adapter as never, client: fc.client as never, task, house, directory: tmpDir, modelId: "m" },
      { pollMs: 20, completionQuietMs: 10_000, timeoutMs: 60_000, signal: ac.signal },
    );

    await waitForSubscribed(fc);
    fc.emit(permissionEvent("per-4"));
    await flush();
    const appr = listApprovalRequests(db, { status: "pending" })[0];
    setApprovalResponse(db, appr.id, "rejected", "denied");

    // Let the relay happen.
    await flush();
    await flush();

    // Status must remain 'rejected' (the user-chosen status), NOT 'cancelled',
    // with relayed_at set as the only "sent" marker.
    const after = listApprovalRequests(db, {})[0];
    expect(after.status).toBe("rejected");
    expect(after.relayedAt).not.toBeNull();
    expect(after.response).toBe("denied");

    ac.abort();
    await promise;
  });

  it("quiet-completion watchdog does NOT fire while awaiting_approval (bug 1 family # quiet-vs-approval)", async () => {
    const { db, house, task } = seedRun();
    // A very quiet session: the ONLY reason the run does not complete is the
    // pending permission blocking it. The watchdog must not overwrite the
    // awaiting_approval state (previously it marked the task completed).
    const fc = makeFakeClient(quietSession());
    const adapter = makeFakeAdapter();

    const ac = new AbortController();
    const promise = executeTask(
      { db, raw: getRawDb(), adapter: adapter as never, client: fc.client as never, task, house, directory: tmpDir, modelId: "m" },
      { pollMs: 20, completionQuietMs: 100, timeoutMs: 30_000, signal: ac.signal },
    );

    await waitForSubscribed(fc);
    fc.emit(messageEvent("working…"));
    fc.emit(permissionEvent("per-quiet"));
    // Let several quiet windows elapse — the run must NOT complete.
    for (let i = 0; i < 6; i++) await flush();

    expect(getTask(db, task.id)?.status).toBe("awaiting_approval");

    // Now approve the permission → session + task resume to running, and the
    // watchdog can fire → completed (bug 6 + quiet-watchdog resume path).
    const appr = listApprovalRequests(db, { status: "pending" })[0];
    setApprovalResponse(db, appr.id, "approved", null);
    const result = await promise;

    expect(result.terminalStatus).toBe("completed");
    expect(getTask(db, task.id)?.status).toBe("completed");
    ac.abort();
  });

  it("a user cancel racing startTask is not overwritten to completed (bug 1 family # cancel-vs-startTask)", async () => {
    const { db, house, task } = seedRun();
    // A quiet session: without the cancel-guard this would complete.
    const fc = makeFakeClient(quietSession());
    const adapter = makeFakeAdapter();

    const ac = new AbortController();
    const promise = executeTask(
      { db, raw: getRawDb(), adapter: adapter as never, client: fc.client as never, task, house, directory: tmpDir, modelId: "m" },
      { pollMs: 20, completionQuietMs: 100, timeoutMs: 30_000, signal: ac.signal },
    );

    await waitForSubscribed(fc);
    // Simulate the web cancel route racing the runner: the task row is already
    // `cancelled` (its authoritative user-intent marker) even though our runner
    // earlier clobbered the session's `aborted` back to `running`.
    setTaskStatus(db, task.id, "cancelled");
    for (let i = 0; i < 6; i++) await flush();

    const result = await promise;
    expect(result.terminalStatus).toBe("aborted");
    expect(getTask(db, task.id)?.status).toBe("cancelled");

    ac.abort();
  });

  it("answering a question resumes the session; the run then reaches completed (bug 1 family # quiet-vs-question)", async () => {
    const { db, house, task } = seedRun();
    // A quiet session: without resuming after the question is answered, the
    // awaiting_input state would block the watchdog forever and the task would
    // hang. Answering must reset the session → running → quiet-completion fires.
    const fc = makeFakeClient(quietSession());
    const adapter = makeFakeAdapter();

    const ac = new AbortController();
    const promise = executeTask(
      { db, raw: getRawDb(), adapter: adapter as never, client: fc.client as never, task, house, directory: tmpDir, modelId: "m" },
      { pollMs: 20, completionQuietMs: 100, timeoutMs: 30_000, signal: ac.signal },
    );

    await waitForSubscribed(fc);
    fc.emit(messageEvent("working…"));
    fc.emit(questionEvent("q-1"));
    for (let i = 0; i < 4; i++) await flush();

    // Blocked awaiting_input.
    expect(getTask(db, task.id)?.status).toBe("awaiting_input");

    // Answer the question via the web respond route semantics.
    const appr = listApprovalRequests(db, { status: "pending" })[0];
    setApprovalResponse(db, appr.id, "replied", "TypeScript");

    const result = await promise;
    expect(result.terminalStatus).toBe("completed");
    expect(getTask(db, task.id)?.status).toBe("completed");

    ac.abort();
  });

  it("subscribes SSE to the provider-RESOLVED directory when it differs from the task dir (Defect A belt-and-braces)", async () => {
    const { db, raw, house, task } = seedRun();
    // getSession reports a resolved directory DIFFERENT from the task's working_directory.
    const subscribedDirs: string[] = [];
    const fc = makeFakeClient(async () => ({
      id: "prov-1",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0 },
      model: { id: "", providerID: "" },
      time: { created: 0, updated: Date.now() },
      title: "",
      directory: "/provider/resolved/dir", // provider's actual session directory
    }));
    // Keep the task from completing: quiet watchdog with a long quiet window.
    const adapter = makeFakeAdapter();
    const origSubscribe = fc.client.subscribeEvents;
    fc.client.subscribeEvents = vi.fn((dir: string, opts: { onEvent: (ev: unknown) => void }) => {
      subscribedDirs.push(dir);
      return origSubscribe(dir, opts);
    }) as never;

    const ac = new AbortController();
    const promise = executeTask(
      { db, raw, adapter: adapter as never, client: fc.client as never, task, house, directory: tmpDir, modelId: "m" },
      { pollMs: 20, completionQuietMs: 100_000, timeoutMs: 30_000, signal: ac.signal },
    );

    await new Promise((r) => setTimeout(r, 60)); // let start + getSession + subscribe fire
    expect(subscribedDirs).toEqual(["/provider/resolved/dir"]);

    ac.abort();
    await promise;
  });

  it("does NOT ingest the user's own prompt as an agent row (Defect C role correlation)", async () => {
    const { db, raw, house, task } = seedRun();
    // A user message followed by its text part; the assistant message + its part.
    // The user's text part shares the USER message id → must NOT be ingested.
    const userMsgId = "msg_user";
    const assisMsgId = "msg_assist";
    const fc = makeFakeClient(quietSession());

    const ac = new AbortController();
    const promise = executeTask(
      { db, raw: getRawDb(), adapter: makeFakeAdapter() as never, client: fc.client as never, task, house, directory: tmpDir, modelId: "m" },
      { pollMs: 20, completionQuietMs: 100, timeoutMs: 30_000, signal: ac.signal },
    );

    await waitForSubscribed(fc);
    // 1. message.updated for a USER message (role captured), then its text part.
    fc.emit({ id: "e", type: "message.updated", properties: { sessionID: "prov-1", info: { id: userMsgId, role: "user" } } });
    fc.emit({ id: "e", type: "message.part.updated", properties: { sessionID: "prov-1", part: { type: "text", text: "the user's own composed prompt should not be an agent row", messageID: userMsgId } } });
    await flush();

    // 2. message.updated for the ASSISTANT message, then its text part.
    fc.emit({ id: "e", type: "message.updated", properties: { sessionID: "prov-1", info: { id: assisMsgId, role: "assistant" } } });
    fc.emit({ id: "e", type: "message.part.updated", properties: { sessionID: "prov-1", part: { type: "text", text: "Real assistant answer", messageID: assisMsgId } } });
    await flush();

    // The run completes; only the assistant text landed as an agent row.
    await promise;
    const rows = (raw.prepare("SELECT content, role FROM agent_messages ORDER BY id").all() as { content: string; role: string }[]);
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe("agent");
    expect(rows[0].content).toBe("Real assistant answer");
    ac.abort();
  });
});
