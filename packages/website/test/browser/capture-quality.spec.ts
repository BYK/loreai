import { expect, test } from "@playwright/test";

for (const path of [
  "/#product",
  "/tour/",
  "/tour/?view=knowledge#product",
  "/docs/first-session/#verify",
]) {
  test(`app captures stay sharp on a Retina screen: ${path}`, async ({
    browser,
    baseURL,
  }, testInfo) => {
    const context = await browser.newContext({
      baseURL,
      viewport: testInfo.project.use.viewport,
      colorScheme: testInfo.project.use.colorScheme,
      deviceScaleFactor: 2,
    });
    try {
      const page = await context.newPage();
      await page.goto(path);
      const captures = page.locator('main img[src*="product-tour/"]:visible');
      expect(await captures.count()).toBeGreaterThan(0);
      for (const img of await captures.all()) {
        await img.scrollIntoViewIfNeeded();
        await expect(img).toHaveJSProperty("complete", true);
        const source = await img.evaluate(
          (el: HTMLImageElement) => el.currentSrc,
        );
        const response = await context.request.get(source);
        expect(response.ok()).toBe(true);
        const bytes = await response.body();
        expect(bytes.subarray(1, 4).toString()).toBe("PNG");
        const pixelWidth = bytes.readUInt32BE(16);
        const displayed = await img.boundingBox();
        expect(pixelWidth, source).toBeGreaterThanOrEqual(
          Math.floor(displayed!.width * 2),
        );
      }
    } finally {
      await context.close();
    }
  });
}
