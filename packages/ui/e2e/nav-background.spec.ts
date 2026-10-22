import { expect, test } from "@playwright/test";
import {
  setWorkspaceTheme,
  openNavigation,
  closeNavigation,
  expectNavigationAvailable,
} from "./workspace-helpers";

test("permanent rail and contextual navigation retain their theme backgrounds", async ({
  page,
}) => {
  const projects = await (await page.request.get("/api/v1/projects")).json();
  const project = projects.find((p: { name: string }) => p.name === "lore");
  const entries = await (
    await page.request.get(`/api/v1/projects/${project.id}/knowledge`)
  ).json();
  await page.goto(`/ui/projects/${project.id}/knowledge/${entries[0].id}`);
  for (const theme of ["light", "dark"] as const) {
    await setWorkspaceTheme(page, theme);
    const toggle = page.getByTestId("context-toggle");
    if ((await toggle.getAttribute("aria-expanded")) === "false")
      await toggle.click();
    const nav = await openNavigation(page);
    const expected = await nav.evaluate(
      (rail) => getComputedStyle(rail).backgroundColor,
    );
    expect(
      await nav.evaluate((el) => el.getBoundingClientRect().left),
    ).toBeGreaterThanOrEqual(0);
    await closeNavigation(page);
    const pane = page.getByTestId("context-pane");
    await expect(pane).toBeVisible();
    expect(
      await pane.evaluate((el) => getComputedStyle(el).backgroundColor),
    ).toBe(expected);
    await toggle.click();
    await expectNavigationAvailable(page);
  }
});
