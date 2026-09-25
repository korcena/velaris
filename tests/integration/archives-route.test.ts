/**
 * Integration tests — archives route (Phase 6 Stage D), invoked directly with
 * `new NextRequest()`.
 *
 * DB isolation contract (matches tests/integration/api-routes.test.ts):
 * VELARIS_DB_PATH points at a fresh temp file per test, set BEFORE importing
 * the route modules; resetDbForTests() + resetBootstrapForTests() in beforeEach.
 *
 * Golden dataset: ≥100 terminal sessions (the §10 acceptance criterion), seeded
 * directly (engine OFF — archives is a pure read over existing tables).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

import { resetDbForTests, getRawDb } from "@/lib/db";
import { resetBootstrapForTests, bootstrapDb } from "@/server/bootstrap";
import { GET as getArchives } from "@/app/api/archives/route";

const BASE = "http://localhost:3000";
const SESSION_COUNT = 100;
let tmpDir: string;

beforeEach(() => {
  resetDbForTests();
  resetBootstrapForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-archives-routes-"));
  process.env.VELARIS_DB_PATH = path.join(tmpDir, "test.db");
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function req(url: string): NextRequest {
  return new NextRequest(url, { headers: { "content-type": "application/json" } });
}

/** Seed 100 terminal tasks + sessions directly (mirrors an engine-off e2e). */
function seedArchives(): void {
  // Migrate + seed defaults via the real boot path so the schema exists before
  // we insert rows directly (the route also bootstraps, idempotently).
  bootstrapDb();
  const raw = getRawDb();
  const now = new Date("2026-01-01T00:00:00.000Z").toISOString();
  raw
    .prepare(
      "INSERT INTO houses (id,name,description,kind,status) VALUES ('arch-house','Archive House','','agent','active')",
    )
    .run();
  const insertTask = raw.prepare(
    `INSERT INTO tasks (id, title, description, type, status, house_id, created_at, updated_at)
     VALUES (?, ?, ?, 'general', 'completed', 'arch-house', ?, ?)`,
  );
  const insertSession = raw.prepare(
    `INSERT INTO execution_sessions (id, task_id, house_id, status, provider, model_id, created_at, updated_at)
     VALUES (?, ?, 'arch-house', 'completed', 'opencode', 'glm-5.3', ?, ?)`,
  );
  for (let i = 1; i <= SESSION_COUNT; i++) {
    insertTask.run(`at-${i}`, `Archived Quest ${i}`, `body-${i}`, now, now);
    insertSession.run(`as-${i}`, `at-${i}`, now, now);
  }
}

describe("GET /api/archives", () => {
  it("searches ≥100 sessions and honours q/house/pagination/total", async () => {
    seedArchives();

    const all = await getArchives(req(`${BASE}/api/archives`));
    expect(all.status).toBe(200);
    const allBody = (await all.json()) as {
      entries: Array<{ taskId: string; houseName: string }>;
      total: number;
      limit: number;
      offset: number;
    };
    expect(allBody.total).toBe(SESSION_COUNT);
    expect(allBody.entries).toHaveLength(25);
    expect(allBody.limit).toBe(25);
    expect(allBody.offset).toBe(0);

    const text = await getArchives(req(`${BASE}/api/archives?q=Archived%20Quest%2042`));
    const textBody = (await text.json()) as { entries: Array<{ taskId: string }>; total: number };
    expect(textBody.total).toBe(1);
    expect(textBody.entries[0].taskId).toBe("at-42");

    const byHouse = await getArchives(req(`${BASE}/api/archives?houseId=arch-house&limit=100`));
    const houseBody = (await byHouse.json()) as { entries: Array<{ houseName: string }>; total: number };
    expect(houseBody.total).toBe(SESSION_COUNT);
    expect(houseBody.entries.every((e) => e.houseName === "Archive House")).toBe(true);

    const page2 = await getArchives(req(`${BASE}/api/archives?limit=25&offset=25`));
    const page2Body = (await page2.json()) as { entries: Array<{ taskId: string }>; total: number };
    expect(page2Body.total).toBe(SESSION_COUNT);
    expect(page2Body.entries).toHaveLength(25);
    expect(page2Body.entries.some((e) => e.taskId === allBody.entries[0].taskId)).toBe(false);
  });

  it("returns an empty result shape (entries [] + total 0)", async () => {
    seedArchives();
    const res = await getArchives(req(`${BASE}/api/archives?q=absolutely-no-match`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: unknown[]; total: number };
    expect(body.entries).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("rejects an invalid status/limit with 400", async () => {
    const badStatus = await getArchives(req(`${BASE}/api/archives?status=running`));
    expect(badStatus.status).toBe(400);

    const badLimit = await getArchives(req(`${BASE}/api/archives?limit=0`));
    expect(badLimit.status).toBe(400);

    const overCap = await getArchives(req(`${BASE}/api/archives?limit=101`));
    expect(overCap.status).toBe(400);
  });

  it("treats LIKE wildcards literally (a '%' query matches nothing)", async () => {
    seedArchives();
    const res = await getArchives(req(`${BASE}/api/archives?q=%25`));
    const body = (await res.json()) as { total: number };
    expect(body.total).toBe(0);
  });
});
