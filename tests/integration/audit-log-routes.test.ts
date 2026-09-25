/**
 * Integration tests — audit log route + service-boundary audit writes
 * (Phase 6 Stage A), invoked directly with `new Request(...)`.
 *
 * DB isolation contract (matches tests/integration/api-routes.test.ts):
 * VELARIS_DB_PATH points at a fresh temp file per test, set BEFORE importing
 * the route modules; resetDbForTests() + resetBootstrapForTests() run in
 * beforeEach.
 *
 * Coverage:
 *  - GET /api/audit-log: default limit, filters, bad query → 400
 *  - House create/update/status/delete via the real routes writes audit rows
 *  - An approval response writes exactly one `approval` audit row
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { resetDbForTests, getDb } from "@/lib/db";
import { resetBootstrapForTests } from "@/server/bootstrap";

import { GET as getAuditLog } from "@/app/api/audit-log/route";
import { POST as createHouseRoute } from "@/app/api/houses/route";
import {
  PATCH as patchHouse,
  DELETE as deleteHouseRoute,
} from "@/app/api/houses/[id]/route";
import { POST as createTaskRoute } from "@/app/api/tasks/route";
import { POST as respondApproval } from "@/app/api/approvals/[id]/respond/route";
import {
  createExecutionSession,
  createApprovalRequest,
} from "@/server/repositories/execution-repo";

const BASE = "http://localhost:3000";
let tmpDir: string;

beforeEach(() => {
  resetDbForTests();
  resetBootstrapForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-audit-routes-"));
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

function housePayload(name = "House of Shadows") {
  return {
    name,
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

interface AuditEntry {
  action: string;
  entityType: string;
  entityId: string | null;
  actor: string;
}

async function getEntries(query = ""): Promise<AuditEntry[]> {
  const res = await getAuditLog(req(`${BASE}/api/audit-log${query}`));
  expect(res.status).toBe(200);
  return ((await res.json()) as { entries: AuditEntry[] }).entries;
}

/* ================================================================== */
/* GET /api/audit-log                                                  */
/* ================================================================== */

describe("GET /api/audit-log", () => {
  it("returns an empty list when nothing has been audited", async () => {
    expect(await getEntries()).toEqual([]);
  });

  it("applies filters and exposes the response envelope", async () => {
    const house = await createHouse();
    await patchHouse(jsonReq("PATCH", `${BASE}/api/houses/${house.id}`, { name: "Renamed" }), idCtx(house.id));

    const all = await getEntries();
    expect(all.length).toBeGreaterThanOrEqual(2);

    const creates = await getEntries("?action=create");
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({ action: "create", entityType: "house", entityId: house.id, actor: "user" });

    const byEntity = await getEntries(`?entityType=house&entityId=${house.id}`);
    expect(byEntity.every((e) => e.entityId === house.id)).toBe(true);
  });

  it("rejects an invalid query with 400", async () => {
    const res = await getAuditLog(req(`${BASE}/api/audit-log?actor=robot`));
    expect(res.status).toBe(400);
    const badLimit = await getAuditLog(req(`${BASE}/api/audit-log?limit=nope`));
    expect(badLimit.status).toBe(400);
  });

  it("caps the page size at the documented maximum", async () => {
    const house = await createHouse();
    await patchHouse(jsonReq("PATCH", `${BASE}/api/houses/${house.id}`, { name: "A" }), idCtx(house.id));
    // The schema caps the page at AUDIT_LOG_MAX_LIMIT (100); an over-cap value
    // is a 400, and a valid large limit still returns the entries.
    expect((await getAuditLog(req(`${BASE}/api/audit-log?limit=101`))).status).toBe(400);
    const res = await getAuditLog(req(`${BASE}/api/audit-log?limit=100`));
    expect(res.status).toBe(200);
    const entries = ((await res.json()) as { entries: unknown[] }).entries;
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries.length).toBeLessThanOrEqual(100);
  });
});

/* ================================================================== */
/* House CRUD audit writes                                             */
/* ================================================================== */

describe("house CRUD writes audit rows", () => {
  it("create / update / status / delete each append a house entry", async () => {
    const house = await createHouse();
    expect(await getEntries("?entityType=house&action=create")).toHaveLength(1);

    await patchHouse(jsonReq("PATCH", `${BASE}/api/houses/${house.id}`, { name: "Renamed" }), idCtx(house.id));
    const update = await getEntries("?entityType=house&action=update");
    expect(update).toHaveLength(1);
    expect(update[0].entityId).toBe(house.id);

    // Status transition (active → archived), then delete.
    await patchHouse(jsonReq("PATCH", `${BASE}/api/houses/${house.id}`, { status: "archived" }), idCtx(house.id));
    const status = await getEntries("?entityType=house&action=status");
    expect(status).toHaveLength(1);

    const del = await deleteHouseRoute(req(`${BASE}/api/houses/${house.id}`, { method: "DELETE" }), idCtx(house.id));
    expect(del.status).toBe(204);
    const deleted = await getEntries("?entityType=house&action=delete");
    expect(deleted).toHaveLength(1);
    expect(deleted[0].entityId).toBe(house.id);

    // A failed update (404) must NOT create an audit row.
    const missing = randomUUID();
    await patchHouse(jsonReq("PATCH", `${BASE}/api/houses/${missing}`, { name: "Ghost" }), idCtx(missing));
    const all = await getEntries("?action=update");
    expect(all).toHaveLength(1); // still only the successful one
  });
});

/* ================================================================== */
/* Approval response audit write                                       */
/* ================================================================== */

describe("approval response writes an audit row", () => {
  it("records exactly one `respond` approval entry", async () => {
    const house = await createHouse();
    const taskRes = await createTaskRoute(
      jsonReq("POST", `${BASE}/api/tasks`, { title: "Quest", houseId: house.id, workingDirectory: tmpDir }),
    );
    const taskId = ((await taskRes.json()) as { task: { id: string } }).task.id;
    const db = getDb();
    const session = createExecutionSession(db, {
      taskId,
      houseId: house.id,
      provider: "opencode",
      modelId: "glm-5.3",
      directory: tmpDir,
    });
    const approval = createApprovalRequest(db, {
      sessionId: session.id,
      taskId,
      houseId: house.id,
      providerRequestId: "pr-audit",
      kind: "permission",
      title: "T",
      message: "M",
    })!;

    const res = await respondApproval(
      jsonReq("POST", `${BASE}/api/approvals/${approval.id}/respond`, { action: "approve" }),
      idCtx(approval.id),
    );
    expect(res.status).toBe(200);

    const approvalEntries = await getEntries("?entityType=approval");
    expect(approvalEntries).toHaveLength(1);
    expect(approvalEntries[0]).toMatchObject({
      action: "respond",
      entityType: "approval",
      entityId: approval.id,
      actor: "user",
    });
  });

  it("does not audit a respond call for an unknown approval", async () => {
    const missing = randomUUID();
    const res = await respondApproval(
      jsonReq("POST", `${BASE}/api/approvals/${missing}/respond`, { action: "approve" }),
      idCtx(missing),
    );
    expect(res.status).toBe(404);
    expect(await getEntries("?entityType=approval")).toHaveLength(0);
  });
});
