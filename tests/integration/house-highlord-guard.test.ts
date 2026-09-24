/**
 * Integration tests — High Lord household guard (addendum D1/D6).
 *
 * The web bootstrap seeds the singleton High Lord house (kind='high_lord').
 * Its status transition and deletion must be rejected with a 422 via the API:
 *  - PATCH status → disabled / archived → 422
 *  - DELETE → 422
 *  - PATCH config fields (model edit) → 200 (editability preserved)
 *
 * DB isolation follows api-routes.test.ts: VELARIS_DB_PATH before importing the
 * route modules; resetDbForTests() + resetBootstrapForTests() per test.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

import { resetDbForTests, getRawDb } from "@/lib/db";
import { resetBootstrapForTests } from "@/server/bootstrap";
import {
  GET as getHouseById,
  PATCH as patchHouse,
  DELETE as deleteHouseRoute,
} from "@/app/api/houses/[id]/route";

const BASE = "http://localhost:3000";
let tmpDir: string;

beforeEach(() => {
  resetDbForTests();
  resetBootstrapForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-hlguard-"));
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
  return new NextRequest(url, { method: init?.method, body: init?.body, headers });
}

function jsonReq(method: string, url: string, body: unknown): NextRequest {
  return req(url, { method, body: JSON.stringify(body) });
}

function idCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}

/**
 * Trigger the web boot (migrate + seed) by hitting a route once, then return
 * the seeded High Lord house row. The seed is idempotent.
 */
async function ensureSeededHighLord(): Promise<{ id: string }> {
  // A GET on a missing id still bootstraps (migrations + HL seed) before the 404.
  await getHouseById(req(`${BASE}/api/houses/00000000-0000-0000-0000-000000000000`), {
    params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }),
  });
  const row = getRawDb()
    .prepare(`SELECT id FROM houses WHERE kind = 'high_lord' LIMIT 1`)
    .get() as { id: string } | undefined;
  if (!row) throw new Error("High Lord was not seeded by bootstrap");
  return row;
}

describe("High Lord guard (422)", () => {
  it("GET /api/houses/{hlId} works (getHouse returns the HL by id, not via the list)", async () => {
    const { id } = await ensureSeededHighLord();
    const res = await getHouseById(req(`${BASE}/api/houses/${id}`), idCtx(id));
    expect(res.status).toBe(200);
    const { house } = await res.json();
    expect(house.kind).toBe("high_lord");
  });

  it("PATCH status → disabled → 422 (High Lord not disableable)", async () => {
    const { id } = await ensureSeededHighLord();
    const res = await patchHouse(
      jsonReq("PATCH", `${BASE}/api/houses/${id}`, { status: "disabled" }),
      idCtx(id),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/High Lord/);
  });

  it("PATCH status → archived → 422 (High Lord not archivable)", async () => {
    const { id } = await ensureSeededHighLord();
    const res = await patchHouse(
      jsonReq("PATCH", `${BASE}/api/houses/${id}`, { status: "archived" }),
      idCtx(id),
    );
    expect(res.status).toBe(422);
  });

  it("DELETE → 422 (High Lord not deletable)", async () => {
    const { id } = await ensureSeededHighLord();
    const res = await deleteHouseRoute(req(`${BASE}/api/houses/${id}`, { method: "DELETE" }), idCtx(id));
    expect(res.status).toBe(422);
  });

  it("PATCH config fields (model edit) → 200 (editability preserved)", async () => {
    const { id } = await ensureSeededHighLord();
    const res = await patchHouse(
      jsonReq("PATCH", `${BASE}/api/houses/${id}`, { configuration: { modelId: "glm-5.3-plus" } }),
      idCtx(id),
    );
    expect(res.status).toBe(200);
    const { house } = await res.json();
    expect(house.configuration.modelId).toBe("glm-5.3-plus");
    expect(house.kind).toBe("high_lord");
    expect(house.status).toBe("active");
  });
});
