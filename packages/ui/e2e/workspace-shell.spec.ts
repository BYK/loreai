import { expect, test, type Page } from "@playwright/test";
import {
  openProjectPicker,
  setWorkspaceTheme,
  clickNavigation,
  expectCurrentNavigation,
  expectNavigationAvailable,
  waitForOverlayMotion,
} from "./workspace-helpers";

async function expectMainAfterNavigation(page: Page) {
  const rail = page.getByTestId("icon-rail");
  const navBox = (await rail.isVisible()) ? await rail.boundingBox() : null;
  const mainBox = await page.locator('main[data-pane="detail"]').boundingBox();
  expect(mainBox).not.toBeNull();
  expect(mainBox?.x).toBeCloseTo(navBox ? navBox.x + navBox.width : 0, 0);
}

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

async function expectSheetCloseInCorner(
  sheet: import("@playwright/test").Locator,
) {
  const button = sheet.getByRole("button", { name: "Dismiss", exact: true });
  const box = (await sheet.boundingBox())!;
  const target = (await button.boundingBox())!;
  const icon = (await button.locator("svg").boundingBox())!;
  expect(target.width).toBeGreaterThanOrEqual(44);
  expect(target.height).toBeGreaterThanOrEqual(44);
  expect(target.y - box.y).toBeGreaterThanOrEqual(0);
  expect(target.y - box.y).toBeLessThanOrEqual(6);
  expect(box.x + box.width - target.x - target.width).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width - target.x - target.width).toBeLessThanOrEqual(6);
  expect(
    Math.abs(icon.x + icon.width / 2 - target.x - target.width / 2),
  ).toBeLessThan(0.5);
  expect(
    Math.abs(icon.y + icon.height / 2 - target.y - target.height / 2),
  ).toBeLessThan(0.5);
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
  const input = page.getByRole("textbox", { name: "Filter this list" });
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
}, testInfo) => {
  const { project } = await seededReader(page);
  await page.goto(`/ui/projects/${project.id}/sessions/e2e-reader?a=example`);
  const toggle = page.getByTestId("context-toggle");
  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();
  await expect(page.getByTestId("session-context-list")).toBeVisible();
  const input = page.getByRole("searchbox", { name: "Filter session list" });
  if (testInfo.project.name.includes("mobile")) {
    for (const control of [
      input,
      page.getByRole("button", { name: "Find", exact: true }),
      page.getByRole("link", { name: "Open as list", exact: true }),
    ]) {
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
  }
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
  await expectMainAfterNavigation(page);
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
    await expectMainAfterNavigation(page);
    await expectNavigationAvailable(page);
  }
});

test("desktop navigation stays mini even with a previously expanded preference", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name.includes("mobile"),
    "desktop mini navigation",
  );
  await page.addInitScript(() =>
    localStorage.setItem("lore.ui.navigationCompact", "false"),
  );
  await page.goto("/ui");
  const rail = page.getByTestId("icon-rail");
  await expect(rail.getByTestId("rail-projects")).toHaveText("");
  await expect(rail.getByTestId("logo").locator(":scope > span")).toHaveClass(
    /sr-only/,
  );
  expect((await rail.boundingBox())!.width).toBe(60);
  await expect(page.getByTestId("navigation-compact-toggle")).toHaveCount(0);
  await expect(rail.getByTestId("folk-status")).toBeVisible();
  await page.reload();
  expect((await rail.boundingBox())!.width).toBe(60);
  await expect(rail.getByTestId("rail-projects")).toHaveText("");
  await expectMainAfterNavigation(page);
});

