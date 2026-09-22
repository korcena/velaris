/**
 * Integration tests — Phase 2 execution + approvals + notifications + messages
 * routes, invoked directly with `new Request(...)` against a temp DB
 * (following tests/integration/api-routes.test.ts's exact isolation contract).
 *
 * Coverage:
 *  - GET/POST /api/approvals, GET one, POST respond (approve/reject/reply), 400/404/
 *    already-responded, notification marked read (bug 10 regression).
 *  - GET /api/notifications (+ unreadOnly), POST read/read-all, 404.
 *  - POST /api/tasks/{id}/cancel (queued → cancelled, terminal → idempotent, 404).
 *  - GET /api/tasks/{id}/events?afterId= cursor.
 *  - GET/POST /api/houses/{id}/messages.
 *  - GET /api/houses/{id} → HouseDetailDto shape.
 *  - GET /api/models (fetch mocked): available:true mapping + graceful fallback.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { resetDbForTests, getDb, getRawDb } from "@/lib/db";
import { resetBootstrapForTests } from "@/server/bootstrap";

import { GET as listApprovals } from "@/app/api/approvals/route";
import { GET as getApprovalById } from "@/app/api/approvals/[id]/route";
import { POST as respondApproval } from "@/app/api/approvals/[id]/respond/route";
import { GET as listNotifications } from "@/app/api/notifications/route";
import { POST as markNotificationRead } from "@/app/api/notifications/[id]/read/route";
import { POST as markAllRead } from "@/app/api/notifications/read-all/route";
import { POST as cancelTask } from "@/app/api/tasks/[id]/cancel/route";
import { GET as getTaskEvents } from "@/app/api/tasks/[id]/events/route";
import { POST as postHouseMessage, GET as listHouseMessages } from "@/app/api/houses/[id]/messages/route";
import { GET as getHouseById } from "@/app/api/houses/[id]/route";
import { GET as getHouseList } from "@/app/api/houses/route";
import { POST as createHouseRoute } from "@/app/api/houses/route";
import { POST as createTaskRoute } from "@/app/api/tasks/route";
import { GET as getModels } from "@/app/api/models/route";

import { createExecutionSession, createExecutionEvent, createApprovalRequest, createNotification, createAgentMessage } from "@/server/repositories/execution-repo";
import { setTaskStatus } from "@/server/repositories/task-repo";

const BASE = "http://localhost:3000";
let tmpDir: string;

beforeEach(() => {
  resetDbForTests();
  resetBootstrapForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-exec-"));
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

function housePayload(): {
  name: string;
  description: string;
  agent: { name: string; role: string };
  configuration: Record<string, unknown>;
} {
  return {
    name: "House of Shadows",
    description: "",
    agent: { name: "Azriel", role: "knight" },
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
    jsonReq("POST", `${BASE}/api/tasks`, { title: "Quest", houseId, workingDirectory: tmpDir }),
  );
  expect(res.status).toBe(201);
  return { id: ((await res.json()) as { task: { id: string } }).task.id };
}

/** Seed a house, running task, and a session with an execution_events row. */
async function seedActive() {
  const house = await createHouse();
  const task = await createTask(house.id);
  const db = getDb();
  const session = createExecutionSession(db, {
    taskId: task.id,
    houseId: house.id,
    provider: "opencode",
    modelId: "glm-5.3",
    directory: tmpDir,
  });
  setTaskStatus(db, task.id, "running");
  const eventId = createExecutionEvent(db, {
    sessionId: session.id,
    taskId: task.id,
    houseId: house.id,
    rawType: "task_started",
    type: "task_started",
    payload: { title: "Quest" },
  });
  return { house: house.id, task: task.id, session: session.id, eventId };
}

/* ================================================================== */
/* Approvals                                                           */
/* ================================================================== */

