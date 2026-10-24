import { expect, test } from "@playwright/test";
import { openNavigation, themeColor } from "./workspace-helpers";

for (const theme of ["light", "dark"] as const) {
  test(`not-found recovery stays useful and accessible in ${theme}`, async ({
    page,
  }, testInfo) => {
    const mobile = testInfo.project.name.includes("mobile");
    await page.addInitScript(
      (choice) => localStorage.setItem("lore.ui.theme", choice),
      theme,
    );
    await page.goto("/ui/does-not-exist?token=private-value");
    const recovery = page.getByTestId("not-found");
    await expect(
      recovery.getByRole("heading", { name: "Page not found" }),
    ).toBeVisible();
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(recovery).not.toContainText("private-value");
    await expect(page.getByTestId("context-toggle")).toHaveCount(0);
    expect(
      await page
        .getByRole("main")
        .evaluate((el) => getComputedStyle(el).backgroundColor),
    ).toBe(
      await themeColor(page, `--color-olive-${theme === "dark" ? 900 : 50}`),
    );
    const browse = recovery.getByRole("link", {
      name: "Browse projects",
      exact: true,
    });
    const search = recovery.getByRole("link", {
      name: "Search knowledge",
      exact: true,
    });
    for (const link of [browse, search]) {
      expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await link.focus();
      await expect(link).toBeFocused();
    }
    await page.screenshot({
      path: testInfo.outputPath(`not-found-${theme}.png`),
      scale: "css",
    });
    const nav = await openNavigation(page);
    await expect(
      nav.getByRole("link", { name: "Knowledge", exact: true }),
    ).toBeVisible();
    if (mobile) {
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("mobile-menu-trigger")).toBeFocused();
    }
    await browse.click();
    await expect(page).toHaveURL(/\/ui\/?$/);
    await expect(page.getByTestId("project-directory")).toBeVisible();
    await page.goBack();
    await search.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/ui\/search\?q=$/);
    await expect(
      page.getByRole("heading", { name: "Search all knowledge" }),
    ).toBeVisible();
  });

  test(`not-found recovery validates project context and fits short screens in ${theme}`, async ({
    page,
  }, testInfo) => {
    await page.addInitScript(
      (choice) => localStorage.setItem("lore.ui.theme", choice),
      theme,
    );
    const projects = await (await page.request.get("/api/v1/projects")).json();
    const project = projects.find(
      (item: { name: string }) => item.name === "lore",
    );
    const path = `/ui/projects/${project.id}`;
    await page.goto(`${path}/does-not-exist`);
    const recovery = page.getByTestId("not-found");
    const back = recovery.getByRole("link", {
      name: "Return to project: lore",
      exact: true,
    });
    await expect(back).toBeVisible();
    await expect(back).toHaveAttribute("href", path);
    await expect(page.getByTestId("project-picker-trigger")).toContainText(
      "lore",
    );
    await page.screenshot({
      path: testInfo.outputPath(`not-found-project-${theme}.png`),
      scale: "css",
    });
    if (testInfo.project.name.includes("mobile")) {
      for (const viewport of [
        { width: 320, height: 480 },
        { width: 568, height: 320 },
      ]) {
        await page.setViewportSize(viewport);
        await expect(page.getByTestId("mobile-menu-trigger")).toBeInViewport();
        await back.scrollIntoViewIfNeeded();
        await expect(back).toBeInViewport();
        expect(
          await page
            .getByRole("main")
            .evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
      }
    }
    await back.click();
    await expect(page).toHaveURL(path);
    await expect(page.getByTestId("health")).toBeVisible();
    await page.goto("/ui/projects/no-such-project/does-not-exist");
    await expect(page.getByTestId("not-found")).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Return to project/ }),
    ).toHaveCount(0);
    await expect(page.getByTestId("project-picker-trigger")).toContainText(
      "Workspace",
    );
  });
}
