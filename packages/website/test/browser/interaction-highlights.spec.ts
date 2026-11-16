import { expect, test } from "@playwright/test";

test("blog hover matches the complete native link without an accent edge or layout shift", async ({
  page,
  isMobile,
}) => {
  await page.goto("/blog/");
  const row = page.locator(".post-row").first();
  const link = row.locator(".post-row-link");
  await expect(link).toHaveCount(1);
  await expect(row.getByRole("link")).toHaveCount(1);
  await page.evaluate(() => document.fonts.ready);
  await link.scrollIntoViewIfNeeded();
  const before = await link.boundingBox();
  if (!isMobile) {
    await link.hover();
    const styles = await link.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        left: s.borderLeftWidth,
        right: s.borderRightWidth,
        leftColor: s.borderLeftColor,
        rightColor: s.borderRightColor,
        background: s.backgroundColor,
        transform: s.transform,
      };
    });
    expect(styles.left).toBe(styles.right);
    expect(styles.leftColor).toBe(styles.rightColor);
    expect(styles.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(styles.transform).toBe("none");
    expect(await link.boundingBox()).toEqual(before);
  }
  const destination = await link.getAttribute("href");
  await link.locator("time").click();
  await expect(page).toHaveURL(new RegExp(destination! + "$"));
});

test("selected journal choices and shared tabs use surfaces instead of inset stripes", async ({
  page,
}) => {
  await page.goto("/?chapter=knowledge#journal");
  const chapter = page.locator(".journal-chapters label:has(input:checked)");
  expect(
    await chapter.evaluate((el) => getComputedStyle(el, "::before").content),
  ).toBe("none");
  await page.locator("details.journal-inventory summary").click();
  const card = page.locator(".journal-card:has(input:checked)");
  await expect(card).toBeVisible();
  expect(await card.evaluate((el) => getComputedStyle(el).boxShadow)).toBe(
    "none",
  );
  const detail = page.locator('[data-journal-entry="webhook"]');
  const borders = await detail.evaluate((el) => {
    const s = getComputedStyle(el);
    return [
      s.borderLeftWidth,
      s.borderRightWidth,
      s.borderLeftColor,
      s.borderRightColor,
    ];
  });
  expect(borders[0]).toBe(borders[1]);
  expect(borders[2]).toBe(borders[3]);
  await page.goto("/tour/");
  const tab = page.locator(".tour-picker .ui-choice-item:has(:checked)");
  expect(await tab.evaluate((el) => getComputedStyle(el).boxShadow)).toBe(
    "none",
  );
});

test("blog row keyboard focus remains visible and phone layout stays contained", async ({
  page,
}) => {
  await page.goto("/blog/");
  const link = page.locator(".post-row-link").first();
  await page.keyboard.press("Tab");
  await link.focus();
  expect(
    await link.evaluate((el) => getComputedStyle(el).outlineStyle),
  ).not.toBe("none");
  expect(
    await link.evaluate((el) => parseFloat(getComputedStyle(el).outlineWidth)),
  ).toBeGreaterThanOrEqual(2);
  await page.keyboard.press("Enter");
  await expect(page.locator(".blog-post h1")).toBeVisible();
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/blog/");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  expect(
    (await page.locator(".post-row-link").first().boundingBox())!.height,
  ).toBeGreaterThanOrEqual(44);
});
