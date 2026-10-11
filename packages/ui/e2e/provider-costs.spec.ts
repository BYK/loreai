import { expect, test } from "@playwright/test";

test.describe("provider cost cards", () => {
  test("/ui/costs renders per-provider cards with subscription quota bars", async ({
    page,
  }) => {
    await page.goto("/ui/costs");

    const cards = page.getByTestId("provider-card");
    await expect(cards).toHaveCount(2);

    const anthropic = cards.filter({ hasText: "Anthropic" });
    await expect(anthropic.getByText("Subscription")).toBeVisible();
    const bars = anthropic.locator('[role="progressbar"]');
    await expect(bars).toHaveCount(2);
    await expect(bars.nth(0)).toHaveAttribute("aria-valuenow", "23");
    await expect(bars.nth(1)).toHaveAttribute("aria-valuenow", "41");
    await expect(anthropic.getByText(/resets in/)).toHaveCount(2);
    await expect(anthropic.getByText("Quota cap · 7d")).toBeVisible();
    await expect(anthropic.getByText("41% / 80%")).toBeVisible();
    await expect(anthropic.getByText("Pace · 5h")).toBeVisible();
    await expect(anthropic.getByText("Pace · 7d")).toBeVisible();
    await expect(page.getByText("Daily budget")).toHaveCount(0);
    // Seeded 5h: 3h of 5h elapsed, used 23 → even pace 60; 7d: 4d of 7d, used 41.
    await expect(anthropic.getByTestId("pace-tick")).toHaveCount(2);
    await expect(anthropic.getByTestId("pace-state")).toHaveText([
      "on pace",
      "on pace",
    ]);

    const openai = cards.filter({ hasText: "OpenAI" });
    await expect(openai.getByText("API key")).toBeVisible();
    await expect(openai.locator('[role="progressbar"]')).toHaveCount(0);
  });

  test("budget editor saves an API-key cap via PUT /costs/budgets and clears it", async ({
    page,
  }, testInfo) => {
    // Budgets are one shared KV row; edit from a single project so parallel
    // projects never race on it.
    test.skip(testInfo.project.name !== "desktop-chromium");
    await page.goto("/ui/costs");
    const openai = page
      .getByTestId("provider-card")
      .filter({ hasText: "OpenAI" });

    await openai.getByRole("button", { name: "Edit budgets" }).click();
    await openai.getByLabel("USD cap per day").fill("5");
    const saved = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/v1/costs/budgets") &&
        r.request().method() === "PUT",
    );
    await openai.getByRole("button", { name: "Save budgets" }).click();
    expect((await saved).status()).toBe(200);
    await expect(openai.getByTestId("budget-editor")).toHaveCount(0);
    await expect(openai.getByText("USD cap · day")).toBeVisible();

    await page.reload();
    await expect(openai.getByText("USD cap · day")).toBeVisible();
    await openai.getByRole("button", { name: "Edit budgets" }).click();
    await expect(openai.getByLabel("USD cap per day")).toHaveValue("5");
    await openai.getByLabel("USD cap per day").fill("");
    await openai.getByRole("button", { name: "Save budgets" }).click();
    await expect(openai.getByText("USD cap · day")).toHaveCount(0);

    // The seeded Anthropic percent cap survived both saves.
    await expect(
      page
        .getByTestId("provider-card")
        .filter({ hasText: "Anthropic" })
        .getByText("Quota cap · 7d"),
    ).toBeVisible();
  });
});
