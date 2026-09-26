/**
 * E2E — Phase 2 quest board live status + house detail page + model picker fallback.
 *
 * Engine is OFF; execution rows (running task, session, events, messages) are
 * seeded directly into the e2e DB with better-sqlite3 mid-test.
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

test.describe("Quest board live status + Cancel", () => {
  test("running task shows the running badge and Cancel works", async ({ page, request }) => {
    await page.goto("/houses");
    await createHouseViaForm(page, {
      houseName: "Runner House",
      agentName: "Rhys",
      agentRole: "operative",
    });

    const houses = (await (await request.get("/api/houses?includeArchived=false")).json()).houses as {
      id: string;
      name: string;
    }[];
    const runnerHouse = houses.find((h) => h.name === "Runner House")!;
    const task = (await (
      await request.post("/api/tasks", {
        data: { title: "Run the walls", houseId: runnerHouse.id },
        headers: { "Content-Type": "application/json" },
      })
    ).json()).task as { id: string };

    // Seed a running task + session directly into the e2e DB.
    const db = openDb();
    const sessionId = `sess-run-${Date.now()}`;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO execution_sessions (id, task_id, house_id, status, provider, model_id, directory, created_at, updated_at)
       VALUES (?, ?, ?, 'running', 'opencode', 'glm-5.3', ?, ?, ?)`,
    ).run(sessionId, task.id, runnerHouse.id, process.cwd(), now, now);
    db.prepare(
      `INSERT INTO execution_events (session_id, task_id, house_id, raw_type, type, payload, created_at)
       VALUES (?, ?, ?, 'task_started', 'task_started', '{"title":"Run the walls"}', ?)`,
    ).run(sessionId, task.id, runnerHouse.id, now);
    // Flip the task to running (the same transition the engine's runner does).
    db.prepare("UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?").run(now, task.id);
    db.close();

    // Quest board shows the running badge + a Cancel button for this task's row.
    await page.goto("/quests");
    await expect(page.getByText("Run the walls", { exact: true })).toBeVisible();
    await expect(page.getByText("running", { exact: true }).first()).toBeVisible();
    const runRow = page.getByRole("row").filter({ hasText: "Run the walls" });
    await expect(runRow.getByRole("button", { name: "Cancel" })).toBeVisible();

    // Cancel the task → badge flips to cancelled.
    await runRow.getByRole("button", { name: "Cancel" }).click();
    await expect(runRow.getByText("cancelled", { exact: true })).toBeVisible();

    // The Cancel button disappears (terminal).
    await expect(runRow.getByRole("button", { name: "Cancel" })).toHaveCount(0);

    // Cleanup.
    await request.patch(`/api/houses/${runnerHouse.id}`, {
      data: { status: "archived" },
      headers: { "Content-Type": "application/json" },
    });
    await request.delete(`/api/houses/${runnerHouse.id}`);
  });
});

test.describe("House detail page (activity + chat + approvals)", () => {
  test("activity feed, chat history and approval tab render seeded rows", async ({
    page,
    request,
  }) => {
    await page.goto("/houses");
    await createHouseViaForm(page, {
      houseName: "Detail House",
      agentName: "Nesta",
      agentRole: "archivist",
    });

    const houses = (await (await request.get("/api/houses?includeArchived=false")).json()).houses as {
      id: string;
      name: string;
    }[];
    const dtHouse = houses.find((h) => h.name === "Detail House")!;
    const task = (await (
      await request.post("/api/tasks", {
        data: { title: "Catalog the library", houseId: dtHouse.id },
        headers: { "Content-Type": "application/json" },
      })
    ).json()).task as { id: string };

    // Seed a session, events, messages, and a pending approval.
    const db = openDb();
    const sessionId = `sess-det-${Date.now()}`;
    const approvalId = `appr-det-${Date.now()}`;
    const notifId = `notif-det-${Date.now()}`;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO execution_sessions (id, task_id, house_id, status, provider, model_id, created_at, updated_at)
       VALUES (?, ?, ?, 'running', 'opencode', 'glm-5.3', ?, ?)`,
    ).run(sessionId, task.id, dtHouse.id, now, now);
    db.prepare(
      `INSERT INTO execution_events (session_id, task_id, house_id, raw_type, type, payload, created_at)
       VALUES (?, ?, ?, 'task_started', 'task_started', '{"title":"Catalog the library"}', ?)`,
    ).run(sessionId, task.id, dtHouse.id, now);
    db.prepare(
      `INSERT INTO execution_events (session_id, task_id, house_id, raw_type, type, payload, created_at)
       VALUES (?, ?, ?, 'message', 'message', '{"text":"The catalog is complete."}', ?)`,
    ).run(sessionId, task.id, dtHouse.id, now);
    // Chat messages (user + agent).
    db.prepare(
      `INSERT INTO agent_messages (id, session_id, role, content, created_at)
       VALUES (?, ?, 'agent', 'Sorted the tomes by age.', ?)`,
    ).run(`msg-a-${Date.now()}`, sessionId, now);
    db.prepare(
      `INSERT INTO agent_messages (id, session_id, role, content, created_at)
       VALUES (?, ?, 'user', 'Keep the rare ones separate.', ?)`,
    ).run(`msg-b-${Date.now()}`, sessionId, now);
    // Pending approval + linked notification.
    db.prepare(
      `INSERT INTO approval_requests (id, session_id, task_id, house_id, provider_request_id, kind, status, title, message, options, created_at)
       VALUES (?, ?, ?, ?, ?, 'permission', 'pending', 'Permission: run', 'run build', '[]', ?)`,
    ).run(approvalId, sessionId, task.id, dtHouse.id, `prov-${approvalId}`, now);
    db.prepare(
      `INSERT INTO notifications (id, type, title, body, house_id, task_id, approval_request_id, read, created_at)
       VALUES (?, 'approval', 'Run permission', 'needs to run build', ?, ?, ?, 0, ?)`,
    ).run(notifId, dtHouse.id, task.id, approvalId, now);
    // Task running so the detail page treats it as active.
    db.prepare("UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?").run(now, task.id);
    db.close();

    // House detail: runtime badge working + activity feed.
    const detailRes = await request.get(`/api/houses/${dtHouse.id}`);
    expect(detailRes.status()).toBe(200);
    await page.goto(`/houses/${dtHouse.id}`);
    // RuntimeStatusBadge appears in the header AND the Overview card (Phase 3).
    await expect(page.getByText("Working", { exact: true }).first()).toBeVisible();

    // Activity feed — the default panel is now Overview, so click the Activity
    // tab before asserting on the feed (Phase 3 default-tab change). The feed
    // describes task_started as "Quest began".
    await page.getByRole("tab", { name: "Activity" }).click();
    await expect(page.getByText("Quest began", { exact: true })).toBeVisible();

    // Chat tab.
    await page.getByRole("tab", { name: "Agent Chat" }).click();
    await expect(page.getByText("Sorted the tomes by age.", { exact: true })).toBeVisible();
    await expect(page.getByText("Keep the rare ones separate.", { exact: true })).toBeVisible();

    // Approvals tab.
    await page.getByRole("tab", { name: "Approvals" }).click();
    await expect(page.getByText("Permission: run", { exact: true })).toBeVisible();

    // Cleanup.
    await request.patch(`/api/houses/${dtHouse.id}`, {
      data: { status: "archived" },
      headers: { "Content-Type": "application/json" },
    });
    await request.delete(`/api/houses/${dtHouse.id}`);
  });
});

test.describe("Model field (picker or manual fallback)", () => {
  test("model field accepts a manual value whether a picker shows or not", async ({ page }) => {
    await page.goto("/houses");
    await page.getByRole("button", { name: "New house" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Execution tab → Model field. The form queries /api/models on mount: if a
    // local OpenCode server answers with models it renders a select picker;
    // otherwise it falls back to a free-text input with the offline hint.
    await dialog.getByRole("tab", { name: "Execution" }).click();

    // The two controls are unambiguously distinct by element type + id:
    // a <button id="modelId" role="combobox"> picker, or an <input id="modelId">.
    // (getByLabel("Model") matches BOTH because the label's `htmlFor` targets the
    // same id in either state — which made the old test fill() a button.)
    const picker = dialog.locator('button#modelId[role="combobox"]');
    const manual = dialog.locator("input#modelId");

    // Wait for the model query to settle. While loading, neither the picker's
    // "Current value:" line nor the offline hint is present, so requiring one of
    // them removes the loading race before we branch.
    const pickerReady = dialog.getByText(/Current value:/i);
    const offlineHint = dialog.getByText(/OpenCode server offline/i);
    await expect(pickerReady.or(offlineHint)).toBeVisible();

    if (await picker.isVisible().catch(() => false)) {
      // Picker branch: the field is interactive and its value is settable.
      await picker.click();
      const option = page.getByRole("option").first();
      await expect(option).toBeVisible();
      const modelLabel = (await option.textContent())!.trim();
      await option.click();
      // Radix renders the selected item's label inside the trigger.
      await expect(picker).toContainText(modelLabel);
    } else {
      // Text-fallback branch: fill a manual value and assert it sticks.
      await expect(manual).toBeVisible();
      await manual.fill("deepseek-v4.1-flash");
      await expect(manual).toHaveValue("deepseek-v4.1-flash");
    }

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).not.toBeVisible();
  });
});
