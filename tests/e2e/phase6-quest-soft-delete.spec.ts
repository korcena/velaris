/**
 * E2E — Phase 6 quest soft-delete (engine OFF).
 *
 * The Quest Board can remove a posting without destroying history:
 *  - a terminal (cancelled) quest is deleted → it leaves /quests;
 *  - it remains in /archives, marked "deleted", with a Restore button;
 *  - restoring clears the marker and the badge disappears.
 *
 * Cleanup: detach + soft-delete the quest, then archive + delete the house so
 * later specs see a clean board/grid (the e2e DB is shared, workers: 1).
 */

import { test, expect } from "@playwright/test";
import { createHouseViaForm } from "./helpers";

test.describe("Phase 6 — quest soft-delete", () => {
  test("delete hides a quest from the board and it is restorable from Archives", async ({
    page,
    request,
  }) => {
    const houseName = `House of Fading Echoes ${Date.now()}`;
    const title = `Vanishing Quest ${Date.now()}`;

    // Create a house so the quest has a home, then resolve its id via the API.
    await page.goto("/houses");
    await createHouseViaForm(page, { houseName });
    const houses = (
      await (await request.get("/api/houses?includeArchived=false")).json()
    ).houses as Array<{ id: string; name: string }>;
    const house = houses.find((h) => h.name === houseName)!;
    expect(house).toBeTruthy();

    // Post a quest, then cancel it (a queued quest is deletable too, but a
    // cancelled one is guaranteed to appear in Archives).
    const created = await request.post("/api/tasks", {
      data: { title, houseId: house.id },
      headers: { "Content-Type": "application/json" },
    });
    expect(created.status()).toBe(201);
    const task = (await created.json()).task as { id: string };
    expect(
      (
        await request.patch(`/api/tasks/${task.id}`, {
          data: { status: "cancelled" },
          headers: { "Content-Type": "application/json" },
        })
      ).status(),
    ).toBe(200);

    // /quests: the row is present; Delete → confirm removes it.
    await page.goto("/quests");
    await expect(page.getByText(title, { exact: true })).toBeVisible();
    await page.getByTestId(`quest-delete-${task.id}`).click();
    await page.getByTestId("quest-delete-confirm").click();
    await expect(page.getByText(title, { exact: true })).toHaveCount(0);

    // /archives: the task is present with the "deleted" badge.
    await page.goto("/archives");
    await page.getByTestId("archives-search").fill(title);
    await expect(page.getByTestId("archives-total")).toHaveText(/1 archived/);
    await expect(page.getByTestId(`archive-deleted-${task.id}`)).toBeVisible();

    // Restore → the badge disappears.
    await page.getByTestId(`archive-restore-${task.id}`).click();
    await expect(page.getByTestId(`archive-deleted-${task.id}`)).toHaveCount(0);

    // Cleanup: detach the quest from the house (so the house can be deleted),
    // then archive + delete the house. The restored quest stays live/house-less.
    await request.patch(`/api/tasks/${task.id}`, {
      data: { houseId: null },
      headers: { "Content-Type": "application/json" },
    });
    await request.delete(`/api/tasks/${task.id}`); // soft delete again (keeps the board clean)
    await request.patch(`/api/houses/${house.id}`, {
      data: { status: "archived" },
      headers: { "Content-Type": "application/json" },
    });
    await request.delete(`/api/houses/${house.id}`);
  });
});
