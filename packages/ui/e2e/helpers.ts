import { expect, type Page } from "@playwright/test";

type ThemeChoice = "system" | "light" | "dark";

export async function setTheme(page: Page, choice: ThemeChoice) {
  const toggle = page.getByTestId("theme-toggle");
  const cycle = page.getByTestId("theme-cycle");
  if (await cycle.isVisible()) {
    const choices: readonly ThemeChoice[] = ["system", "light", "dark"];
    const current = await toggle.getAttribute("data-theme-choice");
    const currentIndex = choices.findIndex(
      (candidate) => candidate === current,
    );
    if (currentIndex < 0) {
      throw new Error(`Unknown current theme choice: ${current}`);
    }
    const clicks =
      (choices.indexOf(choice) - currentIndex + choices.length) %
      choices.length;
    for (let index = 0; index < clicks; index++) {
      await cycle.click();
    }
  } else {
    await page.getByTestId(`theme-${choice}`).click();
  }
  await expect(toggle).toHaveAttribute("data-theme-choice", choice);
}

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
