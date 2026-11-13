import type { Page } from "@playwright/test";

export async function themeButton(page: Page, choice: string) {
  const value = choice === "System" ? "auto" : choice.toLowerCase();
  const visible = page.locator(`button[data-theme-choice="${value}"]:visible`);
  if ((await visible.count()) === 0) {
    await page
      .locator(".nav-burger:visible, starlight-menu-button button:visible")
      .first()
      .click();
  }
  return visible.first();
}
