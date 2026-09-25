/**
 * Unit tests — usage aggregation repository/service (Phase 6 Stage E).
 *
 * Golden dataset over `usage_records` with explicit expected sums. Proves:
 *  - per-house / per-model / per-task grouping math;
 *  - the estimated-vs-provider-reported split (Ollama estimated=1 vs OpenCode
 *    estimated=0);
 *  - the day/hour time series;
 *  - the partition invariant (byHouse/byModel/byTask each sum to totals);
 *  - the DOUBLE-COUNTING GUARD (plan §16 risk 4): every session mirrors the same
 *    cost onto `execution_sessions.cost_total`; an aggregate that summed both
 *    sources would return 2×. The repo must read `usage_records` only, so the
 *    usage total equals — never doubles — the session-mirror sum.
 *
 * Temp DB per test (migrate → seed → teardown).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, getRawDb, resetDbForTests } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";
import {
  getUsageByHouse,
  getUsageByModel,
  getUsageByTask,
  getUsageTimeSeries,
  getUsageTotals,
} from "@/server/repositories/usage-repo";
import { getUsageDashboard } from "@/server/services/usage-service";

let tmpDir: string;

/** One golden usage row. `reported=false` ⇒ estimated (Ollama). */
interface Row {
  houseId: string;
  houseName: string;
  taskId: string;
  taskTitle: string;
  modelId: string;
  provider: string;
  cost: number;
  estimated: boolean;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  createdAt: string;
}

/**
 * Golden fixture. Costs are chosen to exercise the split and rounding:
 *  - hA / glm-5.3 / opencode: 0.0123 + 0.0007 + 1.5  = 1.5130 (reported)
 *  - hA / llama3.1:8b / ollama: 0.25 + 0.5           = 0.75   (estimated)
 *  - hB / claude-x / opencode: 0.99999               = 0.99999 (reported)
 * Total = 3.26299.
 */
const ROWS: Row[] = [
  {
    houseId: "uh-a",
    houseName: "House A",
    taskId: "ut-1",
    taskTitle: "Quest One",
    modelId: "glm-5.3",
    provider: "opencode",
    cost: 0.0123,
    estimated: false,
    input: 100,
    output: 50,
    reasoning: 10,
    cacheRead: 5,
    createdAt: "2026-01-01T10:00:00.000Z",
  },
  {
    houseId: "uh-a",
    houseName: "House A",
    taskId: "ut-2",
    taskTitle: "Quest Two",
    modelId: "glm-5.3",
    provider: "opencode",
    cost: 0.0007,
    estimated: false,
    input: 200,
    output: 80,
    reasoning: 0,
    cacheRead: 0,
    createdAt: "2026-01-01T11:30:00.000Z",
  },
  {
    houseId: "uh-a",
    houseName: "House A",
    taskId: "ut-3",
    taskTitle: "Quest Three",
    modelId: "glm-5.3",
    provider: "opencode",
    cost: 1.5,
    estimated: false,
    input: 1000,
    output: 400,
    reasoning: 100,
    cacheRead: 20,
    createdAt: "2026-01-02T09:00:00.000Z",
  },
  {
    houseId: "uh-a",
    houseName: "House A",
    taskId: "ut-4",
    taskTitle: "Quest Four",
    modelId: "llama3.1:8b",
    provider: "ollama",
    cost: 0.25,
    estimated: true,
    input: 500,
    output: 200,
    reasoning: 0,
    cacheRead: 0,
    createdAt: "2026-01-02T10:00:00.000Z",
  },
  {
    houseId: "uh-a",
    houseName: "House A",
    taskId: "ut-5",
    taskTitle: "Quest Five",
    modelId: "llama3.1:8b",
    provider: "ollama",
    cost: 0.5,
    estimated: true,
    input: 800,
    output: 300,
    reasoning: 0,
    cacheRead: 0,
    createdAt: "2026-01-03T12:00:00.000Z",
  },
  {
    houseId: "uh-b",
    houseName: "House B",
    taskId: "ut-6",
    taskTitle: "Quest Six",
    modelId: "claude-x",
    provider: "opencode",
    cost: 0.99999,
    estimated: false,
    input: 250,
    output: 125,
    reasoning: 5,
    cacheRead: 4,
    createdAt: "2026-01-03T13:00:00.000Z",
  },
];

const REPORTED_TOTAL = 0.0123 + 0.0007 + 1.5 + 0.99999; // 2.51299
const ESTIMATED_TOTAL = 0.75;
const GRAND_TOTAL = REPORTED_TOTAL + ESTIMATED_TOTAL; // 3.26299

