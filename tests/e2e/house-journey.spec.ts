/**
 * E2E — the Phase 1 smoke journey (IMPLEMENTATION_PLAN §5.6):
 *
 * open /, navigate to Houses via the sidebar, see the ten seeded default
 * ACOTAR houses in the grid, create House of Shadows via the form (name,
 * description, agent name, role, Identity + Agent tabs), edit it (change
 * description), disable it (verify the status badge change), then archive it
 * and verify it disappears from the default list and appears under the
 * archived filter.
 */

import { test, expect } from "@playwright/test";
import { navigate, createHouseViaForm, houseCard } from "./helpers";

test.describe("Phase 1 smoke — House of Shadows", () => {
  test("dashboard renders the city", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Velaris", exact: true })).toBeVisible();
  });

  test("create, edit, disable, archive a house end-to-end", async ({ page }) => {
    // 1. Open the dashboard and walk to The Houses via the sidebar.
    await page.goto("/");
    await navigate(page, "The Houses");
    await expect(page.getByRole("heading", { name: "The Houses" })).toBeVisible();

    // Boot seeds the ten default ACOTAR houses, so the grid is populated from
    // the first visit (the old empty state is gone by design).
    await expect(page.getByText("Day Court", { exact: true })).toBeVisible();
    await expect(page.getByText("Helion", { exact: true }).first()).toBeVisible();

    // 2. Create House of Shadows through the form.
    await createHouseViaForm(page, {});

    // 3. It appears in the grid with an Active badge. Scope to its own card:
    // the seeded defaults contribute many Edit/Disable/Archive buttons now.
    const card = houseCard(page, "House of Shadows");
    await expect(page.getByText("House of Shadows", { exact: true })).toBeVisible();
    await expect(card.getByText("Azriel", { exact: true })).toBeVisible();
    await expect(card.getByText("Active", { exact: true })).toBeVisible();

    // 4. Edit it — change the description.
    await card.getByRole("button", { name: "Edit" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Edit — House of Shadows")).toBeVisible();
    await dialog.getByLabel("Description").fill("Reborn in mist and moonlight");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByText("Reborn in mist and moonlight").first()).toBeVisible();

    // 5. Disable it — confirm dialog, then the badge flips to Disabled.
    await card.getByRole("button", { name: "Disable" }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(card.getByText("Disabled", { exact: true })).toBeVisible();

    // The toggle button now offers Enable (disabled → active is legal).
    await expect(card.getByRole("button", { name: "Enable" })).toBeVisible();

    // 6. Archive it — hidden from the default list…
    await card.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByText("House of Shadows", { exact: true })).toHaveCount(0);

    // …and visible under the archived filter.
    await page.getByRole("button", { name: /Show archived|Showing archived/ }).click();
    await expect(page.getByText("House of Shadows", { exact: true })).toBeVisible();
    const archivedCard = houseCard(page, "House of Shadows");
    await expect(archivedCard.getByText("Archived", { exact: true })).toBeVisible();

    // 7. Delete is only offered once archived.
    await expect(archivedCard.getByRole("button", { name: "Delete" })).toBeVisible();
  });
});
