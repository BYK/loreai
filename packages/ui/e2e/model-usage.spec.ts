import { expect, test, type Page } from "@playwright/test";

const PAGE = "/ui/model-usage";

// Seed rows: lore e2e-mu-a anthropic/claude-sonnet-4 on 05-04/11/18 (3),
// lore e2e-mu-b openai/gpt-5 on 05-04/11 (2), scratch e2e-mu-c
// anthropic/claude-sonnet-4 on 05-11 + google/gemini-2.5-pro on 05-18 (1+1).
// Pre-existing fixtures add an anthropic/m session-day on 05-03 (the
// e2e-hostile row nests provider under `model`, so it does not count).

function modelCells(page: Page) {
  return page.locator("table tbody tr td:first-child");
}

test.describe("model usage page", () => {
  test("nav, chart, totals table, sorting and export", async ({ page }) => {
    await page.goto(PAGE);
    const openNavigation = page.getByTestId("open-nav");
    const navigationIsDrawer = await openNavigation.isVisible();
    if (navigationIsDrawer) {
      await openNavigation.click();
      await expect(page.getByTestId("nav-drawer")).toBeVisible();
    }
    await expect(page.getByTestId("nav-model-usage")).toHaveAttribute(
      "aria-current",
      "page",
    );
    if (navigationIsDrawer) {
      await page.getByTestId("nav-model-usage").click();
      await expect(page.getByTestId("nav-drawer")).not.toBeVisible();
    }
    await expect(page.locator("svg.flow-svg")).toBeVisible();
    await expect(page.getByTestId("chart-status")).toContainText(
      "8 active session-days",
    );

    // Default order: Session-days desc then Model asc.
    await expect(modelCells(page)).toHaveText([
      "claude-sonnet-4",
      "GPT-5",
      "m",
      "Gemini 2.5 Pro",
    ]);
    await expect(
      page.locator("table tbody tr").nth(0).locator("td").nth(2),
    ).toHaveText("4");

    // Click the Model header: Model becomes primary sort, ascending.
    await page.getByRole("button", { name: "Sort by Model" }).click();
    await expect(modelCells(page)).toHaveText([
      "claude-sonnet-4",
      "m",
      "Gemini 2.5 Pro",
      "GPT-5",
    ]);

    // Project filter refetches and changes the counts (lore: sonnet 3,
    // gpt-5 2, m 1 → 6 session-days).
    const projects = await (await page.request.get("/api/v1/projects")).json();
    const lore = projects.find((p: { name: string }) => p.name === "lore")!;
    // The closed trigger shows "All projects", not a blank value.
    await expect(page.getByTestId("project-select")).toContainText(
      "All projects",
    );
    await page.getByTestId("project-select").click();
    await page.getByRole("option", { name: "lore", exact: true }).click();
    await expect(page.getByTestId("chart-status")).toContainText(
      "6 active session-days",
    );
    // Model-asc sort persists across the project refetch.
    await expect(modelCells(page)).toHaveText([
      "claude-sonnet-4",
      "m",
      "GPT-5",
    ]);
    await expect(
      page.locator("table tbody tr").nth(0).locator("td").nth(2),
    ).toHaveText("3");

    // Export carries the project param and streams the daily document.
    const exportLink = page.getByTestId("export-link");
    await expect(exportLink).toHaveAttribute(
      "href",
      new RegExp(`project=${lore.id}`),
    );
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      exportLink.click(),
    ]);
    expect(download.suggestedFilename()).toMatch(
      /^lore-model-usage-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.json$/,
    );
    const path = await download.path();
    const doc = JSON.parse(
      (await import("node:fs")).readFileSync(path, "utf8"),
    );
    expect(doc.format).toBe("model-tides-daily");
    expect(doc.version).toBe(2);
    expect(doc.source).toBe("lore");
    const sessionDays = doc.days.reduce(
      (sum: number, day: { models: Record<string, number> }) =>
        sum + Object.values(day.models).reduce((s, n) => s + n, 0),
      0,
    );
    expect(sessionDays).toBe(6);

    // scratch: sonnet 1 + gemini 1 → 2 session-days.
    await page.getByTestId("project-select").click();
    await page.getByRole("option", { name: "scratch", exact: true }).click();
    await expect(page.getByTestId("chart-status")).toContainText(
      "2 active session-days",
    );
    // Both have 1 session-day; Model asc breaks the tie (anthropic < google).
    await expect(modelCells(page)).toHaveText([
      "claude-sonnet-4",
      "Gemini 2.5 Pro",
    ]);

    // Switching back to All projects restores the trigger label (regression:
    // the "" option rendered blank).
    await page.getByTestId("project-select").click();
    await page
      .getByRole("option", { name: "All projects", exact: true })
      .click();
    await expect(page.getByTestId("project-select")).toContainText(
      "All projects",
    );
    await expect(page.getByTestId("chart-status")).toContainText(
      "8 active session-days",
    );
  });
});
