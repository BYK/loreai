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

async function expectFiller60AnchorAfterReturn(
  page: Page,
  useBrowserBack: boolean,
) {
  await page.setViewportSize({ width: 400, height: 800 });
  await page.goto("/ui");

  const scroller = page.getByTestId("project-list-body");
  await expect(scroller).toBeVisible();
  await page.locator(LIST).getByTestId("nav-all-projects").click();
  const target = page
    .locator(`${LIST} [data-testid="nav-project"]`)
    .filter({ hasText: "filler-60" });
  await expect(target).toHaveCount(1);
  await expect(target).toHaveAttribute("data-section", "all");
  const targetKey = await target.getAttribute("data-list-key");
  if (!targetKey?.startsWith("all:")) {
    throw new Error(
      `Expected filler-60 to have an All key, received ${targetKey}`,
    );
  }
  await scroller.evaluate((el) => {
    el.scrollTop = 394;
  });
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(394);

  const before = await firstVisibleRow(scroller);
  if (!before) throw new Error("list has no visible row at scrollTop 394");
  expect(before.key).toMatch(/^all:/);
  const targetBounds = await target.boundingBox();
  const scrollerBounds = await scroller.boundingBox();
  if (!targetBounds || !scrollerBounds) {
    throw new Error("filler-60 row or list scroller has no bounding box");
  }
  expect(targetBounds.y).toBeGreaterThanOrEqual(scrollerBounds.y);
  expect(targetBounds.y + targetBounds.height).toBeLessThanOrEqual(
    scrollerBounds.y + scrollerBounds.height,
  );

  await page.mouse.click(
    targetBounds.x + targetBounds.width / 2,
    targetBounds.y + targetBounds.height / 2,
  );
  await expect(page).toHaveURL(/\/ui\/projects\/[^/]+$/);
  await expect(scroller).toBeHidden();
  await expect(target).toHaveAttribute("data-list-key", targetKey);
  if (useBrowserBack) {
    await page.goBack();
  } else {
    await page.getByTestId("mobile-back").click();
  }
  await expect(page).toHaveURL(/\/ui\/?$/);
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
  test("keeps the same list and selection while opening project and session routes", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name.includes("mobile"), "desktop list scroll");
    await page.goto("/ui");
    const list = page.getByTestId("project-list-body");
    await expect(list).toBeVisible();
    const all = page.locator(LIST).getByTestId("nav-all-projects");
    if (await all.isVisible()) await all.click();
    await list.evaluate((el) => {
      el.dataset.workspaceIdentity = "persistent";
      el.scrollTop = 128;
    });
    const lore = page.locator(LIST).getByTestId("nav-project").filter({
      hasText: "lore",
    });
    await lore.scrollIntoViewIfNeeded();
    const scrollTop = await list.evaluate((el) => el.scrollTop);
    await lore.click();
    await expect(page).toHaveURL(/\/ui\/projects\/[^/]+$/);
    await expect(lore).toHaveAttribute("aria-current", "page");
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

    const projectId = new URL(page.url()).pathname.split("/").at(-1);
    const sessions = await (
      await page.request.get(`/api/v1/projects/${projectId}/sessions`)
    ).json();
    const sessionId = sessions[0]?.session_id;
    if (!sessionId)
      throw new Error("the seeded project must contain a session");
    await page.locator("main").getByRole("link", { name: sessionId }).click();
    await expect(page).toHaveURL(/\/ui\/projects\/[^/]+\/sessions\/[^/]+$/);
    await expect(lore).toHaveAttribute("aria-current", "page");
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
    const all = list.getByTestId("nav-all-projects");
    if (await all.isVisible()) await all.click();
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
    await page.getByTestId("project-list-body").evaluate((el) => {
      el.dataset.workspaceIdentity = "mobile-persistent";
    });
    const lore = list.getByTestId("nav-project").filter({ hasText: "lore" });
    await lore.click();
    await expect(page.getByTestId("document-pane")).toBeVisible();
    await expect(list).toBeHidden();
    await expect(page.getByTestId("mobile-back")).toHaveAttribute(
      "href",
      "/ui",
    );
    await page.getByTestId("mobile-back").click();
    await expect(list).toBeVisible();
    await expect(page.getByTestId("project-list-body")).toHaveAttribute(
      "data-workspace-identity",
      "mobile-persistent",
    );
  });

  test("preserves filler-60's anchor through the mobile Back link", async ({
    page,
  }) => {
    await expectFiller60AnchorAfterReturn(page, false);
  });

  test("preserves filler-60's anchor through browser Back", async ({
    page,
  }) => {
    await expectFiller60AnchorAfterReturn(page, true);
  });
});
