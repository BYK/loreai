import { expect, test } from "@playwright/test";

test("hero highlights only retained knowledge and points to the full journal", async ({
  page,
}) => {
  await page.goto("/?format=markdown&from=preview#problem");
  const preview = page.getByRole("complementary", {
    name: "Example: from conversation to project knowledge",
    exact: true,
  });
  await expect(
    preview.getByRole("heading", { name: "What you said", exact: true }),
  ).toBeVisible();
  await expect(
    preview.getByRole("heading", {
      name: "What your next session remembers",
      exact: true,
    }),
  ).toBeVisible();
  const kept = (await preview.locator("blockquote mark").allTextContents()).map(
    (t) => t.trim().toLowerCase(),
  );
  const remembered = (
    await preview.locator(".preview-kept li").allTextContents()
  ).map((t) => t.trim().replace(/\.$/, "").toLowerCase());
  expect(kept).toHaveLength(2);
  expect(remembered).toEqual(kept);
  await expect(preview.locator("blockquote")).toContainText("port 4330");
  await expect(preview.locator(".preview-kept")).not.toContainText("4330");
  await expect(preview.getByRole("radio")).toHaveCount(0);
  await expect(preview).not.toContainText(".lore.md");
  await preview
    .getByRole("link", { name: "Follow the full example", exact: true })
    .click();
  await expect(page).toHaveURL(/format=markdown&from=preview#journal$/);
});

test("tour inspection explains sample source and revisions without leaving the page", async ({
  page,
}) => {
  await page.goto("/tour/?view=knowledge&from=guide#product");
  const inspector = page.locator(".tour-inspector");
  await expect(inspector.locator('[data-inspect-panel="rule"]')).toContainText(
    "Keep handlers idempotent",
  );
  await inspector.getByRole("radio", { name: "Source", exact: true }).check();
  await expect(
    inspector.locator('[data-inspect-panel="source"]'),
  ).toContainText("exact-message");
  await inspector.getByRole("radio", { name: "History", exact: true }).check();
  await expect(
    inspector.locator('[data-inspect-panel="history"]'),
  ).toContainText("Illustrative revision");
  await expect(page).toHaveURL(
    /view=knowledge&from=guide&inspect=history#product$/,
  );
  await page.reload();
  await expect(
    inspector.locator('[data-inspect-panel="history"]'),
  ).toBeVisible();
  await page.goBack();
  await expect(
    inspector.locator('[data-inspect-panel="source"]'),
  ).toBeVisible();
});

test("setup confirmation is explicit and belongs to the selected client", async ({
  page,
}) => {
  await page.goto("/docs/install/?agent=codex");
  const setup = page.locator(".agent-setup");
  const confirmed = setup
    .locator('[data-setup-panel="codex"]')
    .getByRole("checkbox");
  await expect(confirmed).not.toBeChecked();
  await confirmed.check();
  await expect(
    setup.locator('[data-setup-panel="codex"] .setup-confirmed'),
  ).toBeVisible();
  await setup.getByRole("radio", { name: "Pi", exact: true }).check();
  await expect(
    setup.locator('[data-setup-panel="pi"]').getByRole("checkbox"),
  ).not.toBeChecked();
  await expect(
    setup.locator('[data-setup-panel="pi"] .setup-confirmed'),
  ).toBeHidden();
  await expect(setup).toContainText("does not inspect your local gateway");
});

test("docs tasks and diagnostics point to observable next steps", async ({
  page,
}) => {
  await page.goto("/docs/");
  const tasks = page.locator(".docs-tasks");
  for (const [name, href] of [
    ["Connect an agent", "/docs/install/"],
    ["Find earlier work", "/docs/using-lore/#find-an-earlier-decision"],
    ["Review knowledge", "/docs/using-lore/#review-knowledge"],
    ["Share through Git", "/docs/team-memory/"],
  ])
    await expect(
      tasks.getByRole("link", { name: new RegExp(name) }),
    ).toHaveAttribute("href", href);
  await page.goto("/docs/troubleshooting/?issue=knowledge#diagnostic");
  const guide = page.locator(".diagnostic-guide");
  await expect(guide.locator('[data-issue-panel="knowledge"]')).toContainText(
    "Sessions",
  );
  await guide
    .getByRole("radio", { name: "Gateway unavailable", exact: true })
    .check();
  await expect(guide.locator('[data-issue-panel="gateway"]')).toContainText(
    "printed Dashboard URL",
  );
  await page.goBack();
  await expect(guide.locator('[data-issue-panel="knowledge"]')).toBeVisible();
});

test("fit choices explain an approach while retaining the complete comparison", async ({
  page,
}) => {
  await page.goto("/different/?from=guide#landscape");
  const guide = page.locator(".fit-guide");
  await guide
    .getByRole("radio", { name: "Build an application", exact: true })
    .check();
  await expect(page).toHaveURL(/from=guide&fit=application#landscape$/);
  await expect(guide.locator('[data-fit-panel="application"]')).toBeVisible();
  await expect(page.locator(".fit-table tbody tr")).toHaveCount(4);
  const selected = await page
    .locator('.fit-table tr[data-fit-row="application"]')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  const other = await page
    .locator('.fit-table tr[data-fit-row="rules"]')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(selected).not.toBe(other);
  await page.reload();
  await expect(
    guide.getByRole("radio", { name: "Build an application", exact: true }),
  ).toBeChecked();
});

test("native field guide controls stay useful without JavaScript", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 320, height: 844 },
  });
  try {
    const page = await context.newPage();
    await page.goto(baseURL + "/");
    await expect(
      page.locator(".conversation-preview .preview-kept li"),
    ).toHaveCount(2);
    await expect(
      page.locator(".conversation-preview blockquote mark"),
    ).toHaveCount(2);
    await page.goto(baseURL + "/tour/");
    await page.getByRole("radio", { name: "Knowledge", exact: true }).check();
    await page
      .locator(".tour-inspector")
      .getByRole("radio", { name: "Source", exact: true })
      .check();
    await expect(page.locator('[data-inspect-panel="source"]')).toBeVisible();
    await page.goto(baseURL + "/different/");
    await page
      .getByRole("radio", { name: "Build an application", exact: true })
      .check();
    await expect(page.locator('[data-fit-panel="application"]')).toBeVisible();
    await page.goto(baseURL + "/docs/troubleshooting/");
    await page
      .getByRole("radio", { name: "No knowledge yet", exact: true })
      .check();
    await expect(page.locator('[data-issue-panel="knowledge"]')).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
  } finally {
    await context.close();
  }
});