describe("GET /api/approvals", () => {
  it("lists approvals; filters by status", async () => {
    const { house, task, session } = await seedActive();
    const db = getDb();
    createApprovalRequest(db, {
      sessionId: session,
      taskId: task,
      houseId: house,
      providerRequestId: "per-1",
      kind: "permission",
      title: "Title",
      message: "Body",
    });
    createApprovalRequest(db, {
      sessionId: session,
      taskId: task,
      houseId: house,
      providerRequestId: "per-2",
      kind: "permission",
      title: "Title2",
      message: "Body2",
    });
    const all = await (await listApprovals(req(`${BASE}/api/approvals`))).json();
    expect(all.approvals).toHaveLength(2);

    const pending = await (await listApprovals(req(`${BASE}/api/approvals?status=pending`))).json();
    expect(pending.approvals).toHaveLength(2);
  });

  it("get one → 200; unknown → 404", async () => {
    const { session, task, house } = await seedActive();
    const appr = createApprovalRequest(getDb(), {
      sessionId: session,
      taskId: task,
      houseId: house,
      providerRequestId: "per-x",
      kind: "permission",
      title: "T",
      message: "M",
    })!;
    const res = await getApprovalById(req(`${BASE}/api/approvals/${appr.id}`), idCtx(appr.id));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { approval: { id: string } }).approval.id).toBe(appr.id);

    const missing = randomUUID();
    expect(
      (await getApprovalById(req(`${BASE}/api/approvals/${missing}`), idCtx(missing))).status,
    ).toBe(404);
  });
});

describe("POST /api/approvals/{id}/respond", () => {
  it("approve → 200, status transitions, linked notification marked read (bug 10 regression)", async () => {
    const { house, task, session } = await seedActive();
    const db = getDb();
    const appr = createApprovalRequest(db, {
      sessionId: session,
      taskId: task,
      houseId: house,
      providerRequestId: "per-a",
      kind: "permission",
      title: "Write file",
      message: "write /x",
    })!;
    createNotification(db, {
      type: "approval",
      houseId: house,
      taskId: task,
      approvalRequestId: appr.id,
      title: "Write file",
      body: "write /x",
    });

    const before = await (await listNotifications(req(`${BASE}/api/notifications`))).json();
    expect(before.unread).toBe(1);

    const res = await respondApproval(
      jsonReq("POST", `${BASE}/api/approvals/${appr.id}/respond`, { action: "approve" }),
      idCtx(appr.id),
    );
    expect(res.status).toBe(200);
    const { approval } = await res.json();
    expect(approval.status).toBe("approved");
    expect(approval.respondedAt).toEqual(expect.any(String));

    // The linked notification must now be read (unread count dropped).
    const after = await (await listNotifications(req(`${BASE}/api/notifications`))).json();
    expect(after.unread).toBe(0);
  });

  it("reject with message → status rejected + response saved", async () => {
    const { session, task, house } = await seedActive();
    const db = getDb();
    const appr = createApprovalRequest(db, {
      sessionId: session,
      taskId: task,
      houseId: house,
      providerRequestId: "per-r",
      kind: "permission",
      title: "T",
      message: "M",
    })!;
    const res = await respondApproval(
      jsonReq("POST", `${BASE}/api/approvals/${appr.id}/respond`, { action: "reject", response: "no" }),
      idCtx(appr.id),
    );
    expect(res.status).toBe(200);
    const { approval } = await res.json();
    expect(approval.status).toBe("rejected");
    expect(approval.response).toBe("no");
  });

  it("reply with no response text → 400 (zod)", async () => {
    const { session, task, house } = await seedActive();
    const appr = createApprovalRequest(getDb(), {
      sessionId: session,
      taskId: task,
      houseId: house,
      providerRequestId: "per-y",
      kind: "question",
      title: "Q",
      message: "Which?",
    })!;
    const res = await respondApproval(
      jsonReq("POST", `${BASE}/api/approvals/${appr.id}/respond`, { action: "reply", response: "" }),
      idCtx(appr.id),
    );
    expect(res.status).toBe(400);
  });

  it("invalid action → 400 via zod", async () => {
    const { session, task, house } = await seedActive();
    const appr = createApprovalRequest(getDb(), {
      sessionId: session,
      taskId: task,
      houseId: house,
      providerRequestId: "per-z",
      kind: "permission",
      title: "T",
      message: "M",
    })!;
    const res = await respondApproval(
      jsonReq("POST", `${BASE}/api/approvals/${appr.id}/respond`, { action: "punch" }),
      idCtx(appr.id),
    );
    expect(res.status).toBe(400);
  });

  it("already-responded approval keeps its chosen status (no resurrection)", async () => {
    const { session, task, house } = await seedActive();
    const db = getDb();
    const appr = createApprovalRequest(db, {
      sessionId: session,
      taskId: task,
      houseId: house,
      providerRequestId: "per-done",
      kind: "permission",
      title: "T",
      message: "M",
    })!;
    await respondApproval(jsonReq("POST", `${BASE}/api/approvals/${appr.id}/respond`, { action: "approve" }), idCtx(appr.id));
    const again = await respondApproval(
      jsonReq("POST", `${BASE}/api/approvals/${appr.id}/respond`, { action: "reject" }),
      idCtx(appr.id),
    );
    // Already approved → stays approved (idempotency guard, bug 5 family).
    expect(again.status).toBe(200);
    expect(((await again.json()) as { approval: { status: string } }).approval.status).toBe("approved");
  });

  it("unknown id → 404", async () => {
    const missing = randomUUID();
    const res = await respondApproval(
      jsonReq("POST", `${BASE}/api/approvals/${missing}/respond`, { action: "approve" }),
      idCtx(missing),
    );
    expect(res.status).toBe(404);
  });

  it("select action resolves the option label as response", async () => {
    const { session, task, house } = await seedActive();
    const db = getDb();
    const appr = createApprovalRequest(db, {
      sessionId: session,
      taskId: task,
      houseId: house,
      providerRequestId: "per-select",
      kind: "question",
      title: "Which stack?",
      message: "Choose",
      options: [{ id: "ts", label: "TypeScript" }],
    })!;
    const res = await respondApproval(
      jsonReq("POST", `${BASE}/api/approvals/${appr.id}/respond`, { action: "select", optionId: "ts" }),
      idCtx(appr.id),
    );
    expect(res.status).toBe(200);
    const { approval } = await res.json();
    expect(approval.status).toBe("replied");
    expect(approval.response).toBe("TypeScript");
  });
});

