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

export async function openWorkspaceSettings(page: Page) {
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  if (!(await settings.isVisible())) {
    const option = page.getByRole("button", { name: "Settings", exact: true });
    if (!(await option.isVisible()))
      await page.getByTestId("folk-status").click();
    await option.click();
  }
  await expect(settings).toBeVisible();
  return settings;
}

export async function setWorkspaceTheme(
  page: Page,
  theme: "light" | "dark" | "system",
) {
  const settings = await openWorkspaceSettings(page);
  await settings.getByTestId(`theme-${theme}`).click();
  await settings.getByRole("button", { name: /^(Close|Dismiss)$/ }).click();
  await expect(settings).toHaveCount(0);
  await expect(page.getByTestId("folk-status")).toBeFocused();
}
