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

    // Other specs dismiss seeded scratch pairs (and retries dismiss more), so
    // the open counts are derived from the API rather than hardcoded.
    interface Row {
      project_id_a: string | null;
      project_id_b: string | null;
      project_name_a: string | null;
      project_name_b: string | null;
    }
    const res = await page.request.get("/api/v1/contradictions");
    const { contradictions } = (await res.json()) as {
      contradictions: Row[];
    };
    const scratchCount = contradictions.filter(
      (p) =>
        p.project_id_a !== null &&
        p.project_id_a === p.project_id_b &&
        p.project_name_a === "scratch",
    ).length;
    const crossCount = contradictions.filter(
      (p) => p.project_id_a !== p.project_id_b || p.project_id_a === null,
    ).length;

    const groups = page.getByTestId("contradiction-group");
    const toggles = page.getByTestId("contradiction-group-toggle");
    await expect(groups.first()).toBeVisible();

    const scratchToggle = toggles.filter({
      hasText: new RegExp(`scratch \\(${scratchCount}\\)`),
    });
    await expect(scratchToggle).toHaveCount(1);
    const crossToggle = toggles.filter({
      hasText: new RegExp(`Cross-project \\(${crossCount}\\)`),
    });
    await expect(crossToggle).toHaveCount(1);
    const crossGroup = groups.filter({ has: crossToggle });
    await expect(crossGroup).toHaveCount(1);

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
