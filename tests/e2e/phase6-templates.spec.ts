/**
 * E2E — Phase 6 Stage C templates (engine OFF).
 *
 * The §10 acceptance criterion: a seeded template instantiates a fully
 * configured house via the UI. Also instantiates a project template (directory
 * supplied) and asserts it appears on /projects.
 *
 * Web-only: template + instantiation writes are web-owned user-action rows.
 * Cleanup keeps the shared e2e DB tidy for later specs.
 */

import { test, expect } from "@playwright/test";

test.describe("Phase 6 — house & project templates", () => {
  test("instantiate a seeded house template and a project template", async ({ page, request }) => {
    // --- House template instantiation via the Houses page affordance ---
    await page.goto("/houses");
    await page.getByTestId("new-from-template").click();

    const dialog = page.getByTestId("template-picker");
    await expect(dialog).toBeVisible();

    // Pick the seeded "Day Court" (default badge).
    await dialog.getByText("Day Court", { exact: true }).click();
    const houseName = "Templated Day Court";
    await dialog.getByLabel("House name").fill(houseName);
    await dialog.getByTestId("template-instantiate").click();
    await expect(dialog).not.toBeVisible();

    // The new house shows on the grid; resolve its id for a detail check.
    await expect(page.getByText(houseName).first()).toBeVisible();
    const houses = (
      await (await request.get("/api/houses?includeArchived=false")).json()
    ).houses as Array<{ id: string; name: string; configuration: { modelId: string; approvalPolicy: string } }>;
    const house = houses.find((h) => h.name === houseName)!;
    expect(house).toBeTruthy();
    // Fully configured from the template payload.
    expect(house.configuration.modelId).toBe("deepseek-v4.1-flash");
    expect(house.configuration.approvalPolicy).toBe("risky_only");

    // Detail page shows the configured model.
    await page.goto(`/houses/${house.id}`);
    await expect(page.getByText("deepseek-v4.1-flash").first()).toBeVisible();

    // --- Project template instantiation via the Projects page ---
    await page.goto("/projects");
    await page.getByTestId("new-from-template").click();
    const projDialog = page.getByTestId("template-picker");
    await expect(projDialog).toBeVisible();
    await projDialog.getByText("Standard Repo", { exact: true }).click();
    const projectName = `Templated Repo ${Date.now()}`;
    await projDialog.getByLabel("Project name").fill(projectName);
    await projDialog.getByLabel("Directory (absolute)").fill(process.cwd());
    await projDialog.getByTestId("template-instantiate").click();
    await expect(projDialog).not.toBeVisible();

    await expect(page.getByText(projectName).first()).toBeVisible();

    // --- Settings shows the template manager with seeded + user templates ---
    await page.goto("/settings");
    const manager = page.getByTestId("template-manager-card");
    await expect(manager).toBeVisible();
    await expect(manager.getByText("Day Court").first()).toBeVisible();
    await expect(manager.getByText("seeded").first()).toBeVisible();

    // Cleanup: delete the project + archive/delete the house.
    const projects = (
      await (await request.get("/api/projects")).json()
    ).projects as Array<{ id: string; name: string }>;
    const project = projects.find((p) => p.name === projectName);
    if (project) await request.delete(`/api/projects/${project.id}`);
    await request.patch(`/api/houses/${house.id}`, {
      data: { status: "archived" },
      headers: { "Content-Type": "application/json" },
    });
    await request.delete(`/api/houses/${house.id}`);
  });
});
