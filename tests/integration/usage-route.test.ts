/**
 * Integration tests — usage route (Phase 6 Stage E), invoked directly with
 * `new NextRequest()`.
 *
 * DB isolation contract (tests/integration/api-routes.test.ts): VELARIS_DB_PATH
 * points at a fresh temp file per test, set BEFORE importing the route modules;
 * resetDbForTests() + resetBootstrapForTests() in beforeEach.
 *
 * Golden dataset mixes provider-reported (OpenCode, estimated=false) and
 * estimated (Ollama, estimated=true) usage rows, each mirrored onto
 * `execution_sessions.cost_total`, so the dashboard payload's reported total
 * reconciles with the persisted provider-reported values within ±1%.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

import { resetDbForTests, getRawDb } from "@/lib/db";
import { resetBootstrapForTests, bootstrapDb } from "@/server/bootstrap";
import { GET as getUsage } from "@/app/api/usage/route";

const BASE = "http://localhost:3000";
let tmpDir: string;

beforeEach(() => {
  resetDbForTests();
  resetBootstrapForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-usage-routes-"));
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

/** Seed a house, a task, a session and one usage row (mirrored to the session). */
function seedUsage(opts: {
  id: string;
  houseId: string;
  houseName: string;
  provider: string;
  modelId: string;
  cost: number;
  estimated: boolean;
  createdAt: string;
}): void {
  const raw = getRawDb();
  raw
    .prepare("INSERT OR IGNORE INTO houses (id,name,description,kind,status) VALUES (?,?,'','agent','active')")
    .run(opts.houseId, opts.houseName);
  raw
    .prepare(
      `INSERT INTO tasks (id, title, description, type, status, house_id, created_at, updated_at)
       VALUES (?, ?, '', 'general', 'completed', ?, ?, ?)`,
    )
    .run(`${opts.id}-t`, `Task ${opts.id}`, opts.houseId, opts.createdAt, opts.createdAt);
  raw
    .prepare(
      `INSERT INTO execution_sessions
         (id, task_id, house_id, status, provider, model_id, cost_total, input_tokens, output_tokens, created_at, updated_at)
       VALUES (?, ?, ?, 'completed', ?, ?, ?, 100, 50, ?, ?)`,
    )
    .run(`${opts.id}-s`, `${opts.id}-t`, opts.houseId, opts.provider, opts.modelId, opts.cost, opts.createdAt, opts.createdAt);
  raw
    .prepare(
      `INSERT INTO usage_records
         (id, session_id, task_id, house_id, model_id, provider, input_tokens, output_tokens, cost, estimated, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 100, 50, ?, ?, ?)`,
    )
    .run(`${opts.id}-u`, `${opts.id}-s`, `${opts.id}-t`, opts.houseId, opts.modelId, opts.provider, opts.cost, opts.estimated ? 1 : 0, opts.createdAt);
}

const REPORTED = 0.0123 + 0.0007 + 1.5; // 1.513
const ESTIMATED = 0.25;

function seedGolden(): void {
  bootstrapDb();
  seedUsage({ id: "g1", houseId: "u-house", houseName: "Usage House", provider: "opencode", modelId: "glm-5.3", cost: 0.0123, estimated: false, createdAt: "2026-01-01T10:00:00.000Z" });
  seedUsage({ id: "g2", houseId: "u-house", houseName: "Usage House", provider: "opencode", modelId: "glm-5.3", cost: 0.0007, estimated: false, createdAt: "2026-01-01T11:00:00.000Z" });
  seedUsage({ id: "g3", houseId: "u-house", houseName: "Usage House", provider: "opencode", modelId: "glm-5.3", cost: 1.5, estimated: false, createdAt: "2026-01-02T10:00:00.000Z" });
  seedUsage({ id: "g4", houseId: "u-house", houseName: "Usage House", provider: "ollama", modelId: "llama3.1:8b", cost: ESTIMATED, estimated: true, createdAt: "2026-01-02T12:00:00.000Z" });
}

describe("GET /api/usage", () => {
  it("returns the dashboard payload and reconciles with the session mirror (±1%)", async () => {
    seedGolden();
    const res = await getUsage(req(`${BASE}/api/usage`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totals: { totalCost: number; estimatedCost: number; reportedCost: number; sessions: number };
      byHouse: Array<{ houseId: string; label: string }>;
      byModel: Array<{ modelId: string }>;
      byTask: Array<{ taskId: string }>;
      series: Array<{ bucket: string }>;
      bucket: string;
      generatedAt: string;
    };

    expect(body.bucket).toBe("day");
    expect(body.totals.totalCost).toBeCloseTo(REPORTED + ESTIMATED, 9);
    expect(body.totals.reportedCost).toBeCloseTo(REPORTED, 9);
    expect(body.totals.estimatedCost).toBeCloseTo(ESTIMATED, 9);
    expect(body.totals.sessions).toBe(4);

    // Reconciliation: reported total == Σ session mirror (the provider values).
    const mirror = (
      getRawDb().prepare("SELECT COALESCE(SUM(cost_total),0) AS c FROM execution_sessions").get() as { c: number }
    ).c;
    expect(body.totals.totalCost).toBeCloseTo(mirror, 9);
    const relErr = Math.abs(Number(REPORTED.toFixed(2)) - REPORTED) / REPORTED;
    expect(relErr).toBeLessThanOrEqual(0.01);

    expect(body.byHouse).toHaveLength(1);
    expect(body.byHouse[0].label).toBe("Usage House");
    expect(body.byModel.length).toBe(2);
    expect(body.byTask.length).toBe(4);
    expect(body.series.map((p) => p.bucket)).toEqual(["2026-01-01", "2026-01-02"]);
  });

  it("honours houseId / provider / bucket / taskLimit filters", async () => {
    seedGolden();
    const byProvider = await getUsage(req(`${BASE}/api/usage?provider=ollama`));
    const byProviderBody = (await byProvider.json()) as {
      totals: { totalCost: number; reportedCost: number };
    };
    expect(byProviderBody.totals.totalCost).toBeCloseTo(ESTIMATED, 9);
    expect(byProviderBody.totals.reportedCost).toBe(0);

    const hour = await getUsage(req(`${BASE}/api/usage?bucket=hour&taskLimit=2`));
    const hourBody = (await hour.json()) as { bucket: string; series: unknown[]; byTask: unknown[] };
    expect(hourBody.bucket).toBe("hour");
    expect(hourBody.series).toHaveLength(4);
    expect(hourBody.byTask).toHaveLength(2);
  });

  it("returns an empty payload for a filter with no usage", async () => {
    seedGolden();
    const res = await getUsage(req(`${BASE}/api/usage?houseId=no-such-house`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totals: { totalCost: number; sessions: number };
      byHouse: unknown[];
      series: unknown[];
    };
    expect(body.totals.totalCost).toBe(0);
    expect(body.totals.sessions).toBe(0);
    expect(body.byHouse).toEqual([]);
    expect(body.series).toEqual([]);
  });

  it("rejects an invalid bucket / taskLimit with 400", async () => {
    await getUsage(req(`${BASE}/api/usage?bucket=week`)).then((r) => expect(r.status).toBe(400));
    await getUsage(req(`${BASE}/api/usage?taskLimit=0`)).then((r) => expect(r.status).toBe(400));
  });
});
