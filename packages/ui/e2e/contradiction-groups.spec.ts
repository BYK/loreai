import { expect, test } from "@playwright/test";

test.describe("contradiction groups (#1919)", () => {
  test("groups pairs by project with a cross-project group last", async ({
    page,
  }) => {
    await page.goto("/ui/contradictions");
    await expect(page.getByTestId("connection-status")).toHaveAttribute(
      "data-connection",
      "reachable",
    );

    const groups = page.getByTestId("contradiction-group");
    const toggles = page.getByTestId("contradiction-group-toggle");
    await expect(groups.first()).toBeVisible();

    // The seed records 4 open scratch pairs, 1 hostile pair, and 1
    // cross-project pair; each group header shows its pair count.
    const scratchToggle = toggles.filter({ hasText: /scratch \([4-9]\d*\)/ });
    await expect(scratchToggle).toHaveCount(1);
    const crossGroup = groups.filter({
      has: page.getByText("Cross-project", { exact: false }),
    });
    await expect(crossGroup).toHaveCount(1);
    await expect(
      crossGroup.getByTestId("contradiction-group-toggle"),
    ).toHaveText(/Cross-project \(1\)/);

    // Cross-project renders last and explains its provenance.
    await expect(groups.last()).toHaveAttribute("data-group", "cross-project");
    await expect(crossGroup).toContainText(
      "Entries from different projects (or global rules)",
    );
    await expect(crossGroup.getByTestId("contradiction-row")).toContainText(
      "A: scratch · B: lore",
    );

    // Toggling a group header collapses its rows; toggling again expands.
    const scratchGroup = groups.filter({ has: scratchToggle });
    await expect(scratchToggle).toHaveAttribute("aria-expanded", "true");
    const scratchRows = scratchGroup.getByTestId("contradiction-row");
    await scratchToggle.click();
    await expect(scratchToggle).toHaveAttribute("aria-expanded", "false");
    await expect(scratchRows).toHaveCount(0);
    await scratchToggle.click();
    await expect(scratchToggle).toHaveAttribute("aria-expanded", "true");
    await expect(scratchRows.first()).toBeVisible();
  });
});
