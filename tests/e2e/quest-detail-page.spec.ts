/**
 * E2E — Quest Board roots filter + quest detail page (`/quests/[id]`).
 *
 * Engine is OFF; execution rows are seeded directly into the e2e DB with
 * better-sqlite3. Covered:
 *  - `/quests` hides engine spin-off children (roots filter) while still
 *    showing the user-created top-level parent.
 *  - The row's View action is a `<Link>` to `/quests/<id>` (the old inline
 *    activity expander is gone).
 *  - `/quests/<id>` renders details, the spin-off flow DAG, todos, usage and
 *    the activity/trace section.
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

function now(): string {
  return new Date().toISOString();
}

test.describe("Quest detail page", () => {
  test("roots filter hides children; View links to the detail page with all sections", async ({
    page,
    request,
  }) => {
    // 1. Create a house via the form; resolve its id via the API.
    await page.goto("/houses");
    await createHouseViaForm(page, {
      houseName: "Quest House",
      agentName: "Ariadne",
      agentRole: "weaver",
    });
    const houses = (await (await request.get("/api/houses?includeArchived=false")).json()) as {
      houses: Array<{ id: string; name: string }>;
    };
    const houseId = houses.houses.find((h) => h.name === "Quest House")!.id;

    // 2. A user-created top-level parent quest attached to the house.
    const parentRes = await request.post("/api/tasks", {
      data: { title: "Weave the wards", houseId },
      headers: { "Content-Type": "application/json" },
    });
    const { task: parent } = (await parentRes.json()) as { task: { id: string } };

    // 3. Seed a delegated child (subtask + link) + a session/event for it.
    const marker = "Child step marker";
    const childId = `${parent.id}-child-s0`;
    const db = openDb();
    const t = now();
    db.prepare(
      `INSERT INTO tasks (id, title, description, type, priority, status, house_id, execution_preferences, attachments, created_at, updated_at)
       VALUES (?, ?, ?, 'general', 'medium', 'queued', ?, '{}', '[]', ?, ?)`,
    ).run(childId, marker, marker, houseId, t, t);
    db.prepare(
      `INSERT INTO subtasks (id, parent_task_id, task_id, order_index, depends_on, status, attempt_count, plan_id, title, instructions, completion_requirements, created_at, updated_at)
       VALUES (?, ?, ?, 0, '[]', 'delegated', 0, 's0', ?, '', '', ?, ?)`,
    ).run(`${parent.id}-sub-s0`, parent.id, childId, marker, t, t);
    const sessionId = `sess-${parent.id}`;
    db.prepare(
      `INSERT INTO execution_sessions (id, task_id, house_id, status, provider, model_id, created_at, updated_at)
       VALUES (?, ?, ?, 'completed', 'opencode', 'glm-5.3', ?, ?)`,
    ).run(sessionId, childId, houseId, t, t);
    db.prepare(
      `INSERT INTO execution_events (session_id, task_id, house_id, raw_type, type, payload, created_at)
       VALUES (?, ?, ?, 'task_started', 'task_started', '{"title":"Child step marker"}', ?)`,
    ).run(sessionId, childId, houseId, t);
    db.close();

    // 4. Quest Board: parent visible, child hidden (roots filter).
    await page.goto("/quests");
    await expect(page.getByRole("row").filter({ hasText: "Weave the wards" })).toBeVisible();
    await expect(page.getByText(marker, { exact: true })).toHaveCount(0);
    // The old inline expander is gone: View is a link, not a toggle.
    await expect(page.getByRole("button", { name: /View/ })).toHaveCount(0);

    // 5. View → detail page.
    const view = page.getByTestId(`quest-view-${parent.id}`);
    await expect(view).toHaveAttribute("href", `/quests/${parent.id}`);
    await view.click();

    await expect(page).toHaveURL(new RegExp(`/quests/${parent.id}$`));
    await expect(page.getByTestId("quest-detail-title")).toContainText("Weave the wards");
    // Spin-off flow DAG node + todos row.
    await expect(page.getByTestId("subtask-s0")).toBeVisible();
    await expect(page.getByTestId("quest-todo-s0")).toBeVisible();
    await expect(page.getByTestId("quest-usage")).toBeVisible();
    await expect(page.getByTestId("quest-trace")).toBeVisible();

    // 6. Cleanup: detach tasks from the house, soft-delete parent + child,
    // archive + delete the house.
    for (const id of [parent.id, childId]) {
      await request.patch(`/api/tasks/${id}`, {
        data: { houseId: null },
        headers: { "Content-Type": "application/json" },
      });
      await request.delete(`/api/tasks/${id}`);
    }
    await request.patch(`/api/houses/${houseId}`, {
      data: { status: "archived" },
      headers: { "Content-Type": "application/json" },
    });
    await request.delete(`/api/houses/${houseId}`);
  });
});
