import { expect, test } from "@playwright/test";

test("first session leads with verification and discloses earlier connection commands", async ({
  page,
}) => {
  await page.goto("/docs/first-session/?agent=codex-desktop&from=guide#verify");
  const setup = page.locator(".agent-setup");
  await expect(setup.locator('[aria-current="step"]')).toContainText("Verify");
  await expect(
    page.getByRole("heading", { name: "Verify", exact: true }),
  ).toBeVisible();
  const panel = setup.locator('[data-setup-panel="codex-desktop"]');
  const earlier = panel.locator("details.setup-earlier");
  await expect(earlier).not.toHaveAttribute("open", "");
  await expect(panel.locator(".setup-desktop-steps")).toBeHidden();
  await expect(setup.locator(".platform-install")).toHaveCount(0);
  await earlier.locator("summary").click();
  await expect(panel.locator(".setup-desktop-steps > li")).toHaveCount(4);
  await expect(panel).toContainText("lore start --bg --local");
  await expect(panel.locator(".setup-confirmed")).toBeHidden();
  await panel.getByRole("checkbox").check();
  await expect(panel.locator(".setup-confirmed")).toBeVisible();
  await expect(panel).toContainText("does not inspect your local gateway");
  await setup.getByRole("radio", { name: "Hermes", exact: true }).check();
  await expect(page).toHaveURL(/agent=hermes&from=guide#verify$/);
  await expect(
    setup.locator('[data-setup-panel="hermes"] .setup-confirmed'),
  ).toBeHidden();
  await page.goBack();
  await expect(
    setup.getByRole("radio", { name: "Codex Desktop", exact: true }),
  ).toBeChecked();
  await expect(panel.locator(".setup-confirmed")).toBeVisible();
});

test("earlier first-session steps remain native for all six clients without JavaScript", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 320, height: 844 },
  });
  try {
    const page = await context.newPage();
    await page.goto(`${baseURL}/docs/first-session/`);
    const setup = page.locator(".agent-setup");
    for (const [name, client, command] of [
      ["Claude Code", "claude-code", "lore run claude"],
      ["Codex CLI", "codex", "lore run codex"],
      ["Codex Desktop", "codex-desktop", "lore setup codex"],
      ["OpenCode", "opencode", "lore run opencode"],
      ["Pi", "pi", "pi install"],
      ["Hermes", "hermes", "lore run hermes"],
    ]) {
      await setup.getByRole("radio", { name, exact: true }).check();
      const panel = setup.locator(`[data-setup-panel="${client}"]`);
      await expect(panel).toBeVisible();
      await panel.locator("details.setup-earlier > summary").click();
      await expect(panel.locator("details.setup-earlier")).toContainText(
        command,
      );
      await expect(
        panel.locator("details.setup-earlier a").first(),
      ).toHaveAttribute("href", /docs\/install\//);
      await panel.getByRole("checkbox").check();
      await expect(panel.locator(".setup-confirmed")).toBeVisible();
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(320);
  } finally {
    await context.close();
  }
});

test("daily-use examples point to real original captures and name the expected action", async ({
  page,
}) => {
  await page.goto("/docs/using-lore/");
  for (const [id, text, original] of [
    ["session-search", "title or ID", "sessions"],
    ["knowledge-edit", "Edit", "knowledge"],
    ["source-history", "exact-message", "knowledge-detail"],
  ]) {
    const example = page.locator(`[data-task-example="${id}"]`);
    await expect(example).toContainText(text);
    await expect(example).toContainText("Expected result");
    const link = example.locator("a[data-media-viewer]:visible");
    await expect(link).toHaveAttribute(
      "href",
      new RegExp(`/product-tour/${original}-(light|dark)\\.png$`),
    );
    expect(
      (await page.request.get((await link.getAttribute("href"))!)).status(),
    ).toBe(200);
    await expect(example).toContainText(/read-only/i);
  }
});

test("task pages have one contextual ending without competing pagination or generic help", async ({
  page,
}) => {
  for (const route of ["", "first-session", "using-lore", "guides/with-pi"]) {
    await page.goto(`/docs/${route ? `${route}/` : ""}`);
    await expect(page.locator(".docs-next-action")).toHaveCount(1);
    await expect(
      page.locator(".pagination-links, .docs-help-links"),
    ).toHaveCount(0);
    await expect(page.locator(".docs-next-action .next-primary")).toHaveCount(
      1,
    );
  }
  await page.goto("/docs/install/?agent=pi");
  await expect(page.locator("#next-steps")).toHaveCount(1);
  await expect(
    page
      .locator("main")
      .getByRole("heading", { name: "Next steps", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".pagination-links, .docs-help-links")).toHaveCount(
    0,
  );
  await expect(
    page.locator('[data-setup-panel="pi"] .setup-next a').first(),
  ).toHaveAttribute("href", /first-session\/\?agent=pi#verify/);
});
