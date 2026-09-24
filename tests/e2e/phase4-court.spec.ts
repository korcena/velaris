/**
 * E2E — Phase 4 High Lord Court + map gold-plating (addendum D2/D3/D4/D6).
 *
 * Engine is OFF; execution rows are seeded directly into the e2e DB with
 * better-sqlite3. Covered:
 *  - Court chat: empty state, submit an instruction → parent task created,
 *    composer stays enabled during an active plan (steering enabled).
 *  - Plan board renders DAG lanes from seeded subtask rows (statuses, house
 *    chips, plan-id chips, dependency chips, cost rollup).
 *  - Aborted plan: court burning banner (static + animated reduced-motion safe).
 *  - Map: gold High Lord castle with data-kind; data-plan-state="aborted" +
 *    burning overlay when the latest plan aborted.
 *  - Configure link navigates to /houses/{hlId} panel.
 *  - Direct-to-house regression: normal assignment still works (quest board
 *    shows a queued task).
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

async function highLordId(request: {
  get: (url: string) => Promise<{ json: () => Promise<{ houses: Array<{ id: string; kind: string }> }> }>;
}) {
  const res = await request.get("/api/houses?includeHighLord=true");
  const { houses } = await res.json();
  return houses.find((h) => h.kind === "high_lord")!.id;
}

/** Seed a parent task on the HL house + a terminal (steerable) planning session. */
function seedParentAndSession(db: Database.Database, { hlId, title, status, instruction }: {
  hlId: string;
  title: string;
  status: string;
  instruction: string;
}): { parentId: string; sessionId: string } {
  const parentId = `parent-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const sessionId = `hlsess-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const t = now();
  db.prepare(
    `INSERT INTO tasks (id, title, description, type, priority, status, house_id, working_directory, execution_preferences, attachments, created_at, updated_at)
     VALUES (?, ?, ?, 'general', 'medium', ?, ?, ?, '{}', '[]', ?, ?)`,
  ).run(parentId, title, instruction, status, hlId, process.cwd(), t, t);
  db.prepare(
    `INSERT INTO execution_sessions (id, task_id, house_id, status, provider, model_id, directory, created_at, updated_at)
     VALUES (?, ?, ?, 'completed', 'opencode', 'glm-5.3', ?, ?, ?)`,
  ).run(sessionId, parentId, hlId, process.cwd(), t, t);
  db.prepare(
    `INSERT INTO agent_messages (id, session_id, role, content, relayed_at, created_at)
     VALUES (?, ?, 'user', ?, ?, ?)`,
  ).run(`um-${Date.now()}`, sessionId, instruction, t, t);
  db.prepare(
    `INSERT INTO agent_messages (id, session_id, role, content, created_at)
     VALUES (?, ?, 'agent', '{"subtasks":[]}', ?)`,
  ).run(`am-${Date.now()}`, sessionId, t);
  return { parentId, sessionId };
}

/** Seed subtask + handoff + child task rows for a parent plan. */
function seedPlanRows(
  db: Database.Database,
  { parentId, execHouseId, plan }: {
    parentId: string;
    execHouseId: string;
    plan: Array<{ planId: string; title: string; status: string; dependsOn: string[]; child?: string }>;
  },
) {
  const t = now();
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    const subtaskId = `${parentId}-sub-${p.planId}`;
    const childId = `${parentId}-child-${p.planId}`;
    const childStatus = p.child ?? "queued";
    db.prepare(
      `INSERT INTO tasks (id, title, description, type, priority, status, house_id, execution_preferences, attachments, created_at, updated_at)
       VALUES (?, ?, ?, 'general', 'medium', ?, ?, '{}', '[]', ?, ?)`,
    ).run(childId, p.title, p.title, childStatus, execHouseId, t, t);
    db.prepare(
      `INSERT INTO subtasks (id, parent_task_id, task_id, order_index, depends_on, status, attempt_count, plan_id, title, instructions, completion_requirements, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, '', '', ?, ?)`,
    ).run(
      subtaskId, parentId, childId, i, JSON.stringify(p.dependsOn), p.status, p.planId, p.title, t, t,
    );
    db.prepare(
      `INSERT INTO handoffs (id, parent_task_id, subtask_id, source_house_id, destination_house_id, instructions, context, artifacts, completion_requirements, created_at)
       VALUES (?, ?, ?, (SELECT id FROM houses WHERE kind='high_lord' LIMIT 1), ?, '', '{}', '[]', '', ?)`,
    ).run(`${parentId}-ho-${p.planId}`, parentId, subtaskId, execHouseId, t);
  }
}