test("compact rail tooltips label every destination on hover and keyboard focus", async ({
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
    await expectMainAfterNavigation(page);
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

test("knowledge filters combine, dismiss and clear without losing the reader or custom sorting", async ({
  page,
}, testInfo) => {
  const { project, entry } = await seededReader(page);
  const readerPath = `/ui/projects/${project.id}/knowledge/${entry.id}`;
  const customSort = "title:desc,confidence:asc";
  await page.goto(
    `${readerPath}?q=SQLite&sort=${encodeURIComponent(customSort)}`,
  );
  const toggle = page.getByTestId("context-toggle");
  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();
  const toolbar = page.getByTestId("knowledge-list-toolbar");
  const filters = toolbar.getByRole("button", { name: "Filters", exact: true });
  await filters.click();
  const panel = page.getByRole("dialog", {
    name: "Knowledge filters",
    exact: true,
  });
  await panel.getByRole("button", { name: /^Category/ }).click();
  await page.getByRole("option", { name: "Decisions", exact: true }).click();
  await panel.getByRole("button", { name: /^Scope/ }).click();
  await page
    .getByRole("option", { name: "Project + shared", exact: true })
    .click();
  expect(new URL(page.url()).searchParams.has("category")).toBe(false);
  await panel.getByRole("button", { name: "Apply filters" }).click();
  await expect(panel).toHaveCount(0);
  await expect(filters).toBeFocused();
  await expect(page).toHaveURL(
    new RegExp(
      `/knowledge/${entry.id}\\?q=SQLite&category=decision&scope=all&sort=`,
    ),
  );
  expect(new URL(page.url()).searchParams.get("sort")).toBe(customSort);
  await expect(page.getByTestId("knowledge-row").first()).toBeVisible();
  await filters.click();
  await panel.getByRole("button", { name: /^Category/ }).click();
  await page.getByRole("option", { name: "Gotchas", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("category")).toBe("decision");
  const mobile = testInfo.project.name.includes("mobile");
  if (mobile) {
    await expect(
      toolbar.getByRole("group", { name: "Applied knowledge filters" }),
    ).toHaveCount(0);
    await filters.click();
    await panel.getByRole("button", { name: /^Category/ }).click();
    await page
      .getByRole("option", { name: "All categories", exact: true })
      .click();
    await panel.getByRole("button", { name: "Apply filters" }).click();
    await expect(panel).toHaveCount(0);
  } else {
    await toolbar
      .getByRole("button", { name: "Remove category: Decisions" })
      .click();
    await expect(
      toolbar.getByRole("button", { name: "Remove category: Decisions" }),
    ).toHaveCount(0);
  }
  await expect
    .poll(() => new URL(page.url()).searchParams.has("category"))
    .toBe(false);
  expect(new URL(page.url()).searchParams.get("scope")).toBe("all");
  expect(new URL(page.url()).searchParams.get("q")).toBe("SQLite");
  if (mobile) {
    await filters.click();
    await panel
      .getByRole("button", { name: "Clear filters", exact: true })
      .click();
    await expect(panel).toHaveCount(0);
    await expect(filters).toBeFocused();
  } else {
    await toolbar
      .getByRole("button", { name: "Clear filters", exact: true })
      .click();
  }
  await expect(
    toolbar.getByRole("textbox", { name: "Filter this list" }),
  ).toHaveValue("");
  await expect(page).toHaveURL(
    `${readerPath}?sort=${encodeURIComponent(customSort)}`,
  );
  if (testInfo.project.name.includes("mobile")) await toggle.click();
  await expect(page.getByTestId("knowledge-document")).toContainText(
    entry.title,
  );
});

for (const theme of ["light", "dark"] as const) {
  test(`knowledge filter controls fit narrow panes and viewport edges in ${theme} mode`, async ({
    page,
  }, testInfo) => {
    await seededReader(page);
    const mobile = testInfo.project.name.includes("mobile");
    await page.setViewportSize({
      width: mobile ? 320 : 1280,
      height: mobile ? 851 : 800,
    });
    await setWorkspaceTheme(page, theme);
    const toggle = page.getByTestId("context-toggle");
    if ((await toggle.getAttribute("aria-expanded")) === "false")
      await toggle.click();
    const toolbar = page.getByTestId("knowledge-list-toolbar");
    await toolbar.getByRole("button", { name: "Filters", exact: true }).click();
    const panel = page.getByRole("dialog", {
      name: "Knowledge filters",
      exact: true,
    });
    await expect(panel).toBeVisible();
    if (mobile) await waitForOverlayMotion(panel);
    const box = (await panel.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    if (mobile) {
      await expect(panel).toHaveAttribute("data-filter-presentation", "sheet");
      await expectSheetCloseInCorner(panel);
      expect(box.x).toBe(0);
      expect(box.width).toBe(page.viewportSize()!.width);
      expect(box.y + box.height).toBe(page.viewportSize()!.height);
      for (const button of await panel.getByRole("button").all()) {
        expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
    }
    await panel.getByRole("button", { name: /^Scope/ }).click();
    await expect(
      page.getByRole("option", { name: "Shared knowledge", exact: true }),
    ).toBeVisible();
    if (mobile)
      expect(
        (await page
          .getByRole("option", { name: "Shared knowledge", exact: true })
          .boundingBox())!.height,
      ).toBeGreaterThanOrEqual(44);
    await page.keyboard.press("Escape");
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("button", { name: /^Scope/ })).toBeFocused();
    await page.screenshot({
      path: testInfo.outputPath(`knowledge-filters-${theme}.png`),
      fullPage: true,
      scale: "css",
    });
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(
      toolbar.getByRole("button", { name: "Filters", exact: true }),
    ).toBeFocused();
    await toolbar.getByRole("button", { name: /^List sort/ }).click();
    await page
      .getByRole("option", { name: "Lowest confidence", exact: true })
      .click();
    await expect(page).toHaveURL(/sort=confidence%3Aasc$/);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

for (const viewport of [
  { width: 320, height: 480 },
  { width: 568, height: 320 },
]) {
  test(`knowledge filters remain reachable at ${viewport.width}×${viewport.height}`, async ({
    page,
  }, testInfo) => {
    test.skip(!testInfo.project.name.includes("mobile"));
    await page.setViewportSize(viewport);
    await seededReader(page);
    const toggle = page.getByTestId("context-toggle");
    if ((await toggle.getAttribute("aria-expanded")) === "false")
      await toggle.click();
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    const panel = page.getByRole("dialog", {
      name: "Knowledge filters",
      exact: true,
    });
    await expect(panel).toBeVisible();
    await expect
      .poll(async () => {
        const box = (await panel.boundingBox())!;
        return box.y >= 0 && box.y + box.height <= viewport.height;
      })
      .toBe(true);
    await expect(
      panel.getByRole("button", { name: "Apply filters" }),
    ).toBeInViewport();
    await panel.getByRole("button", { name: /^Category/ }).click();
    await page.getByRole("option", { name: "Decisions", exact: true }).click();
    await panel.getByRole("button", { name: /^Scope/ }).click();
    await page
      .getByRole("option", { name: "Project + shared", exact: true })
      .click();
    await panel.getByRole("button", { name: "Apply filters" }).click();
    await expect(panel).toHaveCount(0);
    await expect(page).toHaveURL(/category=decision&scope=all$/);
    await expect(
      page.getByRole("button", { name: "Filters", exact: true }),
    ).toBeFocused();
  });
}

test("knowledge filter presentation closes safely across breakpoints", async ({
  page,
}) => {
  const { entry } = await seededReader(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  const filters = page.getByRole("button", { name: "Filters", exact: true });
  const panel = page.getByRole("dialog", {
    name: "Knowledge filters",
    exact: true,
  });
  await filters.click();
  await panel.getByRole("button", { name: /^Category/ }).click();
  await page.getByRole("option", { name: "Gotchas", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 851 });
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId("context-toggle")).toBeFocused();
  await page.getByTestId("context-toggle").click();
  await filters.click();
  await expect(panel).toHaveAttribute("data-filter-presentation", "sheet");
  await expect(panel.getByRole("button", { name: /^Category/ })).toContainText(
    "All categories",
  );
  await panel.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(filters).toBeFocused();
  await filters.click();
  await expect
    .poll(async () => {
      const box = (await panel.boundingBox())!;
      return Math.abs(box.y + box.height - page.viewportSize()!.height) < 0.5;
    })
    .toBe(true);
  await page.mouse.click(8, 8);
  await expect(panel).toHaveCount(0);
  await expect(filters).toBeFocused();
  await expect(page.getByTestId("nav-drawer")).toHaveCount(0);
  await filters.click();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(panel).toHaveCount(0);
  await expect(filters).toBeFocused();
  expect(new URL(page.url()).searchParams.has("category")).toBe(false);
  await expect(page.getByTestId("knowledge-document")).toContainText(
    entry.title,
  );
});

test("mobile knowledge sheet respects reduced motion and keeps keyboard focus inside", async ({
  page,
}, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await seededReader(page);
  await page.getByTestId("context-toggle").click();
  const filters = page.getByRole("button", { name: "Filters", exact: true });
  await filters.click();
  const panel = page.getByRole("dialog", {
    name: "Knowledge filters",
    exact: true,
  });
  await expect(panel).toHaveAttribute("data-filter-presentation", "sheet");
  expect(
    await panel.evaluate((element) => getComputedStyle(element).animationName),
  ).toBe("none");
  await panel.getByRole("button", { name: "Dismiss", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(panel.getByRole("button", { name: /^Category/ })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    panel.getByRole("button", { name: "Dismiss", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(filters).toBeFocused();
});

for (const action of ["Cancel", "Apply filters", "Dismiss"]) {
  test(`closing the mobile sheet with ${action} before resizing restores current focus`, async ({
    page,
  }, testInfo) => {
    test.skip(!testInfo.project.name.includes("mobile"));
    await page.setViewportSize({ width: 390, height: 851 });
    await seededReader(page);
    await page.getByTestId("context-toggle").click();
    const filters = page.getByRole("button", { name: "Filters", exact: true });
    await filters.click();
    const panel = page.getByRole("dialog", {
      name: "Knowledge filters",
      exact: true,
    });
    await panel.getByRole("button", { name: action, exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(panel).toHaveCount(0);
    await expect(filters).toBeFocused();
  });
}

test("nested knowledge filter options remain accessible after deferred modal updates", async ({
  page,
}, testInfo) => {
  const mobile = testInfo.project.name.includes("mobile");
  await page.setViewportSize({
    width: mobile ? 568 : 1280,
    height: mobile ? 320 : 800,
  });
  await seededReader(page);
  const toggle = page.getByTestId("context-toggle");
  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  const panel = page.getByRole("dialog", {
    name: "Knowledge filters",
    exact: true,
  });
  for (const [label, count] of [
    ["Category", 6],
    ["Scope", 4],
  ] as const) {
    const trigger = panel.getByRole("button", {
      name: new RegExp(`^${label}`),
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      await trigger.click();
      // Kobalte ariaHideOutside schedules its writes with a timeout and rAF.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            setTimeout(
              () =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => resolve()),
                ),
              0,
            ),
          ),
      );
      await expect(page.getByRole("option")).toHaveCount(count);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("listbox")).toHaveCount(0);
      await expect(trigger).toBeFocused();
    }
  }
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
});

for (const theme of ["light", "dark"] as const) {
  test(`knowledge sort uses the responsive choice layout in ${theme}`, async ({
    page,
  }, testInfo) => {
    const mobile = testInfo.project.name.includes("mobile");
    await page.setViewportSize({
      width: mobile ? 320 : 1280,
      height: mobile ? 851 : 800,
    });
    const { project, entry } = await seededReader(page);
    const path = `/ui/projects/${project.id}/knowledge/${entry.id}`;
    const customSort = "title:desc,confidence:asc";
    await page.goto(
      `${path}?q=SQLite&category=decision&scope=all&sort=${encodeURIComponent(customSort)}`,
    );
    await setWorkspaceTheme(page, theme);
    const toggle = page.getByTestId("context-toggle");
    if ((await toggle.getAttribute("aria-expanded")) === "false")
      await toggle.click();
    const filters = page.getByRole("button", { name: "Filters", exact: true });
    if (mobile) {
      const box = (await filters.boundingBox())!;
      expect(box.width).toBe(44);
      expect(box.height).toBe(44);
      await expect(filters.getByText("Filters", { exact: true })).toBeHidden();
      await expect(filters).toContainText("3");
    } else
      await expect(filters.getByText("Filters", { exact: true })).toBeVisible();
    const chips = page.getByRole("group", {
      name: "Applied knowledge filters",
    });
    if (mobile) await expect(chips).toHaveCount(0);
    else await expect(chips).toBeVisible();
    await expect(filters).toHaveAccessibleDescription("3 active filters");
    const badge = filters.getByLabel("3 active filters");
    await expect(badge).toHaveText("3");
    const badgeBox = (await badge.boundingBox())!;
    expect(badgeBox.width).toBeGreaterThanOrEqual(16);
    expect(badgeBox.height).toBeGreaterThanOrEqual(16);
    await page.getByTestId("knowledge-list-toolbar").screenshot({
      path: testInfo.outputPath(`knowledge-toolbar-${theme}.png`),
      scale: "css",
    });
    if (mobile) {
      await filters.click();
      const panel = page.getByRole("dialog", {
        name: "Knowledge filters",
        exact: true,
      });
      for (const name of ["Clear filters", "Cancel", "Apply filters"]) {
        await expect(
          panel.getByRole("button", { name, exact: true }),
        ).toBeInViewport();
      }
      expect(
        await panel.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`knowledge-active-filters-${theme}.png`),
        scale: "css",
        fullPage: true,
      });
      await panel.getByRole("button", { name: "Dismiss", exact: true }).click();
      await expect(panel).toHaveCount(0);
    }
    const sort = page.getByRole("button", { name: /^List sort/ });
    await sort.click();
    const sheet = page.getByRole("dialog", {
      name: "Sort knowledge",
      exact: true,
    });
    if (mobile) {
      await expect(sheet).toHaveAttribute("data-select-presentation", "sheet");
      await expect
        .poll(async () => {
          const box = (await sheet.boundingBox())!;
          return (
            box.x === 0 &&
            Math.abs(box.y + box.height - 851) < 0.5 &&
            box.width === 320
          );
        })
        .toBe(true);
      await expectSheetCloseInCorner(sheet);
      await expect(
        page.getByRole("option", { name: "Custom sort", exact: true }),
      ).toHaveAttribute("aria-selected", "true");
      await page
        .getByRole("option", { name: "Title A–Z", exact: true })
        .focus();
      await page.keyboard.press("ArrowDown");
      expect(new URL(page.url()).searchParams.get("sort")).toBe(customSort);
    } else await expect(sheet).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath(`knowledge-sort-${theme}.png`),
      scale: "css",
      fullPage: true,
    });
    if (mobile) {
      await page
        .getByRole("option", { name: "Title A–Z", exact: true })
        .focus();
      await page.keyboard.press("Enter");
    } else
      await page
        .getByRole("option", { name: "Title A–Z", exact: true })
        .click();
    await expect(page).toHaveURL(
      `${path}?q=SQLite&category=decision&scope=all&sort=title%3Aasc`,
    );
    if (mobile) {
      await expect(sheet).toHaveCount(0);
      await expect(sort).toBeFocused();
    }
  });
}

test("mobile sort keeps options reachable in landscape and restores focus through resizing", async ({
  page,
}, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"));
  await page.setViewportSize({ width: 568, height: 320 });
  await seededReader(page);
  await page.getByTestId("context-toggle").click();
  const sort = page.getByRole("button", { name: /^List sort/ });
  // Normal opening must focus the selected option without moving the header.
  await sort.click();
  const initialSheet = page.getByRole("dialog", {
    name: "Sort knowledge",
    exact: true,
  });
  const selected = page.getByRole("option", {
    name: "Recently updated",
    exact: true,
  });
  await expect(selected).toBeFocused();
  await expect(
    initialSheet.getByRole("heading", { name: "Sort knowledge", exact: true }),
  ).toBeInViewport();
  await page.keyboard.press("Escape");
  await expect(initialSheet).toHaveCount(0);
  // Navigate in the same turn as opening, before deferred autofocus can run.
  await sort.evaluate(async (element) => {
    if (!(element instanceof HTMLButtonElement))
      throw new Error("sort trigger is not a button");
    element.click();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const first = document.querySelector<HTMLElement>('[role="option"]');
    if (!first) throw new Error("sort options did not mount");
    first.focus({ preventScroll: true });
    first.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "End",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  const sheet = page.getByRole("dialog", {
    name: "Sort knowledge",
    exact: true,
  });
  await expect(sheet).toBeVisible();
  const last = page.getByRole("option", {
    name: "Lowest confidence",
    exact: true,
  });
  await expect(last).toBeFocused();
  // A deferred initial-focus callback must not reset an early keyboard choice.
  await waitForOverlayMotion(sheet);
  await sheet.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));
  await expect(last).toBeFocused();
  await expect(last).toBeInViewport();
  await expect(
    sheet.getByRole("heading", { name: "Sort knowledge", exact: true }),
  ).toBeInViewport();
  expect(new URL(page.url()).searchParams.has("sort")).toBe(false);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(sheet).toHaveCount(0);
  await expect(sort).toBeFocused();
  await page.setViewportSize({ width: 390, height: 851 });
  await page.getByTestId("context-toggle").click();
  await sort.click();
  await page.getByRole("option", { name: "Title A–Z", exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(sheet).toHaveCount(0);
  await expect(sort).toBeFocused();
  await expect(page).toHaveURL(/sort=title%3Aasc$/);
});

test("knowledge table and search scope share mobile selection sheets", async ({
  page,
}, testInfo) => {
  const mobile = testInfo.project.name.includes("mobile");
  const { project } = await seededReader(page);
  await page.goto("/ui/knowledge?q=SQLite&sort=title:asc");
  for (const [label, title, value] of [
    ["category", "Knowledge category", "decision"],
    ["project", "Filter by project", "lore"],
    ["scope", "Knowledge visibility", "Project-only"],
  ] as const) {
    const trigger = page.getByRole("button", {
      name: new RegExp(`^${label}\\b`),
    });
    await trigger.click();
    const sheet = page.getByRole("dialog", { name: title, exact: true });
    if (mobile)
      await expect(sheet).toHaveAttribute("data-select-presentation", "sheet");
    else await expect(sheet).toHaveCount(0);
    await page.getByRole("option", { name: value, exact: true }).click();
    if (mobile) {
      await expect(sheet).toHaveCount(0);
      await expect(trigger).toBeFocused();
    }
    await expect
      .poll(() => new URL(page.url()).searchParams.get(label))
      .toBe(
        label === "project"
          ? project.id
          : label === "scope"
            ? "project"
            : value,
      );
    expect(new URL(page.url()).searchParams.get("q")).toBe("SQLite");
    expect(new URL(page.url()).searchParams.get("sort")).toBe("title:asc");
  }
  const projectFilter = page.getByRole("button", { name: /^project\b/ });
  await projectFilter.click();
  await page.getByRole("option", { name: "All projects", exact: true }).click();
  await expect
    .poll(() => new URL(page.url()).searchParams.has("project"))
    .toBe(false);
  if (mobile) await expect(projectFilter).toBeFocused();
  expect(new URL(page.url()).searchParams.get("category")).toBe("decision");
  expect(new URL(page.url()).searchParams.get("scope")).toBe("project");
  await page.goto(`/ui/projects/${project.id}/search?q=SQLite&scope=all`);
  await page.getByRole("button", { name: /^Search scope/ }).click();
  const sheet = page.getByRole("dialog", { name: "Search scope", exact: true });
  if (mobile)
    await expect(sheet).toHaveAttribute("data-select-presentation", "sheet");
  else await expect(sheet).toHaveCount(0);
  await page
    .getByRole("option", { name: "Knowledge and memory files", exact: true })
    .click();
  expect(new URL(page.url()).searchParams.get("scope")).toBe("all");
  await page
    .getByRole("search")
    .getByRole("button", { name: "Search", exact: true })
    .click();
  await expect(page).toHaveURL(
    `/ui/projects/${project.id}/search?q=SQLite&scope=knowledge`,
  );
});

test("desktop sort dropdown hands focus to the mobile toolbar on resize", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await seededReader(page);
  await page.getByRole("button", { name: /^List sort/ }).click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 480 });
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "Sort knowledge", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByTestId("context-toggle")).toBeFocused();
});

test("workspace selectors use sheets on mobile and preserve desktop dropdowns", async ({
  page,
}, testInfo) => {
  const mobile = testInfo.project.name.includes("mobile");
  const { project } = await seededReader(page);
  const choose = async (label: string, title: string, value: string) => {
    const trigger = page.getByRole("button", {
      name: new RegExp(`^${label}\\b`),
    });
    await trigger.click();
    const sheet = page.getByRole("dialog", { name: title, exact: true });
    if (mobile)
      await expect(sheet).toHaveAttribute("data-select-presentation", "sheet");
    else await expect(sheet).toHaveCount(0);
    await page.getByRole("option", { name: value, exact: true }).click();
    if (mobile) {
      await expect(sheet).toHaveCount(0);
      await expect(trigger).toBeFocused();
    }
  };
  await page.goto("/ui/entities");
  await choose("Entity type", "Filter by entity type", "person");
  await expect(page).toHaveURL("/ui/entities?type=person");
  await choose("Entity type", "Filter by entity type", "all");
  await expect(page).toHaveURL("/ui/entities");

  await page.goto(`/ui/projects/${project.id}`);
  await page
    .getByRole("main")
    .getByRole("textbox", { name: "Search this project's memory" })
    .fill("SQLite");
  await choose("Search scope", "Search scope", "Knowledge and memory files");
  await expect(page).toHaveURL(`/ui/projects/${project.id}`);
  await page
    .getByRole("search")
    .getByRole("button", { name: "Search", exact: true })
    .click();
  await expect(page).toHaveURL(
    `/ui/projects/${project.id}/search?q=SQLite&scope=knowledge`,
  );

  await page.goto("/ui/model-usage");
  await choose("Project", "Filter model usage by project", "lore");
  await expect
    .poll(() => new URL(page.url()).searchParams.get("project"))
    .toBe(project.id);
  await expect(page.getByTestId("chart-status")).toContainText(
    "6 active session-days",
  );
  await choose("Project", "Filter model usage by project", "All projects");
  await expect
    .poll(() => new URL(page.url()).searchParams.has("project"))
    .toBe(false);
  await expect(page.getByTestId("chart-status")).toContainText(
    "8 active session-days",
  );
});

for (const section of ["knowledge", "sessions"] as const) {
  test(`Escape in ${section} context search keeps the pane and its preference`, async ({
    page,
  }) => {
    const { project } = await seededReader(page);
    if (section === "sessions") {
      await page.goto(`/ui/projects/${project.id}/sessions/e2e-reader`);
      await expect(page.getByTestId("session-view")).toBeVisible();
    }
    const toggle = page.getByTestId("context-toggle");
    if ((await toggle.getAttribute("aria-expanded")) === "false")
      await toggle.click();
    const pane = page.getByTestId("context-pane");
    const input = pane.getByRole(
      section === "sessions" ? "searchbox" : "textbox",
      {
        name:
          section === "sessions" ? "Filter session list" : "Filter this list",
      },
    );
    await input.fill("SQLite");
    const preference = await page.evaluate(() =>
      localStorage.getItem("lore.ui.sidebarCollapsed"),
    );
    await input.press("Escape");
    await expect(pane).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(input).toBeFocused();
    // Search inputs retain native Escape-to-clear behavior.
    if (section === "sessions") await expect(input).toHaveValue("");
    expect(
      await page.evaluate(() =>
        localStorage.getItem("lore.ui.sidebarCollapsed"),
      ),
    ).toBe(preference);
    await pane.locator("a[href]").first().focus();
    await page.keyboard.press("Escape");
    await expect(pane).toBeHidden();
    await expect(toggle).toBeFocused();
  });
}

test("project pinning retains keyboard focus through regrouping", async ({
  page,
}) => {
  await page.goto("/ui");
  const picker = await openProjectPicker(page);
  const initial = picker.getByTestId("nav-pin").first();
  const name = (await initial.getAttribute("aria-label"))!.replace(/^Pin /, "");
  await expect(initial).toHaveAttribute("aria-pressed", "false");
  await initial.focus();
  await page.keyboard.press("Enter");
  const unpin = picker.getByRole("button", {
    name: `Unpin ${name}`,
    exact: true,
  });
  await expect(unpin).toBeFocused();
  await expect(unpin).toBeInViewport();
  await page.keyboard.press("ArrowDown");
  await expect(picker.getByTestId("nav-project").nth(1)).toBeFocused();
  await unpin.focus();
  await page.keyboard.press("Enter");
  const pin = picker.getByRole("button", { name: `Pin ${name}`, exact: true });
  await expect(pin).toBeFocused();
  await expect(pin).toBeInViewport();
  await page.keyboard.press("ArrowDown");
  await expect(picker.getByTestId("nav-project").nth(1)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(page.getByTestId("project-picker-trigger")).toBeFocused();
});
