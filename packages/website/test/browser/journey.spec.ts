import { expect, test } from "@playwright/test";

const command = "curl -fsSL https://withlore.ai/install | bash";

test("mobile introduction reaches a useful first action before decoration", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("h1")).toContainText("Keep project decisions");
  const install = page
    .locator(".home-hero")
    .getByRole("link", { name: "Install Lore", exact: true });
  await expect(install).toHaveAttribute("href", "/docs/install/");
  const box = await install.boundingBox();
  expect((box?.y ?? Infinity) + (box?.height ?? 0)).toBeLessThan(
    page.viewportSize()?.height ?? 0,
  );
  await expect(page.locator(".memory-example")).toContainText(
    "Illustrative example",
  );
  await expect(page.locator(".memory-example")).toContainText(".lore.md");
  expect(await page.locator(".ticker, .hero-visual, .sr").count()).toBe(0);
});

test("benchmark evidence names the task, denominator and limitations", async ({
  page,
}) => {
  await page.goto("/#evidence");
  const evidence = page.locator("#evidence");
  await expect(evidence.getByRole("link")).toHaveAttribute("href", /benchmark/);
  await expect(page.locator("#features")).toContainText("Available now");
  await expect(page.locator("#waitlist")).toContainText("Early access");
  await evidence.getByRole("link").click();
  const benchmark = page.locator("main");
  await expect(benchmark).toContainText("Twenty authored questions");
  await expect(benchmark).toContainText("13/20");
  await expect(benchmark).toContainText("5/20");
  await expect(benchmark).toContainText(/single session/i);
});

test("clipboard denial keeps the command readable and explains manual copying", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("denied")) },
    }),
  );
  await page.goto("/docs/install/");
  await page.getByRole("button", { name: "Copy installation command" }).click();
  await expect(page.locator(".copy-status")).toContainText(/select and copy/i);
  await expect(page.locator(".install-command")).toContainText(command);
  await expect(page.locator(".copy-status")).not.toContainText("Copied");
});

test("release lookup failure does not invent a version", async ({ page }) => {
  await page.route(
    "https://api.github.com/repos/BYK/loreai/releases/latest",
    (route) => route.fulfill({ status: 503, body: "unavailable" }),
  );
  await page.goto("/");
  await expect(page.locator(".release-link")).toHaveText("Releases");
  await expect(page.locator("body")).not.toContainText("v0.13.4");
});

test("release lookup normalizes the tag and rejects malformed data", async ({
  page,
}) => {
  await page.route(
    "https://api.github.com/repos/BYK/loreai/releases/latest",
    (route) => route.fulfill({ json: { tag_name: "v0.34.0" } }),
  );
  await page.goto("/");
  await expect(page.locator(".release-link")).toHaveText("Latest: v0.34.0");
  await page.route(
    "https://api.github.com/repos/BYK/loreai/releases/latest",
    (route) => route.fulfill({ json: { tag_name: "<img src=x>" } }),
  );
  await page.reload();
  await expect(page.locator(".release-link")).toHaveText("Releases");
});

test("signup preserves the email on error and provides a bounded success receipt", async ({
  page,
}) => {
  let requests = 0;
  await page.route(
    "https://app.loops.so/api/newsletter-form/*",
    async (route) => {
      requests++;
      await route.fulfill({ status: requests === 1 ? 503 : 200, json: {} });
    },
  );
  await page.goto("/different/#waitlist");
  const email = page.getByRole("textbox", { name: "Email address" });
  await email.fill("reader@example.com");
  await page.getByRole("button", { name: "Join early access list" }).click();
  await expect(page.locator("#waitlist-error")).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(email).toHaveValue("reader@example.com");
  await expect(email).toBeFocused();
  await page.getByRole("button", { name: "Join early access list" }).click();
  await expect(page.locator("#waitlist-success")).toBeVisible();
  await expect(page.locator("#waitlist-success")).toContainText(
    "does not create an account",
  );
  await expect(page.locator("#waitlist-success")).toBeFocused();
  expect(requests).toBe(2);
});

