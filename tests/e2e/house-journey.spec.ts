/**
 * E2E — the Phase 1 smoke journey (IMPLEMENTATION_PLAN §5.6):
 *
 * open /, navigate to Houses via the sidebar, create House of Shadows via
 * the form (name, description, agent name, role, Identity + Agent tabs),
 * see it in the grid, edit it (change description), disable it (verify the
 * status badge change), then archive it and verify it disappears from the
 * default list and appears under the archived filter.
 */

import { test, expect } from "@playwright/test";
import { navigate, createHouseViaForm } from "./helpers";

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

    // Fresh E2E DB: the empty state invites us to found a house.
    await expect(page.getByText("The city's great houses lie empty.")).toBeVisible();

    // 2. Create House of Shadows through the form.
    await createHouseViaForm(page, {});

    // 3. It appears in the grid with an Active badge.
    const card = page.locator("div").filter({ hasText: /^House of Shadows$/ }).first();
    await expect(page.getByText("House of Shadows", { exact: true })).toBeVisible();
    await expect(page.getByText("Azriel", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Active", { exact: true }).first()).toBeVisible();

    // 4. Edit it — change the description.
    await page.getByRole("button", { name: "Edit" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Edit — House of Shadows")).toBeVisible();
    await dialog.getByLabel("Description").fill("Reborn in mist and moonlight");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByText("Reborn in mist and moonlight").first()).toBeVisible();

    // 5. Disable it — confirm dialog, then the badge flips to Disabled.
    await page.getByRole("button", { name: "Disable" }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByText("Disabled", { exact: true }).first()).toBeVisible();

    // The toggle button now offers Enable (disabled → active is legal).
    await expect(page.getByRole("button", { name: "Enable" })).toBeVisible();

    // 6. Archive it — hidden from the default list…
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByText("House of Shadows", { exact: true })).toHaveCount(0);

    // …and visible under the archived filter.
    await page.getByRole("button", { name: /Show archived|Showing archived/ }).click();
    await expect(page.getByText("House of Shadows", { exact: true })).toBeVisible();
    await expect(page.getByText("Archived", { exact: true }).first()).toBeVisible();

    // 7. Delete is only offered once archived.
    await expect(page.getByRole("button", { name: "Delete" })).toBeVisible();
  });
});