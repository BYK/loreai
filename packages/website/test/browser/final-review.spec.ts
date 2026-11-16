import { expect, test } from "@playwright/test";

test("diagram padding is inside the dialog; only a backdrop click dismisses it", async ({
  page,
}) => {
  await page.goto("/docs/architecture/");
  const expand = page
    .locator(".mermaid")
    .first()
    .getByRole("button", { name: "Expand diagram", exact: true });
  await expand.click();
  const dialog = page.getByRole("dialog", { name: "Expanded diagram" });
  await dialog.click({ position: { x: 4, y: 4 } });
  await expect(dialog).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(dialog).toBeHidden();
  await expect(expand).toBeFocused();
});

for (const route of ["with-opencode", "with-pi", "local-inference"]) {
  test(`${route} makes remote embeddings an explicit choice, not an automatic fallback`, async ({
    page,
  }) => {
    await page.goto(`/docs/guides/${route}/`);
    const main = page.locator("main");
    await expect(main).not.toContainText("transparently switches");
    await expect(main).toContainText("explicitly configure");
    await expect(main).toContainText("FTS");
  });
}

test("the Claude guide names its client and uses a local standalone gateway", async ({
  page,
}) => {
  await page.goto("/docs/guides/with-claude-code/");
  const main = page.locator("main");
  await expect(
    main.locator("pre code").filter({ hasText: /^lore run claude$/ }),
  ).toBeVisible();
  await expect(main).toContainText("lore start --local");
  await expect(main).toContainText("Gateway listening on");
});
