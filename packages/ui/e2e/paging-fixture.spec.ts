/**
 * `/ui/fixture?view=busy&paged=n` — the busy-session fixture in its paged
 * mode (#1923): the reader starts with only the newest n generated blocks,
 * pages older history in on an upward scroll near the top, keeps the row
 * under the eye steady while it does, and reports a failed page honestly.
 * Dev-only (Vite dev server), like `busy-fixture.spec.ts`.
 */
import { expect, test, type Page } from "@playwright/test";

const PAGE = 200;
const BLOCKS = 10_000;
const LAST_KEY = "m.busy-009999";

async function openPaged(page: Page, extra = "") {
  await page.goto(
    `/ui/fixture?view=busy&blocks=${BLOCKS}&paged=${PAGE}${extra}`,
  );
  await expect(page.getByTestId("session-view")).toBeVisible();
}

const scrollEl = (page: Page) => page.getByTestId("session-scroll");

/** `aria-setsize` is the logical row count — same on every mounted row. */
async function setsize(page: Page) {
  const value = await page
    .locator("[data-row-key]")
    .first()
    .getAttribute("aria-setsize");
  return Number(value);
}

/** Jump the transcript to its top; the reader pages older history itself. */
async function scrollToTop(page: Page) {
  await scrollEl(page).evaluate((el) => {
    el.scrollTop = 0;
  });
}

test.describe("paged busy fixture", () => {
  test("lands at the newest row without touching older history", async ({
    page,
  }) => {
    await openPaged(page);
    await expect(page.locator(`[data-row-key="${LAST_KEY}"]`)).toBeInViewport();
    expect(await setsize(page)).toBe(PAGE);
    await expect(page.getByTestId("reader-coverage-line")).toContainText(
      `${PAGE} of ${BLOCKS.toLocaleString()}`,
    );
    await expect(page.getByTestId("older-loading")).toHaveCount(0);
    expect(await setsize(page)).toBe(PAGE);
    await expect(page.getByTestId("older-status")).toContainText(
      "Scroll up to load older history",
    );
  });

  test("scrolling to the top pages older history in without moving the row under the eye", async ({
    page,
  }) => {
    await openPaged(page);
    // Each load is witnessed by the row that was first *visible* at its top:
    // its screen top must not move as the page prepends above it.
    const loadAndCheck = async (expected: number) => {
      await scrollToTop(page);
      // Once the load is in flight the scroll has been applied; give the
      // virtualiser two frames to remount the top rows, then pick a witness
      // a few rows under the eye — the fold row itself can slide in and out
      // of the overscan range — whose screen top must not move while the
      // page prepends above it.
      await expect(page.getByTestId("older-loading")).toBeVisible();
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      const row = page
        .locator('[data-testid="session-rows"] [data-row-key]')
        .nth(3);
      const key = await row.getAttribute("data-row-key");
      const topBefore = await row.evaluate(
        (el) => el.getBoundingClientRect().top,
      );
      expect(key).toBeTruthy();
      await expect.poll(() => setsize(page)).toBe(expected);
      await expect(page.getByTestId("older-loading")).toHaveCount(0);
      await expect
        .poll(async () => {
          const count = await page.locator(`[data-row-key="${key}"]`).count();
          if (count === 0) return -1;
          const top = await page
            .locator(`[data-row-key="${key}"]`)
            .evaluate((el) => el.getBoundingClientRect().top);
          return Math.abs(top - topBefore);
        })
        .toBeLessThanOrEqual(2);
    };

    await loadAndCheck(2 * PAGE);
    await loadAndCheck(3 * PAGE);
  });

  test("jump-to-latest returns to the newest row", async ({ page }) => {
    await openPaged(page);
    await scrollToTop(page);
    await expect.poll(() => setsize(page)).toBe(2 * PAGE);
    await expect(page.locator(`[data-row-key="${LAST_KEY}"]`)).toHaveCount(0);
    await page.getByTestId("jump-to-latest").click();
    await expect(page.locator(`[data-row-key="${LAST_KEY}"]`)).toBeInViewport();
  });

  test("a failed older page is reported and retried", async ({ page }) => {
    await openPaged(page, "&failOlder=1");
    await scrollToTop(page);
    const status = page.getByTestId("older-status");
    await expect(status.getByRole("alert")).toContainText(
      "Older history unavailable: fixture: older page failed",
    );
    await page.getByTestId("older-retry").click();
    await expect.poll(() => setsize(page)).toBe(2 * PAGE);
    await expect(status.getByRole("alert")).toHaveCount(0);
  });
});
