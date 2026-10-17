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
    await expect(page.getByText("Daily budget")).toHaveCount(0);
    await expect(page.getByTestId("budget-editor")).toHaveCount(0);
    // Seeded 5h: 3h of 5h elapsed at 23% → current ≈7.7 pts/h vs sustainable
    // ≈38.5 pts/h; 7d: 4d of 7d at 41% → both remain within sustainable rate.
    await expect(anthropic.getByTestId("pacing-rates")).toHaveCount(2);
    // Both rates drift with the time between seeding and this assertion
    // (slow CI), so match the band rather than one rounded value.
    await expect(anthropic.getByTestId("pacing-rates").first()).toContainText(
      /sustainable (39|4\d) pts\/h/,
    );
    await expect(anthropic.getByTestId("pacing-rates").first()).toContainText(
      /current 7\.\d pts\/h \(window avg\)/,
    );
    await expect(anthropic.getByTestId("pacing-state")).toHaveText([
      "within sustainable rate",
      "within sustainable rate",
    ]);
    await expect(anthropic.getByTestId("pacing-extra-gap")).toHaveText("none");
    await expect(anthropic.getByTestId("pacing-curation-state")).toHaveText(
      "inactive",
    );
    await expect(anthropic).toContainText(
      "Provider pacing never delays user requests.",
    );
    await expect(
      anthropic.getByRole("switch", { name: "Automatic pacing" }),
    ).toHaveAttribute("aria-checked", "true");

    const openai = cards.filter({ hasText: "OpenAI" });
    await expect(openai.getByText("API key")).toBeVisible();
    await expect(openai.locator('[role="progressbar"]')).toHaveCount(0);
    await expect(openai.getByRole("switch")).toHaveCount(0);
  });

  test("pacing switch turns pacing off via PUT /costs/pacing and back on", async ({
    page,
  }, testInfo) => {
    // The switch is one shared KV row; flip it from a single project so
    // parallel projects never race on it.
    test.skip(testInfo.project.name !== "desktop-chromium");
    await page.goto("/ui/costs");
    const anthropic = page
      .getByTestId("provider-card")
      .filter({ hasText: "Anthropic" });
    const toggle = anthropic.getByRole("switch", { name: "Automatic pacing" });
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    const off = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/v1/costs/pacing") &&
        r.request().method() === "PUT",
    );
    await toggle.click();
    const offResponse = await off;
    expect(offResponse.status()).toBe(200);
    expect(offResponse.request().postDataJSON()).toEqual({
      provider: "anthropic",
      account: "e2e-anth",
      enabled: false,
    });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(anthropic.getByTestId("pacing-extra-gap")).toHaveText("off");
    await expect(anthropic.getByTestId("pacing-curation-state")).toHaveText(
      "inactive",
    );
    await expect(anthropic.getByTestId("pacing-state")).toHaveText([
      "pacing off",
      "pacing off",
    ]);

    await page.reload();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await page.reload();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
  });
});
