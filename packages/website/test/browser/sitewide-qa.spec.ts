import { expect, test } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const contentRoot = fileURLToPath(
  new URL("../../src/content/", import.meta.url),
);
const docs = readdirSync(`${contentRoot}/docs/docs`, { recursive: true })
  .filter((name) => /\.mdx?$/.test(String(name)))
  .map((name) =>
    `/docs/${String(name)
      .replace(/\\/g, "/")
      .replace(/(?:index)?\.mdx?$/, "")
      .replace(/\/?$/, "/")}`.replace(/\/+/g, "/"),
  );
const articles = readdirSync(`${contentRoot}/blog`)
  .filter(
    (name) =>
      /\.mdx?$/.test(name) &&
      !/^draft:\s*true\s*$/m.test(
        readFileSync(`${contentRoot}/blog/${name}`, "utf8"),
      ),
  )
  .map((name) => `/blog/${name.replace(/\.mdx?$/, "")}/`);

for (const path of [
  "/",
  "/different/",
  "/tour/",
  "/blog/",
  ...docs,
  ...articles,
]) {
  test(`route reflow: ${path}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.locator("h1")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
      path,
    ).toBeLessThanOrEqual(1);
    if (path.startsWith("/docs/")) {
      await expect(
        page.locator('.docs-group-icons .top-level a[aria-current="page"]'),
      ).toHaveCount(1);
      const group = await page
        .locator('.docs-group-icons .top-level a[aria-current="page"]')
        .evaluate(
          (el) =>
            el
              .closest("ul.top-level > li")
              ?.querySelector(":scope > details > summary .large")
              ?.textContent ?? "",
        );
      expect(group).not.toBe("");
      await expect(
        page.locator(".docs-journal-title .field-marker"),
      ).toHaveText(group);
    }
    expect(errors, path).toEqual([]);
  });
}

test("verification proof is readable on phones and keeps the original capture", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/docs/first-session/#verify");
  const proof = page.locator(".verification-example");
  await proof.scrollIntoViewIfNeeded();
  const image = proof.locator("img:visible");
  await expect
    .poll(() => image.evaluate((el: HTMLImageElement) => el.currentSrc))
    .toContain("session-detail-mobile-");
  await expect(image).toHaveJSProperty("naturalWidth", 394);
  await expect(
    proof.getByRole("link", {
      name: "Open full-size recorded session screenshot",
      exact: true,
    }),
  ).toHaveAttribute(
    "href",
    /\/product-tour\/session-detail-(light|dark)\.png$/,
  );
  await expect(proof).toContainText("cannot check its connection");
});
