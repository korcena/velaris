/**
 * E2E — Phase 3.1 Archipelago Map (src/components/map/castle-map.tsx).
 *
 * The engine is OFF; execution rows are seeded directly into the e2e DB.
 * Covered:
 *  - Founded houses appear as citadels on /map (data-testid + aria-label).
 *  - §6.1 click semantics: clicking a house opens the drawer (it does NOT
 *    navigate); the drawer's "Open house →" link navigates to the detail.
 *  - A drag on the viewport does NOT open the drawer (and does not navigate).
 *  - A seeded running session makes the citadel render data-state="working".
 *  - Inserting a task_completed execution_events row triggers a
 *    `city-celebration` burst (guarded per taskId), which clears ~3s later.
 *  - With reduced-motion on, a second task_completed renders a
 *    `city-static-celebration` glyph and NOT a `city-celebration`.
 *  - Zoom buttons change the map-world transform scale; Reset restores it.
 *  - Legend filter dims non-matching houses; keyboard selection opens the
 *    drawer; Escape closes it; the drawer deep-links to the Messenger Roost.
 *  - Reduced motion renders the static burning overlay for an aborted plan.
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

/**
 * Assert every citadel's stable click target is inside the map viewport
 * rectangle — the D4 contract that the default camera fits all houses on load.
 * (Playwright's `toBeVisible` does not check on-screen containment, so this is
 * the real "all houses visible on load" assertion.)
 */
async function expectAllCastlesOnScreen(page: import("@playwright/test").Page) {
  const viewportBox = await page.getByTestId("map-viewport").boundingBox();
  expect(viewportBox).not.toBeNull();
  // `.map-house-hit` excludes the `map-castle-burning*` overlay testids, which
  // share the `map-castle-` prefix.
  const castles = page.locator('.map-house-hit[data-testid^="map-castle-"]');
  const count = await castles.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const el = castles.nth(i);
    const box = await el.boundingBox();
    expect(box, `castle ${i} has no box`).not.toBeNull();
    const id = await el.getAttribute("data-testid");
    const tolerance = 1;
    expect(box!.x, `${id} clipped left`).toBeGreaterThanOrEqual(viewportBox!.x - tolerance);
    expect(box!.y, `${id} clipped top`).toBeGreaterThanOrEqual(viewportBox!.y - tolerance);
    expect(box!.x + box!.width, `${id} clipped right`).toBeLessThanOrEqual(
      viewportBox!.x + viewportBox!.width + tolerance,
    );
    expect(box!.y + box!.height, `${id} clipped bottom`).toBeLessThanOrEqual(
      viewportBox!.y + viewportBox!.height + tolerance,
    );
  }
  return { count, viewportBox: viewportBox! };
}

