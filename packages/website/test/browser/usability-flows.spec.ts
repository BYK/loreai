import { expect, test } from "@playwright/test";

test("320px journal task changes reveal the selected rule without moving keyboard focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/?chapter=recall#journal");
  const choice = page.getByRole("radio", {
    name: "Speed up an import",
    exact: true,
  });
  await choice.check();
  const heading = page.locator('[data-journal-result="sqlite"] h4');
  const bounds = await heading.boundingBox();
  const header = await page
    .locator(".field-guide-header")
    .first()
    .boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(header!.y + header!.height);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
  const picker = page.locator(".journal-tasks");
  expect(
    await picker.evaluate((el) =>
      Boolean(
        el.compareDocumentPosition(
          document.querySelector('[data-journal-result="sqlite"]')!,
        ) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ),
  ).toBe(true);
  await choice.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(
    page.getByRole("radio", { name: "Add a settings field", exact: true }),
  ).toBeFocused();
});

test("phone comparison keeps its selected approach first and alternatives native", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/different/?fit=application#landscape");
  await expect(
    page.locator('[data-selected-approach="application"]'),
  ).toBeVisible();
  const alternatives = page.locator(".fit-alternatives");
  await expect(alternatives).not.toHaveAttribute("open");
  await alternatives.locator("summary").click();
  await expect(
    alternatives.locator('[data-alternative-approach="rules"]'),
  ).toBeVisible();
  await expect(
    alternatives.locator('[data-alternative-approach="application"]'),
  ).toBeHidden();
});

test("404 keeps appearance inside its phone menu and shared public footer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/404.html");
  const toggle = page.getByLabel("Toggle navigation menu", { exact: true });
  await expect(toggle).toBeVisible();
  await expect(page.locator(".header-utilities .theme-toggle")).toBeHidden();
  await toggle.click();
  await expect(
    page
      .locator(".nav-mobile-panel")
      .getByRole("button", { name: "Dark theme", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(toggle).toBeFocused();
  await expect(page.locator(".site-footer")).toBeVisible();
  await page
    .getByRole("button", { name: "Search documentation", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Search", exact: true }),
  ).toBeVisible();
});

test("phone comparison and task choices remain usable without JavaScript", async ({
  browser,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 320, height: 844 },
  });
  const page = await context.newPage();
  await page.goto("/different/");
  await page
    .getByRole("radio", { name: "Build an application", exact: true })
    .check();
  await expect(
    page.locator('[data-selected-approach="application"]'),
  ).toBeVisible();
  await page.locator(".fit-alternatives summary").click();
  await expect(
    page.locator('[data-alternative-approach="rules"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-alternative-approach="application"]'),
  ).toBeHidden();
  await page.goto("/");
  await page.getByRole("radio", { name: "Next session", exact: true }).check();
  await page
    .getByRole("radio", { name: "Speed up an import", exact: true })
    .check();
  await expect(page.locator('[data-journal-result="sqlite"]')).toBeVisible();
  await context.close();
});
