import { expect, test } from "@playwright/test";

test("proof selectors keep short words on one line at desktop widths", async ({
  page,
}) => {
  for (const width of [1024, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    for (const label of await page
      .locator(".spotlight-choices .ui-choice-label > span:last-child")
      .all()) {
      expect(
        await label.evaluate((el) => {
          const r = document.createRange();
          r.selectNodeContents(el);
          return r.getClientRects().length;
        }),
      ).toBe(1);
    }
  }
});

test("phone evidence uses focused sources without clipping its width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const preview of ["rule", "source", "history"]) {
    await page.goto(`/?preview=${preview}#product`);
    const stage = page.locator(".spotlight-image");
    const image = stage.locator("a:visible picture:visible img");
    await expect
      .poll(() => image.evaluate((el: HTMLImageElement) => el.currentSrc))
      .toContain(`proof-${preview}-mobile-`);
    expect((await image.boundingBox())!.width).toBeLessThanOrEqual(
      (await stage.boundingBox())!.width + 1,
    );
    await expect(stage.locator("a:visible")).toHaveAttribute(
      "href",
      /inspect=/,
    );
  }
  await page.goto("/tour/?view=usage");
  const image = page.locator('[data-tour-panel="usage"] a:visible img');
  await expect
    .poll(() => image.evaluate((el: HTMLImageElement) => el.currentSrc))
    .toContain("usage-mobile-");
  expect((await image.boundingBox())!.width).toBeLessThan(390);
});

test("phone copy actions stay alongside the command and setup has one verification path", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/docs/install/#4-verify-the-connection");
  const row = page.locator(".install-command");
  const code = (await row.locator("pre").boundingBox())!;
  const button = (await row.getByRole("button").boundingBox())!;
  expect(Math.abs(button.y - code.y)).toBeLessThan(20);
  await expect(
    page.getByRole("heading", { name: "Verify recording", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('[id="4-verify-the-connection"]')).toBeInViewport();
  await expect(page.locator(".setup-disclosure")).toContainText(
    "SENTRY_ENABLED=0",
  );
});

test("reference results explain their purpose and can expand without an internal scroll trap", async ({
  page,
}) => {
  await page.goto("/docs/configuration/?from=qa&setting=knowledge#knowledge");
  const finder = page.locator(".reference-finder");
  const results = finder.locator("[data-finder-results]");
  await expect(results.locator("li:visible")).toHaveCount(6);
  await expect(results.locator("li:visible").first()).toContainText(
    "Long-term knowledge",
  );
  await finder.getByRole("button", { name: /Show all/ }).click();
  expect(await results.locator("li:visible").count()).toBeGreaterThan(6);
  expect(
    await results.evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
  ).toBe(true);
  await expect(page).toHaveURL(/from=qa&setting=knowledge#knowledge/);
  await finder.getByRole("searchbox").fill("autoToolFailureGotchas");
  await expect(results.locator("li:visible")).toHaveCount(1);
  await expect(results).toContainText("tool");
  await finder.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.locator("#knowledge")).toBeAttached();
});

test("journal gives its temporary detail less weight and its next-session result priority", async ({
  page,
}) => {
  await page.goto("/#journal");
  const transient = page.locator("details.journal-transient");
  await expect(transient).toBeVisible();
  await expect(transient).not.toHaveAttribute("open", "");
  await transient.locator("summary").click();
  await expect(transient).toContainText("port 4330");
  await page.getByRole("radio", { name: "Next session", exact: true }).check();
  const result = page.locator('[data-journal-result="webhook"]');
  const choices = page.locator(".journal-tasks");
  expect((await result.boundingBox())!.y).toBeLessThan(
    (await choices.boundingBox())!.y,
  );
  await page
    .getByRole("radio", { name: "Add a settings field", exact: true })
    .check();
  await expect(page.locator('[data-journal-result="forms"]')).toBeVisible();
});

test("setting-name matches precede incidental description matches", async ({
  page,
}) => {
  await page.goto("/docs/configuration/?setting=knowledge");
  const names = await page
    .locator("[data-finder-results] li:visible a")
    .allTextContents();
  expect(names.slice(0, 3)).toEqual([
    "knowledge",
    "knowledge.enabled",
    "knowledge.maxEntityInject",
  ]);
});
