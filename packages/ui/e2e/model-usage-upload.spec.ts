import { test, expect } from "@playwright/test";

/**
 * Consented Model Tides upload flow (#2026 PR3) against the built gateway +
 * the local stub in gateway.mjs: review → type YES → upload → public link →
 * contribute → delete.
 */
test.describe("model usage upload", () => {
  // The local Model Tides stub in gateway.mjs keeps one mutable report; a
  // second worker would race it mid-flow, so the spec runs on one project.
  test("review → YES → upload → link → contribute → delete", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "shared stub state",
    );
    await page.goto("/ui/model-usage");

    const section = page.getByRole("region", { name: "Share on Model Tides" });
    await expect(section).toContainText("Nothing is uploaded automatically");

    // Review dialog lists every week/model/count + privacy text.
    await section.getByRole("button", { name: "Review upload…" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Review upload" });
    await expect(dialog).toContainText("Week of 2026-05-04");
    await expect(dialog).toContainText("Week of 2026-05-11");
    await expect(dialog).toContainText("anthropic/claude-sonnet-4");
    await expect(dialog).toContainText("openai/gpt-5");
    await expect(dialog).toContainText("No prompts, replies, paths");
    await expect(dialog).toContainText(
      "Your personal chart will be viewable by anyone with its link.",
    );

    // YES gating: disabled until the input is exactly "YES".
    const confirm = dialog.getByRole("button", { name: "Confirm" });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel("Type YES to confirm").fill("yes");
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel("Type YES to confirm").fill("YES");
    await expect(confirm).toBeEnabled();
    await confirm.click();

    // After upload: public link + report controls appear.
    await expect(
      section.getByRole("link", { name: "Your public report" }),
    ).toHaveAttribute("href", /\/u\/7b2f9a3e-1c4d-7e5f-8a6b-0c1d2e3f4a5b$/);
    // Revision differs across projects sharing the stub (desktop runs first).
    await expect(section).toContainText(/revision \d+/);

    // Contribute: dialog reviews the stored counts + YES.
    await section.getByRole("button", { name: "Contribute" }).click();
    const contribute = page.getByRole("alertdialog", {
      name: "Contribute to the community aggregate",
    });
    await expect(contribute).toContainText("Week of 2026-05-04");
    await contribute.getByLabel("Type YES to confirm").fill("YES");
    await contribute.getByRole("button", { name: "Confirm" }).click();
    await expect(section).toContainText("in aggregate");
    await expect(
      section.getByRole("button", { name: "Withdraw" }),
    ).toBeVisible();

    // Delete: YES dialog removes report + controls.
    await section.getByRole("button", { name: "Delete report" }).click();
    const del = page.getByRole("alertdialog", {
      name: "Delete Model Tides report",
    });
    await del.getByLabel("Type YES to confirm").fill("YES");
    await del.getByRole("button", { name: "Confirm" }).click();
    await expect(
      section.getByRole("link", { name: "Your public report" }),
    ).toHaveCount(0);
    await expect(
      section.getByRole("button", { name: "Review upload…" }),
    ).toBeVisible();
  });
});
