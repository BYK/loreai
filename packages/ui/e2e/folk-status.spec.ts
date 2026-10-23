import {
  openNavigation,
  setWorkspaceTheme,
  themeColor,
  colorContrast,
} from "./workspace-helpers";
import { expect, test, type Page } from "@playwright/test";

async function projectIdByName(page: Page, name: string) {
  const response = await page.request.get("/api/v1/projects");
  expect(response.ok()).toBe(true);
  const projects = (await response.json()) as { id: string; name: string }[];
  const project = projects.find((item) => item.name === name);
  if (!project) throw new Error(`seeded project ${name} not found`);
  return project.id;
}

async function expectNoTokenText(page: Page) {
  await expect(page.locator("body")).not.toContainText(
    /access_token|refresh_token|provider_token/,
  );
}

test.describe("Folk status surfaces", () => {
  test("shows anonymous status and supports keyboard popover controls", async ({
    page,
  }, testInfo) => {
    await page.goto("/ui/knowledge");
    await openNavigation(page);
    const badge = page.getByTestId("folk-status");
    await expect(badge).toHaveAttribute("data-folk-state", "anonymous");
    await expect(badge).toHaveAttribute("aria-label", /Not signed in/);
    await expect(page.getByText("You", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("account-avatar")).toHaveCount(0);
    await expect(page.getByTestId("anonymous-avatar")).toBeVisible();

    await badge.focus();
    await page.keyboard.press("Enter");
    const panel = page.getByTestId("folk-status-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByText("Anonymous", { exact: true })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("account-menu.png"),
      fullPage: true,
    });
    await expect(page.getByTestId("folk-status-detail")).toContainText(
      "lore login",
    );
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(badge).toBeFocused();
    await expectNoTokenText(page);
  });

  test("hosted mode explains the local flag and never shows an account avatar", async ({
    page,
  }) => {
    await page.route("**/api/v1/account", (route) =>
      route.fulfill({
        json: {
          signed_in: false,
          user: null,
          provider: null,
          expires_at: null,
          state: "hosted",
        },
      }),
    );
    await page.goto("/ui/knowledge");
    await openNavigation(page);
    const badge = page.getByTestId("folk-status");
    await expect(badge).toHaveAttribute("data-folk-state", "hosted");
    await expect(page.getByTestId("account-avatar")).toHaveCount(0);
    await expect(page.getByText("You", { exact: true })).toHaveCount(0);
    await badge.click();
    await expect(page.getByTestId("folk-status-detail")).toContainText(
      "lore start --local",
    );
    await expectNoTokenText(page);
  });

  test("a signed-in local account displays its own initials", async ({
    page,
  }) => {
    await page.route("**/api/v1/account", (route) =>
      route.fulfill({
        json: {
          signed_in: true,
          user: { id: "test-user", display_name: "Ada Lovelace", email: null },
          provider: "github",
          expires_at: null,
          state: "signed_in",
        },
      }),
    );
    await page.goto("/ui/knowledge");
    await openNavigation(page);
    const avatar = page.getByTestId("account-avatar");
    await expect(avatar).toHaveText("AL");
    await expect(avatar).toHaveAttribute(
      "aria-label",
      "Signed in as Ada Lovelace",
    );
    await expect(avatar).toBeVisible();
    await expect(page.getByText("You", { exact: true })).toHaveCount(0);
  });

  test("shows not-linked and degraded project sharing details", async ({
    page,
  }) => {
    const loreId = await projectIdByName(page, "lore");
    await page.goto(`/ui/projects/${loreId}`);
    await openNavigation(page);
    const loreSharing = page.getByTestId("sharing-panel");
    await expect(
      loreSharing.locator('[data-sharing-state="not_linked"]'),
    ).toBeVisible();
    await expect(page.getByTestId("sharing-summary")).toHaveText(
      "Not linked · No team · policy: manual",
    );
    await expectNoTokenText(page);

    const scratchId = await projectIdByName(page, "scratch");
    await page.goto(`/ui/projects/${scratchId}`);
    await openNavigation(page);
    const scratchSharing = page.getByTestId("sharing-panel");
    await expect(
      scratchSharing.locator('[data-sharing-state="degraded"]'),
    ).toBeVisible();
    await expect(page.getByTestId("sharing-summary")).toHaveText(
      "Degraded · Acme e2e · policy: manual",
    );
    await expect(page.getByTestId("sharing-detail")).toHaveText(
      "Not signed in; team content cannot sync",
    );
    await expectNoTokenText(page);
  });
});

