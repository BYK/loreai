import { expect, test } from "@playwright/test";
import { themeColor, colorContrast } from "./workspace-helpers";

for (const theme of ["light", "dark"] as const) {
  test(`amber and olive propagate while chart colors stay independent in ${theme}`, async ({
    page,
  }, testInfo) => {
    await page.addInitScript(
      (choice) => localStorage.setItem("lore.ui.theme", choice),
      theme,
    );
    await page.goto("/ui/search");
    const main = page.locator("main");
    const button = main.getByRole("button", { name: "Search", exact: true });
    const link = main.getByRole("link", {
      name: "Browse all knowledge",
      exact: true,
    });
    await expect(button).toBeVisible();
    await expect(main).toHaveCSS(
      "background-color",
      await themeColor(page, `--color-olive-${theme === "dark" ? 900 : 50}`),
    );
    await expect(button).toHaveCSS(
      "background-color",
      await themeColor(page, `--color-amber-${theme === "dark" ? 400 : 700}`),
    );
    await expect(link).toHaveCSS("color", await themeColor(page, "--accent"));
    await expect(button).toHaveCSS(
      "color",
      await themeColor(page, "--inverse-text"),
    );
    for (const [foreground, background] of [
      ["--text", "--surface"],
      ["--muted", "--soft"],
      ["--accent", "--surface"],
      ["--inverse-text", "--inverse-bg"],
      ["--accent-soft-text", "--accent-soft"],
    ]) {
      expect(
        await colorContrast(
          page,
          await themeColor(page, foreground!),
          await themeColor(page, background!),
        ),
        `${foreground} on ${background}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
    if (testInfo.project.name === "desktop-chromium") {
      await button.hover();
      // Wait for the color transition before measuring the painted result.
      await expect
        .poll(() =>
          button.evaluate((el) =>
            el
              .getAnimations()
              .every((animation) => animation.playState !== "running"),
          ),
        )
        .toBe(true);
      const hover = await button.evaluate((el) => ({
        foreground: getComputedStyle(el).color,
        background: getComputedStyle(el).backgroundColor,
        backdrop: getComputedStyle(el.closest("main")!).backgroundColor,
      }));
      expect(
        await colorContrast(
          page,
          hover.foreground,
          hover.background,
          hover.backdrop,
        ),
        "hovered action text remains readable",
      ).toBeGreaterThanOrEqual(4.5);
      await expect(button).toHaveCSS(
        "background-color",
        await themeColor(page, `--color-amber-${theme === "dark" ? 300 : 800}`),
      );
      await page.mouse.move(0, 0);
      await expect(button).toHaveCSS(
        "background-color",
        await themeColor(page, "--accent"),
      );
    }
    await page.screenshot({
      path: testInfo.outputPath(`palette-${theme}.png`),
      fullPage: true,
    });

    // Change only the palette, not semantic aliases or component classes.
    await page.locator("html").evaluate((el, dark) => {
      el.style.setProperty(
        `--palette-accent-${dark ? 400 : 700}`,
        "rgb(128, 50, 180)",
      );
      el.style.setProperty(
        `--palette-base-${dark ? 900 : 50}`,
        "rgb(230, 225, 210)",
      );
    }, theme === "dark");
    await expect(button).toHaveCSS("background-color", "rgb(128, 50, 180)");
    await expect(link).toHaveCSS("color", "rgb(128, 50, 180)");
    await expect(main).toHaveCSS("background-color", "rgb(230, 225, 210)");
    for (const token of [
      "--inverse-bg",
      "--mark-edge",
      "--quote-edge",
      "--avatar-agent-bg",
    ]) {
      expect(
        await themeColor(page, token),
        `${token} follows the accent palette`,
      ).toBe("rgb(128, 50, 180)");
    }

    // A full navigation restores the selected theme and removes probe overrides.
    await page.goto("/ui/costs");
    const quota = page.getByRole("progressbar", {
      name: "5-hour window used",
      exact: true,
    });
    await expect(quota).toBeVisible();
    await expect(quota.locator("div").first()).toHaveCSS(
      "background-color",
      theme === "dark" ? "rgb(166, 214, 174)" : "rgb(61, 102, 68)",
    );
  });
}
