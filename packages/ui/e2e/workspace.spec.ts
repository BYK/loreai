import { expect, test, type Locator, type Page } from "@playwright/test";

const LIST = '[data-pane="list"]';

async function firstVisibleRow(scroller: Locator) {
  return scroller.evaluate((el) => {
    const top = el.getBoundingClientRect().top;
    const row = [...el.querySelectorAll<HTMLElement>("[data-list-key]")].find(
      (candidate) => candidate.getBoundingClientRect().bottom > top,
    );
    if (!row) return null;
    return {
      key: row.dataset.listKey ?? "",
      offset: row.getBoundingClientRect().top - top,
    };
  });
}

async function expectActivityAnchorAfterReturn(
  page: Page,
  useBrowserBack: boolean,
) {
  await page.setViewportSize({ width: 400, height: 800 });
  await page.goto("/ui");

  const scroller = page.getByTestId("activity-list-body");
  await expect(scroller).toBeVisible();
  await expect
    .poll(() => scroller.locator("[data-list-key]").count())
    .toBeGreaterThan(0);
  await scroller.evaluate((el) => {
    el.scrollTop = 394;
  });
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(394);
  const before = await firstVisibleRow(scroller);
  if (!before) throw new Error("list has no visible row at scrollTop 394");
  const targetInfo = await scroller.evaluate((el) => {
    const bounds = el.getBoundingClientRect();
    const target = [
      ...el.querySelectorAll<HTMLElement>("[data-list-key]"),
    ].find((candidate) => {
      const rowBounds = candidate.getBoundingClientRect();
      return (
        ["knowledge", "session"].includes(
          candidate.dataset.activityKind ?? "",
        ) &&
        rowBounds.top >= bounds.top &&
        rowBounds.bottom <= bounds.bottom
      );
    });
    return target
      ? {
          key: target.dataset.listKey ?? "",
        }
      : null;
  });
  if (!targetInfo) throw new Error("list has no fully visible row");
  const row = scroller.locator(`[data-list-key="${targetInfo.key}"]`);
  await expect(row).toBeVisible();
  const targetKey = targetInfo.key;
  const targetBounds = await row.boundingBox();
  const scrollerBounds = await scroller.boundingBox();
  if (!targetBounds || !scrollerBounds) {
    throw new Error("activity row or list scroller has no bounding box");
  }
  expect(targetBounds.y).toBeGreaterThanOrEqual(scrollerBounds.y);
  expect(targetBounds.y + targetBounds.height).toBeLessThanOrEqual(
    scrollerBounds.y + scrollerBounds.height,
  );

  await page.mouse.click(
    targetBounds.x + targetBounds.width / 2,
    targetBounds.y + targetBounds.height / 2,
  );
  await expect(page).toHaveURL(/\/ui\/projects\/[^/]+\/(sessions|knowledge)\//);
  await expect(scroller).toBeHidden();
  await expect(row).toHaveAttribute("data-list-key", targetKey);
  if (useBrowserBack) await page.goBack();
  else await page.getByTestId("mobile-back").click();
  await expect(page).toHaveURL(/\/ui\/?(\?q=[^#]*)?$/);
  await expect(scroller).toBeVisible();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  const after = await firstVisibleRow(scroller);
  if (!after) throw new Error("list has no visible row after returning");
  expect(after.key).toBe(before.key);
  expect(Math.abs(after.offset - before.offset)).toBeLessThanOrEqual(1);
}

test.describe("persistent workspace panes", () => {
  test("keeps the mobile app bar within 360px and 400px viewports", async ({
    page,
  }) => {
    for (const width of [360, 400]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/ui");
      const appBar = page.getByRole("banner");
      const menu = page.getByTestId("open-nav");
      const themeCycle = page.getByTestId("theme-cycle");

      await expect(menu).toBeVisible();
      await expect(themeCycle).toBeVisible();
      await expect(themeCycle).toHaveAttribute(
        "aria-label",
        "Theme: System; next Light",
      );
      await themeCycle.click();
      await expect(themeCycle).toHaveAttribute(
        "aria-label",
        "Theme: Light; next Dark",
      );
      await themeCycle.click();
      await expect(themeCycle).toHaveAttribute(
        "aria-label",
        "Theme: Dark; next System",
      );
      await themeCycle.click();

      const appBarWidth = await appBar.evaluate((el) => ({
        clientWidth: el.clientWidth,
        scrollWidth: el.scrollWidth,
      }));
      expect(appBarWidth.scrollWidth).toBeLessThanOrEqual(
        appBarWidth.clientWidth,
      );
      const menuBounds = await menu.boundingBox();
      if (!menuBounds) throw new Error("navigation button has no bounding box");
      expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(width);
    }
  });

  test("keeps the same activity list and selection while opening a session route", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name.includes("mobile"), "desktop list scroll");
    await page.goto("/ui");
    const list = page.getByTestId("activity-list-body");
    await expect(list).toBeVisible();
    const search = page.getByRole("searchbox", { name: "Search list" });
    await search.fill("type:session");
    await search.press("Enter");
    const item = page
      .locator('[data-testid="activity-item"][data-activity-kind="session"]')
      .first();
    await expect(item).toBeVisible();
    await list.evaluate((el) => {
      el.dataset.workspaceIdentity = "persistent";
      el.scrollTop = 128;
    });
    const scrollTop = await list.evaluate((el) => el.scrollTop);
    await item.click();
    await expect(page).toHaveURL(/\/ui\/projects\/[^/]+\/sessions\/[^/]+/);
    await expect(item).toHaveAttribute("aria-current", "page");
    await expect
      .poll(() =>
        list.evaluate(
          (el, expected) =>
            el.dataset.workspaceIdentity === "persistent" &&
            el.scrollTop === expected,
          scrollTop,
        ),
      )
      .toBe(true);
  });

  test("minimizes navigation into a popover and restores it", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name.includes("mobile"),
      "desktop pane controls",
    );
    await page.goto("/ui");
    await page.getByTestId("pane-min-nav").click();
    const chip = page.getByTestId("pane-chip-nav");
    await expect(chip).toBeVisible();
    await chip.click();
    const restore = page.getByRole("button", { name: "Restore", exact: true });
    await expect(restore).toBeVisible();
    await restore.click();
    await expect(page.getByTestId("pane-min-nav")).toBeVisible();
    await expect(page.getByTestId("pane-chip-nav")).toHaveCount(0);
  });

  test("restores minimized navigation over a maximized document", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name.includes("mobile"),
      "desktop pane controls",
    );
    await page.goto("/ui");
    await page.getByTestId("pane-min-nav").click();
    await page.getByTestId("pane-max-document").click();
    await expect(page.getByTestId("pane-chip-nav")).toBeVisible();
    await page.getByTestId("pane-chip-nav").click();

    await page.getByRole("button", { name: "Restore", exact: true }).click();

    await expect(page.getByTestId("pane-min-nav")).toBeVisible();
    await expect(page.getByTestId("pane-chip-nav")).toHaveCount(0);
    await expect(page.getByTestId("document-pane")).toBeVisible();
  });

  test("maximizes and restores the document pane", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name.includes("mobile"),
      "desktop pane controls",
    );
    await page.goto("/ui");
    const list = page.locator(LIST);
    await expect(list).toBeVisible();
    const maximize = page.getByTestId("pane-max-document");
    await maximize.click();
    await expect(list).toBeHidden();
    await expect(page.getByTestId("pane-max-document")).toHaveAttribute(
      "aria-label",
      "Restore document",
    );
    await page.getByTestId("pane-max-document").click();
    await expect(list).toBeVisible();
  });

  test("maximizes the list without hiding it and restores the document", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name.includes("mobile"),
      "desktop pane controls",
    );
    await page.goto("/ui");
    const list = page.locator(LIST);
    const document = page.getByTestId("document-pane");
    await expect(list).toBeVisible();
    await expect(document).toBeVisible();

    const maximize = page.getByTestId("pane-max-list");
    await maximize.click();
    await expect(list).toBeVisible();
    await expect(document).toBeHidden();
    await expect(page.getByTestId("pane-chip-list")).toHaveCount(0);
    await expect(maximize).toHaveAttribute("aria-label", "Restore list");

    await maximize.click();
    await expect(list).toBeVisible();
    await expect(document).toBeVisible();
  });

  test("shows the selected document outside full mode and restores the list maximize", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name.includes("mobile"),
      "desktop responsive pane layout",
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/ui");

    const list = page.locator(LIST);
    const document = page.getByTestId("document-pane");
    const maximize = page.getByTestId("pane-max-list");
    await expect(list).toBeVisible();
    await expect(document).toBeVisible();
    await maximize.click();

    const project = list.getByTestId("nav-project").filter({ hasText: "lore" });
    await project.click();
    await expect(page).toHaveURL(/\/ui\/projects\/[^/]+$/);
    await expect(list).toBeVisible();
    await expect(document).toBeHidden();

    for (const width of [1000, 400]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(list).toBeHidden();
      await expect(document).toBeVisible();
      await expect(page.getByTestId("pane-max-list")).toHaveCount(0);
      await expect(page.getByTestId("pane-max-document")).toHaveCount(0);
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(list).toBeVisible();
    await expect(document).toBeHidden();
    await expect(maximize).toHaveAttribute("aria-label", "Restore list");
  });

  test("shows the list outside full mode when the document is maximized", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name.includes("mobile"),
      "desktop responsive pane layout",
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/ui");

    const list = page.locator(LIST);
    const document = page.getByTestId("document-pane");
    const maximize = page.getByTestId("pane-max-document");
    await maximize.click();
    await expect(list).toBeHidden();
    await expect(document).toBeVisible();

    await page.setViewportSize({ width: 400, height: 800 });
    await expect(list).toBeVisible();
    await expect(document).toBeHidden();
    await expect(page.getByTestId("pane-max-document")).toHaveCount(0);

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(list).toBeHidden();
    await expect(document).toBeVisible();
    await expect(maximize).toHaveAttribute("aria-label", "Restore document");
  });

  test("keeps minimized-pane chips usable in split mode", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name.includes("mobile"),
      "desktop pane controls",
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/ui");
    await page.getByTestId("pane-min-nav").click();
    await page.getByTestId("pane-min-participants").click();
    await page.setViewportSize({ width: 1000, height: 800 });

    const navChip = page.getByTestId("pane-chip-nav");
    const participantsChip = page.getByTestId("pane-chip-participants");
    await expect(navChip).toBeVisible();
    await expect(participantsChip).toBeVisible();

    await navChip.click();
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(page.locator('[data-pane="nav"]')).toBeVisible();

    await participantsChip.click();
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(participantsChip).toBeVisible();
  });

  test("restores the list from a chip while Navigation is maximized", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name.includes("mobile"),
      "desktop pane controls",
    );
    await page.goto("/ui");
    const list = page.locator(LIST);
    await expect(list).toBeVisible();

    await page.getByTestId("pane-max-nav").click();
    await expect(list).toBeHidden();
    const chip = page.getByTestId("pane-chip-list");
    await expect(chip).toBeVisible();

    await chip.click();
    await expect(list).toBeVisible();
    await expect(page.getByTestId("pane-chip-list")).toHaveCount(0);
  });

  test("persists minimized panes and keyboard divider resizing across reload", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name.includes("mobile"),
      "desktop pane controls",
    );
    await page.goto("/ui");
    await page.getByTestId("pane-min-nav").click();
    const divider = page.getByTestId("list-divider");
    await divider.focus();
    await page.keyboard.press("ArrowRight");
    await expect(divider).toHaveAttribute("aria-valuenow", "356");
    await page.reload();
    await expect(page.getByTestId("pane-chip-nav")).toBeVisible();
    await expect(page.getByTestId("list-divider")).toHaveAttribute(
      "aria-valuenow",
      "356",
    );
  });

  test("shows list and document on mobile with a back link to the list", async ({
    page,
  }, testInfo) => {
    test.skip(!testInfo.project.name.includes("mobile"), "mobile workspace");
    await page.goto("/ui");
    const list = page.locator(LIST);
    await expect(list).toBeVisible();
    await page.getByTestId("activity-list-body").evaluate((el) => {
      el.dataset.workspaceIdentity = "mobile-persistent";
    });
    const row = page.getByTestId("activity-item").first();
    await row.click();
    await expect(page.getByTestId("document-pane")).toBeVisible();
    await expect(list).toBeHidden();
    await expect(page.getByTestId("mobile-back")).toHaveAttribute(
      "href",
      "/ui",
    );
    await page.getByTestId("mobile-back").click();
    await expect(list).toBeVisible();
    await expect(page.getByTestId("activity-list-body")).toHaveAttribute(
      "data-workspace-identity",
      "mobile-persistent",
    );
  });

  test("preserves an activity anchor through the mobile Back link", async ({
    page,
  }) => {
    await expectActivityAnchorAfterReturn(page, false);
  });

  test("preserves an activity anchor through browser Back", async ({
    page,
  }) => {
    await expectActivityAnchorAfterReturn(page, true);
  });
});
