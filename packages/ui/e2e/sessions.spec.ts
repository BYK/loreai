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
    // Id stays reachable via the chip inside the row.
    await expect(
      row.getByRole("button", { name: "Copy session id" }),
    ).toBeVisible();
    // A title-less session renders its id once, as the primary line.
    const fallback = page.getByRole("link", { name: /e2e-session-tools/ });
    await expect(fallback).toBeVisible();
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
      page.getByText("Refactor the sync outbox pruning").first(),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Copy session id" }).first(),
    ).toBeVisible();
  });

  test("copy button writes the full session id", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const projectId = await openSessions(page);
    const row = page.getByRole("link", {
      name: /Refactor the sync outbox pruning/,
    });
    await row.getByRole("button", { name: "Copy session id" }).click();
    await expect(page).toHaveURL(
      new RegExp(`/projects/${projectId}/sessions$`),
    );
    await expect(row.getByText("Copied")).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe("e2e-session-sqlite");
  });
});

test.describe("mobile list (375x812)", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("titles truncate to one line and the search box stays usable", async ({
    page,
  }) => {
    await openSessions(page);
    const row = page.getByRole("link", {
      name: /Refactor the sync outbox pruning/,
    });
    await expect(row).toBeVisible();
    const box = await row.locator(".font-medium").boundingBox();
    expect(box).not.toBeNull();
    expect(box?.height ?? 0).toBeLessThan(30);
    await expect(
      page.getByRole("searchbox", { name: "Search sessions" }),
    ).toBeVisible();
  });
});
