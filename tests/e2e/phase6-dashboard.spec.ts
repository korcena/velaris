/**
 * E2E — Phase 6 Stages E/F root-dashboard panels (engine OFF).
 *
 * The webServer boots web-only (no engine); rows are seeded directly via
 * better-sqlite3, matching the archive/audit e2e conventions (workers:1, shared
 * e2e DB wiped by the Playwright webServer command, viewport 1280×720).
 *
 * The e2e DB is SHARED across spec files and several earlier specs leave houses,
 * tasks and usage rows behind. Assertions are therefore DELTA-based: read the
 * baseline from the REST API, seed, then assert the panel shows baseline +
 * seeded. This keeps the spec deterministic under any ordering.
 *
 * Asserts:
 *  - the Usage & Cost panel renders totals, the estimated-vs-reported split and
 *    an estimated badge for a seeded Ollama row;
 *  - the Engine Monitor panel renders queue depth / error / failure rates from
 *    seeded rows + a fresh heartbeat;
 *  - both panels remain visible under emulated reduced motion.
 *
 * Cleanup deletes every seeded row so later specs see a clean DB.
 */

import { test, expect, type APIRequestContext, type Locator } from "@playwright/test";
import path from "node:path";
import Database from "better-sqlite3";

const E2E_DB = path.join(process.cwd(), "db", "velaris-e2e.db");

const SEED_REPORTED = 1.5 + 0.013; // 1.513
const SEED_ESTIMATED = 0.25;
const SEED_QUEUED = 3;
const SEED_RUNNING = 1;
const SEED_ERRORS = 1;
const SEED_FAILURES = 2;

/** Parse a rendered "$x.yyyy" value for tolerance-based comparison. */
async function usdValue(locator: Locator): Promise<number> {
  const text = await locator.innerText();
  return parseFloat(text.replace(/[^0-9.-]/g, ""));
}

function openDb() {
  const db = new Database(E2E_DB);
  db.pragma("busy_timeout = 5000");
  return db;
}

interface Baseline {
  totalCost: number;
  reportedCost: number;
  estimatedCost: number;
  sessions: number;
  queueDepth: number;
  runningCount: number;
  errorsLast24h: number;
  failuresLast24h: number;
}

async function readBaseline(request: APIRequestContext): Promise<Baseline> {
  const usage = (await (await request.get("/api/usage")).json()) as {
    totals: {
      totalCost: number;
      reportedCost: number;
      estimatedCost: number;
      sessions: number;
    };
  };
  const monitoring = (await (await request.get("/api/monitoring")).json()) as {
    queueDepth: number;
    runningCount: number;
    errorsLast24h: number;
    failuresLast24h: number;
  };
  return {
    totalCost: usage.totals.totalCost,
    reportedCost: usage.totals.reportedCost,
    estimatedCost: usage.totals.estimatedCost,
    sessions: usage.totals.sessions,
    queueDepth: monitoring.queueDepth,
    runningCount: monitoring.runningCount,
    errorsLast24h: monitoring.errorsLast24h,
    failuresLast24h: monitoring.failuresLast24h,
  };
}

/**
 * Seed a house + usage rows (reported + estimated) + queued/running tasks +
 * 24h error/failure events + a fresh heartbeat. Uses the real web API to ensure
 * migrations/seed have run before raw inserts.
 */
