import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * #1916: the nav's tinted background must cover the whole scrolled project
 * list. `aside[data-pane="nav"]` is the scroll container (transparent); the
 * inner `<nav>` paints `bg-nav` — if it is shorter than the scroll content,
 * the page background shows below it.
 */

/** Resolved value of the --color-nav token under the current theme. */
async function navColor(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.createElement("div");
    el.style.background = "var(--color-nav)";
    document.body.append(el);
    const value = getComputedStyle(el).backgroundColor;
    el.remove();
    return value;
  });
}

/**
 * Assert `scroller` overflows, that the inner Workspace nav reaches the
 * bottom of the scroll content, and that the pixel at the bottom of the
 * scrolled container belongs to the nav (not the page background).
 */
async function assertNavCoversScroll(page: Page, scroller: Locator) {
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
    const nav = el.querySelector('nav[aria-label="Workspace"]');
    if (!(nav instanceof HTMLElement)) return null;
    const rect = el.getBoundingClientRect();
    return {
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      navHeight: nav.offsetHeight,
      navBg: getComputedStyle(nav).backgroundColor,
      hit:
        document
          .elementFromPoint(rect.left + 4, rect.bottom - 4)
          ?.closest('nav[aria-label="Workspace"]') !== null,
    };
  });
  expect(probe).not.toBeNull();
  expect(probe!.scrollHeight).toBeGreaterThan(probe!.clientHeight);
  expect(probe!.navHeight).toBeGreaterThanOrEqual(probe!.scrollHeight - 1);
  expect(probe!.hit).toBe(true);
  expect(probe!.navBg).toBe(await navColor(page));
}

test.describe("nav background (#1916)", () => {
  test("desktop nav background covers the whole scrolled project list (light + dark)", async ({
    page,
  }) => {
    await page.goto("/ui");
    await expect(page.getByTestId("connection-status")).toHaveAttribute(
      "data-connection",
      "reachable",
    );
    test.skip(await page.getByTestId("open-nav").isVisible(), "desktop only");

    const scroller = page.locator('aside[data-pane="nav"]');
    await assertNavCoversScroll(page, scroller);

    await page.getByTestId("theme-dark").click();
    await assertNavCoversScroll(page, scroller);

    await page.getByTestId("theme-light").click();
  });

  test("mobile drawer keeps its tinted background to the bottom", async ({
    page,
  }) => {
    await page.goto("/ui");
    await expect(page.getByTestId("connection-status")).toHaveAttribute(
      "data-connection",
      "reachable",
    );
    test.skip(!(await page.getByTestId("open-nav").isVisible()), "mobile only");

    await page.getByTestId("open-nav").click();
    const drawer = page.getByTestId("nav-drawer");
    await assertNavCoversScroll(page, drawer);
    await page.keyboard.press("Escape");
  });
});
