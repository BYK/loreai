import { expect, test } from "@playwright/test";

test("setup chooser supplies the Desktop route and preserves it into the first-session guide", async ({
  page,
}) => {
  await page.goto("/");
  const setup = page.locator(".agent-setup");
  await setup
    .getByRole("radio", { name: "Codex Desktop", exact: true })
    .check();
  const panel = setup.locator('[data-setup-panel="codex-desktop"]');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("lore setup codex");
  await expect(panel).toContainText("lore start --bg --local");
  await expect(
    panel.getByRole("link", { name: "Connect and verify" }),
  ).toHaveAttribute("href", /first-session\/\?agent=codex-desktop/);
  await panel.getByRole("link", { name: "Connect and verify" }).click();
  await expect(page.locator("h1")).toContainText("first session");
  await expect(
    page.locator(".agent-setup input[value=codex-desktop]"),
  ).toBeChecked();
});

test("setup query is allowlisted and Pi explains its extension prerequisite", async ({
  page,
}) => {
  await page.goto("/docs/install/?agent=%22%5D%3Cscript%3E");
  await expect(
    page.locator(".agent-setup input[value=claude-code]"),
  ).toBeChecked();
  await page.goto("/docs/install/?agent=pi");
  const panel = page.locator("[data-setup-panel=pi]");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("@loreai/pi");
  await expect(panel).toContainText("pi install");
  await expect(page.locator("body")).not.toContainText("[object Object]");
});

test("agent choices work without JavaScript", async ({
  browser,
  baseURL,
  viewport,
  colorScheme,
  isMobile,
  hasTouch,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport,
    colorScheme,
    isMobile,
    hasTouch,
  });
  const page = await context.newPage();
  await page.goto(`${baseURL}/docs/install/`);
  await page
    .locator(".agent-setup")
    .getByRole("radio", { name: "Hermes", exact: true })
    .check();
  await expect(page.locator("[data-setup-panel=hermes]")).toBeVisible();
  await expect(page.locator("[data-setup-panel=hermes]")).toContainText(
    "lore run hermes",
  );
  await expect(page.locator("[data-setup-panel=codex-desktop]")).toBeHidden();
  await context.close();
});

test("product tour shows the actual app and an accessible next step", async ({
  page,
}) => {
  await page.goto("/");
  const tour = page.locator(".product-tour");
  await expect(tour).toContainText("Sample data");
  await tour
    .getByRole("radio", { name: "Review knowledge", exact: true })
    .check();
  const panel = tour.locator("[data-tour-panel=knowledge]");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("img")).toBeVisible();
  await expect(panel.getByRole("img")).toHaveJSProperty("naturalWidth", 1120);
  const theme = await page.locator("html").getAttribute("data-theme");
  await expect(
    panel.getByRole("link", { name: /Open full-size/ }),
  ).toHaveAttribute("href", `/product-tour/knowledge-${theme}.png`);
  await expect(
    panel.getByRole("link", { name: /Learn to review knowledge/ }),
  ).toHaveAttribute("href", /using-lore/);
});

test("built documentation search finds symptom-based help", async ({
  page,
}) => {
  await page.goto("/docs/");
  await page
    .getByRole("button", { name: /Search/ })
    .first()
    .click();
  const query = page
    .getByRole("dialog", { name: "Search", exact: true })
    .getByRole("textbox", { name: "Search", exact: true });
  await query.fill("missing session");
  await expect(
    page
      .locator(".pagefind-ui__result-link")
      .filter({ hasText: /session|troubleshoot/i })
      .first(),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(query).toBeHidden();
});

test("task docs expose a concrete next action and preserve availability boundaries", async ({
  page,
}) => {
  for (const [path, text] of [
    ["/docs/first-session/", "recorded session"],
    ["/docs/using-lore/", "Knowledge"],
    ["/docs/troubleshooting/", "missing session"],
    ["/docs/memory/", "Stored"],
    ["/docs/data-and-costs/", "SENTRY_ENABLED=0"],
    ["/docs/example/", "event ID"],
  ]) {
    await page.goto(path);
    await expect(page.locator("main")).toContainText(new RegExp(text, "i"));
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(page.viewportSize()!.width);
  }
  await page.goto("/different/");
  await expect(page.locator("main")).toContainText("early access");
});

test("documentation copy actions recover from a denied clipboard", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("denied")) },
    }),
  );
  await page.goto("/docs/install/?agent=codex-desktop");
  const setup = page.locator(".agent-setup");
  await setup
    .getByRole("button", { name: "Copy installation command", exact: true })
    .click();
  await expect(setup.locator(".copy-status")).toContainText("Select and copy");
  const panel = setup.locator("[data-setup-panel=codex-desktop]");
  await panel
    .getByRole("button", {
      name: "Copy Codex Desktop connection command",
      exact: true,
    })
    .click();
  await expect(panel.locator(".setup-copy-status")).toContainText(
    "Select and copy",
  );
  await expect(panel.locator("pre")).toContainText("lore setup codex");
});

test("documentation header search and navigation never overlap at intermediate widths", async ({
  page,
}) => {
  for (const width of [900, 1024, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/docs/install/");
    const header = page.locator(".docs-site-header");
    const controls = header.locator(
      ".logo, .docs-primary, site-search, .docs-controls",
    );
    const boxes = [];
    for (const control of await controls.all()) {
      if (await control.isVisible()) {
        const box = await control.boundingBox();
        if (box) boxes.push(box);
      }
    }
    for (let i = 1; i < boxes.length; i++)
      expect(boxes[i].x).toBeGreaterThanOrEqual(
        boxes[i - 1].x + boxes[i - 1].width - 1,
      );
    const search = header.getByRole("button", { name: "Search", exact: true }),
      searchBox = await search.boundingBox(),
      themeBox = await header.locator(".docs-controls").boundingBox();
    expect(searchBox!.x + searchBox!.width).toBeLessThanOrEqual(themeBox!.x);
  }
});
