import { expectGatewayReachable } from "./workspace-helpers";
import { expect, test } from "@playwright/test";

test.describe("entities (UI-08)", () => {
  test("list → detail → edit notes → save", async ({ page }, testInfo) => {
    const notesValue = `First programmer, annotated the engine. [${testInfo.project.name}-${testInfo.retry}-${Date.now()}]`;
    await page.goto("/ui/entities");
    await expectGatewayReachable(page);

    const rows = page.getByTestId("entity-row");
    await expect(rows).toHaveCount(4);
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

    await detail.getByText("Edit entity details", { exact: true }).click();
    // Edit notes and save; the PATCH lands via /api/v1/entities/:id.
    const notes = detail.getByTestId("entity-notes");
    await notes.fill(notesValue);
    const save = detail.getByTestId("entity-save");
    await expect(save).toBeEnabled();
    await save.click();
    await expect(detail).toContainText("Saved.");

    // The write persisted — a reload re-reads the same notes from the server.
    await page.reload();
    await detail.getByText("Edit entity details", { exact: true }).click();
    await expect(detail.getByTestId("entity-notes")).toHaveValue(notesValue);
  });

  test("evidence and both relation directions navigate within /ui before editing", async ({
    page,
  }) => {
    await page.goto("/ui/entities");
    await page
      .getByTestId("entity-row")
      .filter({ hasText: "Ada Lovelace" })
      .click();
    const relations = page.getByTestId("entity-relations");
    await expect(relations).toContainText(
      "Ada Lovelace colleague → Analytical Engines Ltd org",
    );
    await expect(page.getByTestId("entity-knowledge")).toBeVisible();
    await expect(page.getByTestId("entity-notes")).not.toBeVisible();
    const evidence = page
      .getByTestId("entity-knowledge")
      .getByRole("link")
      .first();
    await expect(evidence).toHaveAttribute(
      "href",
      /^\/ui\/projects\/[^/]+\/knowledge\/[^/]+$/,
    );
    await evidence.click();
    await expect(page.getByTestId("knowledge-document")).toBeVisible();
    await page.goBack();
    await relations
      .getByRole("link", { name: "Analytical Engines Ltd" })
      .click();
    await expect(page.getByTestId("entity-name")).toHaveText(
      "Analytical Engines Ltd",
    );
    await expect(relations).toContainText(
      "Ada Lovelace person colleague → Analytical Engines Ltd",
    );
    await relations.getByRole("link", { name: "Ada Lovelace" }).click();
    await expect(page.getByTestId("entity-name")).toHaveText("Ada Lovelace");
  });

  test("unknown entity id shows the not-found state", async ({ page }) => {
    await page.goto("/ui/entities/no-such-entity");
    await expect(page.getByText("Entity not found")).toBeVisible();
  });
});
