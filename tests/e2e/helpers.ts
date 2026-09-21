/**
 * Shared helpers for the Velaris E2E suite.
 *
 * The Playwright webServer runs against an isolated E2E database
 * (db/velaris-e2e.db — wiped by the webServer command), so every test run
 * starts from a clean slate with the two seeded default provider configs.
 */

import { expect, type Page } from "@playwright/test";

/** The 8 nav sections (must match src/shared/constants.ts NAV_SECTIONS). */
export const NAV_SECTIONS = [
  { href: "/", name: "Velaris", heading: "Velaris" },
  { href: "/high-lord", name: "High Lord's Court", heading: "High Lord's Court" },
  { href: "/houses", name: "The Houses", heading: "The Houses" },
  { href: "/quests", name: "Quest Board", heading: "Quest Board" },
  { href: "/roost", name: "Messenger Roost", heading: "Messenger Roost" },
  { href: "/archives", name: "Archives", heading: "Archives" },
  { href: "/projects", name: "Projects", heading: "Projects" },
  { href: "/settings", name: "Settings", heading: "Settings" },
] as const;

/** Click a sidebar nav link by its visible name. */
export async function navigate(page: Page, name: string): Promise<void> {
  await page.getByRole("link", { name: new RegExp(name) }).first().click();
}

/**
 * Create a house through the UI (the §5.6 smoke journey form).
 * Fills Identity + Agent tabs; the other tabs keep their defaults.
 */
export async function createHouseViaForm(
  page: Page,
  opts: {
    houseName?: string;
    description?: string;
    agentName?: string;
    agentRole?: string;
    systemPrompt?: string;
  } = {},
): Promise<void> {
  const {
    houseName = "House of Shadows",
    description = "Quiet, precise engineering work after dark",
    agentName = "Azriel",
    agentRole = "Shadow-singer · senior engineer",
    systemPrompt = "You are Azriel, keeper of shadows.",
  } = opts;

  await page.getByRole("button", { name: "New house" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // Identity tab (default)
  await dialog.getByLabel("Name", { exact: true }).fill(houseName);
  await dialog.getByLabel("Description").fill(description);

  // Agent tab
  await dialog.getByRole("tab", { name: "Agent" }).click();
  await dialog.getByLabel("Agent name").fill(agentName);
  await dialog.getByLabel("Agent role").fill(agentRole);
  await dialog.getByLabel("System prompt").fill(systemPrompt);

  await dialog.getByRole("button", { name: "Create house" }).click();
  await expect(dialog).not.toBeVisible();
}