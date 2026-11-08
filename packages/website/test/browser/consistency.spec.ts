import { expect, test } from "@playwright/test";

test("equivalent choice controls share shape and selection styling", async ({
  page,
}) => {
  const styles = [];
  for (const [path, selector] of [
    ["/", ".knowledge-file"],
    ["/docs/install/", ".setup-picker"],
    ["/docs/troubleshooting/", ".diagnostic-guide"],
  ]) {
    await page.goto(path);
    const selected = page
      .locator(selector + " label:has(input:checked)")
      .first();
    styles.push(
      await selected.evaluate((el) => {
        const s = getComputedStyle(el);
        return { radius: s.borderRadius, background: s.backgroundColor };
      }),
    );
    expect((await selected.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  expect(styles[1]).toEqual(styles[0]);
  expect(styles[2]).toEqual(styles[0]);
});

test("client choices form a stable grid and copying does not confirm a connection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text: string) => {
          (window as unknown as { copied: string }).copied = text;
        },
      },
    }),
  );
  await page.goto("/docs/install/?agent=hermes");
  const choices = await page.locator(".setup-picker label").all();
  const boxes = await Promise.all(choices.map((c) => c.boundingBox()));
  expect(boxes[3]!.y).toBeCloseTo(boxes[5]!.y, 0);
  expect(boxes[0]!.width).toBeCloseTo(boxes[5]!.width, 0);
  const panel = page.locator('[data-setup-panel="hermes"]');
  await panel
    .getByRole("button", {
      name: "Copy Hermes connection command",
      exact: true,
    })
    .click();
  expect(
    await page.evaluate(() => (window as unknown as { copied: string }).copied),
  ).toBe("lore run hermes");
  await expect(panel.getByRole("checkbox")).not.toBeChecked();
  await expect(panel.locator(".setup-copy-status")).toContainText("Run this");
});

test("the mobile tour reaches legible product proof after one introduction", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tour/");
  await expect(page.locator(".tour-intro h1")).toHaveCount(1);
  await expect(page.locator(".product-tour > .section-heading")).toHaveCount(0);
  const link = page.locator(
    '.tour-panel[data-tour-panel="sessions"] .tour-image-link:visible',
  );
  expect((await link.boundingBox())!.y).toBeLessThan(520);
  const image = link.locator("img");
  expect((await image.boundingBox())!.width).toBeGreaterThanOrEqual(640);
  await expect(link).toHaveAttribute("href", /sessions-(light|dark)\.png$/);
});

test("reference finder keeps all content and supports literal search, links and history", async ({
  page,
}) => {
  await page.goto(
    "/docs/configuration/?from=qa&setting=knowledge#field-reference",
  );
  const finder = page.locator(".reference-finder");
  const search = finder.getByRole("searchbox", {
    name: "Find a setting",
    exact: true,
  });
  await expect(search).toHaveValue("knowledge");
  const results = finder.locator("[data-finder-results]");
  await expect(
    results.getByRole("link", { name: "knowledge", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#distillation")).toBeAttached();
  await search.fill('"<script>');
  await expect(finder.getByRole("status")).toContainText("No settings");
  await expect(page).toHaveURL(/from=qa&setting=.*#field-reference$/);
  await search.fill("workerModel");
  await results.getByRole("link", { name: "workerModel", exact: true }).click();
  await expect(page).toHaveURL(/#workermodel$/);
  await search.fill("budget");
  await page.goBack();
  await expect(search).toHaveValue("workerModel");
  await expect(page.locator("#distillation")).toBeAttached();
});

test("reference directories work without JavaScript and do not alter ordinary docs", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 320, height: 844 },
  });
  try {
    const page = await context.newPage();
    await page.goto(baseURL + "/docs/configuration/");
    const directory = page.locator(".reference-finder details");
    await directory.locator("summary").click();
    await directory
      .getByRole("link", { name: "knowledge", exact: true })
      .click();
    await expect(page).toHaveURL(/#knowledge$/);
    await page.goto(baseURL + "/docs/environment/");
    await expect(page.locator(".reference-finder details")).toBeVisible();
    await page.goto(baseURL + "/docs/install/");
    await expect(page.locator(".docs-journal-title")).toContainText(
      "Getting started",
    );
    await expect(page.locator(".reference-finder")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("reference contents are concise while setting anchors remain available", async ({
  page,
}) => {
  await page.goto("/docs/configuration/");
  expect(await page.locator("starlight-toc a").count()).toBeLessThanOrEqual(8);
  await expect(page.locator("#knowledge")).toBeAttached();
  await page.goto("/docs/guides/with-codex/");
  await expect(page.locator(".docs-journal-title")).toContainText("Guides");
  await expect(
    page.locator('starlight-toc a[href="#install-cli"]'),
  ).toHaveCount(1);
});

test("the production404 offers nearby recovery and the existing search dialog", async ({
  page,
}) => {
  const response = await page.goto("/missing-field-guide-page/");
  expect(response!.status()).toBe(404);
  const recovery = page.locator(".page-recovery");
  await expect(
    recovery.getByRole("link", { name: "Back to Lore", exact: true }),
  ).toHaveAttribute("href", "/");
  await expect(
    recovery.getByRole("link", { name: "Open documentation", exact: true }),
  ).toHaveAttribute("href", "/docs/");
  await recovery
    .getByRole("button", { name: "Search documentation", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Search", exact: true }),
  ).toBeVisible();
  await expect(page.locator('dialog[aria-label="Search"]')).toHaveCount(1);
});

test("recovery search waits for the framework and returns focus after Escape", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/_astro/Search.*.js", async (route) => {
    await gate;
    await route.continue();
  });
  try {
    await page.goto("/missing-field-guide-page/", { waitUntil: "commit" });
    const action = page.getByRole("button", {
      name: "Search documentation",
      exact: true,
    });
    await expect(action).toBeVisible();
    await expect(action).toBeDisabled();
    release();
    await page.waitForLoadState("load");
    await expect(action).toBeEnabled();
    await action.click();
    await expect(
      page.getByRole("dialog", { name: "Search", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(action).toBeFocused();
  } finally {
    release();
  }
});

test("the setting finder includes nested fields and environment variables", async ({
  page,
}) => {
  await page.goto("/docs/configuration/");
  await page
    .getByRole("searchbox", { name: "Find a setting", exact: true })
    .fill("autoToolFailureGotchas");
  await expect(
    page.locator("[data-finder-results]").getByRole("link", {
      name: "knowledge.autoToolFailureGotchas",
      exact: true,
    }),
  ).toHaveAttribute("href", "#knowledge");
  await page.goto("/docs/environment/");
  await page
    .getByRole("searchbox", { name: "Find a setting", exact: true })
    .fill("LORE_WORKER_MODEL");
  await expect(
    page
      .locator("[data-finder-results]")
      .getByRole("link", { name: "LORE_WORKER_MODEL", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("searchbox", { name: "Find a setting", exact: true })
    .fill("LORE_LISTEN_PORT");
  await expect(
    page
      .locator("[data-finder-results]")
      .getByRole("link", { name: "LORE_LISTEN_PORT", exact: true }),
  ).toBeVisible();
});
