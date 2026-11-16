import { expect, test } from "@playwright/test";

test("article anchor targets clear both floating navigation and the reading bar", async ({
  page,
}) => {
  await page.goto("/blog/how-lore-remembers-and-forgets/");
  const outline = page.locator(".article-outline");
  await outline.locator("summary").click();
  const link = outline.locator('a[href^="#"]').nth(1);
  const href = await link.getAttribute("href");
  await link.click();
  const target = page.locator(href!);
  await expect(target).toBeFocused();
  const heading = await target.boundingBox();
  const bar = await outline.boundingBox();
  expect(heading!.y).toBeGreaterThanOrEqual(bar!.y + bar!.height + 8);
});
