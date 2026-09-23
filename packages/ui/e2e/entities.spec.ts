import { expect, test } from "@playwright/test";

test.describe("entities (UI-08)", () => {
  test("list → detail → edit notes → save", async ({ page }, testInfo) => {
    const notesValue = `First programmer, annotated the engine. [${testInfo.project.name}-${testInfo.retry}-${Date.now()}]`;
    await page.goto("/ui/entities");
    await expect(page.getByTestId("connection-status")).toHaveAttribute(
      "data-connection",
      "reachable",
    );

    const rows = page.getByTestId("entity-row");
    await expect(rows).toHaveCount(3);
    await rows.filter({ hasText: "Ada Lovelace" }).click();

    await expect(page).toHaveURL(/\/ui\/entities\/[^/]+$/);
    const detail = page.getByTestId("entity-page");
    await expect(detail.getByTestId("entity-name")).toHaveText("Ada Lovelace");
    await expect(detail.getByTestId("entity-aliases")).toContainText(
      "ada@example.com",
    );
    await expect(detail.getByTestId("entity-relations")).toContainText(
      "Analytical Engines Ltd",
    );

    // Edit notes and save; the PATCH lands via /api/v1/entities/:id.
    const notes = detail.getByTestId("entity-notes");
    await notes.fill(notesValue);
    const save = detail.getByTestId("entity-save");
    await expect(save).toBeEnabled();
    await save.click();
    await expect(detail).toContainText("Saved.");

    // The write persisted — a reload re-reads the same notes from the server.
    await page.reload();
    await expect(detail.getByTestId("entity-notes")).toHaveValue(
      notesValue,
    );
  });

  test("unknown entity id shows the not-found state", async ({ page }) => {
    await page.goto("/ui/entities/no-such-entity");
    await expect(page.getByText("Entity not found")).toBeVisible();
  });
});
