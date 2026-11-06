import { expect, test } from "@playwright/test";

test("desktop navigation separates sections from utilities and the install action", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const path of ["/", "/docs/install/", "/blog/"]) {
    await page.goto(path);
    const header = page.locator("header").first();
    const nav = header.getByRole("navigation", {
      name: "Primary navigation",
      exact: true,
    });
    await expect(nav.getByRole("link")).toHaveText([
      "Docs",
      "Why Lore",
      "Blog",
    ]);
    const start = header.getByRole("link", {
      name: "Get started",
      exact: true,
    });
    await expect(start).toBeVisible();
    await expect(start).toHaveAttribute("href", "/docs/install/");
    const appearance = await start.evaluate((el) => ({
      background: getComputedStyle(el).backgroundColor,
      color: getComputedStyle(el).color,
    }));
    const docsBackground = await nav
      .getByRole("link", { name: "Docs", exact: true })
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(appearance.background).not.toBe(docsBackground);
    expect(appearance.background).not.toBe("rgba(0, 0, 0, 0)");
    const github = header.getByRole("link", { name: "GitHub", exact: true });
    await expect(github.locator("svg")).toHaveCount(1);
    await expect(github).toHaveAttribute("rel", /noopener/);
    await expect(
      header.getByRole("group", { name: "Colour theme", exact: true }),
    ).toBeVisible();
  }
});

test("the native phone menu keeps every destination and a readable install action", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 320, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const page = await context.newPage();
    await page.goto(`${baseURL}/`);
    await page.getByLabel("Toggle navigation menu", { exact: true }).click();
    const nav = page.locator(".nav-mobile-panel").getByRole("navigation");
    await expect(nav.getByRole("link")).toHaveText([
      "Docs",
      "Why Lore",
      "Blog",
      "GitHub",
      "Get started",
    ]);
    const start = nav.getByRole("link", { name: "Get started", exact: true });
    await expect(start).toBeVisible();
    await start.click();
    await expect(page).toHaveURL(/\/docs\/install\/$/);
  } finally {
    await context.close();
  }
});