test("guest avatar keeps preferences and sign-in guidance available at narrow widths", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 480 });
  await page.goto("/ui");
  await openNavigation(page);
  const avatar = page.getByTestId("folk-status");
  await expect(page.getByTestId("anonymous-avatar")).toBeVisible();
  const box = (await avatar.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeGreaterThan(430);
  await avatar.click();
  // Kobalte hides outside portals after a timer and an animation frame.
  // Verify the nested account layer after that deferred accessibility update.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(
          () =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          0,
        );
      }),
  );
  const panel = page.getByTestId("folk-status-panel");
  await expect(
    panel.getByRole("button", { name: "Settings", exact: true }),
  ).toHaveCount(0);
  await expect(panel.getByTestId("theme-toggle")).toBeVisible();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  const menuBox = (await panel.boundingBox())!;
  expect(menuBox.x).toBeGreaterThanOrEqual(0);
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(320);
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(480);
  const theme = panel.getByRole("button", { name: "Dark theme", exact: true });
  await theme.focus();
  await expect(theme).toBeFocused();
  const profile = panel.getByRole("button", {
    name: "Sign in to Lore",
    exact: true,
  });
  await expect(profile).toContainText("Anonymous");
  await expect(
    panel.getByRole("button", { name: "Sign in", exact: true }),
  ).toHaveCount(0);
  await profile.focus();
  await page.keyboard.press("Enter");
  const login = page.getByRole("dialog", {
    name: "Sign in to Lore",
    exact: true,
  });
  await expect(login).toBeVisible();
  await expect(login).toContainText("lore login");
  await expect(
    login.getByRole("button", { name: "Copy command" }),
  ).toBeVisible();
  await expect(panel).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(login).toHaveCount(0);
  await expect(avatar).toBeFocused();
  await avatar.click();
  await panel.getByTestId("theme-dark").click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.keyboard.press("Escape");
  await expect(avatar).toBeFocused();
  await avatar.click();
  await expect(panel.getByTestId("theme-dark")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("signed-in avatar menu keeps preferences without a sign-in action", async ({
  page,
}) => {
  await page.route("**/api/v1/account", (route) =>
    route.fulfill({
      json: {
        signed_in: true,
        user: { id: "ada", display_name: "Ada Lovelace", email: null },
        provider: "github",
        expires_at: null,
        state: "signed_in",
      },
    }),
  );
  await page.goto("/ui");
  await openNavigation(page);
  const avatar = page.getByTestId("folk-status");
  await expect(avatar.getByTestId("account-avatar")).toHaveText("AL");
  await avatar.click();
  const panel = page.getByTestId("folk-status-panel");
  await expect(panel.getByTestId("folk-account")).toHaveText("Ada Lovelace");
  await expect(
    panel.getByRole("button", { name: "Sign in to Lore", exact: true }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "Settings", exact: true }),
  ).toHaveCount(0);
  await expect(panel.getByTestId("theme-toggle")).toBeVisible();
});

test("mobile profile row and account panel stay aligned with the drawer", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  let signedIn = false;
  await page.route("**/api/v1/account", (route) =>
    route.fulfill({
      json: {
        signed_in: signedIn,
        state: signedIn ? "signed_in" : "anonymous",
        user: signedIn
          ? {
              id: "ada",
              display_name: "Ada Lovelace with a very long display name",
              email: null,
            }
          : null,
        provider: signedIn ? "github" : null,
        expires_at: null,
      },
    }),
  );
  await page.route("**/api/v1/teams", (route) =>
    route.fulfill({ json: { hosted: false, teams: [] } }),
  );
  await page.route("**/api/v1/sync/status", (route) =>
    route.fulfill({
      json: { enabled: true, state: "idle", pending_changes: 2 },
    }),
  );
  for (const scenario of [
    { width: 320, theme: "light", signedIn: false },
    { width: 390, theme: "dark", signedIn: false },
    { width: 320, theme: "dark", signedIn: true },
    { width: 390, theme: "light", signedIn: true },
  ] as const) {
    const { width, theme } = scenario;
    signedIn = scenario.signedIn;
    await page.setViewportSize({ width, height: 640 });
    await page.goto("/ui");
    await setWorkspaceTheme(page, theme);
    await openNavigation(page);
    const drawer = page.getByTestId("nav-drawer");
    const profile = drawer.getByTestId("folk-status");
    await expect(profile).toContainText(
      signedIn ? "Ada Lovelace" : "Anonymous",
    );
    expect(
      await drawer.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      ),
    ).toBe(
      await themeColor(page, `--color-olive-${theme === "dark" ? 900 : 100}`),
    );
    const colors = await profile
      .getByText("Account & preferences", { exact: true })
      .evaluate((label) => ({
        foreground: getComputedStyle(label).color,
        background: getComputedStyle(
          document.querySelector('[data-testid="mobile-navigation"]')!,
        ).backgroundColor,
      }));
    expect(
      await colorContrast(page, colors.foreground, colors.background),
    ).toBeGreaterThanOrEqual(4.5);
    if (width === 390 && theme === "dark")
      await page.screenshot({
        path: testInfo.outputPath("mobile-drawer-dark.png"),
      });
    const drawerBox = (await drawer.boundingBox())!;
    const profileBox = (await profile.boundingBox())!;
    expect(profileBox.width).toBeGreaterThanOrEqual(drawerBox.width - 40);
    expect(profileBox.height).toBeGreaterThanOrEqual(52);
    await profile.click();
    const panel = page.getByTestId("folk-status-panel");
    await expect(panel).toBeVisible();
    const box = (await panel.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(drawerBox.x + 8);
    expect(box.x + box.width).toBeLessThanOrEqual(
      drawerBox.x + drawerBox.width - 8,
    );
    expect(Math.abs(box.width - profileBox.width)).toBeLessThanOrEqual(1);
    for (const control of await panel
      .getByTestId("theme-toggle")
      .getByRole("button")
      .all()) {
      const bounds = (await control.boundingBox())!;
      expect(bounds.width).toBeGreaterThanOrEqual(44);
      expect(bounds.height).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({
      path: testInfo.outputPath(
        `mobile-account-${signedIn ? "signed-in" : "anonymous"}-${theme}-${width}.png`,
      ),
    });
    if (signedIn) {
      await expect(
        panel.getByRole("button", { name: "Sign in to Lore", exact: true }),
      ).toHaveCount(0);
      expect(
        (await panel.getByTestId("sync-now").boundingBox())!.height,
      ).toBeGreaterThanOrEqual(44);
      await page.keyboard.press("Escape");
      await expect(profile).toBeFocused();
      continue;
    }
    await panel
      .getByRole("button", { name: "Sign in to Lore", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Sign in to Lore", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(profile).toBeFocused();
  }
});
