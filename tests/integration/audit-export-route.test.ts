/**
 * Integration tests — audit log export route (Phase 6.2 Stage S4).
 *
 * DB isolation contract (tests/integration/api-routes.test.ts): VELARIS_DB_PATH
 * points at a fresh temp file per test (set BEFORE handlers run), with
 * resetDbForTests() + resetBootstrapForTests() in beforeEach.
 *
 * Coverage:
 *  - format=csv → content-type + disposition + RFC-4180 quoting
 *  - format=json → { entries } shape
 *  - filters + from/to bounds honoured
 *  - invalid format → 400; over-cap limit → 400
 *  - read-only: the export does not write audit rows
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

import { resetDbForTests, getDb, getRawDb } from "@/lib/db";
import { resetBootstrapForTests, bootstrapDb } from "@/server/bootstrap";
import { recordAudit, listAuditLog } from "@/server/repositories/audit-repo";
import { GET as exportAudit } from "@/app/api/audit-log/export/route";
import { AUDIT_EXPORT_MAX_LIMIT } from "@/shared/schemas/audit";

const BASE = "http://localhost:3000";
let tmpDir: string;

beforeEach(() => {
  resetDbForTests();
  resetBootstrapForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-audit-export-"));
  process.env.VELARIS_DB_PATH = path.join(tmpDir, "test.db");
  bootstrapDb();
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function req(url: string): NextRequest {
  return new NextRequest(url, { headers: { "content-type": "application/json" } });
}

function seedAudit(): void {
  const db = getDb();
  recordAudit(db, {
    id: "a1",
    action: "create",
    entityType: "house",
    entityId: "h1",
    metadata: { name: 'House, "Shadows"\nSecond line' },
  });
  recordAudit(db, { id: "a2", action: "update", entityType: "project", entityId: "p1" });
  const raw = getRawDb();
  raw.prepare("UPDATE audit_log SET created_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", "a1");
  raw.prepare("UPDATE audit_log SET created_at = ? WHERE id = ?").run("2026-06-01T00:00:00.000Z", "a2");
}

describe("GET /api/audit-log/export", () => {
  it("returns RFC-4180 CSV with content-type + disposition and quoting", async () => {
    seedAudit();
    const res = await exportAudit(req(`${BASE}/api/audit-log/export?format=csv`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="audit-log-.*\.csv"$/,
    );

    const csv = await res.text();
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("id,actor,actor_agent_id,action,entity_type,entity_id,metadata,created_at");
    expect(csv.endsWith("\r\n")).toBe(true);
    // Newest-first: a2 (June) before a1 (January).
    expect(lines[1]).toContain(",update,project,p1,");
    // The metadata field contains commas + quotes (JSON-encoded), so it is
    // quoted per RFC-4180 and its embedded quotes are doubled. The JSON `\n`
    // escape stays literal in the JSON string.
    expect(lines[2]).toBe(
      String.raw`a1,user,,create,house,h1,"{""name"":""House, \""Shadows\""\nSecond line""}",2026-01-01T00:00:00.000Z`,
    );
  });

  it("defaults to CSV when format is omitted", async () => {
    seedAudit();
    const res = await exportAudit(req(`${BASE}/api/audit-log/export`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
  });

  it("returns the { entries } JSON shape for format=json", async () => {
    seedAudit();
    const res = await exportAudit(req(`${BASE}/api/audit-log/export?format=json`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { entries: Array<{ id: string; metadata: unknown }> };
    expect(body.entries.map((e) => e.id)).toEqual(["a2", "a1"]);
    expect(body.entries[1].metadata).toMatchObject({ name: expect.stringContaining("Shadows") });
  });

  it("honours filters and the from/to date bounds", async () => {
    seedAudit();
    const filtered = await exportAudit(
      req(`${BASE}/api/audit-log/export?format=json&entityType=project&action=update`),
    );
    const body = (await filtered.json()) as { entries: Array<{ id: string }> };
    expect(body.entries.map((e) => e.id)).toEqual(["a2"]);

    const bounded = await exportAudit(
      req(`${BASE}/api/audit-log/export?format=json&to=2026-03-01T00:00:00.000Z`),
    );
    const boundedBody = (await bounded.json()) as { entries: Array<{ id: string }> };
    expect(boundedBody.entries.map((e) => e.id)).toEqual(["a1"]);
  });

  it("rejects an invalid format and an over-cap limit with 400", async () => {
    expect((await exportAudit(req(`${BASE}/api/audit-log/export?format=xml`))).status).toBe(400);
    expect(
      (await exportAudit(req(`${BASE}/api/audit-log/export?limit=${AUDIT_EXPORT_MAX_LIMIT + 1}`))).status,
    ).toBe(400);
  });

  it("honours an explicit limit below the cap", async () => {
    seedAudit();
    const res = await exportAudit(req(`${BASE}/api/audit-log/export?format=json&limit=1`));
    const body = (await res.json()) as { entries: Array<{ id: string }> };
    expect(body.entries.map((e) => e.id)).toEqual(["a2"]);
  });

  it("is read-only — exporting does not append audit rows", async () => {
    seedAudit();
    const before = listAuditLog(getDb(), { limit: 100 }).length;
    await exportAudit(req(`${BASE}/api/audit-log/export?format=csv`));
    await exportAudit(req(`${BASE}/api/audit-log/export?format=json`));
    expect(listAuditLog(getDb(), { limit: 100 })).toHaveLength(before);
  });
});
