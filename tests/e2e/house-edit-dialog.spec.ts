/**
 * E2E — edit-dialog integrity: the form must always initialize from the
 * house being edited, never from stale state (a previously created/edited
 * house). Regression test for the keyed-remount fix: without it, editing
 * house B after creating/editing house A showed A's values and saving
 * silently overwrote B's configuration with A's.
 *
 * Cleanup: this spec creates houses that later spec files (house-journey)
 * must not see — the suite shares one E2E DB — so every house created here
 * is archived + deleted in afterAll, restoring the empty-houses state.
 */

import { test, expect } from "@playwright/test";
import { createHouseViaForm } from "./helpers";

test.describe("house edit dialog", () => {
  test("edit pre-fills the target house's values; no cross-house leakage", async ({ page }) => {
    await page.goto("/houses");

    // Two houses with distinct values. Grid is newest-first: A is card 1, B card 2.
    await createHouseViaForm(page, { houseName: "House B", agentName: "AgentB", agentRole: "RoleB" });
    await createHouseViaForm(page, { houseName: "House A", agentName: "AgentA", agentRole: "RoleA" });

    // Edit House B (second card) — the dialog must show B's values, not the
    // stale values from the just-created House A.
    await page.getByRole("button", { name: "Edit" }).nth(1).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("House B");
    await dialog.getByRole("tab", { name: "Agent" }).click();
    await expect(dialog.getByLabel("Agent name")).toHaveValue("AgentB");
    await expect(dialog.getByLabel("Agent role")).toHaveValue("RoleB");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).not.toBeVisible();

    // Edit House A → A's values (no leakage of B).
    await page.getByRole("button", { name: "Edit" }).first().click();
    await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("House A");
    await dialog.getByRole("tab", { name: "Agent" }).click();
    await expect(dialog.getByLabel("Agent name")).toHaveValue("AgentA");
    await dialog.getByRole("button", { name: "Cancel" }).click();
  });

  test("edit pre-fills after a page reload (fresh component state)", async ({ page }) => {
    await page.goto("/houses");
    await createHouseViaForm(page, { houseName: "House R", agentName: "AgentR", agentRole: "RoleR" });

    await page.reload();
    await page.getByRole("button", { name: "Edit" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // Without the keyed remount the form initialized blank (mount-time
    // `existing` was undefined) — the values must be the house's own.
    await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("House R");
    await dialog.getByRole("tab", { name: "Agent" }).click();
    await expect(dialog.getByLabel("Agent name")).toHaveValue("AgentR");
  });

  test.afterAll(async ({ request }) => {
    // Archive + delete every house this spec created so later spec files
    // (house-journey expects "the great houses lie empty") see a clean grid.
    const res = await request.get("/api/houses?includeArchived=true");
    const body = (await res.json()) as { houses: { id: string }[] };
    for (const house of body.houses) {
      await request.patch(`/api/houses/${house.id}`, {
        data: { status: "archived" },
        headers: { "Content-Type": "application/json" },
      });
      await request.delete(`/api/houses/${house.id}`);
    }
  });
});