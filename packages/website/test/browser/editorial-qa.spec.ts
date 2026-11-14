import { expect, test } from "@playwright/test";

test("memory concepts have readable named definitions and data boundaries", async ({
  page,
}) => {
  await page.goto("/docs/memory/");
  await expect(page.locator(".memory-definitions")).toBeVisible();
  await expect(page.locator(".memory-flow")).toContainText("Current request");
  await page.goto("/docs/data-and-costs/");
  await expect(page.locator(".data-boundaries")).toContainText(
    "On your machine",
  );
  await expect(page.locator(".data-boundaries")).toContainText(
    "Configured providers",
  );
  if (page.viewportSize()!.width > 640) {
    const tops = await page
      .locator(".data-boundaries > section")
      .evaluateAll((elements) =>
        elements.map((el) => el.getBoundingClientRect().top),
      );
    expect(Math.abs(tops[0] - tops[1])).toBeLessThanOrEqual(1);
  }
});

test("the blog has a practical starting point and quiet topic-specific article framing", async ({
  page,
}) => {
  await page.goto("/blog/");
  await expect(page.locator(".featured-note")).toContainText("Start here");
  await page.goto("/blog/how-lore-remembers-and-forgets/");
  const label = page.locator(".article-field-label .field-marker");
  expect(
    await label.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ).toBeLessThanOrEqual(13);
  await expect(page.locator(".article-takeaway")).not.toContainText(
    "Folk Lore early access",
  );
});

test("configuration navigation resolves to actual rendered headings", async ({
  page,
}) => {
  for (const path of ["/docs/configuration/", "/docs/team-memory/"]) {
    await page.goto(path);
    const links = await page
      .locator('main a[href*="#"], .sl-markdown-content a[href*="#"]')
      .evaluateAll((elements) =>
        elements
          .map((el) => (el as HTMLAnchorElement).href)
          .filter((href) => new URL(href).pathname === "/docs/configuration/"),
      );
    expect(links.length).toBeGreaterThan(1);
    await page.goto("/docs/configuration/");
    for (const href of links) {
      const fragment = decodeURIComponent(new URL(href).hash.slice(1));
      expect(
        await page.evaluate(
          (id) => Boolean(document.getElementById(id)),
          fragment,
        ),
        href,
      ).toBe(true);
    }
  }
});
