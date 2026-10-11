import { expect, test, type Locator, type Page } from "@playwright/test";

import { padActivitySecondPage } from "./helpers";

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

async function installPr3KnowledgeQuery(page: Page) {
  await page.route("**/api/v1/activity**", async (route) => {
    const requestedUrl = new URL(route.request().url());
    if (requestedUrl.searchParams.get("q") !== "type:knowledge PR3") {
      await route.continue();
      return;
    }
    const fixtureUrl = new URL(requestedUrl);
    fixtureUrl.searchParams.set("q", "type:knowledge");
    fixtureUrl.searchParams.delete("cursor");
    const response = await route.fetch({ url: fixtureUrl.toString() });
    const activity = (await response.json()) as {
      items: Array<{ title: string }>;
    };
    await route.fulfill({
      response,
      json: {
        ...activity,
        items: activity.items.map((item) => ({
          ...item,
          title: `PR3 ${item.title}`,
        })),
      },
    });
  });
}

async function waitForUnpinnedActivity(page: Page, keys: string[]) {
  await page.waitForFunction(async (activityKeys) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("lore-ui");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const records = await new Promise<
      Array<{ key: string; pinned_at?: number }>
    >((resolve, reject) => {
      const request = db
        .transaction("activityState", "readonly")
        .objectStore("activityState")
        .getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return activityKeys.every((key) =>
      records.some((record) => record.key === key && !record.pinned_at),
    );
  }, keys);
}

async function dispatchSpace(page: Page) {
  return page.evaluate(() => {
    const event = new KeyboardEvent("keydown", {
      key: " ",
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);
    return event.defaultPrevented;
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

async function expectFilteredKnowledgeScrollAfterReturn(
  page: Page,
  useBrowserBack: boolean,
) {
  await page.setViewportSize({ width: 400, height: 800 });
  await installPr3KnowledgeQuery(page);
  await page.goto(`/ui?q=${encodeURIComponent("type:knowledge PR3")}`);

  const scroller = page.getByTestId("activity-list-body");
  await expect(scroller).toBeVisible();
  await expect
    .poll(() => scroller.locator("[data-list-key]").count())
    .toBeGreaterThan(10);
  await scroller.evaluate((element) => {
    element.scrollTop = 244;
  });
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollTop))
    .toBe(244);
  const before = await firstVisibleRow(scroller);
  if (!before) throw new Error("filtered list has no visible row");

  const targetKey = await scroller.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const target = [
      ...element.querySelectorAll<HTMLElement>("[data-list-key]"),
    ].find((candidate) => {
      const rowBounds = candidate.getBoundingClientRect();
      return (
        candidate.dataset.activityKind === "knowledge" &&
        rowBounds.top >= bounds.top &&
        rowBounds.bottom <= bounds.bottom
      );
    });
    return target?.dataset.listKey ?? null;
  });
  if (!targetKey) throw new Error("filtered list has no fully visible row");
  const target = scroller.locator(`[data-list-key="${targetKey}"]`);
  const title = target.getByTestId("activity-title");
  await expect(title).toHaveClass(/font-semibold/);
  const targetBounds = await target.boundingBox();
  if (!targetBounds) throw new Error("activity row has no bounding box");
  await page.mouse.click(
    targetBounds.x + targetBounds.width / 2,
    targetBounds.y + targetBounds.height / 2,
  );
  await expect(page).toHaveURL(/\/ui\/projects\/[^/]+\/knowledge\//);
  await expect(scroller).toBeHidden();

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
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollTop))
    .toBe(244);
  const after = await firstVisibleRow(scroller);
  if (!after) throw new Error("filtered list has no visible row after return");
  expect(after.key).toBe(before.key);
  expect(Math.abs(after.offset - before.offset)).toBeLessThanOrEqual(2);
  await expect(title).toHaveClass(/font-medium/);
  await expect(title).not.toHaveClass(/font-semibold/);
  await expect(target.getByTestId("activity-unread-chip")).toHaveClass(
    /bg-soft/,
  );
  await expect(target.getByTestId("activity-unread-chip")).toHaveClass(
    /text-muted/,
  );
}