async function seedDashboard(request: APIRequestContext): Promise<{ houseId: string }> {
  await request.get("/api/health");
  const db = openDb();
  const stamp = Date.now();
  const houseId = `e2e-dash-house-${stamp}`;
  const now = new Date().toISOString();

  db.prepare(
    "INSERT INTO houses (id,name,description,kind,status,created_at,updated_at) VALUES (?,?,'','agent','active',?,?)",
  ).run(houseId, "E2E Dashboard House", now, now);

  const insertTask = db.prepare(
    `INSERT INTO tasks (id,title,description,type,status,house_id,created_at,updated_at) VALUES (?,?,'','general',?,?,?,?)`,
  );
  const insertSession = db.prepare(
    `INSERT INTO execution_sessions (id,task_id,house_id,status,provider,model_id,cost_total,input_tokens,output_tokens,created_at,updated_at)
     VALUES (?,?,?,'completed',?,?,?,?,?,?,?)`,
  );
  const insertUsage = db.prepare(
    `INSERT INTO usage_records (id,session_id,task_id,house_id,model_id,provider,input_tokens,output_tokens,cost,estimated,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );

  const addUsage = (
    provider: string,
    modelId: string,
    cost: number,
    estimated: boolean,
    input: number,
    output: number,
    i: number,
  ) => {
    const taskId = `e2e-dash-t-${stamp}-${i}`;
    const sessionId = `e2e-dash-s-${stamp}-${i}`;
    insertTask.run(taskId, `Dashboard Quest ${i}`, "completed", houseId, now, now);
    insertSession.run(sessionId, taskId, houseId, provider, modelId, cost, input, output, now, now);
    insertUsage.run(
      `e2e-dash-u-${stamp}-${i}`,
      sessionId,
      taskId,
      houseId,
      modelId,
      provider,
      input,
      output,
      cost,
      estimated ? 1 : 0,
      now,
    );
  };

  addUsage("opencode", "glm-5.3", 1.5, false, 1000, 500, 1);
  addUsage("opencode", "glm-5.3", 0.013, false, 100, 50, 2);
  addUsage("ollama", "llama3.1:8b", 0.25, true, 800, 400, 3);

  // Queue depth + running count.
  for (let i = 1; i <= SEED_QUEUED; i++) {
    insertTask.run(`e2e-dash-q-${stamp}-${i}`, `Queued ${i}`, "queued", houseId, now, now);
  }
  insertTask.run(`e2e-dash-r-${stamp}-1`, "Running 1", "running", houseId, now, now);

  // 24h error + failure events (valid CHECK-constrained types).
  const insertEvent = db.prepare(
    `INSERT INTO execution_events (session_id,task_id,house_id,raw_type,type,payload,created_at) VALUES (?,?,?,?,?, '{}', ?)`,
  );
  const sessionForEvents = `e2e-dash-s-${stamp}-1`;
  insertEvent.run(sessionForEvents, null, houseId, "error", "error", now);
  insertEvent.run(sessionForEvents, null, houseId, "task_failed", "task_failed", now);
  insertEvent.run(sessionForEvents, null, houseId, "task_failed", "task_failed", now);

  // Fresh heartbeat ⇒ monitor shows live metrics (not offline).
  db.prepare(
    "INSERT INTO engine_state (key,value,updated_at) VALUES ('engine_heartbeat_at',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
  ).run(now, now);
  db.prepare(
    "INSERT INTO engine_state (key,value,updated_at) VALUES ('engine_version','e2e-test',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
  ).run(now);

  db.close();
  return { houseId };
}

function cleanup(houseId: string): void {
  const db = openDb();
  db.prepare("DELETE FROM execution_events WHERE house_id = ?").run(houseId);
  db.prepare("DELETE FROM execution_sessions WHERE house_id = ?").run(houseId);
  db.prepare("DELETE FROM usage_records WHERE house_id = ?").run(houseId);
  db.prepare("DELETE FROM tasks WHERE house_id = ?").run(houseId);
  db.prepare("DELETE FROM houses WHERE id = ?").run(houseId);
  db.close();
}

test.describe("Phase 6 E/F — dashboard usage + monitoring panels", () => {
  test("renders usage totals with the estimated split and live monitor metrics", async ({
    page,
    request,
  }) => {
    const base = await readBaseline(request);
    const { houseId } = await seedDashboard(request);

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Velaris", exact: true })).toBeVisible();

    // --- Usage & Cost panel (delta vs the shared-DB baseline) ---
    const usage = page.getByTestId("usage-panel");
    await expect(usage).toBeVisible();
    // Display values are 4-dp rounded; compare with a tolerance to absorb
    // float rounding on the shared-DB baseline.
    expect(await usdValue(page.getByTestId("usage-total-cost"))).toBeCloseTo(
      base.totalCost + SEED_REPORTED + SEED_ESTIMATED,
      2,
    );
    expect(await usdValue(page.getByTestId("usage-reported-cost"))).toBeCloseTo(
      base.reportedCost + SEED_REPORTED,
      2,
    );
    expect(await usdValue(page.getByTestId("usage-estimated-cost"))).toBeCloseTo(
      base.estimatedCost + SEED_ESTIMATED,
      2,
    );
    await expect(page.getByTestId("usage-sessions")).toHaveText(String(base.sessions + 3));
    await expect(page.getByTestId("usage-split-bar")).toBeVisible();
    await expect(page.getByTestId("usage-sparkline")).toBeVisible();

    // Per-model breakdown lists both provider-reported and estimated models.
    const byModel = page.getByTestId("usage-by-model");
    await expect(byModel).toBeVisible();
    await expect(byModel.getByText("glm-5.3")).toBeVisible();
    await expect(byModel.getByText("llama3.1:8b")).toBeVisible();
    await expect(page.getByTestId("usage-estimated-badge").first()).toBeVisible();

    // --- Engine Monitor panel (delta) ---
    const monitor = page.getByTestId("monitoring-panel");
    await expect(monitor).toBeVisible();
    await expect(page.getByTestId("monitoring-engine-health")).toHaveText(/engine online/);
    await expect(page.getByTestId("monitoring-queue-depth")).toHaveText(
      String(base.queueDepth + SEED_QUEUED),
    );
    await expect(page.getByTestId("monitoring-running")).toHaveText(
      String(base.runningCount + SEED_RUNNING),
    );
    await expect(page.getByTestId("monitoring-errors-24h")).toHaveText(
      String(base.errorsLast24h + SEED_ERRORS),
    );
    await expect(page.getByTestId("monitoring-failures-24h")).toHaveText(
      String(base.failuresLast24h + SEED_FAILURES),
    );

    cleanup(houseId);
  });

  test("panels remain visible under reduced motion (transform/opacity safe)", async ({
    page,
    request,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const { houseId } = await seedDashboard(request);

    await page.goto("/");
    const usage = page.getByTestId("usage-panel");
    const monitor = page.getByTestId("monitoring-panel");
    await expect(usage).toBeVisible();
    await expect(monitor).toBeVisible();

    // The global @media (prefers-reduced-motion: reduce) rule clamps transition
    // durations; assert the split bar's transition is effectively instant.
    const duration = await page.getByTestId("usage-split-bar").evaluate((el) => {
      const inner = el.firstElementChild as HTMLElement | null;
      return inner ? parseFloat(getComputedStyle(inner).transitionDuration) : -1;
    });
    expect(duration).toBeGreaterThanOrEqual(0);
    expect(duration).toBeLessThan(0.1);

    cleanup(houseId);
  });
});
