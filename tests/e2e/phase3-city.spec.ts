/**
 * E2E — Phase 3 City skyline (src/components/city/city-skyline.tsx).
 *
 * The engine is OFF; execution rows are seeded directly into the e2e DB.
 * Covered:
 *  - A founded house appears as a building on the dashboard; clicking it opens
 *    the house detail.
 *  - A seeded running session makes the building render data-state="working".
 *  - Inserting a task_completed execution_events row triggers a
 *    `city-celebration` burst (guarded per taskId), which clears ~3s later.
 *  - With reduced-motion on, a second task_completed renders a
 *    `city-static-celebration` glyph and NOT a `city-celebration`.
 */

import { test, expect } from "@playwright/test";
import path from "node:path";
import Database from "better-sqlite3";
import { createHouseViaForm } from "./helpers";

const E2E_DB = path.join(process.cwd(), "db", "velaris-e2e.db");

function openDb() {
  const db = new Database(E2E_DB);
  db.pragma("busy_timeout = 5000");
  return db;
}

function findHouse(request: {
  get: (url: string) => Promise<{ json: () => Promise<{ houses: Array<{ id: string; name: string }> }> }>;
}, name: string) {
  return request.get("/api/houses?includeArchived=false").then((r) => r.json()).then(
    (d) => d.houses.find((h) => h.name === name)!,
  );
}

test.describe("City skyline", () => {
  test("house appears as a building, click navigates; working state; celebration burst + reduced-motion glyph", async ({
    page,
    request,
  }) => {
    // 1. Found two houses via the UI/API.
    await page.goto("/houses");
    await createHouseViaForm(page, {
      houseName: "Sky House One",
      agentName: "Cassian",
      agentRole: "sentinel",
    });
    await createHouseViaForm(page, {
      houseName: "Sky House Two",
      agentName: "Mor",
      agentRole: "seer",
    });

    const h1 = await findHouse(request, "Sky House One");
    const h2 = await findHouse(request, "Sky House Two");

    // Create tasks for celebration seeding.
    const task1 = (await (
      await request.post("/api/tasks", {
        data: { title: "Light the beacon", houseId: h1.id },
        headers: { "Content-Type": "application/json" },
      })
    ).json()).task as { id: string };

    // 2. Building visible with name on dashboard.
    await page.goto("/");
    const b1 = page.getByTestId(`city-building-${h1.id}`);
    await expect(b1).toBeVisible();
    // The house name is rendered as an SVG text — assert via aria-label too.
    await expect(b1).toHaveAttribute("aria-label", "Sky House One");

    // Click navigates to the house detail.
    await b1.click();
    await page.waitForURL(`/houses/${h1.id}`);
    await expect(page.getByRole("heading", { name: "Sky House One" })).toBeVisible();

    // 3. Seed a running session → reload dashboard shows data-state="working".
    const db = openDb();
    const sessionId = `sess-city-${Date.now()}`;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO execution_sessions (id, task_id, house_id, status, provider, model_id, created_at, updated_at)
       VALUES (?, ?, ?, 'running', 'opencode', 'glm-5.3', ?, ?)`,
    ).run(sessionId, task1.id, h1.id, now, now);
    db.prepare(
      `INSERT INTO execution_events (session_id, task_id, house_id, raw_type, type, payload, created_at)
       VALUES (?, ?, ?, 'task_started', 'task_started', '{"title":"Light the beacon"}', ?)`,
    ).run(sessionId, task1.id, h1.id, now);
    db.prepare("UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?").run(now, task1.id);
    db.close();

    await page.goto("/");
    await expect(page.getByTestId(`city-building-${h1.id}`)).toHaveAttribute("data-state", "working");

    // 4. Insert a task_completed event → celebration burst appears, then clears.
    const db2 = openDb();
    const now2 = new Date().toISOString();
    db2.prepare(
      `INSERT INTO execution_events (session_id, task_id, house_id, raw_type, type, payload, created_at)
       VALUES (?, ?, ?, 'task_completed', 'task_completed', '{}', ?)`,
    ).run(sessionId, task1.id, h1.id, now2);
    db2.close();

    // The SSE tick is ~2s; give it up to 10s to surface.
    const celebration = page.getByTestId("city-celebration");
    await expect(celebration).toBeVisible({ timeout: 10_000 });
    // Guard: still exactly one celebration element after the tick.
    await expect(page.getByTestId("city-celebration")).toHaveCount(1);
    // It clears ~2.6s after the trigger.
    await expect(celebration).toHaveCount(0, { timeout: 10_000 });

    // 5. Reduced-motion: second task → static glyph, no burst.
    // Toggle the live reduced-motion class on <html> (the hook watches via a
    // MutationObserver). We stay on the same page so the EventSource keeps a
    // continuous cursor and the newly-inserted event is delivered.
    await page.evaluate(() => {
      document.documentElement.classList.add("velaris-reduced-motion");
    });
    await expect(page.getByTestId("city-static-celebration")).toHaveCount(0);
    await expect(page.getByTestId(`city-building-${h1.id}`)).toHaveAttribute("data-state", "working");

    // Insert the second task's completion while the reduced-motion page is live.
    const task2 = (await (
      await request.post("/api/tasks", {
        data: { title: "Ring the bell", houseId: h2.id },
        headers: { "Content-Type": "application/json" },
      })
    ).json()).task as { id: string };
    const db3 = openDb();
    const s2 = `sess-city2-${Date.now()}`;
    const now3 = new Date().toISOString();
    db3.prepare(
      `INSERT INTO execution_sessions (id, task_id, house_id, status, provider, model_id, created_at, updated_at)
       VALUES (?, ?, ?, 'completed', 'opencode', 'glm-5.3', ?, ?)`,
    ).run(s2, task2.id, h2.id, now3, now3);
    db3.prepare(
      `INSERT INTO execution_events (session_id, task_id, house_id, raw_type, type, payload, created_at)
       VALUES (?, ?, ?, 'task_completed', 'task_completed', '{}', ?)`,
    ).run(s2, task2.id, h2.id, now3);
    db3.prepare("UPDATE tasks SET status = 'completed', updated_at = ? WHERE id = ?").run(now3, task2.id);
    db3.close();

    await expect(page.getByTestId("city-static-celebration")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("city-celebration")).toHaveCount(0);

    // Cleanup.
    await request.patch(`/api/houses/${h1.id}`, {
      data: { status: "archived" },
      headers: { "Content-Type": "application/json" },
    });
    await request.delete(`/api/houses/${h1.id}`);
    await request.patch(`/api/houses/${h2.id}`, {
      data: { status: "archived" },
      headers: { "Content-Type": "application/json" },
    });
    await request.delete(`/api/houses/${h2.id}`);
  });
});
