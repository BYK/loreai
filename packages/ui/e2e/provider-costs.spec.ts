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

    const openai = cards.filter({ hasText: "OpenAI" });
    await expect(openai.getByText("API key")).toBeVisible();
    await expect(openai.locator('[role="progressbar"]')).toHaveCount(0);
  });
});
