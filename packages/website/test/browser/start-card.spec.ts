import { expect, test } from "@playwright/test";

test("start card shows only the artwork for the active appearance", async ({
  page,
}) => {
  await page.goto("/#get-started");
  await expect(page.locator(".start-card .journal-art:visible")).toHaveCount(1);
});

test("start card and footer remain contained with enlarged phone text", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/#get-started");
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  for (const selector of [".start-card", ".site-footer"]) {
    const region = page.locator(selector);
    for (const link of await region.getByRole("link").all()) {
      if (!(await link.isVisible())) continue;
      const box = await link.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    }
  }
});