async function findAgentHouseId(request: {
  get: (url: string) => Promise<{ json: () => Promise<{ houses: Array<{ id: string; name: string }> }> }>;
}, name: string) {
  const res = await request.get("/api/houses?includeArchived=false");
  const { houses } = await res.json();
  return houses.find((h) => h.name === name)!.id;
}

test.describe("High Lord Court", () => {
  test("court journey: empty state, instruction creates a parent, plan board DAG lanes, steering enabled", async ({ page, request }) => {
    const hlId = await highLordId(request);

    // Seed an agent house for the delegation chips.
    await page.goto("/houses");
    await createHouseViaForm(page, { houseName: "Forge House", agentName: "Hephaestus", agentRole: "smith" });
    const execHouseId = await findAgentHouseId(request, "Forge House");

    // 1. Empty state + configure link.
    await page.goto("/high-lord");
    await expect(page.getByRole("heading", { name: "High Lord's Court" })).toBeVisible();
    await expect(page.getByText(/court is silent/i)).toBeVisible();
    const configure = page.getByRole("link", { name: /Configure the High Lord/ });
    await expect(configure).toBeVisible();
    await expect(configure).toHaveAttribute("href", `/houses/${hlId}`);

    // 2. Submit an instruction via the composer. The text-only composer resolves
    // a working directory from the High Lord's house allowlist (D5 / route
    // fallback), so seed the HL allowlist with the CWD first.
    const seedDb = openDb();
    seedDb.prepare(
      `UPDATE agent_configurations SET workspace_allowlist = ? WHERE agent_id = (SELECT id FROM agents WHERE house_id = ? LIMIT 1)`,
    ).run(JSON.stringify([process.cwd()]), hlId);
    seedDb.close();

    await page.getByPlaceholder("Instruct the High Lord…").fill("Build the city wall");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText(/convenes the court/i)).toBeVisible();
    // The user message appears in the chat.
    await expect(page.getByText("Build the city wall", { exact: true })).toBeVisible();

    // Verify via REST: a new parent task exists on the HL house.
    const tasks = (await (
      await request.get(`/api/tasks?houseId=${hlId}`)
    ).json()).tasks as Array<{ id: string; title: string }>;
    const mine = tasks.find((t) => t.title === "Build the city wall");
    expect(mine).toBeTruthy();
    const parentId = mine!.id;

    // 3. Seed subtask/handoff/child rows (DAG lanes) + a cost usage record.
    const db = openDb();
    seedPlanRows(db, {
      parentId,
      execHouseId,
      plan: [
        { planId: "s0", title: "Forge the keys", status: "completed", dependsOn: [], child: "completed" },
        { planId: "s1", title: "Carve the sigil", status: "in_flight", dependsOn: [], child: "running" },
        { planId: "s2", title: "Unlock the gate", status: "planned", dependsOn: ["s0", "s1"] },
      ],
    });
    db.prepare(
      `INSERT INTO execution_sessions (id, task_id, house_id, status, provider, model_id, created_at, updated_at)
       VALUES (?, ?, ?, 'completed', 'opencode', 'glm-5.3', ?, ?)`,
    ).run(`usagesess-${Date.now()}`, `${parentId}-child-s0`, execHouseId, now(), now());
    db.prepare(
      `INSERT INTO usage_records (id, session_id, task_id, house_id, model_id, provider, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cost, estimated, created_at)
       VALUES (?, (SELECT id FROM execution_sessions WHERE task_id = ? ORDER BY created_at DESC LIMIT 1), ?, ?, 'glm-5.3', 'opencode', 100, 50, 0, 0, 0.0123, 0, ?)`,
    ).run(`usage-${Date.now()}`, `${parentId}-child-s0`, `${parentId}-child-s0`, execHouseId, now());
    db.close();

    // 4. Plan board reflects the seeded DAG. First confirm the plan API carries
    // the seeded subtasks, then re-navigate so the board fetches them.
    const planApi = await request.get(`/api/tasks/${parentId}/plan`);
    expect(planApi.status()).toBe(200);
    const planBody = (await planApi.json()) as { plan: { subtasks: Array<{ planId: string }> } };
    expect(planBody.plan.subtasks.length).toBe(3);

    await page.goto("/high-lord");
    await expect(page.getByTestId("subtask-s0")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("subtask-s0")).toContainText("completed");
    await expect(page.getByTestId("subtask-s1")).toContainText("s1");
    await expect(page.getByTestId("subtask-s1")).toContainText("carve the sigil", { ignoreCase: true });
    await expect(page.getByTestId("subtask-s2")).toContainText("← s0");
    await expect(page.getByTestId("subtask-s2")).toContainText("← s1");
    // House chip on a delegated subtask.
    await expect(page.getByTestId("subtask-s0")).toContainText("Forge House");
    // Cost rollup.
    await expect(page.getByText(/Cost:/)).toBeVisible();

    // 5. Composer stays enabled while a plan is active (steering, D2e).
    await expect(page.getByPlaceholder("Instruct the High Lord…")).toBeEnabled();

    // Cleanup: archive + delete the agent house.
    await request.patch(`/api/houses/${execHouseId}`, {
      data: { status: "archived" },
      headers: { "Content-Type": "application/json" },
    });
    await request.delete(`/api/houses/${execHouseId}`);
  });

  test("aborted plan shows the court burning banner (reduced-motion safe)", async ({ page, request }) => {
    const hlId = await highLordId(request);
    await page.goto("/houses");
    await createHouseViaForm(page, { houseName: "Abort House", agentName: "A", agentRole: "R" });
    const execHouseId = await findAgentHouseId(request, "Abort House");

    const db = openDb();
    const { parentId } = seedParentAndSession(db, {
      hlId,
      title: "Doomed quest",
      status: "failed",
      instruction: "A quest that collapsed",
    });
    seedPlanRows(db, {
      parentId,
      execHouseId,
      plan: [
        { planId: "s0", title: "Partial", status: "completed", dependsOn: [], child: "completed" },
        { planId: "s1", title: "Never finished", status: "cancelled", dependsOn: ["s0"] },
      ],
    });
    db.prepare(
      `UPDATE tasks SET execution_preferences = '{"plan":{"abortReason":"retries_exhausted"}}' WHERE id = ?`,
    ).run(parentId);
    db.close();

    await page.goto("/high-lord");
    await expect(
      page.getByTestId("court-abort").or(page.getByTestId("court-abort-static")),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Plan aborted/i).first()).toBeVisible();

    // Cleanup.
    await request.patch(`/api/houses/${execHouseId}`, {
      data: { status: "archived" },
      headers: { "Content-Type": "application/json" },
    });
    await request.delete(`/api/houses/${execHouseId}`);
  });

  test("map shows the gold High Lord castle with aborted plan-state override", async ({ page, request }) => {
    const hlId = await highLordId(request);
    const db = openDb();
    seedParentAndSession(db, {
      hlId,
      title: "Doomed map quest",
      status: "failed",
      instruction: "A quest on the map",
    });
    db.prepare(
      `UPDATE tasks SET execution_preferences = '{"plan":{"abortReason":"retries_exhausted"}}'
       WHERE house_id = ? AND title = 'Doomed map quest'`,
    ).run(hlId);
    db.close();

    await page.goto("/map");
    const castle = page.getByTestId(`map-castle-${hlId}`);
    await expect(castle).toBeVisible();
    await expect(castle).toHaveAttribute("data-kind", "high_lord");
    await expect(castle).toHaveAttribute("data-plan-state", "aborted");
    await expect(
      page.getByTestId("map-castle-burning").or(page.getByTestId("map-castle-burning-static")),
    ).toBeVisible();
  });
});

test.describe("Direct-to-house regression (acceptance §16)", () => {
  test("a normal quest still assigned to a house shows queued on the Quest Board", async ({ page, request }) => {
    await page.goto("/houses");
    await createHouseViaForm(page, { houseName: "Regress House", agentName: "R", agentRole: "R" });
    const houseId = await findAgentHouseId(request, "Regress House");

    // Assign directly (bypassing the High Lord).
    const taskRes = await request.post("/api/tasks", {
      data: { title: "Direct quest", houseId },
      headers: { "Content-Type": "application/json" },
    });
    const { task } = await (taskRes).json() as { task: { id: string; status: string } };
    expect(task.status).toBe("queued");

    // Quest board shows it (and it is not on the HL house).
    await page.goto("/quests");
    await expect(page.getByRole("row").filter({ hasText: "Direct quest" })).toBeVisible();

    // Cleanup.
    await request.patch(`/api/houses/${houseId}`, {
      data: { status: "archived" },
      headers: { "Content-Type": "application/json" },
    });
    await request.delete(`/api/houses/${houseId}`);
  });
});
