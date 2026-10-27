import { expect, test, type Page } from "@playwright/test";

const surfaces = [
  { name: "home", path: "/", heading: "Keep project decisions" },
  {
    name: "comparison",
    path: "/different/",
    heading: "Context for the work in progress.",
  },
  { name: "docs", path: "/docs/install/", heading: "Install Lore" },
  {
    name: "blog",
    path: "/blog/",
    heading: "Blog",
  },
  {
    name: "article",
    path: "/blog/the-agentic-memory-trap/",
    heading: "The Agentic Memory Trap",
  },
];

async function themeButton(page: Page, choice: string) {
  const menu = page
    .getByLabel("Theme settings", { exact: true })
    .filter({ visible: true })
    .first();
  const value = choice === "System" ? "auto" : choice.toLowerCase();
  const control = page.locator(`button[data-theme-choice="${value}"]`).first();
  if (!(await control.isVisible())) await menu.click();
  return control;
}

test.beforeEach(async ({ page }) => {
  await page.route(
    "https://api.github.com/repos/BYK/loreai/releases/latest",
    async (route) => {
      await route.fulfill({ json: { tag_name: "0.34.0" } });
    },
  );
});

for (const surface of surfaces) {
  test(`${surface.name}: readable content, complete header, and local fonts`, async ({
    page,
    isMobile,
  }) => {
    const errors: string[] = [];
    const broken: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      if (
        response.url().startsWith("http://127.0.0.1:4331/") &&
        response.status() >= 400
      )
        broken.push(response.url());
    });
    await page.goto(surface.path);
    await expect(page.locator("h1")).toContainText(surface.heading, {
      ignoreCase: true,
    });
    await page.evaluate(() => document.fonts.ready);
    expect(
      await page.evaluate(() =>
        document.fonts.check('16px "DM Sans Variable"'),
      ),
    ).toBe(true);
    expect(
      await page.evaluate(() =>
        document.fonts.check('16px "Playfair Display"'),
      ),
    ).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
    // overflow-x:hidden can hide a broken header. Check every visible link/control
    // directly so clipped logos and menu buttons cannot pass as a fitting layout.
    const header = page.locator(".top-nav, .blog-nav, .header").first();
    await expect(header.locator(".logo-img:visible")).toHaveCount(1);
    for (const element of await header.locator("a, button, summary").all()) {
      if (!(await element.isVisible())) continue;
      const box = await element.boundingBox();
      expect(box?.x).toBeGreaterThanOrEqual(-1);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
        (page.viewportSize()?.width ?? 0) + 1,
      );
    }
    const control = await themeButton(page, "System");
    await expect(control).toHaveAttribute("aria-pressed", "true");
    if (isMobile) {
      const box = await control.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
    expect(errors).toEqual([]);
    expect(broken).toEqual([]);
  });
}

test("theme override survives navigation and reload; System resumes live OS updates", async ({
  page,
}) => {
  await page.goto("/");
  await (await themeButton(page, "Dark")).click();
  await expect(
    page.getByLabel("Theme settings", { exact: true }).first(),
  ).toContainText("Dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  for (const path of ["/docs/install/", "/blog/", "/different/"]) {
    await page.goto(path);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(await themeButton(page, "Dark")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  }
  await page.reload();
  await (await themeButton(page, "Light")).click();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await (await themeButton(page, "System")).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(
    await page.evaluate(() => localStorage.getItem("starlight-theme")),
  ).toBeNull();
});

test("keyboard theme controls and native installation copy button", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  const dark = await themeButton(page, "Dark");
  await dark.focus();
  await page.keyboard.press("Enter");
  await expect(dark).toHaveAttribute("aria-pressed", "true");
  expect(
    await page
      .getByLabel("Theme settings", { exact: true })
      .first()
      .evaluate((summary) => getComputedStyle(summary).outlineStyle),
  ).toBe("solid");
  const copy = page.getByRole("button", { name: "Copy installation command" });
  await copy.focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("curl -fsSL https://withlore.ai/install | bash");
});

