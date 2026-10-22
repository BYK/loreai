import { expect, test } from "@playwright/test";
import {
  openProjectPicker,
  setWorkspaceTheme,
  clickNavigation,
  expectCurrentNavigation,
  expectNavigationAvailable,
} from "./workspace-helpers";

test("project picker is reachable, searchable and returns navigation to the selected project", async ({
  page,
}) => {
  await page.goto("/ui");
  const projects: Array<{ id: string; name: string }> = await (
    await page.request.get("/api/v1/projects")
  ).json();
  const target = projects.find((p) => p.name === "lore")!;
  const picker = await openProjectPicker(page);
  const search = picker.getByRole("searchbox", { name: "Filter projects" });
  await search.fill("lore");
  // Match the link itself by stable id, not name/path substrings.
  const link = picker.locator(
    `[data-testid="nav-project"][href$="/projects/${target.id}"]`,
  );
  await expect(link).toBeVisible();
  await search.press("ArrowDown");
  await expect(picker.getByTestId("nav-project").first()).toBeFocused();
  await link.click();
  await expect(page).toHaveURL(`/ui/projects/${target.id}`);
  await expect(page.getByTestId("health")).toBeVisible();
  await expect(picker).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

async function seededReader(page: import("@playwright/test").Page) {
  const projects = await (await page.request.get("/api/v1/projects")).json();
  const project = projects.find((p: { name: string }) => p.name === "lore");
  const entries = await (
    await page.request.get(`/api/v1/projects/${project.id}/knowledge`)
  ).json();
  const entry = entries.find(
    (e: { title: string }) => e.title === "Keep SQLite as the only store",
  );
  await page.goto(`/ui/projects/${project.id}/knowledge/${entry.id}`);
  await expect(page.getByTestId("knowledge-document")).toBeVisible();
  return { project, entry };
}

test("context collapse preserves the permanent rail, picker, document and desktop preference", async ({
  page,
}, testInfo) => {
  const { entry } = await seededReader(page);
  const toggle = page.getByTestId("context-toggle");
  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();
  await expect(page.getByTestId("context-pane")).toBeVisible();
  await toggle.click();
  await expect(page.getByTestId("context-pane")).toBeHidden();
  await expectNavigationAvailable(page);
  await expect(page.getByTestId("project-picker-trigger")).toBeVisible();
  await expect(page.getByTestId("knowledge-document")).toContainText(
    entry.title,
  );
  if (!testInfo.project.name.includes("mobile")) {
    await page.reload();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  }
  await toggle.click();
  const input = page.getByRole("textbox", { name: "Filter knowledge list" });
  await input.fill("SQLite");
  await input.press("Enter");
  await expect(page).toHaveURL(
    new RegExp(`/knowledge/${entry.id}\\?q=SQLite$`),
  );
  await expect(page.getByTestId("context-pane")).toBeVisible();
  if (!testInfo.project.name.includes("mobile")) {
    const handle = page.getByRole("separator", {
      name: "Resize knowledge list",
    });
    await handle.focus();
    await handle.press("ArrowRight");
    await expect(handle).toHaveAttribute("aria-valuenow", "336");
    await page.reload();
    await expect(handle).toHaveAttribute("aria-valuenow", "336");
    await page
      .getByRole("button", { name: "Collapse context pane", exact: true })
      .click();
    await expect(page.getByTestId("context-pane")).toBeHidden();
    await page
      .getByRole("button", { name: "Expand context pane", exact: true })
      .click();
    await page.getByRole("button", { name: /^List sort/ }).click();
    await page.getByRole("option", { name: "Title A–Z", exact: true }).click();
    await page
      .getByRole("button", { name: "Clear filters", exact: true })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/knowledge/${entry.id}\\?sort=title%3Aasc$`),
    );
  } else {
    await toggle.click();
  }
  for (const theme of ["light", "dark"] as const) {
    await setWorkspaceTheme(page, theme);
    await page.getByRole("heading", { level: 1 }).click();
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath(`workspace-${theme}.png`),
      fullPage: true,
    });
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("narrow context replaces content while primary navigation remains available", async ({
  page,
}) => {
  await page.setViewportSize({ width: 393, height: 851 });
  await seededReader(page);
  await page.getByTestId("context-toggle").click();
  await expect(page.getByTestId("context-pane")).toBeVisible();
  await expect(page.locator('main[data-pane="detail"]')).toBeHidden();
  await expectNavigationAvailable(page);
  const row = page.getByTestId("knowledge-row").first();
  await row.focus();
  await row.press("Escape");
  await expect(page.getByTestId("context-pane")).toBeHidden();
  await expect(page.getByTestId("context-toggle")).toBeFocused();
  await expect(page.getByTestId("knowledge-document")).toBeVisible();
  await clickNavigation(page, "rail-knowledge");
  await expect(page).toHaveURL(/\/knowledge$/);
  await clickNavigation(page, "rail-costs");
  await expect(page).toHaveURL("/ui/costs");
  await expectNavigationAvailable(page);
  await expect(page.getByTestId("context-pane")).toBeHidden();
});

test("context focus survives breakpoint changes and content input focus stays put", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await seededReader(page);
  await page.getByTestId("knowledge-row").first().focus();
  await page.setViewportSize({ width: 393, height: 851 });
  await expect(page.getByTestId("context-toggle")).toBeFocused();
  await expectNavigationAvailable(page);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Title", exact: true });
  await input.focus();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(input).toBeFocused();
  await page.getByTestId("context-toggle").click();
  await expect(page.getByTestId("project-picker-trigger")).toBeVisible();
});

test("session context filters preserve transcript and anchor", async ({
  page,
}) => {
  const { project } = await seededReader(page);
  await page.goto(`/ui/projects/${project.id}/sessions/e2e-reader?a=example`);
  const toggle = page.getByTestId("context-toggle");
  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();
  await expect(page.getByTestId("session-context-list")).toBeVisible();
  const input = page.getByRole("searchbox", { name: "Filter session list" });
  await input.fill("reader");
  await input.press("Enter");
  await expect(page).toHaveURL(/sessions\/e2e-reader\?a=example&q=reader$/);
  await expect(page.getByTestId("context-pane")).toBeVisible();
  await expect(page.getByTestId("context-session").first()).toBeVisible();
  await toggle.click();
  await expect(
    page.getByRole("feed", { name: "Session history" }),
  ).toBeVisible();
  await expectNavigationAvailable(page);
});

test("Sessions without a project offers project selection with session destinations", async ({
  page,
}) => {
  await page.goto("/ui");
  await clickNavigation(page, "rail-sessions");
  await expect(page).toHaveURL("/ui?section=sessions");
  await expect(
    page.getByRole("heading", { name: "Choose a project for sessions" }),
  ).toBeVisible();
  await page.getByTestId("project-card").first().click();
  await expect(page).toHaveURL(/\/projects\/[^/]+\/sessions$/);
});

test("directory and project pages use the width without a duplicate navigation pane", async ({
  page,
}) => {
  await page.goto("/ui");
  const main = page.locator('main[data-pane="detail"]');
  await expect(page.getByTestId("context-toggle")).toHaveCount(0);
  await expect(page.getByTestId("context-pane")).toBeHidden();
  await expect(main).toBeVisible();
  expect((await main.boundingBox())!.x).toBeLessThanOrEqual(60);
  await page.getByTestId("project-card").first().click();
  await expect(page.getByTestId("health")).toBeVisible();
  await expect(page.getByTestId("context-toggle")).toHaveCount(0);
});

test("narrow toolbar keeps search and account reachable with a long project name", async ({
  page,
}) => {
  const projects = await (await page.request.get("/api/v1/projects")).json();
  const project = projects.find((p: { name: string }) => p.name === "lore");
  await page.route("**/api/v1/projects", async (route) =>
    route.fulfill({
      json: projects.map((p: { id: string }) =>
        p.id === project.id
          ? { ...p, name: "A very long project name that must stay readable" }
          : p,
      ),
    }),
  );
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto(`/ui/projects/${project.id}`);
  for (const control of [
    page.getByTestId("search-entry"),
    page.getByTestId("project-picker-trigger"),
  ]) {
    await expect(control).toBeVisible();
    const box = (await control.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
  }
});

test("repeated Projects and Sessions transitions keep context destinations aligned", async ({
  page,
}) => {
  await page.goto("/ui");
  for (let pass = 0; pass < 2; pass++) {
    await clickNavigation(page, "rail-sessions");
    await expectCurrentNavigation(page, "rail-sessions");
    await expect(page.getByTestId("context-toggle")).toHaveCount(0);
    await expect(page.getByTestId("project-card").first()).toHaveAttribute(
      "href",
      /\/sessions$/,
    );
    await clickNavigation(page, "rail-projects");
    await expectCurrentNavigation(page, "rail-projects");
    await expect(page.getByTestId("context-toggle")).toHaveCount(0);
    await expect(page.getByTestId("project-card").first()).toHaveAttribute(
      "href",
      /\/projects\/[^/]+$/,
    );
  }
});

test("project picker keeps the active section and rail links have consistent destinations", async ({
  page,
}) => {
  const projects = await (await page.request.get("/api/v1/projects")).json();
  const lore = projects.find((p: { name: string }) => p.name === "lore");
  const scratch = projects.find((p: { name: string }) => p.name === "scratch");
  for (const section of ["knowledge", "sessions", "imports", "duplicates"]) {
    await page.goto(`/ui/projects/${lore.id}/${section}`);
    const picker = await openProjectPicker(page);
    await picker
      .getByRole("searchbox", { name: "Filter projects" })
      .fill("scratch");
    await picker
      .getByTestId("nav-project")
      .filter({ hasText: "scratch" })
      .click();
    await expect(page).toHaveURL(`/ui/projects/${scratch.id}/${section}`);
    await expectCurrentNavigation(page, `rail-${section}`);
  }
});

test("workspace tools use full-width layouts and all destinations remain reachable", async ({
  page,
}) => {
  await page.goto("/ui");
  for (const id of [
    "entities",
    "contradictions",
    "promotions",
    "team",
    "conflicts",
    "warming",
    "costs",
    "model-usage",
  ]) {
    await clickNavigation(page, `rail-${id}`);
    await expect(page).toHaveURL(`/ui/${id}`);
    await expectCurrentNavigation(page, `rail-${id}`);
    await expect(page.getByTestId("context-pane")).toBeHidden();
    await expect(page.getByTestId("context-toggle")).toHaveCount(0);
    await expect(
      page.getByRole("navigation", { name: "Related pages" }),
    ).toHaveCount(0);
    const main = (await page
      .locator('main[data-pane="detail"]')
      .boundingBox())!;
    expect(main.x).toBeLessThanOrEqual(60);
    await expectNavigationAvailable(page);
  }
});

test("rail tooltips label every destination on hover and keyboard focus", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name.includes("mobile"),
    "hover labels are for pointer and keyboard interaction",
  );
  await seededReader(page);
  const rail = page.getByTestId("icon-rail");
  const links = rail.getByRole("link");
  for (const link of await links.all()) {
    // Scrolling dismisses Kobalte tooltips. Finish scrolling before entering
    // the target, as a pointer user does when reaching the lower rail items.
    await link.scrollIntoViewIfNeeded();
    await page.mouse.move(200, 10);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    await link.hover();
    await expect(page.getByRole("tooltip")).toContainText(
      (await link.getAttribute("aria-label"))!,
    );
    await link.press("Escape");
    await expect(page.getByRole("tooltip")).toHaveCount(0);
  }
  const avatar = rail.getByTestId("folk-status");
  await avatar.focus();
  await expect(page.getByRole("tooltip")).toHaveText("Account & preferences");
  await avatar.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await avatar.press("Enter");
  await page
    .getByRole("button", { name: "Sign in to Lore", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("lore login");
  await page.keyboard.press("Escape");
  await expect(avatar).toBeFocused();
});

test("knowledge and search pages have no duplicate section links or empty context column", async ({
  page,
}) => {
  await page.goto("/ui");
  for (const section of ["knowledge", "search", "projects"]) {
    await clickNavigation(page, `rail-${section}`);
    await expect(page.getByTestId("context-toggle")).toHaveCount(0);
    await expect(page.getByTestId("context-pane")).toBeHidden();
    await expect(
      page.getByRole("navigation", { name: "Section navigation" }),
    ).toHaveCount(0);
    const main = (await page
      .locator('main[data-pane="detail"]')
      .boundingBox())!;
    expect(main.x).toBeLessThanOrEqual(60);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
});

test("leaving a narrow reader list restores focus to the persistent toolbar", async ({
  page,
}) => {
  await page.setViewportSize({ width: 393, height: 851 });
  await seededReader(page);
  await page.getByTestId("context-toggle").click();
  const link = page.getByRole("link", { name: "Open as table" });
  await link.focus();
  await link.press("Enter");
  await expect(page).toHaveURL(/\/knowledge$/);
  await expect(page.getByTestId("context-toggle")).toHaveCount(0);
  await expect(page.getByTestId("project-picker-trigger")).toBeFocused();
});
