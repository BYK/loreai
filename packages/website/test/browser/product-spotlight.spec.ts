import { expect, test } from "@playwright/test";

test("product detail choices keep independent history and open the matching tour", async ({
  page,
}) => {
  await page.goto("/?format=markdown&chapter=knowledge&from=spotlight#product");
  const spotlight = page.locator(".product-spotlight");
  await expect(
    spotlight.getByRole("radio", { name: "Rule", exact: true }),
  ).toBeChecked();
  await spotlight.getByRole("radio", { name: "Source", exact: true }).check();
  await expect(
    spotlight.locator('[data-preview-panel="source"]'),
  ).toContainText("exact-message");
  await expect(page).toHaveURL(
    /format=markdown&chapter=knowledge&from=spotlight&preview=source#product$/,
  );
  await page.reload();
  await expect(
    spotlight.locator('[data-preview-panel="source"]'),
  ).toBeVisible();
  await spotlight.getByRole("radio", { name: "History", exact: true }).check();
  await expect(
    spotlight.locator('[data-preview-panel="history"]'),
  ).toContainText("v2");
  await page.goBack();
  await expect(
    spotlight.getByRole("radio", { name: "Source", exact: true }),
  ).toBeChecked();
  await expect(
    page.locator('.knowledge-file input[value="markdown"]'),
  ).toBeChecked();
  await expect(
    page.locator('[data-journal-choice="chapter"][value="knowledge"]'),
  ).toBeChecked();
  await expect(
    spotlight.locator(".spotlight-image .tour-image-link:visible"),
  ).toHaveAttribute("href", "/tour/?view=knowledge&inspect=source#product");
  await spotlight.locator('[data-preview-panel="source"] a').click();
  await expect(page.locator('[data-inspect-panel="source"]')).toBeVisible();
});

test("the product workbench has a compact balanced layout and real capture links", async ({
  page,
}) => {
  for (const width of [320, 390, 768, 1024, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/?preview=history#product");
    const spotlight = page.locator(".product-spotlight");
    const stage = await spotlight.locator(".spotlight-image").boundingBox();
    expect(stage!.height).toBeLessThanOrEqual(width <= 640 ? 260 : 360);
    if (width >= 1024)
      expect((await spotlight.boundingBox())!.height).toBeLessThanOrEqual(600);
    for (const label of await spotlight
      .locator(".spotlight-choices label")
      .all())
      expect((await label.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    const capture = spotlight.getByRole("link", {
      name: "Open original app capture",
      exact: true,
    });
    await expect(capture).toHaveAttribute(
      "href",
      /product-tour\/knowledge-detail-(light|dark)\.png$/,
    );
    expect(
      (await page.request.get((await capture.getAttribute("href"))!)).status(),
    ).toBe(200);
  }
});

test("product choices remain usable without JavaScript", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    colorScheme: "dark",
    viewport: { width: 320, height: 844 },
  });
  try {
    const page = await context.newPage();
    await page.goto(baseURL + "/");
    const spotlight = page.locator(".product-spotlight");
    await spotlight
      .getByRole("radio", { name: "History", exact: true })
      .check();
    await expect(
      spotlight.locator('[data-preview-panel="history"]'),
    ).toBeVisible();
    await spotlight.getByRole("radio", { name: "Source", exact: true }).check();
    await expect(
      spotlight.locator('[data-preview-panel="source"]'),
    ).toBeVisible();
    for (const name of ["Rule", "Source", "History"]) {
      await spotlight.getByRole("radio", { name, exact: true }).check();
      await expect(
        spotlight.locator(".spotlight-image a:visible picture:visible img"),
      ).toHaveAttribute("src", /knowledge-detail-dark\.png$/);
      await expect(
        spotlight.getByRole("link", {
          name: "Open original app capture",
          exact: true,
        }),
      ).toHaveAttribute("href", /knowledge-detail-dark\.png$/);
    }
  } finally {
    await context.close();
  }
});

test("preview choices preserve early native input and reject unrecognized URL values", async ({
  page,
}) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/_astro/*.js", async (route) => {
    await gate;
    await route.continue();
  });
  try {
    await page.goto("/?format=markdown&from=preview#product", {
      waitUntil: "commit",
    });
    await page
      .locator(".spotlight-choices")
      .getByRole("radio", { name: "History", exact: true })
      .check();
  } finally {
    release();
  }
  await page.waitForLoadState("load");
  const history = page
    .locator(".spotlight-choices")
    .getByRole("radio", { name: "History", exact: true });
  await expect(history).toBeChecked();
  expect(new URL(page.url()).searchParams.get("preview")).toBe("history");
  expect(new URL(page.url()).searchParams.get("format")).toBe("markdown");
  await history.press("ArrowLeft");
  await expect(
    page
      .locator(".spotlight-choices")
      .getByRole("radio", { name: "Source", exact: true }),
  ).toBeFocused();
  await expect(page.locator('[data-preview-panel="source"]')).toBeVisible();
  await page.unroute("**/_astro/*.js");
  await page.goto("/?preview=%22%5D%3Cscript%3E#product");
  await expect(
    page
      .locator(".spotlight-choices")
      .getByRole("radio", { name: "Rule", exact: true }),
  ).toBeChecked();
});

test("the clipped app preview has an inward visible keyboard focus ring", async ({
  page,
}) => {
  await page.goto("/#product");
  const image = page.locator(".spotlight-image .tour-image-link:visible");
  await image.focus();
  const ring = await image.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      width: parseFloat(s.outlineWidth),
      offset: parseFloat(s.outlineOffset),
      style: s.outlineStyle,
    };
  });
  expect(ring.style).toBe("solid");
  expect(ring.width).toBeGreaterThanOrEqual(2);
  expect(ring.offset).toBeLessThanOrEqual(-2);
});
