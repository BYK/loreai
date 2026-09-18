import { expect, test } from "@playwright/test";

test.describe("/ui/fixture design specimen", () => {
  test("is labelled non-production and renders every specimen", async ({
    page,
  }, testInfo) => {
    await page.goto("/ui/fixture");
    await expect(page.getByTestId("fixture-banner")).toContainText(
      "NOT PRODUCTION",
    );
    await expect(page.getByTestId("fixture-document")).toBeVisible();
    await expect(page.getByTestId("inline-discussion")).toBeVisible();
    await expect(page.getByTestId("note-states")).toContainText(/draft/i);
    await expect(page.getByTestId("note-states")).toContainText(/saved/i);
    await expect(page.getByTestId("note-states")).toContainText(/sent/i);
    await expect(page.getByTestId("note-states")).toContainText(/unknown/i);
    await expect(page.getByTestId("pane-states")).toContainText(
      "No knowledge yet",
    );
    await expect(page.getByTestId("pane-states")).toContainText(
      "Knowledge unavailable",
    );
    await expect(page.getByTestId("pane-states")).toContainText(
      "Projects hidden",
    );
    await expect(
      page
        .getByTestId("states-specimen")
        .getByRole("button", { name: /Ask agent/ }),
    ).toBeDisabled();

    await page.screenshot({
      path: testInfo.outputPath("fixture-light.png"),
      fullPage: true,
    });
    await page.getByTestId("theme-toggle").click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.screenshot({
      path: testInfo.outputPath("fixture-dark.png"),
      fullPage: true,
    });
  });

  test("focused discussion deep link keeps its source backlink", async ({
    page,
  }) => {
    await page.goto("/ui/fixture");
    await page.getByTestId("open-focus").click();
    await expect(page).toHaveURL(/\/ui\/fixture\?view=focus$/);
    await expect(page.getByTestId("focus-discussion")).toBeVisible();

    await page.reload();
    await expect(page.getByTestId("focus-discussion")).toBeVisible();
    await page.getByTestId("back-to-source").click();
    await expect(page).toHaveURL(/\/ui\/fixture$/);
    await expect(page.getByTestId("inline-discussion")).toBeVisible();
  });
});
