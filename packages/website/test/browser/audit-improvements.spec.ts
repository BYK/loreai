import { expect, test } from "@playwright/test";

test("each primary navigation identifies one current section", async ({
  page,
}) => {
  await page.goto("/docs/install/");
  for (const nav of await page.locator(".primary-nav").all()) {
    await expect(nav.locator("a[aria-current]")).toHaveCount(1);
    await expect(
      nav.getByRole("link", { name: "Docs", exact: true, includeHidden: true }),
    ).toHaveAttribute("aria-current", "true");
  }
});

test("agent selection survives reload and browser history without losing URL context", async ({
  page,
}) => {
  await page.goto(
    "/docs/install/?agent=codex&from=audit#operational-telemetry",
  );
  const setup = page.locator(".agent-setup");
  await setup.getByRole("radio", { name: "Pi", exact: true }).check();
  await expect(page).toHaveURL(/agent=pi&from=audit#operational-telemetry$/);
  await page.reload();
  await expect(setup.locator('input[value="pi"]')).toBeChecked();
  await setup.getByRole("radio", { name: "Hermes", exact: true }).check();
  await page.goBack();
  await expect(setup.locator('input[value="pi"]')).toBeChecked();
  await page.goForward();
  await expect(setup.locator('input[value="hermes"]')).toBeChecked();
});

test("Knowledge preview opens the matching tour and tour choices survive history", async ({
  page,
}) => {
  await page.goto("/#product");
  await page.locator(".spotlight-image .tour-image-link:visible").click();
  await expect(page).toHaveURL(/tour\/\?view=knowledge#product$/);
  const tour = page.locator(".product-tour");
  await expect(tour.locator('[data-tour-panel="knowledge"]')).toBeVisible();
  await tour
    .getByRole("radio", { name: "Inspect activity", exact: true })
    .check();
  await expect(page).toHaveURL(/view=usage/);
  await page.reload();
  await expect(tour.locator('[data-tour-panel="usage"]')).toBeVisible();
  await page.goBack();
  await expect(tour.locator('[data-tour-panel="knowledge"]')).toBeVisible();
  await page.goForward();
  await expect(tour.locator('[data-tour-panel="usage"]')).toBeVisible();
  await page.goto("/tour/?view=%22%5D%3Cscript%3E");
  await expect(tour.locator('input[value="sessions"]')).toBeChecked();
});

test("the selected theme ring has non-text contrast against its surrounding pill", async ({
  page,
}) => {
  await page.goto("/");
  const ratio = await page
    .locator('.theme-toggle [aria-pressed="true"]')
    .evaluate((button) => {
      const canvas = new OffscreenCanvas(1, 1),
        ctx = canvas.getContext("2d")!;
      function luminance(color: string) {
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        const linear = Array.from(ctx.getImageData(0, 0, 1, 1).data)
          .slice(0, 3)
          .map((v) => {
            const c = v / 255;
            return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          });
        return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
      }
      const border = luminance(getComputedStyle(button).borderTopColor),
        bg = luminance(getComputedStyle(button.parentElement!).backgroundColor);
      return (Math.max(border, bg) + 0.05) / (Math.min(border, bg) + 0.05);
    });
  expect(ratio).toBeGreaterThanOrEqual(3);
});

test("long articles offer native collapsible section navigation", async ({
  page,
}) => {
  await page.goto("/blog/the-agentic-memory-trap/");
  const outline = page.locator(".article-outline");
  await expect(outline).not.toHaveAttribute("open");
  await outline.locator("summary").focus();
  await page.keyboard.press("Enter");
  const link = outline.getByRole("link").first(),
    href = await link.getAttribute("href");
  expect(href).toMatch(/^#/);
  await link.click();
  await expect(page.locator(`[id="${href!.slice(1)}"]`)).toBeInViewport();
});

test("signup keeps the address visible and retries in one action after an error", async ({
  page,
}) => {
  let requests = 0;
  await page.route("https://app.loops.so/api/newsletter-form/*", (route) =>
    route.fulfill({ status: ++requests === 1 ? 503 : 200, json: {} }),
  );
  await page.goto("/different/#waitlist");
  const email = page.getByRole("textbox", { name: "Email address" });
  await email.fill("reader@example.com");
  await page.locator("#waitlist-btn").click();
  await expect(page.locator("#waitlist-error")).toBeFocused();
  await expect(email).toBeVisible();
  await expect(email).toHaveValue("reader@example.com");
  await expect(email).toHaveAttribute("aria-describedby", "waitlist-error-msg");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.locator("#waitlist-success")).toBeFocused();
  expect(requests).toBe(2);
});

test("loading enhancements preserves an early native choice without an explicit URL choice", async ({
  page,
}) => {
  for (const [path, selector, name, choice, parameter] of [
    [
      "/docs/install/",
      ".agent-setup",
      "Codex Desktop",
      "codex-desktop",
      "agent",
    ],
    ["/tour/", ".product-tour", "Review knowledge", "knowledge", "view"],
  ]) {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/_astro/*.js", async (route) => {
      await gate;
      await route.continue();
    });
    try {
      await page.goto(path, { waitUntil: "commit" });
      await page
        .locator(selector)
        .getByRole("radio", { name, exact: true })
        .check();
    } finally {
      release?.();
    }
    await page.waitForLoadState("load");
    await expect(
      page.locator(`${selector} input[value="${choice}"]`),
    ).toBeChecked();
    expect(new URL(page.url()).searchParams.get(parameter)).toBe(choice);
    await page.unroute("**/_astro/*.js");
  }
});
