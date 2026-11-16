import { expect, test, type Page } from "@playwright/test";

async function openInventory(page: Page) {
  const inventory = page.locator("details.journal-inventory");
  // commit navigation can return before this later part of the document is parsed.
  await inventory.locator("summary").first().click();
}

for (const chapter of ["conversation", "recall"]) {
  test(`clicking an already-selected card opens knowledge from ${chapter} in one history step`, async ({
    page,
  }) => {
    await page.goto(`/?chapter=${chapter}&entry=sqlite&task=sqlite#journal`);
    await openInventory(page);
    const card = page.getByRole("radio", {
      name: "Inspect SQLite gotcha",
      exact: true,
    });
    await expect(card).toBeChecked();
    await card.click();
    await expect(page.locator('[data-journal-entry="sqlite"]')).toBeVisible();
    await expect(
      page.getByRole("radio", { name: "Saved knowledge", exact: true }),
    ).toBeChecked();
    await page.goBack();
    await expect(
      page.locator(`[data-journal-choice="chapter"][value="${chapter}"]`),
    ).toBeChecked();
    await expect(card).toBeChecked();
  });
}

test("a phone tap on an inventory card brings its rule into view", async ({
  page,
  isMobile,
}) => {
  test.skip(
    !isMobile,
    "Focus transfer is for pointer selection in the stacked phone layout",
  );
  await page.goto("/");
  await openInventory(page);
  await page
    .getByRole("radio", { name: "Inspect SQLite gotcha", exact: true })
    .check();
  await expect(
    page.locator('[data-journal-chapter="knowledge"] h3'),
  ).toBeFocused();
  await expect(page.locator('[data-journal-entry="sqlite"]')).toBeInViewport();
});

test("keyboard card inspection retains the focused radio", async ({ page }) => {
  await page.goto("/");
  await openInventory(page);
  await page
    .getByRole("radio", { name: "Inspect webhook decision", exact: true })
    .focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("radio", { name: "Inspect settings pattern", exact: true }),
  ).toBeFocused();
  await expect(page.locator('[data-journal-entry="forms"]')).toBeVisible();
});

test("a knowledge card reveals its own rule and original source", async ({
  page,
}) => {
  await page.goto("/");
  await openInventory(page);
  const journal = page.getByRole("region", {
    name: "The quest journal",
    exact: true,
  });
  await journal
    .getByRole("radio", { name: "Inspect settings pattern", exact: true })
    .check();
  const entry = journal.locator('[data-journal-entry="forms"]');
  await expect(entry).toBeVisible();
  await expect(entry).toContainText("validation messages beside the field");
  await entry.getByText("Where it came from", { exact: true }).click();
  await expect(entry).toContainText("Session 09 · notification settings");
  await expect(entry).toContainText("follow the current settings form");
  await expect(journal.locator('[data-journal-entry="webhook"]')).toBeHidden();
});

test("a new task supplies the matching knowledge and keeps unrelated entries stored", async ({
  page,
}) => {
  await page.goto("/");
  await openInventory(page);
  const journal = page.locator(".quest-journal");
  await journal
    .getByRole("radio", { name: "Next session", exact: true })
    .check();
  await journal
    .getByRole("radio", { name: "Speed up an import", exact: true })
    .check();
  const result = journal.locator('[data-journal-result="sqlite"]');
  await expect(result).toBeVisible();
  await expect(result).toContainText("serialize writes");
  await expect(result).toContainText("Session 07");
  await expect(
    journal.locator('[data-journal-card="sqlite"] .journal-relevant'),
  ).toBeVisible();
  await expect(
    journal.locator('[data-journal-card="forms"] .journal-stored'),
  ).toBeVisible();
  await journal
    .getByRole("button", { name: "Inspect the supplied rule", exact: true })
    .click();
  await expect(journal.locator('[data-journal-entry="sqlite"]')).toBeVisible();
  await expect(
    journal.locator('[data-journal-chapter="knowledge"] h3'),
  ).toBeFocused();
});

test("journal URL state reloads and restores all choices atomically through history", async ({
  page,
}) => {
  await page.goto("/?campaign=journal#journal");
  await openInventory(page);
  const journal = page.locator(".quest-journal");
  await journal
    .getByRole("radio", { name: "Inspect settings pattern", exact: true })
    .check();
  await expect(page).toHaveURL(
    /campaign=journal.*chapter=knowledge.*entry=forms.*#journal$/,
  );
  await journal
    .getByRole("radio", { name: "Next session", exact: true })
    .check();
  await journal
    .getByRole("radio", { name: "Speed up an import", exact: true })
    .check();
  await page.reload();
  await expect(
    journal.locator('[data-journal-choice="chapter"][value="recall"]'),
  ).toBeChecked();
  await expect(
    journal.locator('[data-journal-choice="entry"][value="sqlite"]'),
  ).toBeChecked();
  await expect(
    journal.locator('[data-journal-choice="task"][value="sqlite"]'),
  ).toBeChecked();
  await page.goBack();
  await expect(
    journal.locator('[data-journal-choice="chapter"][value="recall"]'),
  ).toBeChecked();
  await expect(
    journal.locator('[data-journal-choice="task"][value="webhook"]'),
  ).toBeChecked();
  await page.goBack();
  await expect(
    journal.locator('[data-journal-choice="chapter"][value="knowledge"]'),
  ).toBeChecked();
  await expect(
    journal.locator('[data-journal-choice="entry"][value="forms"]'),
  ).toBeChecked();
  await page.goForward();
  await expect(
    journal.locator('[data-journal-result="webhook"]'),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.get("campaign")).toBe("journal");
});

