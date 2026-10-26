/**
 * Sessions list titles + title search (#1921) against the BUILT gateway and
 * the seeded `lore` project: rows show derived titles with a copyable id
 * chip, `?q=` filters by title substring, the reader header shows the same
 * title, and the copy button writes the full id.
 */
import { expect, test, type Page } from "@playwright/test";

async function loreProjectId(page: Page): Promise<string> {
  const projects = await (await page.request.get("/api/v1/projects")).json();
  const lore = projects.find((p: { name: string }) => p.name === "lore");
  return lore.id as string;
}

async function openSessions(page: Page, query = "") {
  const projectId = await loreProjectId(page);
  await page.goto(`/ui/projects/${projectId}/sessions${query}`);
  return projectId;
}

test.describe("session titles and search", () => {
  test("the list shows derived titles and id chips", async ({ page }) => {
    await openSessions(page);
    const row = page.getByRole("link", {
      name: /Refactor the sync outbox pruning/,
    });
    await expect(row).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Investigate FTS tokenizer diacritics/ }),
    ).toBeVisible();
    const record = row.locator("..");
    const processing = record.locator("details");
    await expect(processing).not.toHaveAttribute("open");
    await expect(row.locator("button, summary")).toHaveCount(0);
    await record.getByText("Processing details", { exact: true }).click();
    await expect(
      record.getByRole("button", { name: "Copy session id" }),
    ).toBeVisible();
    const fallback = page
      .locator("details")
      .filter({ hasText: "e2e-session-tools" })
      .locator("..");
    await expect(
      fallback.getByRole("link", { name: /Untitled session/ }),
    ).toBeVisible();
    await fallback.getByText("Processing details", { exact: true }).click();
    await expect(fallback.getByText("e2e-session-tools")).toHaveCount(1);
  });

  test("search narrows to matching titles and clearing restores all rows", async ({
    page,
  }) => {
    const projectId = await openSessions(page);
    const box = page.getByRole("searchbox", { name: "Search sessions" });
    await box.fill("outbox");
    await box.press("Enter");
    await expect(page).toHaveURL(
      new RegExp(`/projects/${projectId}/sessions\\?q=outbox$`),
    );
    await expect(page.getByText("Sessions matching “outbox”")).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Refactor the sync outbox pruning/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Investigate FTS tokenizer/ }),
    ).toBeHidden();

    // Clearing the box and submitting again restores the unfiltered list.
    await box.fill("");
    await box.press("Enter");
    await expect(page).toHaveURL(
      new RegExp(`/projects/${projectId}/sessions$`),
    );
    await expect(
      page.getByRole("link", { name: /Investigate FTS tokenizer diacritics/ }),
    ).toBeVisible();
  });

  test("empty search result is honest", async ({ page }) => {
    await openSessions(page, "?q=no-such-thing");
    await expect(
      page.getByText("No sessions match “no-such-thing”"),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Clear search" }),
    ).toBeVisible();
  });

  test("deep link with q renders the filtered list", async ({ page }) => {
    const projectId = await openSessions(page, "?q=diacritics");
    await expect(
      page.getByRole("link", { name: /Investigate FTS tokenizer diacritics/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Refactor the sync outbox/ }),
    ).toBeHidden();
    void projectId;
  });

  test("a typo query flags approximate session hits (#1948)", async ({
    page,
  }) => {
    // "outbxo" fuzzy-scores 0.833 against "…sync outbox pruning" — no literal
    // hit exists, so the row is a rescue hit and must say so.
    await openSessions(page, "?q=outbxo");
    await expect(page.getByTestId("session-list-approximate")).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Refactor the sync outbox pruning/ }),
    ).toBeVisible();
    await expect(page.getByTestId("session-match-fuzzy")).toHaveCount(1);

    // The literal query yields an exact hit only — no approximate badge.
    await openSessions(page, "?q=outbox");
    await expect(page.getByTestId("session-match-fuzzy")).toHaveCount(0);
    await expect(page.getByTestId("session-list-approximate")).toBeHidden();
  });

  test("the reader header shows the title and id chip", async ({ page }) => {
    const projectId = await loreProjectId(page);
    await page.goto(`/ui/projects/${projectId}/sessions/e2e-session-sqlite`);
    await expect(
      page.locator("main").getByRole("heading", {
        name: "Refactor the sync outbox pruning",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.locator("main").getByRole("button", { name: "Copy session id" }),
    ).toBeVisible();
  });

  test("copy button writes the full session id", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const projectId = await openSessions(page);
    const row = page.getByRole("link", {
      name: /Refactor the sync outbox pruning/,
    });
    const record = row.locator("..");
    await record.getByText("Processing details", { exact: true }).click();
    await record.getByRole("button", { name: "Copy session id" }).click();
    await expect(page).toHaveURL(
      new RegExp(`/projects/${projectId}/sessions$`),
    );
    await expect(
      record.getByRole("button", { name: "Copy session id" }),
    ).toContainText("Copied");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe("e2e-session-sqlite");
  });
});

test.describe("mobile list (375x812)", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("titles wrap within the viewport and the search box stays usable", async ({
    page,
  }) => {
    await openSessions(page);
    const row = page.getByRole("link", {
      name: /Refactor the sync outbox pruning/,
    });
    await expect(row).toBeVisible();
    const box = await row
      .getByTitle("Refactor the sync outbox pruning", { exact: true })
      .boundingBox();
    if (!box) throw new Error("Missing session title bounds");
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    await expect(
      page.getByRole("searchbox", { name: "Search sessions" }),
    ).toBeVisible();
  });
});

for (const width of [320, 390]) {
  test(`session search has mobile targets and preserves trimmed query/reset at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const projectId = await openSessions(
      page,
      "?q=diacritics&cursor=old-cursor",
    );
    const search = page.getByRole("searchbox", { name: "Search sessions" });
    const submit = page
      .getByRole("search")
      .getByRole("button", { name: "Search", exact: true });
    for (const target of [search, submit]) {
      await expect(target).toBeVisible();
      const box = await target.boundingBox();
      if (!box) throw new Error("Missing session search target");
      expect.soft(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
    await search.fill("  outbox  ");
    await submit.click();
    await expect(page).toHaveURL(`/ui/projects/${projectId}/sessions?q=outbox`);
    await expect(
      page.getByRole("link", { name: /Refactor the sync outbox pruning/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Investigate FTS tokenizer/ }),
    ).toHaveCount(0);
    await search.fill("   ");
    await search.press("Enter");
    await expect(page).toHaveURL(`/ui/projects/${projectId}/sessions`);
    await expect(
      page.getByRole("link", { name: /Investigate FTS tokenizer/ }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}
