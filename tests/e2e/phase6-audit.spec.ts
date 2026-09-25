/**
 * E2E — Phase 6 Stage A audit log surfaced in Settings (engine OFF).
 *
 * Creates a house through the standard house form, then asserts the Settings
 * "Audit Log" card lists the resulting `create house` entry. Web-only: the audit
 * row is written by the web process, so no engine is required.
 *
 * The e2e DB is shared and wiped by the Playwright webServer command; other
 * specs may also append audit rows, so assertions target the specific house.
 */

import { test, expect } from "@playwright/test";
import { createHouseViaForm, navigate } from "./helpers";

test.describe("Phase 6 — Settings audit log card", () => {
  test("a house created via the UI appears in the Settings Audit Log", async ({ page }) => {
    const houseName = "House of Audited Shadows";

    await page.goto("/houses");
    await createHouseViaForm(page, { houseName });

    await navigate(page, "Settings");
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();

    const card = page.getByTestId("audit-log-card");
    await expect(card).toBeVisible();
    await expect(card.getByText("Audit Log")).toBeVisible();

    // The card lists the create entry for this house (newest-first).
    const entries = page.getByTestId("audit-log-entries");
    await expect(entries).toBeVisible();
    await expect(entries.getByText(houseName).first()).toBeVisible();
    await expect(
      entries.getByText("house", { exact: true }).first(),
    ).toBeVisible();
    await expect(entries.getByText("create", { exact: true }).first()).toBeVisible();
  });
});