async function expectPagedActivityScrollAfterReturn(
  page: Page,
  useBrowserBack: boolean,
  loadSecondPage: boolean,
) {
  await page.setViewportSize({ width: 400, height: 800 });
  if (loadSecondPage) await padActivitySecondPage(page);
  let activityResponses = 0;
  let loadedActivityCount = 0;
  page.on("response", (response) => {
    if (new URL(response.url()).pathname.endsWith("/api/v1/activity")) {
      void response.json().then((page) => {
        activityResponses += 1;
        loadedActivityCount += page.items.length;
      });
    }
  });
  await page.goto("/ui");

  const scroller = page.getByTestId("activity-list-body");
  const header = page.getByTestId("activity-list-header");
  await expect(scroller).toBeVisible();
  await expect(header).toContainText("Inbox 1 – 50");
  await expect.poll(() => activityResponses).toBe(1);
  await expect
    .poll(() => scroller.locator("[data-list-key]").count())
    .toBeGreaterThan(0);

  if (loadSecondPage) {
    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect.poll(() => activityResponses).toBe(2);
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollHeight))
      .toBeGreaterThan(5000);
    await expect.poll(() => loadedActivityCount).toBeGreaterThan(50);
  }

  const expectedScrollTop = loadSecondPage ? 4832 : 450;
  await scroller.evaluate((element, top) => {
    element.scrollTop = top;
  }, expectedScrollTop);
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollTop))
    .toBe(expectedScrollTop);
  const beforeScrollTop = await scroller.evaluate(
    (element) => element.scrollTop,
  );
  const before = await firstVisibleRow(scroller);
  if (!before) throw new Error("activity list has no visible row");

  const targetKey = await scroller.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const target = [
      ...element.querySelectorAll<HTMLElement>("[data-list-key]"),
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
    return target?.dataset.listKey ?? null;
  });
  if (!targetKey) throw new Error("activity list has no fully visible row");
  const target = scroller.locator(`[data-list-key="${targetKey}"]`);
  const targetBounds = await target.boundingBox();
  if (!targetBounds) throw new Error("activity row has no bounding box");
  await page.mouse.click(
    targetBounds.x + targetBounds.width / 2,
    targetBounds.y + targetBounds.height / 2,
  );
  await expect(page).toHaveURL(/\/ui\/projects\/[^/]+\/(sessions|knowledge)\//);
  await expect(scroller).toBeHidden();
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

  const afterScrollTop = await scroller.evaluate(
    (element) => element.scrollTop,
  );
  expect(Math.abs(afterScrollTop - beforeScrollTop)).toBeLessThanOrEqual(2);
  const after = await firstVisibleRow(scroller);
  if (!after) throw new Error("activity list has no visible row after return");
  expect(after.key).toBe(before.key);
  expect(Math.abs(after.offset - before.offset)).toBeLessThanOrEqual(2);
}

