import { expect, test, type Page } from "@playwright/test";

async function projectByName(page: Page, name: string) {
  const response = await page.request.get("/api/v1/projects");
  expect(response.ok()).toBe(true);
  const projects = (await response.json()) as Array<{
    id: string;
    name: string | null;
  }>;
  const project = projects.find((item) => item.name === name);
  if (!project) throw new Error(`seeded project ${name} not found`);
  return project;
}

async function projectEntries(page: Page, projectId: string) {
  const response = await page.request.get(
    `/api/v1/projects/${encodeURIComponent(projectId)}/knowledge`,
  );
  expect(response.ok()).toBe(true);
  return (await response.json()) as Array<{ id: string; title: string }>;
}

test.describe("knowledge promotions", () => {
  test("linked scratch knowledge explains sign-in and stays local", async ({
    page,
  }) => {
    const scratch = await projectByName(page, "scratch");
    const before = await projectEntries(page, scratch.id);
    const entry = before.find(
      (item) => item.title === "Prefer terse commit messages",
    );
    if (!entry) throw new Error("scratch promotion fixture not found");

    await page.goto(
      `/ui/projects/${encodeURIComponent(scratch.id)}/knowledge/${encodeURIComponent(entry.id)}`,
    );
    const panel = page.getByTestId("promotion-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Sign in with `lore login` to propose.");
    await expect(panel.getByTestId("promotion-propose")).toBeDisabled();
    await expectNoTokenText(page);

    const after = await projectEntries(page, scratch.id);
    expect(after).toHaveLength(before.length);
  });

  test("an unlinked lore entry explains that it must be linked first", async ({
    page,
  }) => {
    const lore = await projectByName(page, "lore");
    const before = await projectEntries(page, lore.id);
    const entry = before[0];
    if (!entry) throw new Error("lore promotion fixture not found");

    await page.goto(
      `/ui/projects/${encodeURIComponent(lore.id)}/knowledge/${encodeURIComponent(entry.id)}`,
    );
    const panel = page.getByTestId("promotion-panel");
    await expect(panel).toContainText(
      "Link this project to a team before proposing.",
    );
    await expect(panel.getByTestId("promotion-propose")).toBeDisabled();

    const after = await projectEntries(page, lore.id);
    expect(after).toHaveLength(before.length);
  });

  test("the Promotions nav link is keyboard reachable and shows anonymous state", async ({
    page,
  }, testInfo) => {
    await page.goto("/ui");
    const mobile = testInfo.project.name.startsWith("mobile");
    if (mobile) {
      await page.getByTestId("open-nav").click();
    }
    const navLink = mobile
      ? page.getByTestId("nav-drawer").getByTestId("nav-promotions")
      : page.getByTestId("nav-promotions").first();
    const previousLink = mobile
      ? page.getByTestId("nav-drawer").getByTestId("nav-contradictions")
      : page.getByTestId("nav-contradictions");
    await expect(navLink).toBeVisible();
    await previousLink.focus();
    await page.keyboard.press("Tab");
    await expect(navLink).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(/\/ui\/promotions$/);
    await expect(page.getByTestId("promotions-unavailable")).toContainText(
      "Sign in with `lore login`",
    );
    await expectNoTokenText(page);
  });
});

async function expectNoTokenText(page: Page) {
  await expect(page.locator("body")).not.toContainText(
    /access_token|refresh_token|provider_token/,
  );
}
