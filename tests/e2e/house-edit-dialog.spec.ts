/**
 * E2E — edit-dialog integrity: the form must always initialize from the
 * house being edited, never from stale state (a previously created/edited
 * house). Regression test for the keyed-remount fix: without it, editing
 * house B after creating/editing house A showed A's values and saving
 * silently overwrote B's configuration with A's.
 *
 * Cleanup: this spec creates houses that later spec files must not see — the
 * suite shares one E2E DB — so the houses it created are archived + deleted in
 * afterAll. It must NEVER touch the ten seeded default houses (they are the
 * shared fixture), so cleanup is scoped to this spec's own names.
 */

import { test, expect } from "@playwright/test";
import { createHouseViaForm, houseCard } from "./helpers";

const CREATED_HOUSES = ["House B", "House A", "House R"];

test.describe("house edit dialog", () => {
  test("edit pre-fills the target house's values; no cross-house leakage", async ({ page }) => {
    await page.goto("/houses");

    // Two houses with distinct values. Scope Edit clicks to each house's own
    // card — the grid also holds the ten seeded default houses.
    await createHouseViaForm(page, { houseName: "House B", agentName: "AgentB", agentRole: "RoleB" });
    await createHouseViaForm(page, { houseName: "House A", agentName: "AgentA", agentRole: "RoleA" });

    // Edit House B — the dialog must show B's values, not the stale values from
    // the just-created House A.
    await houseCard(page, "House B").getByRole("button", { name: "Edit" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("House B");
    await dialog.getByRole("tab", { name: "Agent" }).click();
    await expect(dialog.getByLabel("Agent name")).toHaveValue("AgentB");
    await expect(dialog.getByLabel("Agent role")).toHaveValue("RoleB");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).not.toBeVisible();

    // Edit House A → A's values (no leakage of B).
    await houseCard(page, "House A").getByRole("button", { name: "Edit" }).click();
    await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("House A");
    await dialog.getByRole("tab", { name: "Agent" }).click();
    await expect(dialog.getByLabel("Agent name")).toHaveValue("AgentA");
    await dialog.getByRole("button", { name: "Cancel" }).click();
  });

  test("edit pre-fills after a page reload (fresh component state)", async ({ page }) => {
    await page.goto("/houses");
    await createHouseViaForm(page, { houseName: "House R", agentName: "AgentR", agentRole: "RoleR" });

    await page.reload();
    await houseCard(page, "House R").getByRole("button", { name: "Edit" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // Without the keyed remount the form initialized blank (mount-time
    // `existing` was undefined) — the values must be the house's own.
    await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("House R");
    await dialog.getByRole("tab", { name: "Agent" }).click();
    await expect(dialog.getByLabel("Agent name")).toHaveValue("AgentR");
  });

  test.afterAll(async ({ request }) => {
    // Archive + delete ONLY the houses this spec created, so later spec files
    // see a clean DB and the ten seeded default houses survive (they are the
    // shared fixture; bootstrap is once-per-process and would not re-seed them).
    const body = (await (await request.get("/api/houses?includeArchived=true")).json()) as {
      houses: { id: string; name: string }[];
    };
    for (const house of body.houses) {
      if (!CREATED_HOUSES.includes(house.name)) continue;
      await request.patch(`/api/houses/${house.id}`, {
        data: { status: "archived" },
        headers: { "Content-Type": "application/json" },
      });
      await request.delete(`/api/houses/${house.id}`);
    }
  });
});
