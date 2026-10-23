import { expect, type Page } from "@playwright/test";

export async function openProjectPicker(page: Page) {
  const picker = page.getByRole("dialog", {
    name: "Switch project",
    exact: true,
  });
  if (await picker.isVisible()) return picker;
  const trigger = page.locator(
    '[data-testid="project-picker-trigger"]:visible',
  );
  if (!(await trigger.count())) await page.getByTestId("open-nav").click();
  await page.locator('[data-testid="project-picker-trigger"]:visible').click();
  await expect(picker).toBeVisible();
  return picker;
}

export async function openAccountMenu(page: Page) {
  const menu = page.getByTestId("folk-status-panel");
  if (!(await menu.isVisible())) {
    await openNavigation(page);
    await page.getByTestId("folk-status").click();
  }
  await expect(menu).toBeVisible();
  return menu;
}

export async function setWorkspaceTheme(
  page: Page,
  theme: "light" | "dark" | "system",
) {
  const menu = await openAccountMenu(page);
  await menu.getByTestId(`theme-${theme}`).click();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId("folk-status")).toBeFocused();
  await closeNavigation(page);
}

/** Open labeled mobile navigation, or return the persistent desktop rail. */
export async function openNavigation(page: Page) {
  const trigger = page.getByTestId("mobile-menu-trigger");
  await expect(trigger.or(page.getByTestId("icon-rail"))).toBeVisible();
  if (await trigger.isVisible()) {
    if (!(await page.getByTestId("nav-drawer").isVisible()))
      await trigger.click();
    await expect(page.getByTestId("nav-drawer")).toBeVisible();
    await expect
      .poll(async () => (await page.getByTestId("nav-drawer").boundingBox())?.x)
      .toBe(0);
    return page.getByTestId("mobile-navigation");
  }
  await expect(page.getByTestId("icon-rail")).toBeVisible();
  return page.getByTestId("icon-rail");
}

export async function closeNavigation(page: Page) {
  const drawer = page.getByTestId("nav-drawer");
  if (await drawer.isVisible()) {
    await drawer.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(drawer).toHaveCount(0);
  }
}

export async function clickNavigation(page: Page, id: string) {
  const nav = await openNavigation(page);
  await nav.getByTestId(id).click();
  await expect(page.getByTestId("nav-drawer")).toHaveCount(0);
}

export async function expectCurrentNavigation(page: Page, id: string) {
  const nav = await openNavigation(page);
  await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
  await expect(nav.getByTestId(id)).toHaveAttribute("aria-current", "page");
  await closeNavigation(page);
}

export async function expectNavigationAvailable(page: Page) {
  const trigger = page.getByTestId("mobile-menu-trigger");
  await expect(trigger.or(page.getByTestId("icon-rail"))).toBeVisible();
  if (await trigger.isVisible()) {
    await expect(page.getByTestId("icon-rail")).toHaveCount(0);
  } else await expect(page.getByTestId("icon-rail")).toBeVisible();
}

export async function expectGatewayReachable(page: Page) {
  await openNavigation(page);
  await expect(page.getByTestId("connection-status")).toHaveAttribute(
    "data-connection",
    "reachable",
  );
  await closeNavigation(page);
}

/** Resolve a theme token through the browser, including Tailwind OKLCH colors. */
export async function themeColor(page: Page, token: string) {
  return page.evaluate((name) => {
    if (
      !getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    ) {
      throw new Error(`Missing theme token: ${name}`);
    }
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
}

/** Rasterize CSS colors before computing contrast: computed colors may be OKLCH. */
export async function colorContrast(
  page: Page,
  foreground: string,
  background: string,
  backdrop = "white",
) {
  return page.evaluate(
    ({ foreground, background, backdrop }) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      const paint = (color: string) => {
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
      };
      const luminance = (foreground: boolean) => {
        context.clearRect(0, 0, 1, 1);
        paint(backdrop);
        paint(background);
        if (foreground) paint(foregroundColor);
        const channels = [...context.getImageData(0, 0, 1, 1).data]
          .slice(0, 3)
          .map((value) => {
            const c = value / 255;
            return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          });
        return (
          channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
        );
      };
      const foregroundColor = foreground;
      const a = luminance(true),
        b = luminance(false);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    },
    { foreground, background, backdrop },
  );
}