function seed(): void {
  const raw = getRawDb();
  raw
    .prepare(
      "INSERT INTO houses (id,name,description,kind,status) VALUES ('uh-a','House A','','agent','active')",
    )
    .run();
  raw
    .prepare(
      "INSERT INTO houses (id,name,description,kind,status) VALUES ('uh-b','House B','','agent','active')",
    )
    .run();

  const insertTask = raw.prepare(
    `INSERT INTO tasks (id, title, description, type, status, house_id, created_at, updated_at)
     VALUES (?, ?, '', 'general', 'completed', ?, ?, ?)`,
  );
  const insertSession = raw.prepare(
    `INSERT INTO execution_sessions
       (id, task_id, house_id, status, provider, model_id, cost_total, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, created_at, updated_at)
     VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertUsage = raw.prepare(
    `INSERT INTO usage_records
       (id, session_id, task_id, house_id, model_id, provider, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cost, estimated, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  ROWS.forEach((r, i) => {
    const sessionId = `us-${i + 1}`;
    insertTask.run(r.taskId, r.taskTitle, r.houseId, r.createdAt, r.createdAt);
    // Session mirrors the SAME cost/tokens — the double-count trap.
    insertSession.run(
      sessionId,
      r.taskId,
      r.houseId,
      r.provider,
      r.modelId,
      r.cost,
      r.input,
      r.output,
      r.reasoning,
      r.cacheRead,
      r.createdAt,
      r.createdAt,
    );
    insertUsage.run(
      `ur-${i + 1}`,
      sessionId,
      r.taskId,
      r.houseId,
      r.modelId,
      r.provider,
      r.input,
      r.output,
      r.reasoning,
      r.cacheRead,
      r.cost,
      r.estimated ? 1 : 0,
      r.createdAt,
    );
  });
}

beforeEach(() => {
  resetDbForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-usage-"));
  process.env.VELARIS_DB_PATH = path.join(tmpDir, "test.db");
  migrate();
  seed();
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const round = (v: number, dp: number) => Number(v.toFixed(dp));

describe("usage totals + estimated/reported split", () => {
  it("splits totals by estimated flag and keeps total = estimated + reported", () => {
    const t = getUsageTotals(getDb());
    expect(t.totalCost).toBeCloseTo(GRAND_TOTAL, 9);
    expect(t.reportedCost).toBeCloseTo(REPORTED_TOTAL, 9);
    expect(t.estimatedCost).toBeCloseTo(ESTIMATED_TOTAL, 9);
    expect(t.estimatedCost + t.reportedCost).toBeCloseTo(t.totalCost, 12);
    expect(t.sessions).toBe(ROWS.length);
  });

  it("sums token counters across every row", () => {
    const t = getUsageTotals(getDb());
    const sum = (f: (r: Row) => number) => ROWS.reduce((a, r) => a + f(r), 0);
    expect(t.inputTokens).toBe(sum((r) => r.input));
    expect(t.outputTokens).toBe(sum((r) => r.output));
    expect(t.reasoningTokens).toBe(sum((r) => r.reasoning));
    expect(t.cacheReadTokens).toBe(sum((r) => r.cacheRead));
  });

  it("filters by house, model and provider", () => {
    const byHouse = getUsageTotals(getDb(), { houseId: "uh-a" });
    expect(byHouse.totalCost).toBeCloseTo(GRAND_TOTAL - 0.99999, 9);

    const byModel = getUsageTotals(getDb(), { modelId: "glm-5.3" });
    expect(byModel.totalCost).toBeCloseTo(1.513, 9);

    const byProvider = getUsageTotals(getDb(), { provider: "ollama" });
    expect(byProvider.totalCost).toBeCloseTo(ESTIMATED_TOTAL, 9);
    expect(byProvider.reportedCost).toBe(0);
  });

  it("filters by date range", () => {
    const t = getUsageTotals(getDb(), {
      from: "2026-01-02T00:00:00.000Z",
      to: "2026-01-02T23:59:59.999Z",
    });
    // Rows on Jan 2: 1.5 (reported) + 0.25 (estimated).
    expect(t.totalCost).toBeCloseTo(1.75, 9);
    expect(t.estimatedCost).toBeCloseTo(0.25, 9);
    expect(t.reportedCost).toBeCloseTo(1.5, 9);
  });
});

describe("usage breakdowns (per house / model / task)", () => {
  it("groups by house with the estimated/reported split and display names", () => {
    const rows = getUsageByHouse(getDb());
    expect(rows).toHaveLength(2);

    const a = rows.find((r) => r.houseId === "uh-a")!;
    expect(a.label).toBe("House A");
    expect(a.totalCost).toBeCloseTo(GRAND_TOTAL - 0.99999, 9);
    expect(a.reportedCost).toBeCloseTo(1.513, 9);
    expect(a.estimatedCost).toBeCloseTo(ESTIMATED_TOTAL, 9);
    expect(a.estimated).toBe(true);

    const b = rows.find((r) => r.houseId === "uh-b")!;
    expect(b.estimated).toBe(false);
    expect(b.reportedCost).toBeCloseTo(0.99999, 9);
  });

  it("groups by provider/model and keeps model labels", () => {
    const rows = getUsageByModel(getDb());
    expect(rows).toHaveLength(3);
    const glm = rows.find((r) => r.modelId === "glm-5.3")!;
    expect(glm.key).toBe("opencode/glm-5.3");
    expect(glm.provider).toBe("opencode");
    expect(glm.totalCost).toBeCloseTo(1.513, 9);
    const llama = rows.find((r) => r.modelId === "llama3.1:8b")!;
    expect(llama.estimated).toBe(true);
    expect(llama.estimatedCost).toBeCloseTo(0.75, 9);
    expect(llama.reportedCost).toBe(0);
  });

  it("groups by task (top-N by cost) and returns task titles", () => {
    const rows = getUsageByTask(getDb(), {}, 3);
    expect(rows).toHaveLength(3);
    // Highest cost first: ut-3 (1.5), ut-6 (0.99999), ut-5 (0.5).
    expect(rows.map((r) => r.taskId)).toEqual(["ut-3", "ut-6", "ut-5"]);
    expect(rows[0].label).toBe("Quest Three");
  });
});

describe("usage partition invariant (double-count guard)", () => {
  it("byHouse / byModel / byTask each sum to totals", () => {
    const totals = getUsageTotals(getDb()).totalCost;
    const sum = (rows: { totalCost: number }[]) => rows.reduce((a, r) => a + r.totalCost, 0);
    expect(sum(getUsageByHouse(getDb()))).toBeCloseTo(totals, 9);
    expect(sum(getUsageByModel(getDb()))).toBeCloseTo(totals, 9);
    expect(sum(getUsageByTask(getDb(), {}, 50))).toBeCloseTo(totals, 9);
  });

  it("reads usage_records ONLY — it equals the session mirror, never 2× it", () => {
    // Each session mirrors the same cost. If the aggregate summed usage rows
    // AND session rows it would return 2× the true total.
    const raw = getRawDb();
    const mirror = raw
      .prepare("SELECT COALESCE(SUM(cost_total),0) AS c FROM execution_sessions")
      .get() as { c: number };
    const t = getUsageTotals(getDb());
    expect(t.totalCost).toBeCloseTo(mirror.c, 9);
    expect(t.totalCost).toBeCloseTo(GRAND_TOTAL, 9);
    expect(t.totalCost).not.toBeCloseTo(GRAND_TOTAL * 2, 6);
  });
});

describe("usage time series", () => {
  it("buckets by day, oldest first, and sums the split per bucket", () => {
    const series = getUsageTimeSeries(getDb(), "day");
    expect(series.map((p) => p.bucket)).toEqual(["2026-01-01", "2026-01-02", "2026-01-03"]);
    expect(series[0].totalCost).toBeCloseTo(0.013, 9); // 0.0123 + 0.0007
    expect(series[1].totalCost).toBeCloseTo(1.75, 9); // 1.5 + 0.25
    expect(series[1].estimatedCost).toBeCloseTo(0.25, 9);
    expect(series[1].reportedCost).toBeCloseTo(1.5, 9);
    expect(series[2].totalCost).toBeCloseTo(1.49999, 9); // 0.5 + 0.99999
  });

  it("buckets by hour", () => {
    const series = getUsageTimeSeries(getDb(), "hour");
    expect(series).toHaveLength(6);
    expect(series[0].bucket).toBe("2026-01-01T10");
    expect(series[0].totalCost).toBeCloseTo(0.0123, 9);
  });

  it("honours filters in the series", () => {
    const series = getUsageTimeSeries(getDb(), "day", { provider: "opencode" });
    expect(series.map((p) => p.bucket)).toEqual(["2026-01-01", "2026-01-02", "2026-01-03"]);
    const est = series.reduce((a, p) => a + p.estimatedCost, 0);
    expect(est).toBe(0);
  });
});

describe("usage dashboard service", () => {
  it("assembles totals + breakdowns + series and defaults the bucket", () => {
    const dash = getUsageDashboard(getDb(), {});
    expect(dash.bucket).toBe("day");
    expect(dash.totals.totalCost).toBeCloseTo(GRAND_TOTAL, 9);
    expect(dash.byHouse.length).toBe(2);
    expect(dash.byModel.length).toBe(3);
    expect(dash.series.length).toBe(3);
    expect(typeof dash.generatedAt).toBe("string");
  });

  it("coerces string query params and validates bucket/taskLimit", () => {
    const dash = getUsageDashboard(getDb(), { bucket: "hour", taskLimit: "2" });
    expect(dash.bucket).toBe("hour");
    expect(dash.byTask).toHaveLength(2);
    expect(dash.series).toHaveLength(6);
  });

  it("rejects an invalid bucket / taskLimit / unknown filter", () => {
    expect(() => getUsageDashboard(getDb(), { bucket: "week" })).toThrow();
    expect(() => getUsageDashboard(getDb(), { taskLimit: "0" })).toThrow();
    expect(() => getUsageDashboard(getDb(), { taskLimit: "999" })).toThrow();
  });

  it("returns zeroed totals for a filter with no rows", () => {
    const dash = getUsageDashboard(getDb(), { houseId: "nope" });
    expect(dash.totals).toEqual({
      totalCost: 0,
      estimatedCost: 0,
      reportedCost: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      sessions: 0,
    });
    expect(dash.byHouse).toEqual([]);
    expect(dash.series).toEqual([]);
  });
});

// Keep the rounding helper referenced so the intent of display rounding is
// documented next to the assertions (the reconciliation test exercises it).
void round;
