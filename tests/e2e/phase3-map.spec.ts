/**
 * E2E — Phase 3.1 Castle Map (src/components/map/castle-map.tsx).
 *
 * The engine is OFF; execution rows are seeded directly into the e2e DB.
 * Covered:
 *  - Founded houses appear as castles on /map (data-testid + aria-label);
 *    clicking one navigates to the house detail.
 *  - A drag on the viewport does NOT navigate.
 *  - A seeded running session makes the castle render data-state="working".
 *  - Inserting a task_completed execution_events row triggers a
 *    `city-celebration` burst (guarded per taskId), which clears ~3s later.
 *  - With reduced-motion on, a second task_completed renders a
 *    `city-static-celebration` glyph and NOT a `city-celebration`.
 *  - Zoom buttons change the map-world transform scale; Reset restores it.
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

function findHouse(
  request: {
    get: (url: string) => Promise<{ json: () => Promise<{ houses: Array<{ id: string; name: string }> }> }>;
  },
  name: string,
) {
  return request.get("/api/houses?includeArchived=false").then((r) => r.json()).then(
    (d) => d.houses.find((h) => h.name === name)!,
  );
}

/** Parse translate3d + scale(...) from the map-world transform string. */
function parseTransform(transform: string) {
  const match = transform.match(/translate3d\(([-\d.]+)px, ([-\d.]+)px, \d+px\) scale\(([\d.]+)\)/);
  if (!match) return { x: 0, y: 0, scale: 1 };
  return { x: parseFloat(match[1]), y: parseFloat(match[2]), scale: parseFloat(match[3]) };
}

test.describe("Castle map", () => {
  test("castles render + click navigates; drag suppressed; working; celebration; reduced-motion glyph; zoom/reset", async ({
    page,
    request,
  }) => {
    // 1. Found two houses via the UI.
    await page.goto("/houses");
    await createHouseViaForm(page, {
      houseName: "Map House One",
      agentName: "Cassian",
      agentRole: "sentinel",
    });
    await createHouseViaForm(page, {
      houseName: "Map House Two",
      agentName: "Mor",
      agentRole: "seer",
    });

    const h1 = await findHouse(request, "Map House One");
    const h2 = await findHouse(request, "Map House Two");

    // Create a task for celebration seeding.
    const task1 = (await (
      await request.post("/api/tasks", {
        data: { title: "Light the beacon", houseId: h1.id },
        headers: { "Content-Type": "application/json" },
      })
    ).json()).task as { id: string };

    // 2. Castles visible with aria-label on /map.
    await page.goto("/map");
    const c1 = page.getByTestId(`map-castle-${h1.id}`);
    await expect(c1).toBeVisible();
    await expect(c1).toHaveAttribute("aria-label", "Map House One");
    await expect(page.getByTestId(`map-castle-${h2.id}`)).toBeVisible();

    // The seeded High Lord castle is always present at the city heart (D3):
    // gold (data-kind="high_lord") and on the map even with zero user houses.
    // It is pinned to slot 0 / world centre regardless of founded order.
    const hiHouse = (await (
      await request.get("/api/houses?includeHighLord=true")
    ).json()).houses.find((h: { kind: string }) => h.kind === "high_lord") as { id: string };
    const hlCastle = page.getByTestId(`map-castle-${hiHouse.id}`);
    await expect(hlCastle).toBeVisible();
    await expect(hlCastle).toHaveAttribute("data-kind", "high_lord");
    // HL is idle at rest.
    await expect(hlCastle).toHaveAttribute("data-state", /idle/);

    // Click navigates to the house detail.
    await c1.click();
    await page.waitForURL(`/houses/${h1.id}`);
    await expect(page.getByRole("heading", { name: "Map House One" })).toBeVisible();

    // 3. Back to /map; drag suppresses navigation.
    await page.goto("/map");
    const viewport = page.getByTestId("map-viewport");
    const box = await viewport.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + 60, box!.y + box!.height / 2 + 30, { steps: 4 });
    await page.mouse.up();
    expect(page.url()).toContain("/map");

    // 4. Seed a running session → reload /map shows data-state="working".
    const db = openDb();
    const sessionId = `sess-map-${Date.now()}`;
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

    await page.goto("/map");
    await expect(page.getByTestId(`map-castle-${h1.id}`)).toHaveAttribute("data-state", "working");

    // 5. Insert a task_completed event → celebration burst appears, then clears.
    const db2 = openDb();
    const now2 = new Date().toISOString();
    db2.prepare(
      `INSERT INTO execution_events (session_id, task_id, house_id, raw_type, type, payload, created_at)
       VALUES (?, ?, ?, 'task_completed', 'task_completed', '{}', ?)`,
    ).run(sessionId, task1.id, h1.id, now2);
    db2.close();

    const celebration = page.getByTestId("city-celebration");
    await expect(celebration).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("city-celebration")).toHaveCount(1);
    await expect(celebration).toHaveCount(0, { timeout: 10_000 });

    // 6. Reduced-motion glyph on a second task while the page stays live.
    await page.evaluate(() => {
      document.documentElement.classList.add("velaris-reduced-motion");
    });
    await expect(page.getByTestId("city-static-celebration")).toHaveCount(0);
    await expect(page.getByTestId(`map-castle-${h1.id}`)).toHaveAttribute("data-state", "working");

    const task2 = (await (
      await request.post("/api/tasks", {
        data: { title: "Ring the bell", houseId: h2.id },
        headers: { "Content-Type": "application/json" },
      })
    ).json()).task as { id: string };
    const db3 = openDb();
    const s2 = `sess-map2-${Date.now()}`;
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

    // 7. Zoom buttons / reset.
    const world = page.getByTestId("map-world");
    const before = parseTransform((await world.getAttribute("style")) ?? "");
    await page.getByRole("button", { name: "Zoom in" }).click();
    await page.getByRole("button", { name: "Zoom in" }).click();
    const zoomed = parseTransform((await world.getAttribute("style")) ?? "");
    expect(zoomed.scale).toBeGreaterThan(before.scale);
    await page.getByRole("button", { name: "Reset view" }).click();
    const reset = parseTransform((await world.getAttribute("style")) ?? "");
    // Reset restores the fitted default: max(1, cover) scale and the world
    // centred in the viewport (Playwright viewport is 1280×720, the world
    // 1280×800 → scale 1, y = (720-800)/2 = -40 — not the old fixed (0,0,1)).
    expect(reset.scale).toBe(1);
    expect(reset.x).toBeCloseTo(before.x, 1);
    expect(reset.y).toBeCloseTo(before.y, 1);
    // And after reset the world still covers the viewport (no empty edges).
    const viewportBox = await page.getByTestId("map-viewport").boundingBox();
    const worldBox = await world.boundingBox();
    if (viewportBox && worldBox) {
      expect(worldBox.width).toBeGreaterThanOrEqual(viewportBox.width - 0.5);
    }

    // Cleanup: archive + delete both houses.
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
