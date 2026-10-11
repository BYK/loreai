import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectConnectionStatus } from "./helpers";

/**
 * Project list scrolling must stay inside its surface without exposing the
 * page background below the rows.
 */

/** Resolved value of the --color-surface token under the current theme. */
async function surfaceColor(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.createElement("div");
    el.style.background = "var(--color-surface)";
    document.body.append(el);
    const value = getComputedStyle(el).backgroundColor;
    el.remove();
    return value;
  });
}

/**
 * Assert the project body overflows and remains inside the list pane surface.
 */
async function assertListCoversScroll(page: Page, scroller: Locator) {
  const allProjects = scroller.getByTestId("nav-all-projects");
  await expect(allProjects).toBeVisible();
  // The sidebar shows only pinned+recent until "All projects" expands (#1929);
  // don't click again when a previous call already expanded it.
  if ((await allProjects.getAttribute("aria-expanded")) !== "true") {
    await allProjects.click();
  }
  await expect(allProjects).toHaveAttribute("aria-expanded", "true");
  await expect
    .poll(() => scroller.getByTestId("nav-project").count())
    .toBeGreaterThanOrEqual(60);
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect
    .poll(() =>
      scroller.evaluate(
        (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
      ),
    )
    .toBeLessThan(2);

  const probe = await scroller.evaluate((el) => {
    const pane = el.closest('section[data-pane="list"]');
    if (!(pane instanceof HTMLElement)) return null;
    const rect = el.getBoundingClientRect();
    return {
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      paneHeight: pane.offsetHeight,
      paneBg: getComputedStyle(pane).backgroundColor,
      hit:
        document
          .elementFromPoint(rect.left + 4, rect.bottom - 4)
          ?.closest('[data-testid="project-list-body"]') !== null,
    };
  });
  expect(probe).not.toBeNull();
  expect(probe!.scrollHeight).toBeGreaterThan(probe!.clientHeight);
  expect(probe!.paneHeight).toBeGreaterThanOrEqual(probe!.clientHeight);
  expect(probe!.hit).toBe(true);
  expect(probe!.paneBg).toBe(await surfaceColor(page));
}

test.describe("project list scrolling", () => {
  test("list surface covers the scrolled project body (light + dark)", async ({
    page,
  }) => {
    await page.goto("/ui");
    await expectConnectionStatus(page);
    test.skip(await page.getByTestId("open-nav").isVisible(), "desktop only");

    const scroller = page.getByTestId("project-list-body");
    await assertListCoversScroll(page, scroller);

    await page.getByTestId("theme-dark").click();
    await assertListCoversScroll(page, scroller);

    await page.getByTestId("theme-light").click();
  });

  test("mobile navigation drawer remains available separately from the list", async ({
    page,
  }) => {
    await page.goto("/ui");
    await expectConnectionStatus(page);
    test.skip(!(await page.getByTestId("open-nav").isVisible()), "mobile only");

    await page.getByTestId("open-nav").click();
    const drawer = page.getByTestId("nav-drawer");
    await expect(
      drawer.getByRole("navigation", { name: "Workspace" }),
    ).toBeVisible();
    await expect(page.getByTestId("project-list-body")).toBeVisible();
    await page.keyboard.press("Escape");
  });
});
