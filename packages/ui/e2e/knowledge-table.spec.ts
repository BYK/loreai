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
    const projectId = await loreProjectId(page);
    await page.goto(`/ui/projects/${projectId}`);
    await page.getByRole("link", { name: /Browse knowledge/ }).click();
    await page.getByRole("button", { name: "category" }).click();
    await page.getByRole("option", { name: "gotcha" }).click();
    await page.getByRole("button", { name: "Sort by Title" }).click();
    await expect(page).toHaveURL(
      /category=gotcha.*sort=title%3Aasc%2Cupdated_at%3Adesc|sort=title%3Aasc%2Cupdated_at%3Adesc.*category=gotcha/,
    );
    const url = page.url();
    await page.reload();
    await expect(page).toHaveURL(url);
    await expect(
      page.getByRole("button", {
        name: "Sort by Title, level 1, ascending",
      }),
    ).toBeVisible();
  });

  test("knowledge q filters stay on the table view", async ({ page }) => {
    const projectId = await loreProjectId(page);
    await page.goto(`/ui/projects/${projectId}/knowledge`);
    const search = page.getByRole("textbox", { name: "Filter this list" });
    await search.fill("SQLite");
    await search.press("Enter");
    await expect(page).toHaveURL(/\/knowledge\?q=SQLite/);
    await expect(search).toBeVisible();
    await expect(page.getByText(/Recall Results/)).toHaveCount(0);
  });

  test("typo filter shows a fuzzy row with the approximate badge", async ({
    page,
  }) => {
    const projectId = await loreProjectId(page);
    await page.goto(`/ui/projects/${projectId}/knowledge`);
    const search = page.getByRole("textbox", { name: "Filter this list" });
    // Typo of the seeded "Use cursor pagination" title.
    await search.fill("curosr pagin");
    await search.press("Enter");
    const row = page
      .getByTestId("knowledge-row")
      .filter({ hasText: "Use cursor pagination" });
    await expect(row).toBeVisible();
    await expect(row.getByTestId("knowledge-match-fuzzy")).toBeVisible();
    await expect(row.getByTestId("knowledge-match-fuzzy")).toContainText(
      "approximate",
    );
    await expect(page.locator("caption")).toContainText(
      "approximate matches shown below exact hits",
    );
  });

  test("exact filter shows rows without the approximate badge", async ({
    page,
  }) => {
    const projectId = await loreProjectId(page);
    await page.goto(`/ui/projects/${projectId}/knowledge`);
    const search = page.getByRole("textbox", { name: "Filter this list" });
    await search.fill("cursor pagination");
    await search.press("Enter");
    const row = page
      .getByTestId("knowledge-row")
      .filter({ hasText: "Use cursor pagination" });
    await expect(row).toBeVisible();
    await expect(page.getByTestId("knowledge-match-fuzzy")).toHaveCount(0);
  });

  test("mobile row navigation preserves the table query", async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    const projectId = await loreProjectId(page);
    await page.goto(
      `/ui/projects/${projectId}/knowledge?category=gotcha&sort=title:asc`,
    );
    await page.getByTestId("knowledge-row").first().click();
    await expect(page.getByTestId("knowledge-document")).toBeVisible();
    await page.getByTestId("mobile-back").click();
    await expect(page).toHaveURL(
      /category=gotcha.*sort=title%3Aasc|sort=title%3Aasc.*category=gotcha/,
    );
  });

  test("clicking a session row navigates to the UI-06 reader route", async ({
    page,
  }) => {
    const projectId = await loreProjectId(page);
    await page.goto(`/ui/projects/${projectId}/sessions`);
    const title = page.getByRole("link", {
      name: /Refactor the sync outbox pruning/,
    });
    await expect(title).toHaveAttribute(
      "href",
      `/ui/projects/${projectId}/sessions/e2e-session-sqlite`,
    );
    const processing = title.locator("..").locator("details");
    await expect(processing).not.toHaveAttribute("open");
    await expect(
      processing.getByText("Processing details", { exact: true }),
    ).toBeVisible();
    await expect(title.locator("summary, button, details")).toHaveCount(0);
    await expect(title).not.toContainText(/messages|distilled/);
    await title.click();
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
    await page
      .getByRole("option", { name: "Knowledge and memory files" })
      .click();
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

for (const width of [800, 700, 320]) {
  test(`responsive knowledge sorting stays usable at ${width}px`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium");
    await page.setViewportSize({ width, height: 480 });
    const projectId = await loreProjectId(page);
    await page.goto(
      `/ui/projects/${projectId}/knowledge?category=gotcha&sort=title%3Adesc%2Ccreated_at%3Aasc%2Cconfidence%3Aasc`,
    );
    // Include headers and their responsive equivalents: at least one visible,
    // keyboard-operable control for each server sort must survive every width.
    for (const label of ["Confidence", "Updated", "Title"]) {
      const control = page
        .getByRole("button", { name: new RegExp(`Sort by ${label}`) })
        .filter({ visible: true })
        .first();
      await expect(control).toBeVisible();
      await control.focus();
      await expect(control).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(
        new RegExp(
          `category=gotcha.*sort=${label === "Confidence" ? "confidence%3Adesc%2Ctitle%3Adesc%2Ccreated_at%3Aasc" : label === "Updated" ? "updated_at%3Adesc%2Cconfidence%3Adesc%2Ctitle%3Adesc" : "title%3Aasc%2Cupdated_at%3Adesc%2Cconfidence%3Adesc"}`,
        ),
      );
    }
    const size = await page
      .locator("main")
      .evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
    expect(size.scroll).toBeLessThanOrEqual(size.client + 1);
  });
}
