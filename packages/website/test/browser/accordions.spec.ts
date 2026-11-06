import { expect, test } from "@playwright/test";

test("FAQ uses shared full-row triggers and a single native open group", async ({
  page,
}) => {
  await page.goto("/#questions");
  const items = page.locator('.faq [data-slot="accordion-item"]');
  await expect(items).toHaveCount(4);
  const triggers = items.locator(":scope > summary");
  for (const trigger of await triggers.all()) {
    await expect(
      trigger.locator('[data-slot="accordion-chevron"]'),
    ).toHaveCount(1);
    await expect(trigger).toHaveCSS("list-style-type", "none");
    expect((await trigger.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await triggers.nth(0).focus();
  await page.keyboard.press("Enter");
  await expect(items.nth(0)).toHaveAttribute("open", "");
  await expect(
    items.nth(0).getByRole("link", { name: "Choose your setup", exact: true }),
  ).toBeVisible();
  await expect(triggers.nth(0)).toBeFocused();
  await triggers.nth(1).click();
  await expect(items.nth(1)).toHaveAttribute("open", "");
  await expect(items.nth(0)).not.toHaveAttribute("open", "");
  await triggers.nth(1).press("Space");
  await expect(items.nth(1)).not.toHaveAttribute("open", "");
});

test("journal and article disclosures share the component without sharing open state", async ({
  page,
}) => {
  await page.goto("/?chapter=knowledge#journal");
  const entry = page.locator('[data-journal-entry="webhook"]');
  const file = entry
    .locator("details")
    .filter({ hasText: "Review the .lore.md excerpt" });
  const source = entry
    .locator("details")
    .filter({ hasText: "Where it came from" });
  await expect(file).toHaveAttribute("data-slot", "accordion-item");
  await file.locator("summary").click();
  await source.locator("summary").click();
  await expect(file).toHaveAttribute("open", "");
  await expect(source).toHaveAttribute("open", "");
  await expect(file.locator("pre")).toContainText("Keep handlers idempotent");
  await expect(source.locator("blockquote")).toBeVisible();
  const inventory = page.locator("details.journal-inventory");
  await expect(inventory).toHaveAttribute("data-slot", "accordion-item");
  await inventory.locator("summary").click();
  await expect(
    inventory.getByRole("radio", {
      name: "Inspect settings pattern",
      exact: true,
    }),
  ).toBeVisible();
  await expect(file).toHaveAttribute("open", "");
  await page.goto("/blog/how-lore-remembers-and-forgets/");
  const outline = page.locator("details.article-outline");
  await expect(outline).toHaveAttribute("data-slot", "accordion-item");
  await outline.locator("summary").click();
  await expect(
    outline.getByRole("navigation", { name: "Article sections" }),
  ).toBeVisible();
});

test("native accordion semantics remain useful without JavaScript on a phone", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 320, height: 844 },
    colorScheme: "dark",
    isMobile: true,
    hasTouch: true,
  });
  try {
    const page = await context.newPage();
    await page.goto(baseURL + "/#questions");
    const items = page.locator('.faq [data-slot="accordion-item"]');
    await items.nth(0).locator("summary").click();
    await expect(
      items.nth(0).locator('[data-slot="accordion-content"]'),
    ).toBeVisible();
    await items.nth(2).locator("summary").click();
    await expect(items.nth(0)).not.toHaveAttribute("open", "");
    await expect(
      items
        .nth(2)
        .getByRole("link", { name: "Follow the knowledge checklist" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
  } finally {
    await context.close();
  }
});

test("native input before deferred scripts load is preserved", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/_astro/*.js", async (route) => {
    await gate;
    await route.continue();
  });
  try {
    await page.goto("/#questions", { waitUntil: "commit" });
    const item = page.locator(".faq details").first();
    await item.locator("summary").click();
    await expect(item).toHaveAttribute("open", "");
    release();
    await page.waitForLoadState("load");
    await expect(item).toHaveAttribute("open", "");
    await item
      .getByRole("link", { name: "Choose your setup", exact: true })
      .click();
    await expect(page).toHaveURL(/\/docs\/install\/$/);
  } finally {
    release();
  }
});

test("pointer enhancement respects reduced motion and keyboard interruption", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/#questions");
  const item = page.locator(".faq details").first();
  const trigger = item.locator("summary");
  const chevron = trigger.locator("svg");
  await trigger.click();
  await expect(item).toHaveAttribute("open", "");
  await expect(chevron).toHaveCSS("transition-duration", "0.18s");
  // Keyboard use interrupts any pointer motion and changes native state immediately.
  await trigger.press("Space");
  await expect(item).not.toHaveAttribute("open", "");
  await expect(chevron).toHaveCSS("transition-duration", "0s");
  await trigger.press("Enter");
  await expect(item).toHaveAttribute("open", "");
  await expect(trigger).toHaveCSS("outline-style", "solid");
  const setupLink = item.getByRole("link", {
    name: "Choose your setup",
    exact: true,
  });
  await expect(setupLink).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(setupLink).toBeFocused();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await trigger.click();
  await expect(item).not.toHaveAttribute("open", "");
  await expect(chevron).toHaveCSS("transition-duration", "0s");
  await trigger.click();
  await expect(item).toHaveAttribute("open", "");
  // Expanded text and the trailing chevron stay in separate columns at 320px.
  const longTrigger = page.locator(".faq details").nth(2).locator("summary");
  const label = (await longTrigger
    .locator(".ui-accordion-label")
    .boundingBox())!;
  const icon = (await longTrigger.locator("svg").boundingBox())!;
  expect(label.x + label.width).toBeLessThanOrEqual(icon.x - 8);
});

test("docs navigation retains framework disclosure state and real destinations", async ({
  page,
  isMobile,
}) => {
  await page.goto("/docs/install/");
  if (isMobile)
    await page.getByRole("button", { name: "Menu", exact: true }).click();
  const group = page
    .locator(".sidebar-content details")
    .filter({ has: page.locator('a[aria-current="page"]') })
    .first();
  await expect(group).toHaveAttribute("open", "");
  const trigger = group.locator(":scope > summary");
  expect((await trigger.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await trigger.press("Enter");
  await expect(group).not.toHaveAttribute("open", "");
  await trigger.press("Space");
  await expect(group).toHaveAttribute("open", "");
  await group
    .getByRole("link", { name: "Your first session", exact: true })
    .click();
  await expect(page).toHaveURL(/\/docs\/first-session\/$/);
  if (isMobile) {
    const toc = page.locator("#starlight__mobile-toc");
    await toc.locator("summary").click();
    await expect(toc).toHaveAttribute("open", "");
    await toc.locator("a").nth(1).click();
    await expect(toc).not.toHaveAttribute("open", "");
    expect(new URL(page.url()).hash).not.toBe("");
  }
});

test("keyboard opening a grouped sibling immediately closes a pointer-open answer", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/#questions");
  const items = page.locator(".faq details");
  const oldItem = items.nth(0);
  await oldItem.locator("summary").click();
  await expect(oldItem.locator("svg")).toHaveCSS(
    "transition-duration",
    "0.18s",
  );
  await items.nth(1).locator("summary").press("Enter");
  await expect(items.nth(1)).toHaveAttribute("open", "");
  await expect(oldItem).not.toHaveAttribute("open", "");
  await expect(oldItem.locator("svg")).toHaveCSS("transition-duration", "0s");
  expect(
    await oldItem.evaluate(
      (el) => getComputedStyle(el, "::details-content").transitionDuration,
    ),
  ).toBe("0s");
});
