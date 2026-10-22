import { expect, type Page } from "@playwright/test";

export async function openProjectPicker(page: Page) {
  const picker = page.getByRole("dialog", {
    name: "Switch project",
    exact: true,
  });
  if (await picker.isVisible()) return picker;
  const trigger = page.locator(
    '[data-testid="project-picker-trigger"]:visible',
  );
  if (!(await trigger.count())) await page.getByTestId("open-nav").click();
  await page.locator('[data-testid="project-picker-trigger"]:visible').click();
  await expect(picker).toBeVisible();
  return picker;
}

export async function openAccountMenu(page: Page) {
  const menu = page.getByTestId("folk-status-panel");
  if (!(await menu.isVisible())) {
    await openNavigation(page);
    await page.getByTestId("folk-status").click();
  }
  await expect(menu).toBeVisible();
  return menu;
}

export async function setWorkspaceTheme(
  page: Page,
  theme: "light" | "dark" | "system",
) {
  const menu = await openAccountMenu(page);
  await menu.getByTestId(`theme-${theme}`).click();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId("folk-status")).toBeFocused();
  await closeNavigation(page);
}

/** Open labeled mobile navigation, or return the persistent desktop rail. */
export async function openNavigation(page: Page) {
  const trigger = page.getByTestId("mobile-menu-trigger");
  await expect(trigger.or(page.getByTestId("icon-rail"))).toBeVisible();
  if (await trigger.isVisible()) {
    if (!(await page.getByTestId("nav-drawer").isVisible()))
      await trigger.click();
    await expect(page.getByTestId("nav-drawer")).toBeVisible();
    await expect
      .poll(async () => (await page.getByTestId("nav-drawer").boundingBox())?.x)
      .toBe(0);
    return page.getByTestId("mobile-navigation");
  }
  await expect(page.getByTestId("icon-rail")).toBeVisible();
  return page.getByTestId("icon-rail");
}

export async function closeNavigation(page: Page) {
  const drawer = page.getByTestId("nav-drawer");
  if (await drawer.isVisible()) {
    await drawer.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(drawer).toHaveCount(0);
  }
}

export async function clickNavigation(page: Page, id: string) {
  const nav = await openNavigation(page);
  await nav.getByTestId(id).click();
  await expect(page.getByTestId("nav-drawer")).toHaveCount(0);
}

export async function expectCurrentNavigation(page: Page, id: string) {
  const nav = await openNavigation(page);
  await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
  await expect(nav.getByTestId(id)).toHaveAttribute("aria-current", "page");
  await closeNavigation(page);
}

export async function expectNavigationAvailable(page: Page) {
  const trigger = page.getByTestId("mobile-menu-trigger");
  await expect(trigger.or(page.getByTestId("icon-rail"))).toBeVisible();
  if (await trigger.isVisible()) {
    await expect(page.getByTestId("icon-rail")).toHaveCount(0);
  } else await expect(page.getByTestId("icon-rail")).toBeVisible();
}

export async function expectGatewayReachable(page: Page) {
  await openNavigation(page);
  await expect(page.getByTestId("connection-status")).toHaveAttribute(
    "data-connection",
    "reachable",
  );
  await closeNavigation(page);
}
