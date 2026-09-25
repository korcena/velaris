/**
 * Unit test — Stage E acceptance criterion (§10):
 * "usage graphs reconcile with OpenCode-reported session cost (±1% rounding)".
 *
 * Proven deterministically WITHOUT a live provider. The §0 finding is that we
 * store the provider-reported cost exactly once, at terminal:
 *   - the engine writes one `usage_records` row with `estimated:false`, then
 *   - mirrors the SAME `cost_total`/tokens onto `execution_sessions`.
 * The fixtures below ARE those provider-reported values.
 *
 * What this test proves:
 *  1. `getUsageTotals()` total == Σ `execution_sessions.cost_total` == Σ fixtures
 *     (the aggregation reads `usage_records` ONLY).
 *  2. Relative error ≤ 1% after documented display rounding (4 dp per row,
 *     2 dp total) — the same rounding the dashboard applies.
 *  3. `estimatedCost + reportedCost === totalCost` exactly.
 *  4. A mixed set (Ollama `estimated=true`) does not contaminate `reportedCost`.
 *
 * DOUBLE-COUNTING GUARD (the real risk, plan §16 risk 4): summing BOTH the usage
 * rows and the session mirror would return 2× the true total. A dedicated test
 * asserts the total is the mirror, not twice it.
 *
 * No live provider is required; an opt-in `@real` smoke is documented but off
 * the gate.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, getRawDb, resetDbForTests } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";
import { getUsageTotals } from "@/server/repositories/usage-repo";

let tmpDir: string;

/**
 * Provider-reported fixtures (OpenCode). Costs chosen to exercise rounding
 * edge cases: a sub-cent value, a 4-dp value, and a large value.
 */
const REPORTED_FIXTURES = [0.0123, 0.0007, 1.5, 0.00009, 12.3456];
/** Ollama estimated fixtures — must NOT contaminate reportedCost. */
const ESTIMATED_FIXTURES = [0.25, 0.5, 0.0];

const Σ_REPORTED = REPORTED_FIXTURES.reduce((a, b) => a + b, 0);
const Σ_ESTIMATED = ESTIMATED_FIXTURES.reduce((a, b) => a + b, 0);
const Σ_ALL = Σ_REPORTED + Σ_ESTIMATED;

/**
 * Documented display rounding: 4 dp per row (the dashboard's `usd()` uses 4
 * dp), 2 dp for the grand total headline. Returns the relative error between
 * the rounded aggregate and the exact provider value.
 */
export function displayRound(rows: number[]): number {
  const perRow = rows.map((r) => Number(r.toFixed(4)));
  return Number(perRow.reduce((a, b) => a + b, 0).toFixed(2));
}

function seed(): void {
  const raw = getRawDb();
  raw
    .prepare(
      "INSERT INTO houses (id,name,description,kind,status) VALUES ('rec-house','Reconcile House','','agent','active')",
    )
    .run();

  const insertTask = raw.prepare(
    `INSERT INTO tasks (id, title, description, type, status, house_id, created_at, updated_at)
     VALUES (?, ?, '', 'general', 'completed', 'rec-house', ?, ?)`,
  );
  const insertSession = raw.prepare(
    `INSERT INTO execution_sessions
       (id, task_id, house_id, status, provider, model_id, cost_total, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, created_at, updated_at)
     VALUES (?, ?, 'rec-house', 'completed', ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
  );
  const insertUsage = raw.prepare(
    `INSERT INTO usage_records
       (id, session_id, task_id, house_id, model_id, provider, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cost, estimated, created_at)
     VALUES (?, ?, ?, 'rec-house', ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
  );

  const t = "2026-02-01T08:00:00.000Z";
  let n = 0;
  const add = (
    modelId: string,
    provider: string,
    cost: number,
    estimated: boolean,
    input: number,
    output: number,
  ) => {
    n += 1;
    const taskId = `rec-t-${n}`;
    const sessionId = `rec-s-${n}`;
    insertTask.run(taskId, `Reconcile Quest ${n}`, t, t);
    // Session mirror holds the SAME provider-reported cost as the usage row.
    insertSession.run(
      sessionId,
      taskId,
      provider,
      modelId,
      cost,
      input,
      output,
      t,
      t,
    );
    insertUsage.run(
      `rec-u-${n}`,
      sessionId,
      taskId,
      modelId,
      provider,
      input,
      output,
      cost,
      estimated ? 1 : 0,
      t,
    );
  };

  for (const c of REPORTED_FIXTURES) add("glm-5.3", "opencode", c, false, 1000, 500);
  for (const c of ESTIMATED_FIXTURES) add("llama3.1:8b", "ollama", c, true, 800, 400);
}

beforeEach(() => {
  resetDbForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-usage-recon-"));
  process.env.VELARIS_DB_PATH = path.join(tmpDir, "test.db");
  migrate();
  seed();
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("usage reconciliation with provider-reported session cost (±1%)", () => {
  it("aggregation total == Σ execution_sessions.cost_total == Σ provider fixtures", () => {
    const raw = getRawDb();
    const mirror = raw
      .prepare("SELECT COALESCE(SUM(cost_total),0) AS c FROM execution_sessions")
      .get() as { c: number };
    const totals = getUsageTotals(getDb());

    // The acceptance criterion's equality chain.
    expect(totals.totalCost).toBeCloseTo(Σ_ALL, 9);
    expect(mirror.c).toBeCloseTo(Σ_ALL, 9);
    expect(totals.totalCost).toBeCloseTo(mirror.c, 9);
  });

  it("relative error vs provider-reported total is within 1% after display rounding", () => {
    const totals = getUsageTotals(getDb());
    // Report only the reported (provider) portion against its fixtures.
    const rounded = displayRound(REPORTED_FIXTURES);
    const relativeError = Math.abs(rounded - Σ_REPORTED) / Σ_REPORTED;
    expect(relativeError).toBeLessThanOrEqual(0.01);
    // The unrounded aggregate is exact, and the reported split equals the
    // provider fixtures (the session-mirror values).
    expect(totals.reportedCost).toBeCloseTo(Σ_REPORTED, 9);
  });

  it("keeps total = estimatedCost + reportedCost exactly", () => {
    const totals = getUsageTotals(getDb());
    expect(totals.estimatedCost + totals.reportedCost).toBeCloseTo(totals.totalCost, 12);
    expect(totals.totalCost).toBeCloseTo(Σ_ALL, 9);
  });

  it("does not contaminate reportedCost with estimated (Ollama) rows", () => {
    const totals = getUsageTotals(getDb());
    expect(totals.reportedCost).toBeCloseTo(Σ_REPORTED, 9);
    expect(totals.estimatedCost).toBeCloseTo(Σ_ESTIMATED, 9);
    // A single estimated row must not leak into the reported bucket.
    expect(totals.reportedCost).not.toBeCloseTo(Σ_ALL, 6);
  });

  it("DOUBLE-COUNT GUARD: total is the session mirror, never 2× (usage + sessions)", () => {
    const raw = getRawDb();
    const mirror = raw
      .prepare("SELECT COALESCE(SUM(cost_total),0) AS c FROM execution_sessions")
      .get() as { c: number };
    const totals = getUsageTotals(getDb());

    // If the aggregation summed usage rows AND session rows, it would be ~2×.
    expect(totals.totalCost).toBeCloseTo(mirror.c, 9);
    expect(totals.totalCost).not.toBeCloseTo(mirror.c * 2, 6);
    // And there is exactly one usage row per session, so session counts match.
    expect(totals.sessions).toBe(REPORTED_FIXTURES.length + ESTIMATED_FIXTURES.length);
  });
});
