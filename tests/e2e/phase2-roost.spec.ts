/**
 * E2E — Messenger Roost + house-card bird indicator + nav badge (Phase 2).
 *
 * The engine is OFF in e2e, so approvals/notifications (engine-written rows)
 * are seeded directly into the e2e DB with better-sqlite3 mid-test, after the
 * webserver has booted (migrations exist). We then assert:
 *  - the house card shows a "Messenger bird" indicator with the pending count
 *  - the Roost nav badge shows the unread count
 *  - the Roost page lists the bird/notification
 *  - approving it via the UI drops the pending count and marks the notification read
 *
 * The e2e DB path is './db/velaris-e2e.db' (set by playwright.config.ts
 * VELARIS_DB_PATH; CWD is the project root when tests run).
 */

import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import Database from "better-sqlite3";
import { createHouseViaForm } from "./helpers";

const E2E_DB = path.join(process.cwd(), "db", "velaris-e2e.db");

/** Open the shared e2e DB. WAL mode allows a second writer with busy_timeout. */
function openDb() {
  const db = new Database(E2E_DB);
  db.pragma("busy_timeout = 5000");
  return db;
}

/** Seed a session + approval_request + a linked notification for a house + task. */
function seedBird(db: Database.Database, houseId: string, taskId: string) {
  const approvalId = `appr-${Date.now()}`;
  const notifId = `notif-${Date.now()}`;
  const sessionId = `sess-${Date.now()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO execution_sessions (id, task_id, house_id, status, provider, model_id, created_at, updated_at)
     VALUES (?, ?, ?, 'running', 'opencode', 'glm-5.3', ?, ?)`,
  ).run(sessionId, taskId, houseId, now, now);
  db.prepare(
    `INSERT INTO approval_requests
       (id, session_id, task_id, house_id, provider_request_id, kind, status, title, message, options, created_at)
     VALUES (?, ?, ?, ?, ?, 'permission', 'pending', 'Permission: write', 'write — /a/b', '[]', ?)`,
  ).run(approvalId, sessionId, taskId, houseId, `prov-${approvalId}`, now);
  db.prepare(
    `INSERT INTO notifications
       (id, type, title, body, house_id, task_id, approval_request_id, read, created_at)
     VALUES (?, 'approval', 'Write permission', 'The house needs to write a file', ?, ?, ?, 0, ?)`,
  ).run(notifId, houseId, taskId, approvalId, now);
}

test.describe("Messenger Roost + bird", () => {
  test("bird indicator, nav badge, roost list, approve via UI, notification marked read", async ({
    page,
    request,
  }) => {
    // 1. Create a house via the UI (writes through the API to the e2e DB).
    await page.goto("/houses");
    await createHouseViaForm(page, {
      houseName: "Bird House",
      agentName: "Cressida",
      agentRole: "courier",
    });

    // 2. Create a task assigned to that house via the API.
    const housesRes = await request.get("/api/houses?includeArchived=false");
    const houses = (await housesRes.json()).houses as { id: string; name: string }[];
    const birdHouse = houses.find((h) => h.name === "Bird House")!;
    const taskRes = await request.post("/api/tasks", {
      data: { title: "Fetch the scroll", houseId: birdHouse.id },
      headers: { "Content-Type": "application/json" },
    });
    const task = (await taskRes.json()).task as { id: string };

    // 3. Seed the approval + notification directly into the e2e DB.
    const db = openDb();
    seedBird(db, birdHouse.id, task.id);
    db.close();

    // 4. The house card shows the bird indicator + count.
    await page.reload();
    await expect(page.getByText("Messenger bird awaiting", { exact: true })).toBeVisible();
    await expect(page.getByText("Messenger bird awaiting").locator("..").getByText("1", { exact: true })).toBeVisible();

    // 5. The Roost nav badge shows the unread count.
    const roostLink = page.getByRole("link").filter({ hasText: /Messenger Roost/ }).first();
    await expect(roostLink).toContainText("1");

    // 6. The Roost page lists the bird (notification) and the pending approval.
    await roostLink.click();
    await expect(page.getByRole("heading", { name: "Messenger Roost" })).toBeVisible();
    await expect(page.getByText(/unread message/)).toBeVisible();
    await expect(page.getByText("Write permission", { exact: true })).toBeVisible();

    // 7. The pending-approvals tab lists it.
    await page.getByRole("tab", { name: "Pending approvals" }).click();
    await expect(page.getByText("Permission: write", { exact: true })).toBeVisible();

    // 8. Approve it via the UI.
    await page.getByRole("button", { name: "Approve" }).click();

    // The approved card leaves the pending list (refetch clears it).
    await expect(page.getByText("Permission: write", { exact: true })).toHaveCount(0);

    // 9. Back on the house grid, the bird is gone…
    await page.goto("/houses");
    await expect(page.getByText("Messenger bird awaiting", { exact: true })).toHaveCount(0);

    // 10. …and the badge count can no longer read the unread message.
    await expect(
      page.getByRole("link").filter({ hasText: /Messenger Roost/ }).first(),
    ).toBeVisible();

    // Cleanup: archive + delete the house so the suite stays deterministic for
    // later spec files that expect an empty grid.
    await request.patch(`/api/houses/${birdHouse.id}`, {
      data: { status: "archived" },
      headers: { "Content-Type": "application/json" },
    });
    await request.delete(`/api/houses/${birdHouse.id}`);
  });
});