/** Seed a running session + task event for a house/task. */
function seedRunningSession(
  db: Database.Database,
  { sessionId, taskId, houseId }: { sessionId: string; taskId: string; houseId: string },
) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO execution_sessions (id, task_id, house_id, status, provider, model_id, created_at, updated_at)
     VALUES (?, ?, ?, 'running', 'opencode', 'glm-5.3', ?, ?)`,
  ).run(sessionId, taskId, houseId, now, now);
  db.prepare(
    `INSERT INTO execution_events (session_id, task_id, house_id, raw_type, type, payload, created_at)
     VALUES (?, ?, ?, 'task_started', 'task_started', '{"title":"task"}', ?)`,
  ).run(sessionId, taskId, houseId, now);
  db.prepare("UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?").run(now, taskId);
}

test.describe("Archipelago map", () => {
  test("citadels render + drawer opens + deep-link navigates; drag suppressed; working; celebration; reduced-motion glyph; zoom/reset", async ({
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

    // 2. Citadels visible with aria-label on /map.
    await page.goto("/map");
    const c1 = page.getByTestId(`map-castle-${h1.id}`);
    await expect(c1).toBeVisible();
    await expect(c1).toHaveAttribute("aria-label", "Map House One");
    await expect(page.getByTestId(`map-castle-${h2.id}`)).toBeVisible();

    // The seeded High Lord citadel is always present at the world heart (D3):
    // gold (data-kind="high_lord") and on the map even with zero user houses.
    const hiHouse = (await (
      await request.get("/api/houses?includeHighLord=true")
    ).json()).houses.find((h: { kind: string }) => h.kind === "high_lord") as { id: string };
    const hlCastle = page.getByTestId(`map-castle-${hiHouse.id}`);
    await expect(hlCastle).toBeVisible();
    await expect(hlCastle).toHaveAttribute("data-kind", "high_lord");
    // HL is idle at rest.
    await expect(hlCastle).toHaveAttribute("data-state", /idle/);

    // D4: the default camera fits the whole world, so every citadel is on
    // screen at load — no zoom-out needed to reach a house.
    await expectAllCastlesOnScreen(page);

    // §6.1: click opens the drawer (does NOT navigate); its "Open house →"
    // link then navigates to the house detail.
    await c1.click();
    const drawer = page.getByTestId("map-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText("Map House One");
    expect(page.url()).toContain("/map");
    await drawer.getByRole("link", { name: /Open house/ }).click();
    await page.waitForURL(`/houses/${h1.id}`);
    await expect(page.getByRole("heading", { name: "Map House One" })).toBeVisible();

    // 3. Back to /map; drag suppresses selection + navigation.
    await page.goto("/map");
    const viewport = page.getByTestId("map-viewport");
    const box = await viewport.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + 60, box!.y + box!.height / 2 + 30, { steps: 4 });
    await page.mouse.up();
    expect(page.url()).toContain("/map");
    await expect(page.getByTestId("map-drawer")).toHaveCount(0);

    // 4. Seed a running session → reload /map shows data-state="working".
    const db = openDb();
    const sessionId = `sess-map-${Date.now()}`;
    seedRunningSession(db, { sessionId, taskId: task1.id, houseId: h1.id });
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
    // Reset restores the fitted default: the whole world contained in the
    // viewport (D4). Playwright is 1280×720 → panel 960×664 → scale 0.6; the
    // key invariant is that Reset equals the on-load default and fits the world.
    expect(reset.x).toBeCloseTo(before.x, 1);
    expect(reset.y).toBeCloseTo(before.y, 1);
    expect(reset.scale).toBeCloseTo(before.scale, 2);
    // After reset the whole world is visible (world scaled ≤ viewport) and
    // every citadel is still on screen.
    const viewportBox = await page.getByTestId("map-viewport").boundingBox();
    const worldBox = await world.boundingBox();
    if (viewportBox && worldBox) {
      expect(worldBox.width).toBeLessThanOrEqual(viewportBox.width + 0.5);
      expect(worldBox.height).toBeLessThanOrEqual(viewportBox.height + 0.5);
    }
    await expectAllCastlesOnScreen(page);

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

  test("legend filter dims non-matching houses and toggles off", async ({ page, request }) => {
    await page.goto("/houses");
    await createHouseViaForm(page, { houseName: "Filter House", agentName: "F", agentRole: "filterer" });
    const filterHouse = await findHouse(request, "Filter House");

    const task = (await (
      await request.post("/api/tasks", {
        data: { title: "Filter task", houseId: filterHouse.id },
        headers: { "Content-Type": "application/json" },
      })
    ).json()).task as { id: string };

    const db = openDb();
    seedRunningSession(db, {
      sessionId: `sess-filter-${Date.now()}`,
      taskId: task.id,
      houseId: filterHouse.id,
    });
    db.close();

    await page.goto("/map");
    const workingCastle = page.getByTestId(`map-castle-${filterHouse.id}`);
    await expect(workingCastle).toHaveAttribute("data-state", "working");

    // Counts render on the legend buttons.
    await expect(page.getByTestId("map-legend-working")).toContainText(/\d/);

    // Filter by "working": the working house stays lit; an idle house dims.
    const workingBtn = page.getByTestId("map-legend-working");
    await workingBtn.click();
    await expect(workingBtn).toHaveAttribute("aria-pressed", "true");
    await expect(workingCastle).toHaveAttribute("data-dimmed", "false");

    const idleCastle = page.locator('.map-island-house[data-state="idle"]').first();
    await expect(idleCastle).toHaveAttribute("data-dimmed", "true");

    // Toggle the filter off again → nothing dimmed.
    await workingBtn.click();
    await expect(workingBtn).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator('.map-island-house[data-dimmed="true"]')).toHaveCount(0);

    // Cleanup.
    await request.patch(`/api/houses/${filterHouse.id}`, {
      data: { status: "archived" },
      headers: { "Content-Type": "application/json" },
    });
    await request.delete(`/api/houses/${filterHouse.id}`);
  });

  test("keyboard selects a house, shows a focus ring, and Escape closes the drawer", async ({ page, request }) => {
    await page.goto("/houses");
    await createHouseViaForm(page, { houseName: "Key House", agentName: "K", agentRole: "keyhandler" });
    const keyHouse = await findHouse(request, "Key House");

    await page.goto("/map");

    // M1: tab (real keyboard navigation) until focus lands on a citadel's
    // focusable `.map-house-hit`. The ring must be non-none with a non-zero
    // width; the ancestor highlight is driven by `:focus-within`.
    let hit = false;
    for (let i = 0; i < 80; i++) {
      await page.keyboard.press("Tab");
      hit = await page.evaluate(() =>
        (document.activeElement as HTMLElement | null)?.classList.contains("map-house-hit") ?? false,
      );
      if (hit) break;
    }
    expect(hit, "focus never reached a citadel via Tab").toBe(true);

    // Let the `.map-sel` opacity transition (0.2s) settle before reading it.
    await page.waitForTimeout(300);
    const focused = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return null;
      const cs = getComputedStyle(el);
      const parent = el.closest(".map-island-house");
      const sel = parent?.querySelector<HTMLElement>(".map-sel");
      return {
        testid: el.getAttribute("data-testid"),
        focusVisible: el.matches(":focus-visible"),
        outlineStyle: cs.outlineStyle,
        outlineWidth: parseFloat(cs.outlineWidth || "0"),
        selOpacity: sel ? parseFloat(getComputedStyle(sel).opacity) : null,
      };
    });

    expect(focused, "no element received focus").not.toBeNull();
    expect(focused!.testid, "focus did not land on a citadel").toMatch(/^map-castle-/);
    expect(focused!.focusVisible, "focused citadel does not match :focus-visible").toBe(true);
    expect(focused!.outlineStyle).not.toBe("none");
    expect(focused!.outlineWidth, "focus ring has no width").toBeGreaterThan(0);
    // The parent label/selection highlight is driven from the focused child.
    expect(focused!.selOpacity, "selection ring not shown while focused").toBe(1);

    // Keep the exact citadel we want selected, then Enter opens the drawer.
    const castle = page.getByTestId(`map-castle-${keyHouse.id}`);
    await castle.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("map-drawer")).toBeVisible();
    await expect(page.getByTestId("map-drawer")).toContainText("Key House");
    expect(page.url()).toContain("/map");

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("map-drawer")).toHaveCount(0);

    // Cleanup.
    await request.patch(`/api/houses/${keyHouse.id}`, {
      data: { status: "archived" },
      headers: { "Content-Type": "application/json" },
    });
    await request.delete(`/api/houses/${keyHouse.id}`);
  });

  test("drawer deep-links to the Messenger Roost when a bird is pending", async ({ page, request }) => {
    await page.goto("/houses");
    await createHouseViaForm(page, { houseName: "Roost Link House", agentName: "R", agentRole: "courier" });
    const roostHouse = await findHouse(request, "Roost Link House");

    const task = (await (
      await request.post("/api/tasks", {
        data: { title: "Carry a message", houseId: roostHouse.id },
        headers: { "Content-Type": "application/json" },
      })
    ).json()).task as { id: string };

    // Seed a pending approval + linked notification so pendingApprovals > 0.
    const db = openDb();
    const now = new Date().toISOString();
    const approvalId = `appr-map-${Date.now()}`;
    const sessionId = `sess-roost-map-${Date.now()}`;
    db.prepare(
      `INSERT INTO execution_sessions (id, task_id, house_id, status, provider, model_id, created_at, updated_at)
       VALUES (?, ?, ?, 'awaiting_approval', 'opencode', 'glm-5.3', ?, ?)`,
    ).run(sessionId, task.id, roostHouse.id, now, now);
    db.prepare(
      `INSERT INTO approval_requests
         (id, session_id, task_id, house_id, provider_request_id, kind, status, title, message, options, created_at)
       VALUES (?, ?, ?, ?, ?, 'permission', 'pending', 'Permission: write', 'write — /a/b', '[]', ?)`,
    ).run(approvalId, sessionId, task.id, roostHouse.id, `prov-${approvalId}`, now);
    db.prepare(
      `INSERT INTO notifications
         (id, type, title, body, house_id, task_id, approval_request_id, read, created_at)
       VALUES (?, 'approval', 'Write permission', 'Needs a write', ?, ?, ?, 0, ?)`,
    ).run(`notif-map-${Date.now()}`, roostHouse.id, task.id, approvalId, now);
    db.close();

    await page.goto("/map");
    // The pending-approval bird indicator is present on the map.
    await expect(page.getByTestId(`map-bird-dot-${roostHouse.id}`)).toBeVisible();

    // D4: the default camera fits every house at load, so the citadel is on
    // screen without zooming out first.
    await expectAllCastlesOnScreen(page);
    await page.getByTestId(`map-castle-${roostHouse.id}`).click();
    const drawer = page.getByTestId("map-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText("Roost Link House");
    await expect(page.getByTestId("map-drawer-approval")).toBeVisible();

    const openHouse = drawer.getByRole("link", { name: /Open house/ });
    const roost = drawer.getByRole("link", { name: /Messenger Roost/ });
    await expect(openHouse).toHaveAttribute("href", `/houses/${roostHouse.id}`);
    await expect(roost).toHaveAttribute("href", "/roost");

    await roost.click();
    await page.waitForURL("**/roost");

    // Cleanup.
    await request.patch(`/api/houses/${roostHouse.id}`, {
      data: { status: "archived" },
      headers: { "Content-Type": "application/json" },
    });
    await request.delete(`/api/houses/${roostHouse.id}`);
  });

  test("reduced motion renders the static burning overlay for an aborted plan", async ({ page, request }) => {
    const hlId = (await (
      await request.get("/api/houses?includeHighLord=true")
    ).json()).houses.find((h: { kind: string }) => h.kind === "high_lord").id as string;

    const parentId = `parent-map-abort-${Date.now()}`;
    const sessionId = `hlsess-map-${Date.now()}`;
    const db = openDb();
    const now = new Date().toISOString();
    try {
      // Seed a failed parent task with an aborted-plan preference on the HL.
      db.prepare(
        `INSERT INTO tasks (id, title, description, type, priority, status, house_id, working_directory, execution_preferences, attachments, created_at, updated_at)
         VALUES (?, 'Doomed archive quest', 'x', 'general', 'medium', 'failed', ?, ?, '{"plan":{"abortReason":"retries_exhausted"}}', '[]', ?, ?)`,
      ).run(parentId, hlId, process.cwd(), now, now);
      db.prepare(
        `INSERT INTO execution_sessions (id, task_id, house_id, status, provider, model_id, directory, created_at, updated_at)
         VALUES (?, ?, ?, 'completed', 'opencode', 'glm-5.3', ?, ?, ?)`,
      ).run(sessionId, parentId, hlId, process.cwd(), now, now);

      await page.goto("/map");
      await page.evaluate(() => {
        document.documentElement.classList.add("velaris-reduced-motion");
      });

      const castle = page.getByTestId(`map-castle-${hlId}`);
      await expect(castle).toHaveAttribute("data-plan-state", "aborted");
      await expect(page.getByTestId("map-castle-burning-static")).toBeVisible();
      await expect(page.getByTestId("map-castle-burning")).toHaveCount(0);
    } finally {
      // The suite is sequential over ONE shared DB (workers:1) and retries:2.
      // This aborted parent drives the HL's sticky `planState='aborted'`, so if
      // it leaked, a retried FIRST test asserting HL `data-state` /idle/ would
      // fail deterministically. Remove everything seeded here.
      db.prepare("DELETE FROM execution_sessions WHERE id = ?").run(sessionId);
      db.prepare("DELETE FROM tasks WHERE id = ?").run(parentId);
      db.close();
    }
  });
});
