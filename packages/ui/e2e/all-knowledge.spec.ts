import { expect, test } from "@playwright/test";

async function projectId(page: import("@playwright/test").Page, name: string) {
  const response = await page.request.get("/api/v1/projects");
  const projects = (await response.json()) as Array<{
    id: string;
    name: string;
  }>;
  const project = projects.find((item) => item.name === name);
  if (!project) throw new Error(`missing e2e project ${name}`);
  return project.id;
}

async function openAllKnowledgeFromHome(page: import("@playwright/test").Page) {
  await page.goto("/ui");
  const opener = page.getByTestId("open-nav");
  const allKnowledge = page.getByTestId("nav-all-knowledge");
  if ((await opener.isVisible()) && !(await allKnowledge.isVisible())) {
    await opener.click();
    await page
      .getByTestId("nav-drawer")
      .getByTestId("nav-all-knowledge")
      .click();
  } else {
    await allKnowledge.click();
  }
  await expect(page).toHaveURL("/ui/knowledge");
}

test.describe("cross-project knowledge", () => {
  test("lists projects and Global, opens an entry, and filters category plus project", async ({
    page,
  }) => {
    await openAllKnowledgeFromHome(page);
    const table = page.getByRole("table");
    await expect(table).toBeVisible();
    await expect(table.getByText("lore", { exact: true }).first()).toHaveText(
      "lore",
    );
    await expect(
      table.getByText("scratch", { exact: true }).first(),
    ).toHaveText("scratch");
    await expect(table.getByText("Global", { exact: true })).toHaveText(
      "Global",
    );
    const globalRow = page
      .getByTestId("knowledge-row")
      .filter({ hasText: "Global: prefer inert rendering" });
    await globalRow.click();
    await expect(page).toHaveURL(/\/ui\/knowledge\/[^/?]+$/);
    await expect(page.getByTestId("knowledge-document")).toContainText(
      "Global: prefer inert rendering",
    );

    await openAllKnowledgeFromHome(page);
    const loreId = await projectId(page, "lore");
    await page.getByRole("button", { name: "category" }).click();
    await page.getByRole("option", { name: "gotcha" }).click();
    await page.getByRole("button", { name: /^project\b/ }).click();
    await page.getByRole("option", { name: "lore" }).click();
    await expect(page).toHaveURL(
      new RegExp(`/ui/knowledge\\?category=gotcha&project=${loreId}$`),
    );
    const rows = page.getByTestId("knowledge-row");
    await expect(rows).not.toHaveCount(0);
    for (const row of await rows.all()) {
      await expect(row.locator("td").nth(1)).toHaveText("gotcha");
      await expect(row.locator("td").nth(3)).toHaveText("lore");
    }
  });

  test("all-knowledge and search deep links preserve their server order on reload", async ({
    page,
  }) => {
    const loreId = await projectId(page, "lore");
    const listUrl = `/ui/knowledge?project=${loreId}&category=gotcha&sort=title_asc`;
    await page.goto(listUrl);
    const rows = page.getByTestId("knowledge-row");
    await expect(rows).not.toHaveCount(0);
    const ids = await rows.evaluateAll((elements) =>
      elements.map((row) => row.getAttribute("data-knowledge-id")),
    );
    await page.reload();
    await expect(page).toHaveURL(listUrl);
    await expect(rows).toHaveCount(ids.length);
    expect(
      await rows.evaluateAll((elements) =>
        elements.map((row) => row.getAttribute("data-knowledge-id")),
      ),
    ).toEqual(ids);

    const searchUrl = "/ui/search?q=SQLite";
    await page.goto(searchUrl);
    const hits = page.getByTestId("search-hit");
    await expect(hits).not.toHaveCount(0);
    const hrefs = await hits.evaluateAll((elements) =>
      elements.map((hit) => hit.getAttribute("href")),
    );
    await page.reload();
    await expect(page).toHaveURL(searchUrl);
    await expect(hits).toHaveCount(hrefs.length);
    expect(
      await hits.evaluateAll((elements) =>
        elements.map((hit) => hit.getAttribute("href")),
      ),
    ).toEqual(hrefs);
  });

  test("workspace search links to ranked hits and the complete table", async ({
    page,
  }) => {
    await page.goto("/ui");
    await page
      .locator('form:has([data-testid="search-entry"])')
      .evaluate((form) => {
        const input = form.querySelector<HTMLInputElement>('[name="q"]');
        if (!input) throw new Error("workspace search input missing");
        input.value = "SQLite";
        (form as HTMLFormElement).requestSubmit();
      });
    await expect(page).toHaveURL("/ui/search?q=SQLite");
    const summary = page.getByTestId("search-summary");
    const response = await page.request.get(
      "/api/v1/knowledge/search?q=SQLite&limit=50",
    );
    const results = (await response.json()) as {
      total: number;
      items: unknown[];
    };
    await expect(summary).toHaveText(
      results.total > results.items.length
        ? `Top ${results.items.length} of ${results.total} matches`
        : `${results.total} ${results.total === 1 ? "match" : "matches"}`,
    );
    const hit = page.getByTestId("search-hit").first();
    await expect(hit).toHaveAttribute("href", /\/ui\/knowledge\/[^/]+$/);
    const browse = page.getByRole("link", {
      name: `Browse all ${results.total} ${
        results.total === 1 ? "match" : "matches"
      } in the table`,
    });
    await browse.click();
    await expect(page).toHaveURL("/ui/knowledge?q=SQLite");
    await expect(page.getByRole("table")).toBeVisible();
    await expect(page.getByTestId("knowledge-row")).not.toHaveCount(0);
  });

  test("hostile titles remain literal and inert in list and search", async ({
    page,
  }) => {
    const hostileId = await projectId(page, "hostile");
    await page.goto(`/ui/knowledge?project=${hostileId}`);
    const detailPane = page.locator('[data-pane="detail"]');
    await expect(detailPane.getByText(/<script>/).first()).toBeVisible();
    await expect(
      detailPane.locator('img[src="x"], iframe, script'),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        () => (window as Window & { __pwned?: number }).__pwned ?? 0,
      ),
    ).toBe(0);

    await page.goto("/ui/search?q=Hostile");
    await expect(
      detailPane.getByText(/<script>|onerror=/).first(),
    ).toBeVisible();
    await expect(
      detailPane.locator('img[src="x"], iframe, script'),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        () => (window as Window & { __pwned?: number }).__pwned ?? 0,
      ),
    ).toBe(0);
  });
});
