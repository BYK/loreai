import { expect, test, type Page } from "@playwright/test";

/**
 * UI-08 project actions against the seeded throw-away gateway. Every
 * destructive assertion runs on a per-viewport, per-retry disposable project
 * (`pa-<tag>-<run>-<letter>`) so parallel specs keep their own fixtures.
 */

const tagFor = (projectName: string) =>
  projectName.startsWith("mobile") ? "mobile" : "desktop";

async function projectIdByName(page: Page, name: string) {
  const response = await page.request.get("/api/v1/projects");
  expect(response.ok()).toBe(true);
  const projects = (await response.json()) as { id: string; name: string }[];
  const project = projects.find((p) => p.name === name);
  if (!project) throw new Error(`seeded project ${name} not found`);
  return project.id;
}

async function gotoProject(page: Page, name: string) {
  const id = await projectIdByName(page, name);
  await page.goto(`/ui/projects/${id}`);
  await expect(page.getByTestId("project-actions")).toBeVisible();
  return id;
}

test.describe("project actions (UI-08)", () => {
  test("rename persists after reload and rejects an empty name", async ({
    page,
  }, testInfo) => {
    const tag = tagFor(testInfo.project.name);
    const run = testInfo.retry + 1;
    const original = `pa-${tag}-${run}-a`;
    const renamed = `${original}-renamed`;
    await gotoProject(page, original);

    const actions = page.getByTestId("project-actions");
    await actions.getByRole("button", { name: "Rename…" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Rename project")).toBeVisible();

    const input = dialog.getByLabel("Project name");
    await expect(input).toHaveValue(original);
    const save = dialog.getByRole("button", { name: "Save" });

    // Client-side validation: an empty name cannot be submitted.
    await input.fill("   ");
    await expect(save).toBeDisabled();

    await input.fill(renamed);
    await save.click();
    await expect(actions.getByTestId("action-notice-result")).toContainText(
      renamed,
    );

    // The write persisted — a reload re-reads the stored name.
    await page.reload();
    await expect(page.getByRole("heading", { name: renamed })).toBeVisible();
    await expect(
      page.request.get("/api/v1/projects").then(async (r) => {
        const projects = (await r.json()) as { name: string }[];
        return projects.some((p) => p.name === renamed);
      }),
    ).resolves.toBe(true);
  });

  test("clear empties the project's knowledge list", async ({
    page,
  }, testInfo) => {
    const tag = tagFor(testInfo.project.name);
    const name = `pa-${tag}-${testInfo.retry + 1}-b`;
    const id = await gotoProject(page, name);
    await expect(
      page.getByTestId("health").getByText("1 knowledge"),
    ).toBeVisible();

    await page
      .getByTestId("project-actions")
      .getByRole("button", { name: "Clear…" })
      .click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(name);
    await dialog.getByRole("button", { name: "Clear project data" }).click();
    await expect(
      page.getByTestId("project-actions").getByTestId("action-notice-result"),
    ).toContainText("Cleared");

    await page.goto(`/ui/projects/${id}/knowledge`);
    await expect(page.getByText("No knowledge")).toBeVisible();
  });

  test("delete removes the project and redirects to the list", async ({
    page,
  }, testInfo) => {
    const tag = tagFor(testInfo.project.name);
    const name = `pa-${tag}-${testInfo.retry + 1}-c`;
    await gotoProject(page, name);

    await page
      .getByTestId("project-actions")
      .getByRole("button", { name: "Delete project…" })
      .click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(name);
    await dialog.getByRole("button", { name: "Delete project" }).click();

    await expect(page).toHaveURL(/\/ui\/?$/);
    await expect(page.getByRole("link", { name })).toHaveCount(0);
    const projects = (await (
      await page.request.get("/api/v1/projects")
    ).json()) as { name: string }[];
    expect(projects.some((p) => p.name === name)).toBe(false);
  });

  test("move a session from scratch to lore", async ({ page }, testInfo) => {
    const tag = tagFor(testInfo.project.name);
    const run = testInfo.retry + 1;
    const sessionId = `e2e-session-scratch-${tag}-${run}`;
    const scratchId = await projectIdByName(page, "scratch");
    const loreId = await projectIdByName(page, "lore");
    await page.goto(`/ui/projects/${scratchId}`);
    await expect(page.getByTestId("project-actions")).toBeVisible();

    await page
      .getByTestId("project-actions")
      .getByRole("button", { name: "Move sessions…" })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("checkbox", { name: new RegExp(sessionId) }).check();
    const target = dialog.getByRole("button", { name: "Target project" });
    await expect(target).toBeEnabled();
    await target.click();
    // The Kobalte Select popup portals outside the dialog — which the modal
    // dialog marks aria-hidden — so role queries can't see the options, and
    // with many seeded projects "lore" sits outside the listbox scrollport,
    // so a normal click cannot scroll it into view. dispatchEvent still runs
    // the item's real click handler.
    await page
      .locator("[role='option']")
      .filter({ hasText: "lore" })
      .dispatchEvent("click");
    await dialog.getByRole("button", { name: /Move \d+ session/ }).click();
    await expect(
      page.getByTestId("project-actions").getByTestId("action-notice-result"),
    ).toContainText("Moved 1 session");

    await page.goto(`/ui/projects/${loreId}/sessions`);
    await expect(page.getByRole("link", { name: sessionId })).toBeVisible();
  });

  test("move dialog keeps focus trapped after the target select closes", async ({
    page,
  }) => {
    const scratchId = await projectIdByName(page, "scratch");
    await page.goto(`/ui/projects/${scratchId}`);
    const actions = page.getByTestId("project-actions");
    await actions.getByRole("button", { name: "Delete project…" }).click();
    await page.keyboard.press("Escape");
    await actions.getByRole("button", { name: "Move sessions…" }).click();
    const dialog = page.getByRole("dialog");
    const target = dialog.getByRole("button", { name: "Target project" });
    await expect(target).toBeEnabled();
    await target.click();
    await page.keyboard.press("Escape");
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(
        () => document.activeElement?.closest("[role='dialog']") !== null,
      );
      expect(inside, `Tab ${i} left the dialog`).toBe(true);
    }
  });

  test("merge duplicates reports none on the seeded data", async ({ page }) => {
    await page.goto("/ui/");
    await expect(page.getByTestId("merge-projects")).toBeVisible();
    await page
      .getByTestId("merge-projects")
      .getByRole("button", { name: "Merge duplicate projects" })
      .click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Merge duplicates" })
      .click();
    await expect(
      page.getByTestId("merge-projects").getByTestId("action-notice-result"),
    ).toContainText("No duplicates found");
  });
});
