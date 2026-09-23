/**
 * E2E — navigation: all 9 sidebar sections render their pages, and the
 * sidebar marks the active section.
 */

import { test, expect } from "@playwright/test";
import { NAV_SECTIONS } from "./helpers";

test.describe("9 navigation sections", () => {
  for (const section of NAV_SECTIONS) {
    test(`renders ${section.name} at ${section.href}`, async ({ page }) => {
      const response = await page.goto(section.href);
      expect(response?.status()).toBe(200);

      // The page heading names the section.
      await expect(
        page.getByRole("heading", { name: section.heading, exact: true }).first(),
      ).toBeVisible();

      // The sidebar marks this section as active.
      const link = page
        .getByRole("link")
        .filter({ hasText: new RegExp(section.name) })
        .first();
      await expect(link).toHaveClass(/bg-primary/);
    });
  }

  test("sidebar shows all 9 sections", async ({ page }) => {
    await page.goto("/");
    const nav = page.locator("nav");
    for (const section of NAV_SECTIONS) {
      await expect(
        nav.getByRole("link").filter({ hasText: new RegExp(section.name) }).first(),
      ).toBeVisible();
    }
  });

  test("dashboard quick links work", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /Visit the Houses/ }).click();
    await expect(page.getByRole("heading", { name: "The Houses" })).toBeVisible();
  });
});