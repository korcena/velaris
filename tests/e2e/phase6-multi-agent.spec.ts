/**
 * E2E — Phase 6 Stage B multi-agent houses (engine OFF).
 *
 * Creates a house via the standard form, adds a second agent through the
 * house-detail "Agents" panel, and asserts:
 *  - the new agent persists (GET /api/houses/{id} → agents[]);
 *  - the Quest Board offers an agent picker for a multi-agent house, and a
 *    quest posted against the second agent round-trips `agentId`.
 *
 * Cleanup: archive + delete the house created here so later spec files see a
 * clean grid (the e2e DB is shared, workers: 1).
 */

import { test, expect } from "@playwright/test";
import { createHouseViaForm } from "./helpers";

test.describe("Phase 6 — multi-agent houses", () => {
  test("add a second agent and target it from the Quest Board", async ({ page, request }) => {
    const houseName = "House of Many Voices";
    await page.goto("/houses");
    await createHouseViaForm(page, { houseName });

    // Resolve the created house id via the API.
    const houses = (
      await (await request.get("/api/houses?includeArchived=false")).json()
    ).houses as Array<{ id: string; name: string }>;
    const house = houses.find((h) => h.name === houseName)!;
    expect(house).toBeTruthy();

    // House detail → Agents tab → add a second agent.
    await page.goto(`/houses/${house.id}`);
    await page.getByRole("tab", { name: "Agents" }).click();
    const panel = page.getByTestId("house-agents-panel");
    await expect(panel).toBeVisible();

    await panel.getByRole("button", { name: "Add agent" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Name").fill("Nesta");
    await dialog.getByLabel("Role").fill("Librarian · archivist");
    await dialog.getByLabel("System prompt").fill("You are Nesta, keeper of the archives.");
    await dialog.getByRole("button", { name: "Add agent" }).click();
    await expect(dialog).not.toBeVisible();

    // Persistence: the detail endpoint lists both agents, oldest-first.
    const detail = (await (await request.get(`/api/houses/${house.id}`)).json()).house as {
      agent: { name: string };
      agents: Array<{ id: string; name: string }>;
    };
    expect(detail.agents.map((a) => a.name)).toEqual(["Azriel", "Nesta"]);
    expect(detail.agent.name).toBe("Azriel"); // default = oldest, unchanged
    const nesta = detail.agents.find((a) => a.name === "Nesta")!;

    // Quest Board offers the agent picker for the multi-agent house.
    await page.goto("/quests");
    await page.getByRole("button", { name: "New quest" }).click();
    const questDialog = page.getByRole("dialog");
    await questDialog.getByLabel("Title").fill("Catalogue the library");
    // Select the house.
    await questDialog.getByTestId("house-select").click();
    await page.getByRole("option", { name: houseName }).click();
    // The agent picker appears (agent-select testid).
    const agentSelect = questDialog.getByTestId("agent-select");
    await expect(agentSelect).toBeVisible();
    await agentSelect.click();
    await page.getByRole("option", { name: /Nesta/ }).click();
    await questDialog.getByRole("button", { name: "Post quest" }).click();
    await expect(questDialog).not.toBeVisible();

    // The posted quest carries the targeted agentId.
    const tasks = (await (await request.get(`/api/tasks?houseId=${house.id}`)).json()).tasks as Array<{
      id: string;
      title: string;
      agentId: string | null;
    }>;
    const quest = tasks.find((t) => t.title === "Catalogue the library")!;
    expect(quest.agentId).toBe(nesta.id);

    // Cleanup: delete the quest, then archive + delete the house (keeps the
    // shared e2e DB tidy for future specs).
    await request.delete(`/api/tasks/${quest.id}`);
    await request.patch(`/api/houses/${house.id}`, {
      data: { status: "archived" },
      headers: { "Content-Type": "application/json" },
    });
    await request.delete(`/api/houses/${house.id}`);
  });
});
