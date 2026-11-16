import { expect, test } from "@playwright/test";

test("screenshots use one centered viewer with fit, keyboard zoom, dismissal and focus return", async ({
  page,
}) => {
  await page.goto("/tour/");
  const image = page
    .locator(
      '.tour-panel[data-tour-panel="sessions"] a[data-media-viewer]:visible',
    )
    .first();
  await image.focus();
  await image.press("Enter");
  const dialog = page.getByRole("dialog", { name: "App screenshot" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/Read-only/)).toBeVisible();
  const box = await dialog.boundingBox();
  const viewport = page.viewportSize()!;
  expect(Math.abs(box!.x + box!.width / 2 - viewport.width / 2)).toBeLessThan(
    2,
  );
  await expect(dialog.locator(".media-canvas > img")).toHaveAttribute(
    "src",
    /sessions-(light|dark)\.png$/,
  );
  await dialog.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("125%");
  await dialog.locator(".media-canvas").focus();
  await page.keyboard.press("+");
  await expect(dialog.getByRole("status")).toHaveText("150%");
  await page.keyboard.press("0");
  await expect(dialog.getByRole("status")).toHaveText("Fit");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(image).toBeFocused();
  await image.click();
  await page.mouse.click(1, 1);
  await expect(dialog).toBeHidden();
  await expect(image).toBeFocused();
});

test("open diagrams rerender safely through a theme change and keep their origin intact", async ({
  page,
}) => {
  await page.goto("/docs/architecture/");
  const source = page.locator(".mermaid").first();
  const expand = source.getByRole("button", {
    name: "Expand diagram",
    exact: true,
  });
  await expand.click();
  const dialog = page.getByRole("dialog", { name: "Expanded diagram" });
  await expect(dialog.locator(".media-canvas > svg")).toHaveCount(1);
  await page.evaluate(
    () =>
      (document.documentElement.dataset.theme =
        document.documentElement.dataset.theme === "dark" ? "light" : "dark"),
  );
  await expect
    .poll(() => source.getAttribute("data-rendered-theme"))
    .toBe(await page.evaluate(() => document.documentElement.dataset.theme));
  await expect(dialog.locator(".media-canvas > svg")).toHaveCount(1);
  await dialog
    .getByRole("button", { name: "Close diagram", exact: true })
    .click();
  await expect(source.locator(":scope > svg")).toHaveCount(1);
  await expect(expand).toBeFocused();
  await expect(page.locator("dialog.media-dialog")).toHaveCount(1);
});

test("long article contents stays available and tracks the native anchor section", async ({
  page,
}) => {
  await page.goto("/blog/how-lore-remembers-and-forgets/");
  const outline = page.locator(".article-outline");
  await outline.locator("summary").click();
  const link = outline.locator("a").last();
  const href = await link.getAttribute("href");
  await link.click();
  await expect(page).toHaveURL(new RegExp(href! + "$"));
  await expect(link).toHaveAttribute("aria-current", "location");
  const heading = page.locator(href!);
  const y = (await heading.boundingBox())!.y;
  expect(y).toBeGreaterThanOrEqual(90);
  const bounds = await outline.boundingBox();
  expect(bounds!.y).toBeGreaterThan(0);
  expect(bounds!.y).toBeLessThan(160);
});

test("full original image links and article anchors work without JavaScript", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    baseURL,
  });
  try {
    const page = await context.newPage();
    await page.goto("/tour/");
    const link = page
      .locator(
        '.tour-panel[data-tour-panel="sessions"] a[data-media-viewer]:visible',
      )
      .first();
    const response = await context.request.get(
      (await link.getAttribute("href"))!,
    );
    expect(response.ok()).toBe(true);
    expect((await response.body()).readUInt32BE(16)).toBe(2240);
    await page.goto("/blog/how-lore-remembers-and-forgets/");
    await page.locator(".article-outline summary").click();
    const anchor = page.locator(".article-outline a").last();
    const href = await anchor.getAttribute("href");
    await anchor.click();
    await expect(page).toHaveURL(new RegExp(href! + "$"));
  } finally {
    await context.close();
  }
});

test("zoomed screenshots pan with keys and restore focus to the visible theme variant", async ({
  page,
}) => {
  await page.goto("/tour/");
  const link = page
    .locator(
      '.tour-panel[data-tour-panel="sessions"] a[data-media-viewer]:visible',
    )
    .first();
  await link.click();
  const dialog = page.getByRole("dialog", { name: "App screenshot" });
  await expect(dialog.locator(".media-canvas > img")).toHaveJSProperty(
    "complete",
    true,
  );
  await dialog
    .getByRole("button", { name: "Zoom in", exact: true })
    .click({ clickCount: 8 });
  const canvas = dialog.locator(".media-canvas");
  await canvas.focus();
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => canvas.evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(0);
  await page.evaluate(
    () =>
      (document.documentElement.dataset.theme =
        document.documentElement.dataset.theme === "dark" ? "light" : "dark"),
  );
  await dialog
    .getByRole("button", { name: "Close image", exact: true })
    .click();
  await expect(
    page
      .locator(
        '.tour-panel[data-tour-panel="sessions"] a[data-media-viewer]:visible',
      )
      .first(),
  ).toBeFocused();
});

test("the media enhancement never loads Mermaid on an unrelated screenshot page", async ({
  page,
}) => {
  const scripts: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "script") scripts.push(request.url());
  });
  await page.goto("/tour/");
  await page
    .locator(
      '.tour-panel[data-tour-panel="sessions"] a[data-media-viewer]:visible',
    )
    .first()
    .click();
  await expect(
    page.getByRole("dialog", { name: "App screenshot" }),
  ).toBeVisible();
  expect(
    scripts.some((url) => /mermaid|flowDiagram|sequenceDiagram/.test(url)),
  ).toBe(false);
});

test("closing during a diagram theme render restores exactly one latest diagram", async ({
  page,
}) => {
  await page.goto("/docs/architecture/");
  const source = page.locator(".mermaid").first();
  const expand = source.getByRole("button", {
    name: "Expand diagram",
    exact: true,
  });
  await expand.click();
  const theme = await page.evaluate(() => {
    const next =
      document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    document.querySelector<HTMLDialogElement>("dialog.media-dialog")!.close();
    return next;
  });
  await expect(source).toHaveAttribute("data-rendered-theme", theme);
  await expect(source.locator(":scope > svg")).toHaveCount(1);
  await expect(expand).toBeFocused();
  await expand.click();
  await expect(
    page
      .getByRole("dialog", { name: "Expanded diagram" })
      .locator(".media-canvas > svg"),
  ).toHaveCount(1);
});
