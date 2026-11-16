import { expect, test } from "@playwright/test";

async function expectIconButton(button: import("@playwright/test").Locator) {
  await expect(button.locator('svg[aria-hidden="true"]')).toHaveCount(1);
  expect((await button.innerText()).trim()).toBe("");
  const box = await button.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
}

test("diagram utility icons retain names, touch targets, dismissal and return focus", async ({
  page,
}) => {
  await page.goto("/docs/architecture/");
  const expand = page
    .locator(".mermaid")
    .first()
    .getByRole("button", { name: "Expand diagram", exact: true });
  await expectIconButton(expand);
  await expect(
    page
      .locator(".expressive-code .frame")
      .filter({ has: page.locator(".mermaid") }),
  ).toHaveCount(0);
  await expect(
    page.locator('.expressive-code > link[rel="stylesheet"]'),
  ).toHaveCount(1);
  await expand.focus();
  await expand.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Expanded diagram" });
  const close = dialog.getByRole("button", {
    name: "Close diagram",
    exact: true,
  });
  await expectIconButton(close);
  await expect(close).toBeFocused();
  await close.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(expand).toBeFocused();
  await expand.click();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(expand).toBeFocused();
});

for (const route of ["configuration", "environment"]) {
  test(`the ${route} search clear icon stays inside its field and preserves URL context`, async ({
    page,
  }) => {
    await page.goto(
      `/docs/${route}/?from=icons&setting=knowledge#field-reference`,
    );
    const finder = page.locator(".reference-finder");
    const input = finder.getByRole("searchbox", {
      name: "Find a setting",
      exact: true,
    });
    const clear = finder.getByRole("button", {
      name: "Clear search",
      exact: true,
    });
    await expectIconButton(clear);
    const a = await input.boundingBox(),
      b = await clear.boundingBox();
    expect(b!.x).toBeGreaterThanOrEqual(a!.x);
    expect(b!.x + b!.width).toBeLessThanOrEqual(a!.x + a!.width + 1);
    await clear.click();
    await expect(input).toHaveValue("");
    await expect(input).toBeFocused();
    await expect(clear).toBeHidden();
    const url = new URL(page.url());
    expect(url.searchParams.get("from")).toBe("icons");
    expect(url.searchParams.has("setting")).toBe(false);
    expect(url.hash).toBe("#field-reference");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
  });
}

test("the native phone menu swaps its menu icon for a close icon without JavaScript", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 390, height: 844 },
  });
  try {
    const page = await context.newPage();
    await page.goto(baseURL + "/");
    const menu = page.getByLabel("Toggle navigation menu", { exact: true });
    await expect(menu.locator('[data-menu-icon="open"] svg')).toBeVisible();
    await expect(menu.locator('[data-menu-icon="close"] svg')).toBeHidden();
    await menu.click();
    await expect(menu.locator('[data-menu-icon="close"] svg')).toBeVisible();
    await expect(menu.locator('[data-menu-icon="open"] svg')).toBeHidden();
    await menu.click();
    await expect(page.locator(".nav-mobile-panel")).toBeHidden();
  } finally {
    await context.close();
  }
});