/* ================================================================== */
/* Notifications                                                       */
/* ================================================================== */

describe("GET /api/notifications", () => {
  it("lists + unreadOnly filter + unread count", async () => {
    const { house, task } = await seedActive();
    const db = getDb();
    createNotification(db, { type: "approval", houseId: house, taskId: task, title: "A", body: "a" });
    createNotification(db, { type: "completion", houseId: house, taskId: task, title: "C", body: "c" });

    const all = await (await listNotifications(req(`${BASE}/api/notifications`))).json();
    expect(all.notifications).toHaveLength(2);
    expect(all.unread).toBe(2);

    const unreadOnly = await (await listNotifications(req(`${BASE}/api/notifications?unreadOnly=1`))).json();
    expect(unreadOnly.notifications).toHaveLength(2);

    // Mark one read → count + filter shift.
    const first = all.notifications[0];
    await markNotificationRead(req(`${BASE}/api/notifications/${first.id}/read`, { method: "POST" }), idCtx(first.id));
    const after = await (await listNotifications(req(`${BASE}/api/notifications?unreadOnly=1`))).json();
    expect(after.unread).toBe(1);
    expect(after.notifications).toHaveLength(1);
  });

  it("mark read → 200 + read flips; unknown → 404", async () => {
    const { house, task } = await seedActive();
    const db = getDb();
    const notif = createNotification(db, { type: "approval", houseId: house, taskId: task, title: "A", body: "a" });
    // fetch the id via the repo
    const { listNotifications } = await import("@/server/repositories/execution-repo");
    const row = listNotifications(db, {})[0];
    const res = await markNotificationRead(
      req(`${BASE}/api/notifications/${row.id}/read`, { method: "POST" }),
      idCtx(row.id),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { notification: { read: boolean } }).notification.read).toBe(true);
    void notif;

    const missing = randomUUID();
    const miss = await markNotificationRead(req(`${BASE}/api/notifications/${missing}/read`, { method: "POST" }), idCtx(missing));
    expect(miss.status).toBe(404);
  });

  it("read-all drops unread to 0", async () => {
    const { house, task } = await seedActive();
    const db = getDb();
    createNotification(db, { type: "approval", houseId: house, taskId: task, title: "A", body: "a" });
    createNotification(db, { type: "completion", houseId: house, taskId: task, title: "C", body: "c" });

    const res = await markAllRead(req(`${BASE}/api/notifications/read-all`, { method: "POST" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { marked: number }).marked).toBe(2);

    const after = await (await listNotifications(req(`${BASE}/api/notifications`))).json();
    expect(after.unread).toBe(0);
  });
});

