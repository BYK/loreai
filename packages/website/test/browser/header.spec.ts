import { expect, test } from "@playwright/test";

test("field guide menus show real destinations and dismiss predictably", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const path of ["/", "/docs/install/", "/blog/"]) {
    await page.goto(path);
    const header = page.locator("header").first();
    const product = header
      .locator(".guide-menu")
      .filter({ has: page.locator("summary", { hasText: "Product" }) });
    const resources = header
      .locator(".guide-menu")
      .filter({ has: page.locator("summary", { hasText: "Resources" }) });
    const trigger = product.locator("summary");
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(product).toHaveAttribute("open", "");
    await expect(
      product.getByRole("link", { name: "Explore the app", exact: false }),
    ).toHaveAttribute("href", "/tour/?view=knowledge#product");
    await expect(
      product.getByRole("link", { name: /Open the quest journal/ }),
    ).toHaveAttribute("href", "/#journal");
    await page.keyboard.press("Tab");
    await expect(product.locator(".guide-destination").first()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(product).not.toHaveAttribute("open", "");
    await expect(trigger).toBeFocused();
    // Open the second disclosure before pending toggle events can settle.
    await page.evaluate(() => {
      const triggers = document.querySelectorAll<HTMLElement>(
        ".guide-menu > summary",
      );
      triggers[0].click();
      triggers[1].click();
    });
    await expect(resources).toHaveAttribute("open", "");
    await expect(product).not.toHaveAttribute("open", "");
    await expect(
      resources.getByRole("link", { name: /Follow the setup guide/ }),
    ).toHaveAttribute("href", "/docs/first-session/");
    await header
      .locator(".header-utilities")
      .getByLabel("System theme", { exact: true })
      .click();
    await expect(resources).not.toHaveAttribute("open", "");
    const start = header.getByRole("link", {
      name: "Get started",
      exact: true,
    });
    await expect(start).toBeVisible();
    const colors = await start.evaluate((el) => ({
      bg: getComputedStyle(el).backgroundColor,
      fg: getComputedStyle(el).color,
    }));
    expect(colors.bg).not.toBe(colors.fg);
    expect(colors.bg).not.toBe("rgba(0, 0, 0, 0)");
    await expect(
      header.getByRole("link", { name: "GitHub", exact: true }).locator("svg"),
    ).toHaveCount(1);
  }
});

test("native field guide navigation works without JavaScript on desktop and phone", async ({
  browser,
  baseURL,
}) => {
  for (const width of [1280, 320]) {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width, height: 480 },
    });
    try {
      const page = await context.newPage();
      await page.goto(`${baseURL}/`);
      if (width === 1280) {
        await page
          .locator(".guide-menu summary")
          .filter({ hasText: "Product" })
          .click();
        await expect(
          page.getByRole("link", { name: /Open the quest journal/ }),
        ).toBeVisible();
        await page
          .locator(".guide-menu summary")
          .filter({ hasText: "Resources" })
          .click();
        await expect(page.locator(".guide-menu[open]")).toHaveCount(1);
        await page.getByRole("link", { name: /Documentation Setup/ }).click();
        await expect(page).toHaveURL(/\/docs\/$/);
      } else {
        await page
          .getByLabel("Toggle navigation menu", { exact: true })
          .click();
        const nav = page.locator(".nav-mobile-panel").getByRole("navigation");
        for (const label of [
          "Explore the app",
          "How memory works",
          "The quest journal",
          "Why Lore",
          "Documentation",
          "Blog",
          "GitHub",
          "Day-to-day workflow",
          "Get help",
        ])
          await expect(
            nav.getByRole("link", { name: label, exact: true }),
          ).toHaveCount(1);
        const start = nav.getByRole("link", {
          name: "Get started",
          exact: true,
        });
        await start.click();
        await expect(page).toHaveURL(/\/docs\/install\/$/);
      }
    } finally {
      await context.close();
    }
  }
});

test("phone header controls fit on both sides of the wordmark breakpoint", async ({
  page,
}) => {
  for (const width of [320, 380, 381, 390, 414, 600, 799, 800]) {
    await page.setViewportSize({ width, height: 640 });
    for (const path of ["/", "/docs/install/"]) {
      await page.goto(path);
      const controls = page
        .locator("header")
        .first()
        .locator(".logo, .theme-toggle, [data-open-modal], .nav-burger");
      const boxes = [];
      for (const control of await controls.all()) {
        if (!(await control.isVisible())) continue;
        const box = await control.boundingBox();
        if (box) {
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width);
          boxes.push(box);
        }
      }
      boxes.sort((a, b) => a.x - b.x);
      for (let i = 1; i < boxes.length; i++)
        expect(boxes[i].x).toBeGreaterThanOrEqual(
          boxes[i - 1].x + boxes[i - 1].width,
        );
    }
  }
});

test("a field-guide journal link closes the menu and reaches the native fragment", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  const product = page
    .locator(".guide-menu")
    .filter({ hasText: "Meet your project memory" });
  await product.locator("summary").click();
  await product.getByRole("link", { name: /Open the quest journal/ }).click();
  await expect(page).toHaveURL(/\/#journal$/);
  await expect(product).not.toHaveAttribute("open", "");
  await expect(page.locator("#journal")).toBeInViewport();
});

test("tabbing beyond an open dropdown dismisses it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  const product = page
    .locator(".guide-menu")
    .filter({ hasText: "Meet your project memory" });
  await product.locator("summary").focus();
  await page.keyboard.press("Space");
  await expect(product).toHaveAttribute("open", "");
  await product.getByRole("link", { name: /Data & costs/ }).focus();
  await page.keyboard.press("Tab");
  await expect(
    page.locator(".guide-menu summary").filter({ hasText: "Resources" }),
  ).toBeFocused();
  await expect(product).not.toHaveAttribute("open", "");
});
