import { expect, test } from "@playwright/test";

test("the story begins with the conversation and shows product proof first", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("radio", { name: "Conversation", exact: true }),
  ).toBeChecked();
  const positions = await page.evaluate(() => ({
    product: document.querySelector("#product")!.getBoundingClientRect().top,
    journal: document.querySelector("#journal")!.getBoundingClientRect().top,
  }));
  expect(positions.product).toBeLessThan(positions.journal);
  await expect(page.locator(".hero-copy")).toContainText(".lore.md");
});

test("the inventory is optional and its active text remains legible", async ({
  page,
}) => {
  await page.goto("/?chapter=recall&task=webhook");
  const inventory = page.locator(".journal-inventory");
  const summary = inventory.locator("summary");
  if (await summary.count()) await summary.click();
  const text = page.locator('[data-journal-card="forms"] .journal-stored');
  await expect(text).toBeVisible();
  const result = await text.evaluate((el) => {
    const card = el.closest(".journal-card")!,
      margin = el.closest(".journal-inventory")!;
    const c = new OffscreenCanvas(1, 1),
      ctx = c.getContext("2d")!;
    const alpha = Number(getComputedStyle(card).opacity);
    function color(foreground: string) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = getComputedStyle(margin).backgroundColor;
      ctx.fillRect(0, 0, 1, 1);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = foreground;
      ctx.fillRect(0, 0, 1, 1);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data)
        .slice(0, 3)
        .map((v) => {
          const n = v / 255;
          return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
        })
        .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    }
    const a = color(getComputedStyle(el).color),
      b = color(getComputedStyle(card).backgroundColor);
    return {
      size: parseFloat(getComputedStyle(el).fontSize),
      ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
    };
  });
  expect(result.size).toBeGreaterThanOrEqual(12);
  expect(result.ratio).toBeGreaterThanOrEqual(4.5);
  await expect(summary).toBeVisible();
  await summary.click();
  await expect(text).toBeHidden();
});

test("light artwork uses its own ink palette and survives explicit theme changes", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Light theme", { exact: true }).first().click();
  const art = page.locator("img.journal-art:visible").first();
  await expect(art).toHaveAttribute("src", /-light\.svg$/);
  await expect(art).toHaveCSS("filter", "none");
  await page.getByLabel("Dark theme", { exact: true }).first().click();
  await expect(
    page.locator("img.journal-art:visible").first(),
  ).not.toHaveAttribute("src", /-light\.svg$/);
});

test("setup has one sequence and its verification action names the destination", async ({
  page,
}) => {
  await page.goto("/docs/install/?agent=codex");
  await expect(
    page.getByRole("heading", {
      name: "2. Install and check the executable",
      exact: true,
    }),
  ).toHaveCount(0);
  const link = page
    .locator('[data-setup-panel="codex"]')
    .getByRole("link", { name: "See verification steps", exact: true });
  await expect(link).toHaveAttribute(
    "href",
    /first-session\/\?agent=codex#verify$/,
  );
  await link.click();
  await expect(
    page.getByRole("heading", { name: "Verify", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".verification-example")).toBeVisible();
});

test("comparison facts stay together without horizontal scrolling on phones", async ({
  page,
}) => {
  await page.goto("/different/#landscape");
  const comparison = page.getByRole("region", {
    name: "Approach comparison",
    exact: true,
  });
  expect(
    await comparison.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBe(true);
});

test("legacy numbered setup links still land in the consolidated flow", async ({
  page,
}) => {
  for (const fragment of [
    "1-choose-your-agent",
    "2-install-and-check-the-executable",
    "3-connect-from-your-project",
    "4-verify-the-connection",
  ]) {
    await page.goto(`/docs/install/#${fragment}`);
    await expect(page.locator(`[id="${fragment}"]`)).toHaveCount(1);
  }
});

test("verification captures follow a dark device without JavaScript", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    colorScheme: "dark",
  });
  try {
    const page = await context.newPage();
    await page.goto(`${baseURL}/docs/first-session/`);
    await expect(page.locator(".verification-dark")).toBeVisible();
    await expect(page.locator(".verification-light")).toBeHidden();
  } finally {
    await context.close();
  }
});
