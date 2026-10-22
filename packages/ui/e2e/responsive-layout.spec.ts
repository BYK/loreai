import { expect, test } from "@playwright/test";

for (const width of [1440, 390, 320]) {
  test(`workspace pages contain their layout at ${width}px`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium");
    await page.setViewportSize({ width, height: 900 });
    const projects = (await (
      await page.request.get("/api/v1/projects")
    ).json()) as { id: string; name: string }[];
    const project = projects.find((item) => item.name === "lore")!;
    const base = `/ui/projects/${project.id}`;
    const routes = [
      "/ui",
      "/ui/knowledge",
      "/ui/search",
      "/ui/search?q=SQLite",
      "/ui/entities",
      "/ui/contradictions",
      "/ui/promotions",
      "/ui/team",
      "/ui/conflicts",
      "/ui/costs",
      "/ui/warming",
      "/ui/model-usage",
      base,
      `${base}/knowledge`,
      `${base}/search`,
      `${base}/sessions`,
      `${base}/imports`,
      `${base}/duplicates`,
      `${base}/sessions/e2e-reader`,
    ];
    for (const route of routes) {
      await page.goto(route);
      const main = page.locator('main[data-pane="detail"]');
      await expect(main).toBeVisible();
      await expect(page.locator("main")).toHaveCount(1);
      await page
        .getByText(/^Loading /)
        .first()
        .waitFor({ state: "hidden" });
      const size = await main.evaluate((el) => ({
        client: el.clientWidth,
        scroll: el.scrollWidth,
      }));
      if (size.scroll > size.client + 1) {
        console.log(
          "Layout overflow",
          route,
          await main.evaluate((el) => {
            const edge = el.getBoundingClientRect().right;
            return [...el.querySelectorAll("*")]
              .filter((node) => node.getBoundingClientRect().right > edge + 1)
              .slice(0, 15)
              .map((node) => ({
                tag: node.tagName,
                id: node.getAttribute("data-testid"),
                class: node.className,
                right: Math.round(node.getBoundingClientRect().right),
                width: Math.round(node.getBoundingClientRect().width),
              }));
          }),
        );
        await page.screenshot({
          path: testInfo.outputPath(
            `overflow-${route.split("/").pop()}-${width}.png`,
          ),
          fullPage: true,
        });
      }
      expect
        .soft(
          size.scroll,
          `${route}: content must scroll inside its own table or code block`,
        )
        .toBeLessThanOrEqual(size.client + 1);
      if (route === base || route === `${base}/search`) {
        const input = page.getByRole("textbox", {
          name: route === base ? "Search project memory" : "Search query",
          exact: true,
        });
        expect
          .soft(
            (await input.boundingBox())!.width,
            `${route}: readable search field`,
          )
          .toBeGreaterThanOrEqual(160);
      }
      if (route === base) {
        const heading = (await page
          .getByRole("heading", { level: 1 })
          .boundingBox())!;
        const health = (await page.getByTestId("health").boundingBox())!;
        expect
          .soft(
            Math.abs(heading.x - health.x),
            "overview heading aligns with sections",
          )
          .toBeLessThanOrEqual(1);
      }
      if ([base, `${base}/imports`].includes(route))
        await page.screenshot({
          path: testInfo.outputPath(
            `${route.endsWith("imports") ? "imports" : "overview"}-${width}.png`,
          ),
          fullPage: true,
        });
    }
  });
  test(`project dialog has breathing room at ${width}px`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium");
    await page.setViewportSize({ width, height: 740 });
    const projects = (await (
      await page.request.get("/api/v1/projects")
    ).json()) as { id: string; name: string }[];
    await page.goto(
      `/ui/projects/${projects.find((item) => item.name === "lore")!.id}`,
    );
    await page.getByRole("button", { name: "Rename…", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "Rename project",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    const box = (await dialog.boundingBox())!;
    expect
      .soft(box.x, "dialog is inset from the viewport")
      .toBeGreaterThanOrEqual(12);
    expect.soft(box.x + box.width).toBeLessThanOrEqual(width - 12);
    const field = (await dialog
      .getByRole("textbox", { name: "Project name", exact: true })
      .boundingBox())!;
    expect
      .soft(field.x + field.width, "dialog field stays inside its panel")
      .toBeLessThanOrEqual(box.x + box.width - 16);
    const dialogSize = await dialog.evaluate((el) => ({
      client: el.clientWidth,
      scroll: el.scrollWidth,
    }));
    expect
      .soft(dialogSize.scroll, "dialog contents must not clip horizontally")
      .toBeLessThanOrEqual(dialogSize.client + 1);
    const cancel = (await dialog
      .getByRole("button", { name: "Cancel", exact: true })
      .boundingBox())!;
    const save = (await dialog
      .getByRole("button", { name: "Save", exact: true })
      .boundingBox())!;
    const gap =
      width < 640
        ? cancel.y - (save.y + save.height)
        : save.x - (cancel.x + cancel.width);
    expect
      .soft(gap, "dialog actions have a visible gap")
      .toBeGreaterThanOrEqual(8);
    await page.screenshot({
      path: testInfo.outputPath(`rename-dialog-${width}.png`),
      fullPage: true,
    });
    await page.keyboard.press("Escape");
  });
}
