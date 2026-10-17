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
    const target = dialog.getByRole("combobox", { name: "Target project" });
    await expect(target).toBeEnabled();
    await expect(target).toHaveAttribute("aria-expanded", "false");
    await dialog.getByRole("checkbox", { name: new RegExp(sessionId) }).check();
    // Every fixture path contains "lore-ui-e2e"; include the project suffix
    // so keyboard selection does not depend on recency among tied path hits.
    await target.fill("projects/lroe");
    await expect(dialog.getByRole("option", { name: /^lore/ })).toContainText(
      "Approximate match",
    );
    await target.press("ArrowDown");
    await target.press("Enter");
    await expect(target).toHaveValue("lore");
    await dialog.getByRole("button", { name: /Move \d+ session/ }).click();
    await expect(
      page.getByTestId("project-actions").getByTestId("action-notice-result"),
    ).toContainText("Moved 1 session");

    await page.goto(`/ui/projects/${loreId}/sessions`);
    await expect(page.getByRole("link", { name: sessionId })).toBeVisible();
  });

  test("move dialog keeps focus trapped after the target picker closes", async ({
    page,
  }) => {
    const scratchId = await projectIdByName(page, "scratch");
    await page.goto(`/ui/projects/${scratchId}`);
    const actions = page.getByTestId("project-actions");
    await actions.getByRole("button", { name: "Delete project…" }).click();
    await page.keyboard.press("Escape");
    await actions.getByRole("button", { name: "Move sessions…" }).click();
    const dialog = page.getByRole("dialog");
    const target = dialog.getByRole("combobox", { name: "Target project" });
    await expect(target).toBeEnabled();
    await target.fill("lroe");
    await expect(dialog.getByRole("option", { name: /^lore/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(target).toHaveAttribute("aria-expanded", "false");
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(
        () => document.activeElement?.closest("[role='dialog']") !== null,
      );
      expect(inside, `Tab ${i} left the dialog`).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("target search accepts paths and revokes selection on a no-match query", async ({
    page,
  }) => {
    await gotoProject(page, "lore");
    await page
      .getByTestId("project-actions")
      .getByRole("button", { name: "Move sessions…" })
      .click();
    const dialog = page.getByRole("dialog");
    const target = dialog.getByRole("combobox", { name: "Target project" });
    await target.fill("projects/scratch");
    const option = dialog.getByRole("option", { name: "scratch", exact: true });
    await expect(option).toContainText("/projects/scratch");
    await expect(option).not.toContainText("Approximate match");
    if (test.info().project.name.startsWith("mobile")) {
      await option.tap();
    } else {
      await option.click();
    }
    await expect(target).toHaveValue("scratch");
    await target.fill("zzzzzzzzzz");
    await expect(dialog.getByRole("status")).toHaveText(
      "No matching projects.",
    );
    await expect(dialog.getByRole("option")).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: /Move \d+ session/ }),
    ).toBeDisabled();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await page
      .getByTestId("project-actions")
      .getByRole("button", { name: "Move sessions…" })
      .click();
    await expect(
      page.getByRole("combobox", { name: "Target project" }),
    ).toHaveValue("");
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
