/**
 * E2E — Phase 6 Stage D archives (engine OFF).
 *
 * The §10 acceptance criterion: search by task/house/text over ≥100 historical
 * sessions. Rows are seeded directly via better-sqlite3 (the archive is a pure
 * read; no engine, no writer). Asserts:
 *  - the archives page lists the seeded terminal tasks;
 *  - a text query narrows the table to only matching rows;
 *  - the house filter narrows to one house;
 *  - `total` reflects the full ≥100 dataset.
 */

import { test, expect } from "@playwright/test";
import path from "node:path";
import Database from "better-sqlite3";

const E2E_DB = path.join(process.cwd(), "db", "velaris-e2e.db");
const SEED_COUNT = 105;

function openDb() {
  const db = new Database(E2E_DB);
  db.pragma("busy_timeout = 5000");
  return db;
}

/** Seed a dedicated house + 105 terminal tasks with searchable markers. */
function seedArchives(): { houseId: string } {
  const db = openDb();
  const houseId = `e2e-arch-house-${Date.now()}`;
  const otherHouseId = `${houseId}-other`;
  const now = new Date().toISOString();

  const insertHouse = db.prepare(
    "INSERT INTO houses (id,name,description,kind,status,created_at,updated_at) VALUES (?,?,'','agent','active',?,?)",
  );
  insertHouse.run(houseId, "E2E Archive House", now, now);
  insertHouse.run(otherHouseId, "E2E Archive House Two", now, now);

  const insertTask = db.prepare(
    `INSERT INTO tasks (id, title, description, type, status, house_id, created_at, updated_at)
     VALUES (?, ?, ?, 'general', 'completed', ?, ?, ?)`,
  );
  const insertSession = db.prepare(
    `INSERT INTO execution_sessions (id, task_id, house_id, status, provider, model_id, created_at, updated_at)
     VALUES (?, ?, ?, 'completed', 'opencode', 'glm-5.3', ?, ?)`,
  );

  const stamp = Date.now();
  for (let i = 1; i <= SEED_COUNT; i++) {
    const taskId = `e2e-arch-${stamp}-${i}`;
    const sessionId = `e2e-arch-s-${stamp}-${i}`;
    // Only the matching subset mentions the unique text marker.
    const title = i % 10 === 0 ? `Archived Needle ${i}` : `Archived Entry ${i}`;
    insertTask.run(taskId, title, `body ${i}`, i % 2 === 0 ? houseId : otherHouseId, now, now);
    insertSession.run(sessionId, taskId, i % 2 === 0 ? houseId : otherHouseId, now, now);
  }
  db.close();
  return { houseId };
}

test.describe("Phase 6 — archives search", () => {
  test("search by text and house over 105 seeded sessions", async ({ page }) => {
    const { houseId } = seedArchives();

    await page.goto("/archives");
    await expect(page.getByRole("heading", { name: "Archives", exact: true })).toBeVisible();

    const table = page.getByTestId("archives-table");
    await expect(table).toBeVisible();

    // total reflects the full ≥100 dataset (other specs may add more).
    const totalText = await page.getByTestId("archives-total").innerText();
    const total = Number(totalText.match(/\d+/)?.[0] ?? "0");
    expect(total).toBeGreaterThanOrEqual(SEED_COUNT);

    // Text query: only the 10 "Archived Needle <i>" rows match (i % 10 == 0).
    await page.getByTestId("archives-search").fill("Archived Needle");
    await expect(page.getByTestId("archives-total")).toHaveText(/10 archived/);
    await expect(table.getByText(/Archived Needle/).first()).toBeVisible();
    await expect(table.getByText(/Archived Entry/)).toHaveCount(0);

    // Clear text, filter by house: houseId holds the even tasks (52 of 105).
    await page.getByTestId("archives-search").fill("");
    await page.getByTestId("archives-house-filter").click();
    await page.getByRole("option", { name: "E2E Archive House", exact: true }).click();
    await expect(page.getByTestId("archives-total")).toHaveText(/52 archived/);

    // A specific task title is reachable through search.
    await page.getByTestId("archives-search").fill("Archived Needle 50");
    await expect(page.getByTestId("archives-total")).toHaveText(/1 archived/);
    await expect(table.getByText("Archived Needle 50")).toBeVisible();

    // Cleanup: delete the seeded tasks/houses so later specs see a clean DB.
    const db = openDb();
    db.prepare("DELETE FROM execution_sessions WHERE task_id LIKE 'e2e-arch-%'").run();
    db.prepare("DELETE FROM tasks WHERE id LIKE 'e2e-arch-%'").run();
    db.prepare("DELETE FROM houses WHERE id LIKE ?").run(`${houseId}%`);
    db.close();
  });
});
