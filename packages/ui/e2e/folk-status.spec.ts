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
    await page.goto("/ui");
    const badge = page.getByTestId("folk-status");
    await expect(badge).toHaveAttribute("data-folk-state", "anonymous");
    await expect(badge).toHaveAttribute("aria-label", /Not signed in/);
    await expect(page.getByTestId("account-avatar")).toHaveCount(0);
    if (testInfo.project.name.startsWith("mobile")) {
      await expect(badge.getByText("Not signed in")).toBeHidden();
    } else {
      await expect(badge.getByText("Not signed in")).toBeVisible();
    }

    await badge.focus();
    await page.keyboard.press("Enter");
    const panel = page.getByTestId("folk-status-panel");
    await expect(panel).toBeVisible();
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
    const badge = page.getByTestId("folk-status");
    await expect(badge).toHaveAttribute("data-folk-state", "hosted");
    await expect(page.getByTestId("account-avatar")).toHaveCount(0);
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
    const avatar = page.getByTestId("account-avatar");
    await expect(avatar).toHaveText("AL");
    await expect(avatar).toHaveAttribute(
      "aria-label",
      "Signed in as Ada Lovelace",
    );
    await expect(avatar).toBeVisible();
  });

  test("shows not-linked and degraded project sharing details", async ({
    page,
  }) => {
    const loreId = await projectIdByName(page, "lore");
    await page.goto(`/ui/projects/${loreId}`);
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
