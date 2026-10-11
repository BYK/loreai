import { expect, type Page } from "@playwright/test";

import type { ActivityPage } from "../src/contracts/activity";

type ThemeChoice = "system" | "light" | "dark";

export async function padActivitySecondPage(page: Page) {
  let firstPageItems: ActivityPage["items"] = [];
  await page.route("**/api/v1/activity**", async (route) => {
    const response = await route.fetch();
    const activityPage = (await response.json()) as ActivityPage;
    if (activityPage.items.length >= 50) {
      firstPageItems = activityPage.items;
      await route.fulfill({ response });
      return;
    }
    if (activityPage.items.length === 0 || firstPageItems.length === 0) {
      await route.fulfill({ response });
      return;
    }

    const items = [...activityPage.items];
    let cloneIndex = 0;
    while (items.length < 50) {
      const source = firstPageItems[cloneIndex % firstPageItems.length];
      if (!source) break;
      items.push({
        ...source,
        id: `${source.id}-scroll-${cloneIndex}`,
      });
      cloneIndex += 1;
    }
    await route.fulfill({
      response,
      body: JSON.stringify({ ...activityPage, items }),
    });
  });
}

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
