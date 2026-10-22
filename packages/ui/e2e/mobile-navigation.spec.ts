import { expect, test } from "@playwright/test";
import { openNavigation, openAccountMenu } from "./workspace-helpers";

for (const width of [320, 390, 767]) {
  test(`mobile navigation gives the document full width at ${width}px`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium");
    await page.setViewportSize({ width, height: 740 });
    await page.goto("/ui/knowledge");
    const trigger = page.getByTestId("mobile-menu-trigger");
    await expect(trigger).toBeVisible();
    await expect(page.getByTestId("icon-rail")).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Lore.AI — home" }),
    ).toHaveCount(0);
    const main = (await page
      .locator('main[data-pane="detail"]')
      .boundingBox())!;
    expect(main.x).toBe(0);
    expect(main.width).toBe(width);
    await trigger.focus();
    await trigger.press("Enter");
    const drawer = page.getByRole("dialog", {
      name: "Navigation",
      exact: true,
    });
    await expect(drawer).toBeVisible();
    await expect(
      drawer.getByRole("link", { name: "Knowledge", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(drawer.getByTestId("folk-status")).toBeVisible();
    await expect.poll(async () => (await drawer.boundingBox())?.x).toBe(0);
    const box = (await drawer.boundingBox())!;
    expect(box.x).toBe(0);
    expect(box.width).toBeLessThanOrEqual(width - 32);
    await page.screenshot({
      path: testInfo.outputPath(`mobile-menu-${width}.png`),
    });
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(trigger).toBeFocused();
    const nav = await openNavigation(page);
    await nav.getByTestId("rail-model-usage").click();
    await expect(page).toHaveURL("/ui/model-usage");
    await expect(drawer).toHaveCount(0);
    await expect(page.getByTestId("model-filter")).toBeVisible();
    await openNavigation(page);
    await page.getByTestId("rail-model-usage").focus();
    await page.setViewportSize({ width: 1024, height: 740 });
    await expect(page.getByTestId("icon-rail")).toBeVisible();
    await expect(drawer).toHaveCount(0);
    await expect(trigger).toHaveCount(0);
    await expect(page.getByTestId("rail-model-usage")).toBeFocused();
    await expect(page.getByTestId("rail-model-usage")).toHaveAttribute(
      "aria-current",
      "page",
    );
    await page.setViewportSize({ width, height: 740 });
    await expect(drawer).toHaveCount(0);
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(trigger).toBeFocused();
    // Dismiss on backdrop, then activate the current destination without changing path.
    await openNavigation(page);
    await page.mouse.click(width - 8, 90);
    await expect(drawer).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await openNavigation(page);
    await page.getByTestId("rail-model-usage").click();
    await expect(drawer).toHaveCount(0);
  });
}

test("resizing mobile account layers returns focus to desktop navigation", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  for (const layer of ["theme", "sign-in"]) {
    await page.setViewportSize({ width: 390, height: 740 });
    await page.goto("/ui/knowledge");
    const account = await openAccountMenu(page);
    if (layer === "theme") await account.getByTestId("theme-dark").focus();
    else {
      await account
        .getByRole("button", { name: "Sign in to Lore", exact: true })
        .click();
      await expect(
        page.getByRole("dialog", { name: "Sign in to Lore", exact: true }),
      ).toBeVisible();
    }
    await page.setViewportSize({ width: 1024, height: 740 });
    await expect(page.getByTestId("icon-rail")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByTestId("folk-status-panel")).toHaveCount(0);
    await expect(page.getByTestId("rail-knowledge")).toBeFocused();
    const desktopAccount = await openAccountMenu(page);
    if (layer === "theme")
      await desktopAccount.getByTestId("theme-dark").focus();
    else {
      await desktopAccount
        .getByRole("button", { name: "Sign in to Lore", exact: true })
        .click();
      await expect(
        page.getByRole("dialog", { name: "Sign in to Lore", exact: true }),
      ).toBeVisible();
    }
    await page.setViewportSize({ width: 390, height: 740 });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByTestId("folk-status-panel")).toHaveCount(0);
    await expect(page.getByTestId("mobile-menu-trigger")).toBeFocused();
  }
});
