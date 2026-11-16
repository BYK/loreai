import { expect, test } from "@playwright/test";
import { themeButton } from "../helpers/theme";

for (const path of ["/", "/docs/install/", "/blog/"]) {
  test(`phone menu owns theme preferences: ${path}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(path);
    await expect(page.locator(".theme-toggle:visible")).toHaveCount(0);
    const dark = await themeButton(page, "Dark");
    await expect(dark).toBeVisible();
    await dark.focus();
    await page.keyboard.press("Space");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(dark).toBeFocused();
    const group = page.getByRole("group", {
      name: "Colour theme",
      exact: true,
    });
    await expect(group).toBeVisible();
    await expect(group.locator('[aria-pressed="true"]')).toHaveCount(1);
    await expect(group).toBeInViewport();
    await page.keyboard.press("Escape");
    await expect(page.locator(".theme-toggle:visible")).toHaveCount(0);
    await expect(
      page
        .locator(".nav-burger:visible, starlight-menu-button button:visible")
        .first(),
    ).toBeFocused();
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.locator(".theme-toggle:visible")).toHaveCount(1);
    await expect(await themeButton(page, "Dark")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(await themeButton(page, "Dark")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
}

test("theme ownership follows the public and docs menu breakpoints", async ({
  page,
}) => {
  for (const path of ["/", "/docs/install/"])
    for (const width of [799, 800, 900, 901]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(path);
      const menuMode = path === "/" ? width <= 900 : width < 800;
      await expect(page.locator(".theme-toggle:visible")).toHaveCount(
        menuMode ? 0 : 1,
      );
      await expect(await themeButton(page, "System")).toBeVisible();
      await expect(page.locator(".theme-toggle:visible")).toHaveCount(1);
    }
});

test("recovery keeps appearance accessible without a sidebar menu", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/missing-field-guide-page/");
  await expect(page.locator(".mobile-theme-preferences")).toHaveCount(0);
  await expect(page.locator("header .theme-toggle")).toBeVisible();
  await (await themeButton(page, "Dark")).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("docs keyboard navigation keeps links clear of the sticky appearance row", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 320 });
  await page.goto("/docs/install/");
  await (await themeButton(page, "System")).focus();
  const target = page
    .locator("#starlight__sidebar .top-level")
    .getByRole("link", { name: "Team memory", exact: true });
  for (let i = 0; i < 28; i++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((el) => el === document.activeElement)) break;
  }
  await expect(target).toBeFocused();
  for (let i = 0; i < 9; i++) {
    await page.keyboard.press("Shift+Tab");
    const active = page.locator("#starlight__sidebar a:focus");
    if ((await active.count()) === 0) continue;
    const link = await active.boundingBox();
    const row = await page
      .locator(".docs-group-icons > .mobile-theme-preferences")
      .boundingBox();
    expect(link!.y, await active.innerText()).toBeGreaterThanOrEqual(
      row!.y + row!.height - 1,
    );
  }
});
