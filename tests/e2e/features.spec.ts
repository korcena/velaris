/**
 * E2E — quest board + projects + settings surfaces:
 *   - create a quest from the Quest Board, see it listed as queued
 *   - register a project (real absolute directory) via the UI
 *   - provider configs: seeded defaults visible in Settings
 *   - reduced-motion toggle flips the html class (and persists on reload)
 */

import { test, expect } from "@playwright/test";
import { navigate } from "./helpers";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test.describe("Quest Board", () => {
  test("create a quest; it is listed locked to 'queued'", async ({ page }) => {
    await page.goto("/quests");
    await expect(page.getByRole("heading", { name: "Quest Board" })).toBeVisible();
    await expect(page.getByText("No quests have been posted yet.")).toBeVisible();

    await page.getByRole("button", { name: "New quest" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Title", { exact: true }).fill("Map the city walls");
    await dialog.getByLabel("Description").fill("A cartography quest.");

    await dialog.getByRole("button", { name: "Post quest" }).click();
    await expect(dialog).not.toBeVisible();

    // The posting is listed with its locked status.
    await expect(page.getByRole("cell", { name: "Map the city walls" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "queued", exact: true })).toBeVisible();
  });
});

test.describe("Projects", () => {
  let projDir: string;

  test.beforeAll(() => {
    projDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-e2e-proj-"));
  });
  test.afterAll(() => {
    fs.rmSync(projDir, { recursive: true, force: true });
  });

  test("register a real directory; git info auto-detected", async ({ page }) => {
    await page.goto("/projects");
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    await expect(page.getByText("No projects registered.")).toBeVisible();

    await page.getByRole("button", { name: "Register project" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name", { exact: true }).fill("Velaris");
    await dialog.getByLabel("Directory (absolute)").fill(projDir);
    await dialog.getByRole("button", { name: "Register project" }).click();
    await expect(dialog).not.toBeVisible();

    await expect(page.getByText("Velaris", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(projDir).first()).toBeVisible();
    // Temp dir is not a git repo → no repository detected.
    await expect(page.getByText("No git repository detected.").first()).toBeVisible();
  });

  test("duplicate directory is rejected with an inline toast", async ({ page }) => {
    await page.goto("/projects");
    await page.getByRole("button", { name: "Register project" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name", { exact: true }).fill("Duplicate");
    await dialog.getByLabel("Directory (absolute)").fill(projDir);
    await dialog.getByRole("button", { name: "Register project" }).click();

    // The 409 surfaces as a sonner error toast.
    await expect(page.getByText(/already exists/i).first()).toBeVisible();
  });
});

test.describe("Settings", () => {
  test("provider configs: seeded defaults are visible", async ({ page }) => {
    await page.goto("/settings");
    await expect(
      page.getByRole("heading", { name: "Settings", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("OpenCode (local)")).toBeVisible();
    await expect(page.getByText("Ollama (local)")).toBeVisible();
  });

  test("reduced-motion toggle flips the html class and persists", async ({ page }) => {
    await page.goto("/settings");

    const html = page.locator("html");
    await expect(html).not.toHaveClass(/velaris-reduced-motion/);

    const toggle = page.getByRole("switch", { name: "Reduced motion" });
    await toggle.click();
    await expect(html).toHaveClass(/velaris-reduced-motion/);

    // Toggle persists across a reload (state AND effect).
    await page.reload();
    await expect(html).toHaveClass(/velaris-reduced-motion/);

    // Toggle back off.
    await page.getByRole("switch", { name: "Reduced motion" }).click();
    await expect(html).not.toHaveClass(/velaris-reduced-motion/);
  });
});

test.describe("Dark theme", () => {
  test("dark color scheme + Velaris background applied", async ({ page }) => {
    await page.goto("/");
    const scheme = await page.evaluate(
      () => getComputedStyle(document.documentElement).colorScheme,
    );
    expect(scheme).toBe("dark");

    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe("rgb(11, 16, 38)"); // --velaris-midnight #0b1026
  });

  test("prefers-reduced-motion: reduce collapses animations (OS-level respect)", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    const duration = await page.evaluate(() => {
      const el = document.createElement("div");
      el.style.animation = "spin 4s linear infinite";
      document.body.appendChild(el);
      const d = getComputedStyle(el).animationDuration;
      el.remove();
      return d;
    });
    // The global @media (prefers-reduced-motion: reduce) rule clamps animations
    // to ~0.01ms regardless of the specified 4s.
    expect(parseFloat(duration)).toBeLessThan(0.1);
  });
});