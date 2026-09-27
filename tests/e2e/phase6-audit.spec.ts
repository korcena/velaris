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

  test("export controls link at the export route (engine OFF)", async ({ page, request }) => {
    await page.goto("/settings");
    const card = page.getByTestId("audit-log-card");
    await expect(card).toBeVisible();

    // The two plain-anchor export controls point at the export route with the
    // current format. Engine is not required (web-only read).
    const csvLink = card.getByTestId("audit-log-export-csv");
    await expect(csvLink).toHaveAttribute("href", /\/api\/audit-log\/export\?format=csv/);
    const jsonLink = card.getByTestId("audit-log-export-json");
    await expect(jsonLink).toHaveAttribute("href", /\/api\/audit-log\/export\?format=json/);

    // The route itself responds as CSV/JSON without an engine.
    const csvRes = await request.get("/api/audit-log/export?format=csv");
    expect(csvRes.status()).toBe(200);
    expect(csvRes.headers()["content-type"]).toContain("text/csv");

    const jsonRes = await request.get("/api/audit-log/export?format=json");
    expect(jsonRes.status()).toBe(200);
    const body = (await jsonRes.json()) as { entries: unknown[] };
    expect(Array.isArray(body.entries)).toBe(true);
  });

  test("retention select persists to the default OpenCode provider extra", async ({ page, request }) => {
    await page.goto("/settings");
    const card = page.getByTestId("audit-log-card");
    await expect(card).toBeVisible();

    const trigger = card.getByRole("combobox", { name: "Audit log retention" });
    await expect(trigger).toBeEnabled();
    await trigger.click();
    await page.getByRole("option", { name: "30 days" }).click();

    // The write is audited automatically and visible via GET /api/provider-configs.
    await expect(page.getByText("Audit log retention: 30 days")).toBeVisible();
    const configs = (
      await (await request.get("/api/provider-configs")).json()
    ).providerConfigs as Array<{ type: string; isDefault: boolean; extra: Record<string, unknown> }>;
    const opencode = configs.find((c) => c.type === "opencode" && c.isDefault)!;
    expect((opencode.extra.audit as { retentionDays?: number }).retentionDays).toBe(30);

    // Round-trips: reload and the select shows 30 days.
    await page.reload();
    await expect(
      card.getByRole("combobox", { name: "Audit log retention" }),
    ).toHaveText(/30 days/);
  });
});
