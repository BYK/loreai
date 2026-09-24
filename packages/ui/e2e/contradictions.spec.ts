import { expect, test } from "@playwright/test";

test.describe("contradictions (UI-08)", () => {
  test("shows a recorded pair and keeps both after explicit dismissal", async ({
    page,
  }) => {
    await page.goto("/ui/contradictions");
    await expect(page.getByTestId("connection-status")).toHaveAttribute(
      "data-connection",
      "reachable",
    );

    const row = page.getByTestId("contradiction-row");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Prefer deterministic ids");
    await expect(row).toContainText("Regenerate ids on every read");
    await row.getByRole("button", { name: "Keep both" }).click();
    await expect(page.getByText("No open contradictions")).toBeVisible();

    // Dismissal persists across a page load; the idle detector must not reopen it.
    await page.reload();
    await expect(page.getByText("No open contradictions")).toBeVisible();
    await expect(page.getByTestId("contradiction-row")).toHaveCount(0);
  });
});
