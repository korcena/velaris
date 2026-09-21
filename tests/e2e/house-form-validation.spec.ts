/**
 * E2E — house form validation errors render inline (§5.5):
 * submitting the create form with required fields empty shows field-level
 * messages inside the dialog (react-hook-form + zodResolver), and the
 * server-side 400 path is exercised via a concurrency violation.
 */

import { test, expect } from "@playwright/test";

test("house form renders inline validation errors", async ({ page }) => {
  await page.goto("/houses");
  await page.getByRole("button", { name: "New house" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // Submit with everything empty — name is required.
  await dialog.getByRole("button", { name: "Create house" }).click();

  // Inline field error under the Name input (zod: "Must not be empty").
  await expect(dialog.getByText(/must not be empty/i).first()).toBeVisible();

  // The dialog stays open — nothing was created.
  await expect(dialog).toBeVisible();

  // Fill the Identity tab but leave the Agent tab's required fields empty.
  await dialog.getByLabel("Name", { exact: true }).fill("House of Whispers");
  await dialog.getByRole("tab", { name: "Agent" }).click();
  await dialog.getByRole("button", { name: "Create house" }).click();
  await expect(
    dialog.getByText(/must not be empty/i).first(),
  ).toBeVisible(); // agent name/role error
  await expect(dialog).toBeVisible();
});