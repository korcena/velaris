/**
 * E2E — Phase 3 house detail panel (5 tabs, Overview default).
 *
 * Engine is OFF; execution rows (completed task, session, usage, diff artifact,
 * message/tool events, pending approval) are seeded directly into the e2e DB.
 * Covered:
 *  - Overview is the default tab and shows model, policy, usage cost &
 *    RuntimeStatusBadge.
 *  - Activity shows a message bubble + tool chip, and NO raw JSON.
 *  - Task Results defaults to the finished task and shows the diff header plus
 *    visible +added / -removed lines.
 *  - Approvals still lists the pending approval.
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

test.describe("House detail panel (Phase 3)", () => {
  test("Overview default; activity has bubbles/chips not JSON; results show diff; approvals list pending", async ({
    page,
    request,
  }) => {
    await page.goto("/houses");
    await createHouseViaForm(page, {
      houseName: "Panel House",
      agentName: "Amren",
      agentRole: "loremaster",
    });

    const houses = (await (
      await request.get("/api/houses?includeArchived=false")
    ).json()).houses as { id: string; name: string }[];
    const ph = houses.find((h) => h.name === "Panel House")!;

    // The form leaves modelId empty; set it so the Overview card shows it.
    await request.patch(`/api/houses/${ph.id}`, {
      data: { configuration: { modelId: "glm-5.3", aiProvider: "ollama-cloud" } },
      headers: { "Content-Type": "application/json" },
    });

    const task = (await (
      await request.post("/api/tasks", {
        data: { title: "Annotate the grimoire", houseId: ph.id },
        headers: { "Content-Type": "application/json" },
      })
    ).json()).task as { id: string };

    const db = openDb();
    const sessionId = `sess-panel-${Date.now()}`;
    const now = new Date().toISOString();
    // Active (running) session so the Activity feed + Approvals render.
    db.prepare(
      `INSERT INTO execution_sessions (id, task_id, house_id, status, provider, model_id, cost_total, input_tokens, output_tokens, created_at, updated_at)
       VALUES (?, ?, ?, 'running', 'opencode', 'glm-5.3', 1.5, 100, 50, ?, ?)`,
    ).run(sessionId, task.id, ph.id, now, now);
    // Usage record for the running session (drives Overview usage + sessions count).
    db.prepare(
      `INSERT INTO usage_records (id, session_id, task_id, house_id, model_id, provider, cost, input_tokens, output_tokens, created_at)
       VALUES (?, ?, ?, ?, 'glm-5.3', 'opencode', 1.5, 100, 50, ?)`,
    ).run(`usage-panel-${Date.now()}`, sessionId, task.id, ph.id, now);

    // Events: task_started, message, tool_call.
    db.prepare(
      `INSERT INTO execution_events (session_id, task_id, house_id, raw_type, type, payload, created_at)
       VALUES (?, ?, ?, 'task_started', 'task_started', '{"title":"Annotate the grimoire"}', ?)`,
    ).run(sessionId, task.id, ph.id, now);
    db.prepare(
      `INSERT INTO execution_events (session_id, task_id, house_id, raw_type, type, payload, created_at)
       VALUES (?, ?, ?, 'message', 'message', '{"text":"The grimoire is annotated."}', ?)`,
    ).run(sessionId, task.id, ph.id, now);
    db.prepare(
      `INSERT INTO execution_events (session_id, task_id, house_id, raw_type, type, payload, created_at)
       VALUES (?, ?, ?, 'tool_call', 'tool_call', '{"tool":{"tool":"fs","input":"write annotation.md"}}', ?)`,
    ).run(sessionId, task.id, ph.id, now);

    // Pending approval.
    db.prepare(
      `INSERT INTO approval_requests (id, session_id, task_id, house_id, provider_request_id, kind, status, title, message, options, created_at)
       VALUES (?, ?, ?, ?, ?, 'permission', 'pending', 'Permission: write', 'write annotation.md', '[]', ?)`,
    ).run(`appr-panel-${Date.now()}`, sessionId, task.id, ph.id, `prov-panel-${Date.now()}`, now);

    // Task stays RUNNING so the detail treats it as active (activity + approvals).
    db.prepare("UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?").run(now, task.id);

    // A SECOND, finished task with a diff artifact → drives Task Results.
    const doneTask = (await (
      await request.post("/api/tasks", {
        data: { title: "Map the dungeon", houseId: ph.id },
        headers: { "Content-Type": "application/json" },
      })
    ).json()).task as { id: string };
    const doneSession = `sess-done-${Date.now()}`;
    db.prepare(
      `INSERT INTO execution_sessions (id, task_id, house_id, status, provider, model_id, created_at, updated_at)
       VALUES (?, ?, ?, 'completed', 'opencode', 'glm-5.3', ?, ?)`,
    ).run(doneSession, doneTask.id, ph.id, now, now);
    db.prepare(
      `INSERT INTO artifacts (id, session_id, task_id, kind, content, created_at)
       VALUES (?, ?, ?, 'diff', ?, ?)`,
    ).run(`art-diff-${Date.now()}`, doneSession, doneTask.id, "modified annotation.md\n@@ -1 +1 @@\n+added line\n-context\n-removed line", now);
    db.prepare("UPDATE tasks SET status = 'completed', updated_at = ? WHERE id = ?").run(now, doneTask.id);
    db.close();

    // Open detail → Overview is default.
    await page.goto(`/houses/${ph.id}`);
    await expect(page.getByRole("heading", { name: "Panel House" })).toBeVisible();
    // RuntimeStatusBadge for a running session → "Working".
    await expect(page.getByText("Working", { exact: true }).first()).toBeVisible();

    // Overview tab content: the Execution card shows provider/model/policy.
    await expect(page.getByText("opencode", { exact: true })).toBeVisible();
    await expect(page.getByText(/ollama-cloud\/glm-5\.3/)).toBeVisible();
    await expect(page.getByText("always", { exact: true })).toBeVisible();
    // Usage cost rendered from the usage summary.
    await expect(page.getByText("$1.5000", { exact: true })).toBeVisible();

    // Activity tab: bubble + tool chip, no raw JSON.
    await page.getByRole("tab", { name: "Activity" }).click();
    await expect(page.getByText("The grimoire is annotated.", { exact: true })).toBeVisible();
    await expect(page.getByText(/\[fs\] write annotation\.md/)).toBeVisible();
    // Raw JSON payload dump must NOT be present (the old <pre> dump is gone).
    await expect(page.getByTestId("activity-raw-json")).toHaveCount(0);
    await expect(page.locator("pre")).toHaveCount(0);

    // Task Results: defaults to the finished task, shows diff header + changed lines.
    await page.getByRole("tab", { name: "Task Results" }).click();
    await expect(page.getByText("Map the dungeon", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("modified", { exact: true })).toBeVisible();
    await expect(page.getByText("annotation.md", { exact: true })).toBeVisible();
    await expect(page.getByText("+added line", { exact: true })).toBeVisible();
    await expect(page.getByText("-removed line", { exact: true })).toBeVisible();

    // Approvals still lists the pending one.
    await page.getByRole("tab", { name: "Approvals" }).click();
    await expect(page.getByText("Permission: write", { exact: true })).toBeVisible();

    // Cleanup.
    await request.patch(`/api/houses/${ph.id}`, {
      data: { status: "archived" },
      headers: { "Content-Type": "application/json" },
    });
    await request.delete(`/api/houses/${ph.id}`);
  });
});
