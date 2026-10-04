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
  test("workspace nav active state resolves within the /ui base", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium");

    await page.goto("/ui/knowledge");
    const allKnowledge = page.getByTestId("nav-all-knowledge");
    const projects = page.getByTestId("nav-projects");
    await expect(allKnowledge).toHaveClass(/bg-accent-soft/);
    await expect(projects).not.toHaveClass(/bg-accent-soft/);

    await page.goto("/ui");
    await expect(projects).toHaveClass(/bg-accent-soft/);
    await expect(allKnowledge).not.toHaveClass(/bg-accent-soft/);
  });

  test("workspace links highlight Entities on list and detail, and Costs", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium");
    const response = await page.request.get("/api/v1/entities");
    const { entities } = (await response.json()) as {
      entities: Array<{ id: string; canonical_name: string }>;
    };
    const ada = entities.find(
      (entity) => entity.canonical_name === "Ada Lovelace",
    );
    if (!ada) throw new Error("missing seeded Ada Lovelace entity");

    await page.goto("/ui/entities");
    const entitiesLink = page.getByTestId("nav-entities");
    const costsLink = page.getByTestId("nav-costs");
    await expect(entitiesLink).toHaveClass(/bg-accent-soft/);
    await page.goto(`/ui/entities/${ada.id}`);
    await expect(page.getByTestId("entity-page")).toBeVisible();
    await expect(entitiesLink).toHaveClass(/bg-accent-soft/);

    await page.goto("/ui/costs");
    await expect(page.getByTestId("costs-page")).toBeVisible();
    await expect(costsLink).toHaveClass(/bg-accent-soft/);
    await expect(entitiesLink).not.toHaveClass(/bg-accent-soft/);
  });

  test("lists projects and shared knowledge, opens an entry, and filters category plus project", async ({
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
    await expect(table.getByText("No project", { exact: true })).toHaveText(
      "No project",
    );
    const sharedRow = page
      .getByTestId("knowledge-row")
      .filter({ hasText: "Shared: prefer inert rendering" });
    await sharedRow.click();
    await expect(page).toHaveURL(/\/ui\/knowledge\/[^/?]+$/);
    await expect(page.getByTestId("knowledge-document")).toContainText(
      "Shared: prefer inert rendering",
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

    await page.getByRole("button", { name: "category" }).click();
    await page.getByRole("option", { name: "All categories" }).click();
    await expect(page).toHaveURL(
      new RegExp(`/ui/knowledge\\?project=${loreId}$`),
    );
  });

  test("clears the all-knowledge project filter", async ({ page }) => {
    const loreId = await projectId(page, "lore");
    await page.goto("/ui/knowledge");

    await page.getByRole("button", { name: /^project\b/ }).click();
    await page.getByRole("option", { name: "lore", exact: true }).click();
    await expect(page).toHaveURL(`/ui/knowledge?project=${loreId}`);

    const rows = page.getByTestId("knowledge-row");
    await expect(rows).not.toHaveCount(0);
    await page.getByRole("button", { name: /^project\b/ }).click();
    await page
      .getByRole("option", { name: "All projects", exact: true })
      .click();
    await expect(page).toHaveURL("/ui/knowledge");
    await expect(rows).not.toHaveCount(0);

    const projectNames = await rows.evaluateAll((elements) =>
      elements
        .map((row) => row.querySelectorAll("td")[3]?.textContent?.trim())
        .filter((name): name is string => !!name && name !== "No project"),
    );
    expect(new Set(projectNames).size).toBeGreaterThan(1);

    const rowCount = await rows.count();
    await page.reload();
    await expect(page).toHaveURL("/ui/knowledge");
    await expect(rows).toHaveCount(rowCount);
  });

  test("clears the all-knowledge category filter", async ({ page }) => {
    await page.goto("/ui/knowledge");
    await page.getByRole("button", { name: "category" }).click();
    await page.getByRole("option", { name: "gotcha", exact: true }).click();
    await expect(page).toHaveURL("/ui/knowledge?category=gotcha");

    await page.getByRole("button", { name: "category" }).click();
    await page
      .getByRole("option", { name: "All categories", exact: true })
      .click();
    await expect(page).toHaveURL("/ui/knowledge");
    await expect(page.getByTestId("knowledge-row")).not.toHaveCount(0);

    await page.getByRole("button", { name: /^scope\b/ }).click();
    await page.getByRole("option", { name: "project", exact: true }).click();
    await expect(page).toHaveURL("/ui/knowledge?scope=project");

    await page.getByRole("button", { name: /^scope\b/ }).click();
    await page.getByRole("option", { name: "Any scope", exact: true }).click();
    await expect(page).toHaveURL("/ui/knowledge");
    await expect(page.getByTestId("knowledge-row")).not.toHaveCount(0);
    await page.reload();
    await expect(page).toHaveURL("/ui/knowledge");
  });

  test("all-knowledge and search deep links preserve their server order on reload", async ({
    page,
  }) => {
    const loreId = await projectId(page, "lore");
    const listUrl = `/ui/knowledge?project=${loreId}&category=gotcha&sort=title:asc`;
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

  test("stacked header sorting preserves order and indicators across reload", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium");
    await page.goto("/ui/knowledge");

    await page.getByRole("button", { name: "Sort by Confidence" }).click();
    await expect(page).toHaveURL(
      "/ui/knowledge?sort=confidence%3Adesc%2Cupdated_at%3Adesc",
    );
    await page
      .getByRole("button", {
        name: "Sort by Updated, level 2, descending",
      })
      .click();
    const deepLink = "/ui/knowledge?sort=updated_at%3Adesc%2Cconfidence%3Adesc";
    await expect(page).toHaveURL(deepLink);
    const table = page.getByRole("table");
    await expect(table).toContainText(
      "Sorted by Updated ↓, then Confidence ↓ · page of up to 50",
    );

    await page.reload();
    await expect(page).toHaveURL(deepLink);
    await expect(
      page.getByRole("button", {
        name: "Sort by Updated, level 1, descending",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Sort by Confidence, level 2, descending",
      }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("button", {
          name: "Sort by Updated, level 1, descending",
        })
        .locator("xpath=.."),
    ).toHaveAttribute("aria-sort", "descending");
    await expect(
      page
        .getByRole("button", {
          name: "Sort by Confidence, level 2, descending",
        })
        .locator("xpath=.."),
    ).toHaveAttribute("aria-sort", "none");
  });

  test("shared scope shows cross-project and projectless rows only", async ({
    page,
  }) => {
    await page.goto("/ui/knowledge?scope=shared");
    const rows = page.getByTestId("knowledge-row");
    const crossProject = rows.filter({
      hasText: "Shared: cross-project filter fixture",
    });
    const projectless = rows.filter({
      hasText: "Shared: prefer inert rendering",
    });
    await expect(crossProject).toHaveCount(1);
    await expect(projectless).toHaveCount(1);
    await expect(crossProject.locator("td").nth(2)).toHaveText("shared");
    await expect(crossProject.locator("td").nth(3)).toHaveText("scratch");
    await expect(projectless.locator("td").nth(2)).toHaveText("shared");
    await expect(projectless.locator("td").nth(3)).toHaveText("No project");
    await expect(
      rows.filter({ hasText: "Prefer terse commit messages" }),
    ).toHaveCount(0);
  });

  test("knowledge filter controls share a top edge and 36px height", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium");
    await page.goto("/ui/knowledge");
    const controls = [
      page.getByRole("textbox", { name: "Knowledge search" }),
      page.getByRole("search").getByRole("button", {
        name: "Search",
        exact: true,
      }),
      page.getByRole("button", { name: "category" }),
    ];
    const boxes = await Promise.all(
      controls.map((control) => control.boundingBox()),
    );
    expect(boxes.every((box) => box !== null)).toBe(true);
    const [input, search, category] = boxes;
    if (!input || !search || !category) {
      throw new Error("knowledge filter controls must have bounding boxes");
    }
    expect(Math.abs(input.y - search.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(input.y - category.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(input.height - search.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(input.height - category.height)).toBeLessThanOrEqual(1);
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
      items: Array<{ match?: string }>;
    };
    const fuzzy = results.items.filter((hit) => hit.match === "fuzzy").length;
    await expect(summary).toHaveText(
      (results.total > results.items.length
        ? `Top ${results.items.length} of ${results.total} matches`
        : `${results.total} ${results.total === 1 ? "match" : "matches"}`) +
        (fuzzy > 0 ? ` · ${fuzzy} approximate` : ""),
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

  test("workspace search flags fuzzy hits for a typo query", async ({
    page,
  }) => {
    await page.goto("/ui");
    await page
      .locator('form:has([data-testid="search-entry"])')
      .evaluate((form) => {
        const input = form.querySelector<HTMLInputElement>('[name="q"]');
        if (!input) throw new Error("workspace search input missing");
        input.value = "curosr pagin";
        (form as HTMLFormElement).requestSubmit();
      });
    await expect(page).toHaveURL("/ui/search?q=curosr%20pagin");
    const hit = page.getByTestId("search-hit").first();
    await expect(hit.getByTestId("search-match-fuzzy")).toHaveText(
      "≈ approximate",
    );
    await expect(hit).toContainText("Use cursor pagination");
    await expect(page.getByTestId("search-summary")).toContainText(
      "approximate",
    );
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
