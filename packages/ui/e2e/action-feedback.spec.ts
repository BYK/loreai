import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"] as const) {
  test(`copy feedback reflects pending, success and failure in ${theme}`, async ({
    page,
    context,
  }, testInfo) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript((choice) => {
      localStorage.setItem("lore.ui.theme", choice);
      const nativeWrite = navigator.clipboard.writeText.bind(
        navigator.clipboard,
      );
      type Harness = Window & {
        finishCopy?: () => void;
        failCopy?: () => void;
      };
      navigator.clipboard.writeText = (text) =>
        new Promise<void>((resolve, reject) => {
          (window as Harness).finishCopy = () => {
            void nativeWrite(text).then(resolve, reject);
          };
          (window as Harness).failCopy = () =>
            reject(new Error("Clipboard access denied"));
        });
    }, theme);
    const projects = await (await page.request.get("/api/v1/projects")).json();
    const project = projects.find((p: { name: string }) => p.name === "lore");
    await page.goto(`/ui/projects/${project.id}/sessions`);
    const sessionRow = page.getByRole("link", {
      name: /Refactor the sync outbox pruning/,
    });
    const record = sessionRow.locator("..");
    await record.getByText("Processing details", { exact: true }).click();
    const idCopy = record.getByRole("button", { name: "Copy session id" });
    await idCopy.click();
    await expect(idCopy).toBeDisabled();
    const copyBox = (await idCopy.boundingBox())!;
    // Hit-test the disabled control with real pointer input: a pending copy
    // in processing details must never navigate away while pending.
    await page.mouse.click(
      copyBox.x + copyBox.width / 2,
      copyBox.y + copyBox.height / 2,
    );
    await expect(page).toHaveURL(
      new RegExp(`/projects/${project.id}/sessions$`),
    );
    await page.evaluate(() =>
      (window as Window & { finishCopy?: () => void }).finishCopy?.(),
    );
    await expect(idCopy).toContainText("Copied");
    await page.goto(`/ui/projects/${project.id}/sessions/e2e-reader`);
    const row = page
      .locator("[data-row-key]")
      .filter({ hasText: "needle-229" });
    await expect(row).toBeInViewport();
    await row.focus();
    await page.keyboard.press("Enter");
    const panel = page.getByTestId("selection-panel");
    await expect(panel).toBeVisible();
    const copy = panel.getByTestId("copy-with-source");
    await copy.click();
    await expect(copy).toBeDisabled();
    await expect(copy).toHaveAttribute("aria-busy", "true");
    await expect(copy).not.toContainText("Copied");
    await expect(copy.locator("svg")).toHaveCount(1);
    // The spinner is static under reduced motion, but its pending label remains.
    expect(
      await copy
        .locator("svg")
        .evaluate((el) => getComputedStyle(el).animationName),
    ).toBe("none");
    await page.evaluate(() =>
      (window as Window & { finishCopy?: () => void }).finishCopy?.(),
    );
    await expect(copy).toBeEnabled();
    await expect(copy).toContainText("Copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
      "needle-229",
    );
    await expect(panel.getByRole("status")).toContainText("Copied selection");
    await page.screenshot({
      path: testInfo.outputPath(`copy-success-${theme}.png`),
      scale: "css",
    });
    await panel.getByTestId("copy-link").click();
    await page.evaluate(() =>
      (window as Window & { failCopy?: () => void }).failCopy?.(),
    );
    await expect(panel.getByRole("alert")).toContainText(
      "Select and copy the text manually",
    );
    await expect(copy).not.toContainText("Copied");
    await expect(panel.getByTestId("copy-link")).toBeEnabled();
    // No page overflow at either desktop or phone width after feedback wraps.
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`copy-error-${theme}.png`),
      scale: "css",
    });
  });
}
