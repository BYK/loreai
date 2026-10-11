import { expect, test, type Locator } from "@playwright/test";

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

  test("keeps the visible project rows anchored when returning to the list", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 400, height: 800 });
    await page.goto("/ui");

    const scroller = page.getByTestId("project-list-body");
    await expect(scroller).toBeVisible();
    await page.locator(LIST).getByTestId("nav-all-projects").click();

    const allProjects = page.locator(
      `${LIST} [data-section="all"][data-testid="nav-project"]`,
    );
    await scroller.evaluate((el) => {
      el.scrollTop = 394;
    });
    const targetIndex = await allProjects.evaluateAll((rows) => {
      const list = rows[0]?.closest<HTMLElement>(
        '[data-testid="project-list-body"]',
      );
      if (!list) throw new Error("project list scroller is missing");
      const listRect = list.getBoundingClientRect();
      const midpoint = listRect.top + listRect.height / 2;
      return rows.reduce(
        (closestIndex, candidate, index) => {
          const distance = Math.abs(
            candidate.getBoundingClientRect().top +
              candidate.getBoundingClientRect().height / 2 -
              midpoint,
          );
          return distance < closestIndex.distance
            ? { index, distance }
            : closestIndex;
        },
        { index: 0, distance: Number.POSITIVE_INFINITY },
      ).index;
    });
    const target = allProjects.nth(targetIndex);
    const targetKey = await target.getAttribute("data-list-key");
    if (!targetKey?.startsWith("all:")) {
      throw new Error(`Expected an All project key, received ${targetKey}`);
    }
    const targetId = targetKey.slice("all:".length);

    const targetPosition = await target.evaluate((row) => {
      const list = row.closest<HTMLElement>(
        '[data-testid="project-list-body"]',
      );
      if (!list) throw new Error("project list scroller is missing");
      const listRect = list.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const desiredOffset = Math.min(
        320,
        listRect.height - rowRect.height - 20,
      );
      list.scrollTop += rowRect.top - listRect.top - desiredOffset;
      const positionedRow = row.getBoundingClientRect();
      return {
        top: positionedRow.top - listRect.top,
        bottom: positionedRow.bottom - listRect.top,
        height: listRect.height,
      };
    });
    expect(targetPosition.top).toBeGreaterThan(0);
    expect(targetPosition.bottom).toBeLessThan(targetPosition.height);

    const before = await firstVisibleRow(scroller);
    expect(before?.key).toMatch(/^all:/);
    expect(before?.key).not.toBe(targetKey);

    const bounds = await target.boundingBox();
    if (!bounds) throw new Error("target project row has no bounding box");
    await page.mouse.click(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    await expect(page).toHaveURL(/\/ui\/projects\/[^/]+$/);
    await expect(scroller).toBeHidden();
    await expect(
      scroller.locator(`[data-list-key="recent:${targetId}"]`),
    ).toHaveCount(1);
    await expect(
      scroller.locator(`[data-list-key="all:${targetId}"]`),
    ).toHaveCount(0);
    await page.getByTestId("mobile-back").click();
    await expect(scroller).toBeVisible();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        }),
    );
    const after = await firstVisibleRow(scroller);
    if (!before || !after) {
      throw new Error(
        "Expected a visible list row before and after navigation",
      );
    }
    expect(after.key).toBe(before.key);
    expect(Math.abs(after.offset - before.offset)).toBeLessThanOrEqual(1);
    await expect(scroller).toHaveCSS("overflow-anchor", "none");
  });
});
