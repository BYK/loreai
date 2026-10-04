import { expect, test } from "@playwright/test";

test.describe("import history (UI-08)", () => {
  test("project page → import history table", async ({ page }) => {
    const projects = (await (
      await page.request.get("/api/v1/projects")
    ).json()) as { id: string; name: string }[];
    const lore = projects.find((p) => p.name === "lore");
    expect(lore).toBeTruthy();

    await page.goto(`/ui/projects/${lore!.id}`);
    await expect(page.getByTestId("connection-status")).toHaveAttribute(
      "data-connection",
      "reachable",
    );
    await page.getByRole("link", { name: "Import history →" }).click();

    await expect(page).toHaveURL(
      new RegExp(`/ui/projects/${lore!.id}/imports$`),
    );
    const table = page.getByTestId("imports-table");
    await expect(page.getByText("3 imports")).toBeVisible();
    await expect(page.getByTestId("import-row")).toHaveCount(3);
    await expect(table).toContainText("claude-session-alpha");
    await expect(table).toContainText("codex-thread-9");
  });

  test("unknown project id shows the not-found state", async ({ page }) => {
    await page.goto(
      "/ui/projects/00000000-0000-4000-8000-000000000000/imports",
    );
    await expect(page.getByText("Import history not found")).toBeVisible();
  });

  test("imports page shows the empty state for a project without imports", async ({
    page,
  }) => {
    const projects = (await (
      await page.request.get("/api/v1/projects")
    ).json()) as { id: string; name: string }[];
    const scratch = projects.find((p) => p.name === "scratch");
    await page.goto(`/ui/projects/${scratch!.id}/imports`);
    await expect(page.getByText("No imports")).toBeVisible();
  });
});
