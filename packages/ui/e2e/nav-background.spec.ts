import { expect, test } from "@playwright/test";

test.describe("activity list surface", () => {
  test("list rows scroll inside the workspace surface in light and dark themes", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name.includes("mobile"), "desktop workspace");
    await page.goto("/ui");
    const scroller = page.getByTestId("activity-list-body");
    await expect(scroller).toBeVisible();
    await expect(scroller.getByTestId("activity-item").first()).toBeVisible();
    await expect(scroller).toHaveCSS("overflow-anchor", "none");

    const measure = () =>
      scroller.evaluate((el) => ({
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
        paneHeight: el.closest('[data-pane="list"]')?.clientHeight ?? 0,
      }));
    const light = await measure();
    expect(light.scrollHeight).toBeGreaterThanOrEqual(light.clientHeight);
    expect(light.paneHeight).toBeGreaterThanOrEqual(light.clientHeight);

    await page.getByTestId("theme-dark").click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    const dark = await measure();
    expect(dark.paneHeight).toBeGreaterThanOrEqual(dark.clientHeight);
  });

  test("mobile navigation drawer remains available separately from the activity list", async ({
    page,
  }, testInfo) => {
    test.skip(!testInfo.project.name.includes("mobile"), "mobile workspace");
    await page.goto("/ui");
    await expect(page.getByTestId("activity-list-body")).toBeVisible();
    await page.getByTestId("open-nav").click();
    const drawer = page.getByTestId("nav-drawer");
    await expect(
      drawer.getByRole("navigation", { name: "Workspace" }),
    ).toBeVisible();
    await expect(page.getByTestId("activity-list-body")).toBeVisible();
    await page.keyboard.press("Escape");
  });
});