test("malformed journal choices cannot become a rule, source or selector", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(
    "/?chapter=%22%5D%3Cscript%3E&entry=__proto__&task=constructor",
  );
  await openInventory(page);
  await expect(
    page.locator('[data-journal-chapter="conversation"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-journal-choice="chapter"][value="conversation"]'),
  ).toBeChecked();
  await expect(
    page.locator('[data-journal-choice="task"][value="webhook"]'),
  ).toBeChecked();
  expect(errors).toEqual([]);
});

test("an early native choice survives delayed journal enhancement", async ({
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
    await page.goto("/", { waitUntil: "commit" });
    await openInventory(page);
    await page
      .getByRole("radio", { name: "Conversation", exact: true })
      .check();
    await page
      .getByRole("radio", { name: "Inspect SQLite gotcha", exact: true })
      .check();
  } finally {
    release();
  }
  await page.waitForLoadState("load");
  await expect(
    page.getByRole("radio", { name: "Conversation", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("radio", { name: "Inspect SQLite gotcha", exact: true }),
  ).toBeChecked();
  await page
    .getByRole("radio", { name: "Saved knowledge", exact: true })
    .check();
  await expect(page.locator('[data-journal-entry="sqlite"]')).toBeVisible();
});

test("explicit journal URL state takes precedence over an early native selection", async ({
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
    await page.goto("/?chapter=knowledge&entry=forms&task=sqlite", {
      waitUntil: "commit",
    });
    await openInventory(page);
    await page
      .getByRole("radio", { name: "Next session", exact: true })
      .check();
  } finally {
    release();
  }
  await page.waitForLoadState("load");
  await expect(page.locator('[data-journal-entry="forms"]')).toBeVisible();
  await expect(
    page.locator('[data-journal-choice="task"][value="sqlite"]'),
  ).toBeChecked();
});

test("keyboard chapter navigation retains focus and reduced motion stays still", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await openInventory(page);
  const chapter = page.getByRole("radio", {
    name: "Saved knowledge",
    exact: true,
  });
  await chapter.focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("radio", { name: "Next session", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("radio", { name: "Add a settings field", exact: true })
    .check();
  await expect(page.locator('[data-journal-result="forms"]')).toBeVisible();
  expect(
    await page
      .locator(".quest-journal")
      .evaluate((root) => root.getAnimations({ subtree: true }).length),
  ).toBe(0);
});

test("native journal chapters, cards, sources and tasks remain useful without JavaScript", async ({
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
  try {
    await page.goto(`${baseURL}/`);
    await openInventory(page);
    await page
      .getByRole("radio", { name: "Conversation", exact: true })
      .check();
    await expect(
      page.locator('[data-journal-chapter="conversation"]'),
    ).toBeVisible();
    await page
      .getByRole("radio", { name: "Saved knowledge", exact: true })
      .check();
    await page
      .getByRole("radio", { name: "Inspect SQLite gotcha", exact: true })
      .check();
    const entry = page.locator('[data-journal-entry="sqlite"]');
    await expect(entry).toBeVisible();
    await entry.getByText("Where it came from", { exact: true }).click();
    await expect(entry).toContainText("Session 07 · data import");
    await page
      .getByRole("radio", { name: "Next session", exact: true })
      .check();
    await page
      .getByRole("radio", { name: "Add a settings field", exact: true })
      .check();
    await expect(page.locator('[data-journal-result="forms"]')).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Inspect the supplied rule",
        exact: true,
      }),
    ).toBeHidden();
  } finally {
    await context.close();
  }
});

for (const path of [
  "/",
  "/tour/",
  "/docs/install/",
  "/docs/memory/",
  "/different/",
  "/blog/",
  "/blog/the-agentic-memory-trap/",
]) {
  test(`shared design stays contained and intentional artwork loads: ${path}`, async ({
    page,
  }) => {
    const failed: string[] = [];
    page.on("response", (r) => {
      if (r.url().includes("/journal-art/") && r.status() >= 400)
        failed.push(r.url());
    });
    await page.goto(path);
    if (path === "/") await openInventory(page);
    const art = page.locator("img.journal-art:visible");
    if (["/tour/", "/docs/install/"].includes(path))
      await expect(art).toHaveCount(0);
    else expect(await art.count()).toBeGreaterThan(0);
    for (const image of await art.all()) {
      await image.scrollIntoViewIfNeeded();
      await expect
        .poll(() =>
          image.evaluate(
            (i: HTMLImageElement) => i.complete && i.naturalWidth > 0,
          ),
        )
        .toBe(true);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
    expect(failed).toEqual([]);
  });
}

test("reduced-motion inventory cards stay in place on hover", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Hover feedback applies to a fine pointer");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await openInventory(page);
  const card = page.locator('[data-journal-card="webhook"]');
  await card.scrollIntoViewIfNeeded();
  const before = await card.boundingBox();
  await card.hover();
  const after = await card.boundingBox();
  expect(before).not.toBeNull();
  expect(after).not.toBeNull();
  expect(after!.y).toBeCloseTo(before!.y, 1);
  expect(after!.x).toBeCloseTo(before!.x, 1);
});