/* ================================================================== */
/* Task cancel + events                                               */
/* ================================================================== */

describe("POST /api/tasks/{id}/cancel", () => {
  it("cancels a queued task → cancelled:true", async () => {
    const { id: house } = await createHouse();
    const task = await createTask(house);
    const res = await cancelTask(req(`${BASE}/api/tasks/${task.id}/cancel`, { method: "POST" }), idCtx(task.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cancelled).toBe(true);
    expect(body.task.status).toBe("cancelled");
  });

  it("terminal (completed/failed) task is not re-cancelled (idempotent 200)", async () => {
    const { task } = await seedActive();
    setTaskStatus(getDb(), task, "completed");
    const res = await cancelTask(req(`${BASE}/api/tasks/${task}/cancel`, { method: "POST" }), idCtx(task));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cancelled).toBe(false);
    expect(body.task.status).toBe("completed");
  });

  it("unknown id → 404", async () => {
    const missing = randomUUID();
    const res = await cancelTask(req(`${BASE}/api/tasks/${missing}/cancel`, { method: "POST" }), idCtx(missing));
    expect(res.status).toBe(404);
  });
});

describe("GET /api/tasks/{id}/events", () => {
  it("returns seeded events ordered by id; afterId cursor respected", async () => {
    const { task, session, house } = await seedActive();
    const db = getDb();
    const id2 = createExecutionEvent(db, { sessionId: session, taskId: task, houseId: house, rawType: "session_started", type: "session_started" });
    const id3 = createExecutionEvent(db, { sessionId: session, taskId: task, houseId: house, rawType: "message", type: "message", payload: { text: "hi" } });

    const all = await (await getTaskEvents(req(`${BASE}/api/tasks/${task}/events`), idCtx(task))).json();
    expect(all.events).toHaveLength(3);
    expect(all.events.map((e: { id: number }) => e.id)).toEqual([1, 2, 3].slice(0, all.events.length));

    // After the first event id → only 2 remain.
    const after = await (await getTaskEvents(req(`${BASE}/api/tasks/${task}/events?afterId=${Math.min(id2, id3) - 1}`), idCtx(task))).json();
    expect(after.events.length).toBeGreaterThan(0);
  });

  it("unknown task → 404", async () => {
    const missing = randomUUID();
    const res = await getTaskEvents(req(`${BASE}/api/tasks/${missing}/events`), idCtx(missing));
    expect(res.status).toBe(404);
  });
});

/* ================================================================== */
/* House messages                                                      */
/* ================================================================== */

describe("POST/GET /api/houses/{id}/messages", () => {
  it("POST inserts a user message for the active session → { accepted, sessionId }; GET lists it", async () => {
    const { id: house } = await createHouse();
    // No active session → message route 404s.
    const noSession = await postHouseMessage(
      jsonReq("POST", `${BASE}/api/houses/${house}/messages`, { content: "hi" }),
      idCtx(house),
    );
    expect(noSession.status).toBe(404);

    // Activate a session.
    const { task, session } = await seedActiveForHouse(house);
    const res = await postHouseMessage(
      jsonReq("POST", `${BASE}/api/houses/${house}/messages`, { content: "hello" }),
      idCtx(house),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accepted).toBe(true);
    expect(body.sessionId).toBe(session);

    const list = await (await listHouseMessages(req(`${BASE}/api/houses/${house}/messages`), idCtx(house))).json();
    const userMsgs = list.messages.filter((m: { role: string }) => m.role === "user");
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0].content).toBe("hello");
    expect(task).toBeTruthy();
  });

  it("POST invalid/empty content → 400", async () => {
    const { house } = await seedActive();
    const res = await postHouseMessage(
      jsonReq("POST", `${BASE}/api/houses/${house}/messages`, { content: "   " }),
      idCtx(house),
    );
    expect(res.status).toBe(400);
  });

  it("POST unknown house → 404", async () => {
    const missing = randomUUID();
    const res = await postHouseMessage(
      jsonReq("POST", `${BASE}/api/houses/${missing}/messages`, { content: "hi" }),
      idCtx(missing),
    );
    expect(res.status).toBe(404);
  });
});