test("mobile menu closes on Escape and after an in-page link", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "Marketing drawer is a mobile navigation control");
  await page.goto("/");
  const toggle = page.getByLabel("Toggle navigation menu", { exact: true });
  await toggle.click();
  await expect(page.locator(".nav-mobile")).toHaveAttribute("open", "");
  await page.keyboard.press("Escape");
  await expect(page.locator(".nav-mobile")).not.toHaveAttribute("open");
  await expect(toggle).toBeFocused();
  await toggle.click();
  await page
    .locator(".nav-mobile-panel")
    .getByRole("link", { name: "How it works", exact: true })
    .click();
  await expect(page.locator(".nav-mobile")).not.toHaveAttribute("open");
  await expect(page).toHaveURL(/#how$/);
});

test("disabled storage still permits an explicit in-memory theme", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new Error("storage disabled");
      },
    });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await (await themeButton(page, "Light")).click();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(errors).toEqual([]);
});

test("content and native navigation remain available without JavaScript", async ({
  browser,
  baseURL,
  viewport,
  colorScheme,
  isMobile,
  hasTouch,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport,
    colorScheme,
    isMobile,
    hasTouch,
  });
  const page = await context.newPage();
  await page.goto(`${baseURL}/`);
  await expect(page.locator("h1")).toBeVisible();
  await expect(page.locator(".hero-desc")).toBeVisible();
  await expect(page.locator(".theme-toggle")).toBeHidden();
  if (isMobile) {
    await page.getByLabel("Toggle navigation menu", { exact: true }).click();
    await expect(
      page
        .locator(".nav-mobile-panel")
        .getByRole("link", { name: "Docs", exact: true }),
    ).toBeVisible();
  }
  await context.close();
});

test("newsletter input retains a visible keyboard focus ring", async ({
  page,
}) => {
  await page.goto("/");
  const input = page.locator("#waitlist-email");
  await input.focus();
  expect(
    await input.evaluate((element) => getComputedStyle(element).outlineStyle),
  ).toBe("solid");
  expect(
    await input.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).outlineWidth),
    ),
  ).toBeGreaterThanOrEqual(2);
});

test("community destinations remain visible without decorative motion", async ({
  page,
}) => {
  await page.goto("/");
  const footer = page.getByRole("navigation", { name: "Community links" });
  await expect(
    footer.getByRole("link", { name: "GitHub", exact: true }),
  ).toBeVisible();
  await expect(
    footer.getByRole("link", { name: "Follow on X", exact: true }),
  ).toBeVisible();
  expect(await page.locator(".ticker, .hero-visual").count()).toBe(0);
});

test("HTML declares its charset within the first 1024 bytes", async ({
  request,
}) => {
  for (const path of ["/", "/different/", "/blog/", "/docs/install/"]) {
    const response = await request.get(path);
    const bytes = await response.body();
    expect(bytes.subarray(0, 1024).toString("utf8")).toMatch(
      /<meta charset="UTF-8"/i,
    );
  }
});

test("text and action colours keep readable contrast in either theme", async ({
  page,
}) => {
  await page.goto("/");
  const ratios = await page.evaluate(() => {
    const styles = getComputedStyle(document.documentElement);
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d")!;
    function luminance(token: string) {
      ctx.fillStyle = styles.getPropertyValue(token).trim();
      ctx.fillRect(0, 0, 1, 1);
      const rgba = ctx.getImageData(0, 0, 1, 1).data;
      const linear = Array.from(rgba)
        .slice(0, 3)
        .map((value) => {
          const channel = value / 255;
          return channel <= 0.04045
            ? channel / 12.92
            : ((channel + 0.055) / 1.055) ** 2.4;
        });
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    }
    return [
      ["--text", "--bg"],
      ["--muted", "--bg"],
      ["--accent", "--surface"],
      ["--accent-contrast", "--accent"],
    ].map(([fg, bg]) => {
      const a = luminance(fg);
      const b = luminance(bg);
      return {
        fg,
        bg,
        ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
      };
    });
  });
  for (const pair of ratios)
    expect(pair.ratio, `${pair.fg} on ${pair.bg}`).toBeGreaterThanOrEqual(4.5);
});