test.describe("persistent workspace panes", () => {
  test("Space only advances unread activity from an activity document", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name.includes("mobile"), "desktop workspace");
    await page.goto("/ui/costs");
    await expect(page.getByTestId("costs-page")).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator(
            '[data-testid="activity-item"] [data-testid="activity-unread-chip"]',
          )
          .count(),
      )
      .toBeGreaterThan(0);

    expect(await dispatchSpace(page)).toBe(false);
    await expect(page).toHaveURL(/\/ui\/costs$/);

    const activity = page
      .locator(
        '[data-testid="activity-item"][data-activity-kind="knowledge"]:has([data-testid="activity-unread-chip"].bg-accent-soft)',
      )
      .first();
    await expect(activity).toBeVisible();
    await activity.locator("a").click();
    await expect(page).toHaveURL(/\/ui\/projects\/[^/]+\/knowledge\/[^/?]+/);
    expect(await dispatchSpace(page)).toBe(true);
  });

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

  test("keeps every document app bar child inside a 400px viewport in both themes", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 400, height: 800 });
    await page.goto("/ui");
    await page.getByTestId("activity-item").first().click();
    await expect(page.getByTestId("document-pane")).toBeVisible();
    const appBar = page.getByRole("banner");
    const themeCycle = page.getByTestId("theme-cycle");
    const themeRoot = page.getByTestId("theme-toggle");

    for (const choice of ["light", "dark"]) {
      for (let step = 0; step < 3; step += 1) {
        if ((await themeRoot.getAttribute("data-theme-choice")) === choice) {
          break;
        }
        await themeCycle.click();
      }
      await expect(themeRoot).toHaveAttribute("data-theme-choice", choice);
      const overflow = await appBar.evaluate((header) => {
        const bounds = Array.from(header.querySelectorAll<HTMLElement>("*"))
          .filter((element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              Number(style.opacity) !== 0 &&
              rect.width > 0 &&
              rect.height > 0
            );
          })
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              tag: element.tagName,
              label:
                element.getAttribute("aria-label") ??
                element.textContent?.trim().slice(0, 30),
              left: rect.left,
              right: rect.right,
            };
          });
        return {
          widths: { client: header.clientWidth, scroll: header.scrollWidth },
          children: bounds.filter(
            (rect) => rect.left < 0 || rect.right > window.innerWidth,
          ),
        };
      });
      expect(overflow.widths.scroll).toBeLessThanOrEqual(
        overflow.widths.client,
      );
      expect(overflow.children).toEqual([]);
    }
  });

  test("matches session unread rule color to the list unread chip", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name.includes("mobile"), "desktop reader color");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/ui?q=${encodeURIComponent("type:session")}`);
    const row = page
      .locator('[data-testid="activity-item"][data-activity-kind="session"]')
      .first();
    await expect(row).toBeVisible();
    const key = await row.getAttribute("data-list-key");
    if (!key) throw new Error("session row has no stable key");
    await row.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Unread", exact: true }).click();
    await row.locator("a").click();
    await expect(page).toHaveURL(/\/ui\/projects\/[^/]+\/sessions\//);
    const unreadMessage = page.locator("[data-unread]").first();
    await expect(unreadMessage).toBeVisible();
    const colors = await unreadMessage.evaluate((message, listKey) => {
      const chip = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-testid="activity-item"][data-activity-kind="session"]',
        ),
      )
        .filter((item) => item.dataset.listKey !== listKey)
        .map((item) =>
          item.querySelector<HTMLElement>(
            '[data-testid="activity-unread-chip"]',
          ),
        )
        .find((candidate) => candidate !== null);
      if (!chip) throw new Error("session unread chip was not retained");
      return {
        rule: getComputedStyle(message).borderLeftColor,
        chip: getComputedStyle(chip).color,
      };
    }, key);
    expect(colors.rule).toBe(colors.chip);
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
      .nth(2);
    await expect(item).toBeVisible();
    await list.evaluate((el) => {
      el.dataset.workspaceIdentity = "persistent";
      el.scrollTop = 128;
    });
    const scrollTop = await list.evaluate((el) => el.scrollTop);
    await expect(item).toBeInViewport();
    await item.click();
    await expect(page).toHaveURL(/\/ui\/projects\/[^/]+\/sessions\/[^/]+/);
    await expect(item.locator("a")).toHaveAttribute("aria-current", "page");
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

    const search = page.getByRole("searchbox", { name: "Search list" });
    await search.fill("type:session");
    await search.press("Enter");
    const item = list
      .locator('[data-testid="activity-item"][data-activity-kind="session"]')
      .nth(2);
    await expect(item).toBeVisible();
    await item.click();
    await expect(page).toHaveURL(/\/ui\/projects\/[^/]+\/sessions\/[^/]+/);
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

  for (const back of [
    { name: "Back link", useBrowserBack: false },
    { name: "browser Back", useBrowserBack: true },
  ]) {
    test(`restores filtered mobile scroll and read state via ${back.name}`, async ({
      page,
    }, testInfo) => {
      test.skip(
        !testInfo.project.name.includes("mobile"),
        "filtered mobile activity list",
      );
      await expectFilteredKnowledgeScrollAfterReturn(page, back.useBrowserBack);
    });
  }

  for (const scenario of [
    { name: "first page", loadSecondPage: false },
    { name: "after loading page two", loadSecondPage: true },
  ]) {
    for (const back of [
      { name: "Back to list link", useBrowserBack: false },
      { name: "browser Back", useBrowserBack: true },
    ]) {
      test(`preserves mobile activity scroll ${scenario.name} via ${back.name}`, async ({
        page,
      }, testInfo) => {
        test.skip(
          !testInfo.project.name.includes("mobile"),
          "mobile activity list",
        );
        await expectPagedActivityScrollAfterReturn(
          page,
          back.useBrowserBack,
          scenario.loadSecondPage,
        );
      });
    }
  }

  test("bulk archive and Inbox actions update activity filters", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name.includes("mobile"), "desktop bulk toolbar");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/ui");
    const row = page.getByTestId("activity-item").first();
    await expect(row).toBeVisible();
    const key = await row.getAttribute("data-list-key");
    if (!key) throw new Error("activity row has no stable key");
    await row.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Archive", exact: true }).click();

    const search = page.getByRole("searchbox", { name: "Search list" });
    await search.fill("in:archive");
    await search.press("Enter");
    const archivedRow = page.locator(`[data-list-key="${key}"]`);
    await expect(archivedRow).toBeVisible();
    await archivedRow.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Inbox", exact: true }).click();

    await page.getByRole("searchbox", { name: "Search list" }).fill("in:inbox");
    await page.getByRole("searchbox", { name: "Search list" }).press("Enter");
    await expect(page.locator(`[data-list-key="${key}"]`)).toBeVisible();
  });

  test("unpins all checked rows from is:pinned and persists both transitions", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name.includes("mobile"), "desktop bulk toolbar");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/ui");
    const rows = page.getByTestId("activity-item");
    await expect.poll(() => rows.count()).toBeGreaterThan(1);
    const keys = [
      await rows.nth(0).getAttribute("data-list-key"),
      await rows.nth(1).getAttribute("data-list-key"),
    ];
    if (!keys[0] || !keys[1])
      throw new Error("activity rows have no stable key");
    const activityKeys = keys.filter((key): key is string => key !== null);
    await rows.nth(0).getByRole("checkbox").check();
    await rows.nth(1).getByRole("checkbox").check();
    await page.getByRole("button", { name: "Pin", exact: true }).click();

    const search = page.getByRole("searchbox", { name: "Search list" });
    await search.fill("is:pinned");
    await search.press("Enter");
    await expect(page.getByTestId("activity-item")).toHaveCount(2);
    for (const key of activityKeys) {
      const row = page.locator(`[data-list-key="${key}"]`);
      await expect(row).toBeVisible();
      await row.getByRole("checkbox").check();
    }
    await page.getByRole("button", { name: "Unpin", exact: true }).click();
    await expect(page.getByTestId("activity-item")).toHaveCount(0);
    await waitForUnpinnedActivity(page, activityKeys);
    await page.reload();
    await expect(page.getByTestId("activity-item")).toHaveCount(0);
  });

  test("creates a folder and moves selected activity into it", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name.includes("mobile"), "desktop bulk toolbar");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/ui");
    const row = page.getByTestId("activity-item").first();
    await expect(row).toBeVisible();
    const key = await row.getAttribute("data-list-key");
    if (!key) throw new Error("activity row has no stable key");
    await row.getByRole("checkbox").check();
    const moveButton = page.getByRole("button", {
      name: "Move to folder",
      exact: true,
    });
    await moveButton.click();
    const newFolder = page
      .getByTestId("activity-folder-menu")
      .getByRole("button", { name: "New folder…" });
    await expect(newFolder).toBeVisible();
    const newFolderBounds = await newFolder.boundingBox();
    if (!newFolderBounds) throw new Error("folder option has no bounding box");
    await page.mouse.click(
      newFolderBounds.x + newFolderBounds.width / 2,
      newFolderBounds.y + newFolderBounds.height / 2,
    );
    await page.getByLabel("Folder name").fill("Work notes");
    await page.getByTestId("activity-folder-save").click();

    await page
      .getByTestId("activity-item")
      .nth(1)
      .getByRole("checkbox")
      .check();
    await moveButton.click();
    const folderOption = page
      .getByTestId("activity-folder-menu")
      .getByRole("button", { name: "Work notes", exact: true });
    await expect(folderOption).toBeVisible();
    const folderOptionBounds = await folderOption.boundingBox();
    if (!folderOptionBounds)
      throw new Error("folder option has no bounding box");
    await page.mouse.click(
      folderOptionBounds.x + folderOptionBounds.width / 2,
      folderOptionBounds.y + folderOptionBounds.height / 2,
    );
    await expect(page.getByTestId("activity-folder-menu")).toBeHidden();
    await page
      .getByTestId("activity-folder")
      .filter({ hasText: "Work notes" })
      .click();
    await expect(page.locator(`[data-list-key="${key}"]`)).toBeVisible();
  });

  test("opening knowledge activity marks it read and keeps document actions", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name.includes("mobile"),
      "desktop document actions",
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/ui");
    const search = page.getByRole("searchbox", { name: "Search list" });
    await search.fill("type:knowledge is:unread");
    await search.press("Enter");
    const row = page
      .locator('[data-testid="activity-item"][data-activity-kind="knowledge"]')
      .first();
    await expect(row).toBeVisible();
    const key = await row.getAttribute("data-list-key");
    if (!key) throw new Error("activity row has no stable key");
    await row.locator("a").click();
    await expect(page).toHaveURL(
      /\/ui\/(projects\/[^/]+\/knowledge|knowledge)\//,
    );
    await expect(page.getByTestId("workspace-next-unread")).toBeVisible();
    await expect(page.getByTestId("workspace-next-item")).toBeEnabled();
    await expect(page.locator(`[data-list-key="${key}"]`)).toHaveCount(0);
  });

  test("participant search commits a with query", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name.includes("mobile"),
      "desktop participant pane",
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/ui");
    const search = page.getByRole("searchbox", {
      name: "Search participants",
    });
    await expect(search).toBeVisible();
    await search.fill("You");
    await page
      .getByTestId("workspace-participant")
      .filter({ hasText: "You" })
      .click();
    await expect(page).toHaveURL(/q=with%3Auser/);
  });
});