test("installation guides lead through connection and verification before reference details", async ({
  page,
}) => {
  await page.goto("/docs/install/");
  await expect(
    page.getByRole("heading", { name: "1. Choose your agent", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "4. Verify the connection",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("link", { name: /installer and uninstall reference/i })
      .first(),
  ).toHaveAttribute("href", /installation-reference/);
  const headings = await page.locator("main h2").allTextContents();
  expect(
    headings.findIndex((text) => text.includes("Verify the connection")),
  ).toBeLessThan(headings.findIndex((text) => text.includes("Reference")));
  await expect(
    page
      .locator('[data-setup-panel="codex"] a')
      .filter({ hasText: "Codex CLI guide" }),
  ).toHaveAttribute("href", /with-codex/);
});

test("shared navigation identifies the current section and blog metadata is not a fake filter", async ({
  page,
}) => {
  await page.goto("/blog/");
  const toggle = page.getByLabel("Toggle navigation menu", { exact: true });
  if (await toggle.isVisible()) await toggle.click();
  const active = page
    .getByRole("navigation", { name: "Primary navigation" })
    .getByRole("link", { name: "Blog", exact: true });
  await expect(active).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".blog-card")).toHaveCount(0);
  await expect(page.locator(".post-row").first()).toBeVisible();
  await expect(page.locator("h1")).toHaveText("Blog");
  expect(await page.locator(".post-tags button, .post-tags a").count()).toBe(0);
});

test("short portrait and landscape screens keep both compact menus usable", async ({
  page,
}) => {
  for (const viewport of [
    { width: 320, height: 480 },
    { width: 568, height: 320 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    const summary = page.getByLabel("Theme settings", { exact: true });
    await summary.click();
    const options = page.locator(".theme-options");
    const box = await options.boundingBox();
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.y ?? Infinity) + (box?.height ?? 0)).toBeLessThanOrEqual(
      viewport.height,
    );
    await page.keyboard.press("Escape");
    await expect(summary).toBeFocused();
    await page.getByLabel("Toggle navigation menu", { exact: true }).click();
    const panel = page.locator(".nav-mobile-panel");
    const panelBox = await panel.boundingBox();
    expect(panelBox?.x).toBeGreaterThanOrEqual(0);
    expect(
      (panelBox?.y ?? Infinity) + (panelBox?.height ?? 0),
    ).toBeLessThanOrEqual(viewport.height);
  }
});

test("pending signup is submitted once and its timeout offers recovery", async ({
  page,
}) => {
  await page.clock.install();
  let requests = 0;
  await page.route("https://app.loops.so/api/newsletter-form/*", async () => {
    requests++;
  });
  await page.goto("/different/#waitlist");
  await page
    .getByRole("textbox", { name: "Email address" })
    .fill("reader@example.com");
  const submit = page.getByRole("button", { name: "Join early access list" });
  await submit.click();
  await expect(page.locator("#waitlist-btn")).toBeDisabled();
  await expect.poll(() => requests).toBe(1);
  await page
    .locator("#waitlist-form")
    .evaluate((form: HTMLFormElement) => form.requestSubmit());
  expect(requests).toBe(1);
  await page.clock.fastForward(16_000);
  await expect(page.locator("#waitlist-error")).toContainText("timed out");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(submit).toBeEnabled();
  await expect(
    page.getByRole("textbox", { name: "Email address" }),
  ).toHaveValue("reader@example.com");
  expect(requests).toBe(1);
});

test("blog masthead stays compact enough to lead with the articles", async ({
  page,
}) => {
  await page.goto("/blog/");
  const size = await page
    .locator(".blog-hero h1")
    .evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).fontSize),
    );
  const padding = await page
    .locator(".blog-hero")
    .evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).paddingBottom),
    );
  expect(size).toBeLessThanOrEqual(48);
  expect(padding).toBeLessThanOrEqual(32);
});

test("an article with a comparison table stays within a narrow reading column", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/blog/why-memory-is-not-enough/");
  await expect(page.locator(".blog-prose table")).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
});

test("legacy public fragments and the separated installer reference remain reachable", async ({
  page,
}) => {
  for (const [path, ids] of [
    [
      "/",
      [
        "local-first",
        "problem",
        "how",
        "unified",
        "features",
        "voices",
        "waitlist",
      ],
    ],
    [
      "/different/",
      [
        "pillars",
        "landscape",
        "depth",
        "context-engine",
        "cost",
        "portability",
        "team",
        "waitlist",
      ],
    ],
    [
      "/docs/install/",
      [
        "operational-telemetry",
        "what-the-installer-writes",
        "uninstall",
        "slimmer-installs-remote-embeddings",
        "existing-conversations",
      ],
    ],
  ] as const) {
    await page.goto(path);
    for (const id of ids)
      await expect(page.locator(`[id="${id}"]`).first()).toBeAttached();
  }
  await page.goto("/docs/installation-reference/#uninstall");
  await expect(page.locator("main")).toContainText("lore uninstall --purge");
  await expect(page.locator("main")).toContainText("lore uninstall --dry-run");
});
