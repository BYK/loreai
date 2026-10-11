import { expect, type Page } from "@playwright/test";

export async function expectConnectionStatus(page: Page) {
  const status = page.getByTestId("connection-status");
  if (!(await status.count())) {
    await page.getByTestId("open-nav").click();
  }
  await expect(status).toBeVisible();
  await expect(status).toHaveAttribute("data-connection", "reachable");
  if (await page.getByTestId("nav-drawer").count()) {
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("nav-drawer")).toHaveCount(0);
  }
}
