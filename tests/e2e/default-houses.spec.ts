/**
 * E2E — the ten default ACOTAR houses (design spec §9).
 *
 * Boot seeds the ten houses, one agent each, so they are the shared fixture for
 * the whole suite. This spec asserts they appear on the houses list and as
 * castles on /map, and that a quest can be targeted at a specific seed house's
 * agent. It never archives or deletes a seeded house.
 */

import { test, expect } from "@playwright/test";
import { DEFAULT_HOUSES } from "../../src/shared/constants";

test.describe("default ACOTAR houses", () => {
  test("the ten seeded houses appear on the list and as castles on the map", async ({
    page,
    request,
  }) => {
    // --- Houses list: every seeded house + its agent is shown ---
    await page.goto("/houses");
    for (const h of DEFAULT_HOUSES) {
      await expect(page.getByText(h.house.name, { exact: true })).toBeVisible();
      await expect(page.getByText(h.agent.name, { exact: true }).first()).toBeVisible();
    }

    // Resolve each seeded house id via the API.
    const houses = (
      await (await request.get("/api/houses?includeArchived=false")).json()
    ).houses as Array<{ id: string; name: string }>;
    const seeded = DEFAULT_HOUSES.map((h) => ({
      def: h,
      row: houses.find((r) => r.name === h.house.name)!,
    }));
    for (const { def, row } of seeded) {
      expect(row, `missing seeded house ${def.house.name}`).toBeTruthy();
    }

    // --- Map: each seeded house renders as its own castle ---
    await page.goto("/map");
    for (const { def, row } of seeded) {
      const castle = page.getByTestId(`map-castle-${row.id}`);
      await expect(castle).toBeVisible();
      await expect(castle).toHaveAttribute("aria-label", def.house.name);
    }
  });

  test("a quest can be targeted at a specific seeded house/agent", async ({ page, request }) => {
    const houses = (
      await (await request.get("/api/houses?includeArchived=false")).json()
    ).houses as Array<{ id: string; name: string }>;
    const target = houses.find((h) => h.name === "House of Shadow")!;
    expect(target).toBeTruthy();

    // Resolve the seed agent belonging to the target house.
    const detail = (
      await (await request.get(`/api/houses/${target.id}`)).json()
    ).house as { agents: Array<{ id: string; name: string }> };
    const agent = detail.agents.find((a) => a.name === "Azriel")!;
    expect(agent).toBeTruthy();

    // Create a quest targeted at that specific house + agent.
    const title = `Hunt shadows ${Date.now()}`;
    const created = await request.post("/api/tasks", {
      data: { title, houseId: target.id, agentId: agent.id },
      headers: { "Content-Type": "application/json" },
    });
    expect(created.status()).toBe(201);
    const task = (await created.json()).task as {
      id: string;
      houseId: string | null;
      agentId: string | null;
    };
    expect(task.houseId).toBe(target.id);
    expect(task.agentId).toBe(agent.id);

    // It is visible on the Quest Board.
    await page.goto("/quests");
    await expect(page.getByText(title, { exact: true })).toBeVisible();

    // Cleanup: remove the quest so later specs relying on the empty board pass
    // (the seeded houses remain the shared fixture).
    expect((await request.delete(`/api/tasks/${task.id}`)).status()).toBe(204);
  });
});
