import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

async function loreProjectId(page: Page) {
  const response = await page.request.get("/api/v1/projects");
  const projects = (await response.json()) as Array<{
    id: string;
    name: string;
  }>;
  return projects.find((project) => project.name === "lore")!.id;
}

test.describe("knowledge table routes", () => {
  test("filter and sort state survives reload", async ({ page }) => {
    await page.goto("/ui");
    const project = page
      .getByRole("navigation", { name: "Workspace" })
      .getByTestId("nav-project")
      .first();
    await project.click();
    await page.getByRole("link", { name: /Browse knowledge/ }).click();
    await page.getByRole("button", { name: "category" }).click();
    await page.getByRole("option", { name: "gotcha" }).click();
    await page.getByRole("button", { name: /Sort/ }).click();
    await page.getByRole("option", { name: "Title A–Z" }).click();
    await expect(page).toHaveURL(
      /category=gotcha.*sort=title_asc|sort=title_asc.*category=gotcha/,
    );
    const url = page.url();
    await page.reload();
    await expect(page).toHaveURL(url);
  });

  test("knowledge q filters stay on the table view", async ({ page }) => {
    const projectId = await loreProjectId(page);
    await page.goto(`/ui/projects/${projectId}/knowledge`);
    const search = page.getByRole("textbox", { name: "Knowledge search" });
    await search.fill("SQLite");
    await search.press("Enter");
    await expect(page).toHaveURL(/\/knowledge\?q=SQLite/);
    await expect(search).toBeVisible();
    await expect(page.getByText(/Recall Results/)).toHaveCount(0);
  });

  test("mobile row navigation preserves the table query", async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    const projectId = await loreProjectId(page);
    await page.goto(
      `/ui/projects/${projectId}/knowledge?category=gotcha&sort=title_asc`,
    );
    await page.getByTestId("knowledge-row").first().click();
    await expect(page.getByTestId("knowledge-document")).toBeVisible();
    await page.getByTestId("mobile-back").click();
    await expect(page).toHaveURL(
      /category=gotcha.*sort=title_asc|sort=title_asc.*category=gotcha/,
    );
  });

  test("clicking a session row navigates to the UI-06 reader route", async ({
    page,
  }) => {
    const projectId = await loreProjectId(page);
    await page.goto(`/ui/projects/${projectId}/sessions`);
    await page
      .getByRole("link")
      .filter({ hasText: /messages/ })
      .first()
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/projects/${projectId}/sessions/[^/]+$`),
    );
  });

  test("search displays recall results and knowledge links", async ({
    page,
  }) => {
    const projectId = await loreProjectId(page);
    await page.goto(`/ui/projects/${projectId}/search?q=SQLite`);
    await page.getByRole("button", { name: "Search scope" }).click();
    await page.getByRole("option", { name: "knowledge" }).click();
    await page
      .getByRole("search")
      .getByRole("button", { name: "Search", exact: true })
      .click();
    await expect(page).toHaveURL(/\/search\?q=SQLite&scope=knowledge/);
    await expect(page.getByText(/Recall Results/)).toBeVisible();
    await expect(
      page.getByRole("link", { name: /\(k:/ }).first(),
    ).toHaveAttribute("href", /\/knowledge\//);
  });
});