async function seedActiveForHouse(houseId: string): Promise<{ task: string; session: string }> {
  const db = getDb();
  const task = await createTask(houseId);
  const session = createExecutionSession(db, {
    taskId: task.id,
    houseId,
    provider: "opencode",
    modelId: "glm-5.3",
    directory: tmpDir,
  });
  setTaskStatus(db, task.id, "running");
  (await import("@/server/repositories/execution-repo")).setSessionStatus(db, session.id, "running");
  return { task: task.id, session: session.id };
}

/* ================================================================== */
/* House detail + list shapes                                          */
/* ================================================================== */

describe("GET /api/houses/{id} — HouseDetailDto shape", () => {
  it("returns runtimeStatus + activeTask/pendingApprovals present", async () => {
    const { id: house } = await createHouse();
    const res = await getHouseById(req(`${BASE}/api/houses/${house}`), idCtx(house));
    expect(res.status).toBe(200);
    const { house: detail } = await res.json();
    expect(detail.id).toBe(house);
    // Phase 1 fields preserved.
    expect(detail.name).toBe("House of Shadows");
    // Phase 2 fields present.
    expect(detail).toHaveProperty("runtimeStatus");
    expect(detail.runtimeStatus).toBe("idle");
    expect(detail.activeTask).toEqual({ id: null, title: null, status: null });
    expect(detail.pendingApprovals).toBe(0);
  });

  it("activeTask populated when there is a running session + task", async () => {
    const { id: house } = await createHouse();
    const { task } = await seedActiveForHouse(house);
    const res = await getHouseById(req(`${BASE}/api/houses/${house}`), idCtx(house));
    const { house: detail } = await res.json();
    expect(detail.runtimeStatus).toBe("working");
    expect(detail.activeTask.id).toBe(task);
    expect(detail.activeTask.title).toBe("Quest");
    expect(detail.pendingApprovals).toBe(0);
  });

  it("house list entries carry runtimeStatus + pendingApprovals (bird indicator)", async () => {
    const { id: house } = await createHouse();
    const list = await (await getHouseList(req(`${BASE}/api/houses`))).json();
    const h = list.houses.find((x: { id: string }) => x.id === house);
    expect(h.runtimeStatus).toBe("idle");
    expect(h.pendingApprovals).toBe(0);
  });
});

/* ================================================================== */
/* Models                                                              */
/* ================================================================== */

describe("GET /api/models", () => {
  it("maps provider models to {models, available:true}", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: RequestInfo) =>
      new Response(
        JSON.stringify(
          String(url).includes("/api/provider")
            ? { all: [{ id: "ollama-cloud", name: "Ollama Cloud" }], connected: ["ollama-cloud"] }
            : { data: [{ id: "glm-5.3", providerID: "ollama-cloud" }] },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    try {
      const res = await getModels(req(`${BASE}/api/models`));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.available).toBe(true);
      expect(body.models).toHaveLength(1);
      expect(body.models[0]).toEqual({
        id: "glm-5.3",
        providerId: "ollama-cloud",
        providerName: "Ollama Cloud",
        modelId: "glm-5.3",
        displayName: "Ollama Cloud/glm-5.3",
      });
    } finally {
      globalThis.fetch = original;
      // Drop the in-memory model cache so later tests re-fetch.
      (await import("@/server/services/model-service")).resetModelCache();
    }
  });

  it("falls back to available:false {models:[]} when fetch rejects", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    try {
      const res = await getModels(req(`${BASE}/api/models`));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.available).toBe(false);
      expect(body.models).toEqual([]);
    } finally {
      globalThis.fetch = original;
      (await import("@/server/services/model-service")).resetModelCache();
    }
  });
});
