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
  if (!(await menu.isVisible())) await page.getByTestId("folk-status").click();
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
}