test("field-note diagrams and next steps stay tied to their article", async ({
  page,
}) => {
  await page.goto("/blog/");
  await expect(
    page.locator(".featured-note img.journal-art:visible"),
  ).toHaveCount(1);
  await page.goto("/blog/how-lore-remembers-and-forgets/");
  await expect(page.locator(".article-diagram")).toContainText(
    "Stored history",
  );
  await expect(page.locator(".article-next")).toContainText(
    "Put this into practice",
  );
  await expect(page.locator(".article-next a").first()).toHaveAttribute(
    "href",
    "/docs/using-lore/#review-knowledge",
  );
});

for (const [path, selector, parameter, choice, label] of [
  [
    "/tour/?view=knowledge",
    ".inspection-picker",
    "inspect",
    "source",
    "Source",
  ],
  ["/different/", ".fit-guide", "fit", "rules", "Keep a few stable rules"],
  [
    "/docs/troubleshooting/",
    ".diagnostic-guide",
    "issue",
    "knowledge",
    "No knowledge yet",
  ],
]) {
  test(`native ${parameter} choice survives delayed enhancement and invalid URLs`, async ({
    page,
  }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/_astro/*.js", async (route) => {
      await gate;
      await route.continue();
    });
    try {
      await page.goto(path, { waitUntil: "commit" });
      // The inspector is nested in a separately enhanced tour choice.
      if (parameter === "inspect")
        await page
          .locator(".tour-picker")
          .getByRole("radio", { name: "Knowledge", exact: true })
          .check();
      await page
        .locator(selector)
        .getByRole("radio", { name: label, exact: true })
        .check();
    } finally {
      release();
    }
    await page.waitForLoadState("load");
    await expect(
      page.locator(selector).getByRole("radio", { name: label, exact: true }),
    ).toBeChecked();
    expect(new URL(page.url()).searchParams.get(parameter)).toBe(choice);
    await page.unroute("**/_astro/*.js");
    const url = new URL(path, "http://localhost");
    url.searchParams.set(parameter, "]<script>");
    await page.goto(url.pathname + url.search);
    await expect(page.locator(selector).locator("input").first()).toBeChecked();
  });
}

test("new page controls and panels remain contained at compact and phone widths", async ({
  page,
}) => {
  for (const width of [320, 390, 768, 1024]) {
    await page.setViewportSize({ width, height: 844 });
    for (const path of [
      "/?format=markdown",
      "/tour/?view=knowledge&inspect=source#product",
      "/docs/",
      "/docs/install/?agent=codex-desktop",
      "/docs/troubleshooting/?issue=gateway#diagnostic",
      "/different/?fit=framework#landscape",
      "/blog/",
      "/blog/how-lore-remembers-and-forgets/",
    ]) {
      await page.goto(path);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        `${width} ${path}`,
      ).toBe(true);
      const targets = page.locator(
        ".guide-segments label, .setup-observation label, .setup-picker label",
      );
      for (const target of await targets.all())
        if (await target.isVisible()) {
          const box = await target.boundingBox();
          expect(box!.height).toBeGreaterThanOrEqual(44);
          await expect(target).toHaveCSS("margin-top", "0px");
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        }
    }
  }
});

test("inspection points stay inside the screenshot when a longer note is selected", async ({
  page,
}) => {
  for (const width of [1001, 1040, 1100, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/tour/?view=knowledge&inspect=source#product");
    for (const name of ["Source", "History"]) {
      await page
        .locator(".tour-inspector")
        .getByRole("radio", { name, exact: true })
        .check();
      const image = await page
        .locator(".inspection-capture img:visible")
        .boundingBox();
      for (const point of await page.locator(".inspection-point").all()) {
        const box = await point.boundingBox();
        expect(box!.y + box!.height, `${width} ${name}`).toBeLessThanOrEqual(
          image!.y + image!.height + 1,
        );
        expect(box!.x).toBeGreaterThanOrEqual(image!.x);
        expect(box!.x + box!.width).toBeLessThanOrEqual(
          image!.x + image!.width + 1,
        );
      }
    }
  }
});

test("field guide selection borders have non-text contrast", async ({
  page,
}) => {
  for (const [path, selector] of [
    ["/", ".product-spotlight"],
    ["/tour/?view=knowledge", ".tour-inspector"],
    ["/different/", ".fit-guide"],
    ["/docs/troubleshooting/", ".diagnostic-guide"],
  ]) {
    await page.goto(path);
    const ratio = await page
      .locator(selector + " .guide-segments label:has(input:checked)")
      .evaluate((label) => {
        const ctx = new OffscreenCanvas(1, 1).getContext("2d")!;
        const luminance = (color: string) => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = color;
          ctx.fillRect(0, 0, 1, 1);
          return Array.from(ctx.getImageData(0, 0, 1, 1).data)
            .slice(0, 3)
            .map((v) => {
              const n = v / 255;
              return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
            })
            .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
        };
        const style = getComputedStyle(label),
          a = luminance(style.borderTopColor),
          b = luminance(style.backgroundColor);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      });
    expect(ratio, path).toBeGreaterThanOrEqual(3);
  }
});
