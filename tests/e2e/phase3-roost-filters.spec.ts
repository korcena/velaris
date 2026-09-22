/**
 * E2E — Phase 3 Messenger Roost filters + resolved history.
 *
 * Engine is OFF; notifications/approval rows are seeded directly into the e2e DB.
 * Covered:
 *  - Type filter "completion" hides other notification types.
 *  - "Unread only" switch hides read notifications.
 *  - The "View house" link navigates to the house.
 *  - Resolved history shows a resolved approval with its response.
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

test.describe("Messenger Roost filters + history (Phase 3)", () => {
  test("type filter, unread toggle, view-house link, resolved history", async ({ page, request }) => {
    await page.goto("/houses");
    await createHouseViaForm(page, {
      houseName: "Roost Filter House",
      agentName: "Elain",
      agentRole: "forager",
    });

    const houses = (await (
      await request.get("/api/houses?includeArchived=false")
    ).json()).houses as { id: string; name: string }[];
    const fh = houses.find((h) => h.name === "Roost Filter House")!;

    // Create a real task so notifications/approvals reference valid rows (FK).
    const task = (await (
      await request.post("/api/tasks", {
        data: { title: "Scout the valley", houseId: fh.id },
        headers: { "Content-Type": "application/json" },
      })
    ).json()).task as { id: string };

    const db = openDb();
    const now = new Date().toISOString();
    const taskId = task.id;
    const sessionId = `sess-roost-${Date.now()}`;
    const stamp = Date.now();

    // A real session row so approvals/messages FK-validate.
    db.prepare(
      `INSERT INTO execution_sessions (id, task_id, house_id, status, provider, model_id, created_at, updated_at)
       VALUES (?, ?, ?, 'completed', 'opencode', 'glm-5.3', ?, ?)`,
    ).run(sessionId, taskId, fh.id, now, now);

    // Three notifications: unread approval, unread completion, read system.
    db.prepare(
      `INSERT INTO notifications (id, type, title, body, house_id, task_id, read, created_at)
       VALUES (?, 'approval', 'Approval Needed', 'grant permission', ?, ?, 0, ?)`,
    ).run(`n-appr-${stamp}`, fh.id, taskId, now);
    db.prepare(
      `INSERT INTO notifications (id, type, title, body, house_id, task_id, read, created_at)
       VALUES (?, 'completion', 'Quest Done', 'the house finished', ?, ?, 0, ?)`,
    ).run(`n-comp-${stamp}`, fh.id, taskId, now);
    db.prepare(
      `INSERT INTO notifications (id, type, title, body, house_id, task_id, read, created_at)
       VALUES (?, 'system', 'System Note', 'engine online', NULL, NULL, 1, ?)`,
    ).run(`n-sys-${stamp}`, now);

    // One resolved approval (approved) for the house.
    db.prepare(
      `INSERT INTO approval_requests
       (id, session_id, task_id, house_id, provider_request_id, kind, status, title, message, options, response, responded_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'permission', 'approved', 'Write file', 'write a file', '[]', 'looks good', ?, ?)`,
    ).run(`appr-res-${stamp}`, sessionId, taskId, fh.id, `prov-res-${stamp}`, now, now);

    db.close();

    // Open the roost.
    await page.goto("/roost");

    // 1. Type filter → completion hides others.
    await page.getByRole("combobox").filter({ hasText: "All types" }).first().click();
    await page.getByRole("option", { name: "complete" }).first().click();
    await expect(page.getByText("Quest Done", { exact: true })).toBeVisible();
    await expect(page.getByText("Approval Needed", { exact: true })).toHaveCount(0);
    await expect(page.getByText("System Note", { exact: true })).toHaveCount(0);

    // 2. Unread-only switch hides the (read) system note. Reset filter to All.
    await page.getByRole("combobox").filter({ hasText: "complete" }).first().click();
    await page.getByRole("option", { name: "All types" }).first().click();
    await expect(page.getByText("System Note", { exact: true })).toBeVisible();
    await page.getByRole("switch").click();
    await expect(page.getByText("System Note", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Quest Done", { exact: true })).toBeVisible();
    await page.getByRole("switch").click();

    // 3. View house link navigates.
    await expect(page.getByRole("link", { name: "View house" }).first()).toHaveAttribute(
      "href",
      `/houses/${fh.id}`,
    );
    await page.getByRole("link", { name: "View house" }).first().click();
    await page.waitForURL(`/houses/${fh.id}`);
    await expect(page.getByRole("heading", { name: "Roost Filter House" })).toBeVisible();

    // 4. Resolved history on the Approvals tab.
    await page.goto("/roost");
    await page.getByRole("tab", { name: "Pending approvals" }).click();
    await expect(page.getByRole("heading", { name: "Resolved history" })).toBeVisible();
    await expect(page.getByText("Write file", { exact: true })).toBeVisible();
    await expect(page.getByText(/looks good/)).toBeVisible();
    await expect(page.getByText("approved", { exact: true })).toBeVisible();

    // Cleanup.
    await request.patch(`/api/houses/${fh.id}`, {
      data: { status: "archived" },
      headers: { "Content-Type": "application/json" },
    });
    await request.delete(`/api/houses/${fh.id}`);
  });
});
