import { expect, test } from "@playwright/test";
import { setWorkspaceTheme } from "./workspace-helpers";

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
    const expected = await page
      .getByTestId("icon-rail")
      .evaluate((rail) => getComputedStyle(rail).backgroundColor);
    const pane = page.getByTestId("context-pane");
    await expect(pane).toBeVisible();
    expect(
      await pane.evaluate((el) => getComputedStyle(el).backgroundColor),
    ).toBe(expected);
    expect(
      await page
        .getByTestId("icon-rail")
        .evaluate((el) => el.getBoundingClientRect().left),
    ).toBe(0);
    await toggle.click();
    await expect(page.getByTestId("icon-rail")).toBeVisible();
  }
});
