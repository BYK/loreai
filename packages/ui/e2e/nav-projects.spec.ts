import { expect, test } from "@playwright/test";
import { fuzzyRank } from "../src/lib/fuzzy";

/**
 * #1918 sidebar: pinned projects survive reloads (localStorage), the filter
 * narrows the list, and "All projects" expands beyond the Recent limit.
 * The seed gives 7 projects — lore and scratch with activity plus five
 * empty archive-* projects — so `rest` is non-empty.
 */

const NAV = { name: "Workspace" } as const;

test.describe("sidebar pinned / recent / filter", () => {
  test("pin persists across reload; unpin removes it", async ({ page }) => {
    await page.goto("/ui");
    const nav = page.getByRole("navigation", NAV);

    const pin = nav.getByRole("button", { name: "Pin lore" });
    await pin.click();
    await expect(
      nav.getByRole("button", { name: "Unpin lore" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(nav.locator('[data-section="pinned"]')).toContainText("lore");

    await page.reload();
    await expect(nav.getByRole("button", { name: "Unpin lore" })).toBeVisible();
    await expect(nav.locator('[data-section="pinned"]')).toContainText("lore");

    await nav.getByRole("button", { name: "Unpin lore" }).click();
    await expect(nav.locator('[data-section="pinned"]')).toHaveCount(0);
  });

  test("filter narrows to matches and All projects expands", async ({
    page,
  }) => {
    // Derive expectations from the API — the gateway may register an extra
    // project for its cwd depending on where it was launched from.
    const projects: Array<{ name: string | null; path: string }> = await (
      await page.request.get("/api/v1/projects")
    ).json();
    const recent = Math.min(projects.length, 5);
    const rest = projects.length - recent;
    // #1948: the filter ranks fuzzy hits too — "arch" also catches "scratch"
    // — so derive the expected count with the same helper the UI uses.
    const matches = fuzzyRank("arch", projects, (p) => [
      p.name ?? "",
      p.path,
    ]).length;

    await page.goto("/ui");
    const nav = page.getByRole("navigation", NAV);

    const filter = nav.getByTestId("nav-project-filter");
    await filter.fill("arch");
    await expect(nav.locator('[data-section="matches"]')).toHaveCount(matches);
    expect(matches).toBeGreaterThanOrEqual(5);
    await expect(nav.locator('[data-section="recent"]')).toHaveCount(0);

    await filter.press("Escape");
    await expect(nav.locator('[data-section="recent"]')).toHaveCount(recent);

    const all = nav.getByTestId("nav-all-projects");
    await expect(all).toHaveText(`All projects (${rest})`);
    await all.click();
    await expect(nav.locator('[data-section="all"]')).toHaveCount(rest);
  });

  test("filter typo finds projects and shows the approximate hint", async ({
    page,
  }) => {
    await page.goto("/ui");
    const nav = page.getByRole("navigation", NAV);

    const filter = nav.getByTestId("nav-project-filter");
    await filter.fill("archve");
    await expect(nav.getByRole("link", { name: "archive-0" })).toBeVisible();
    await expect(
      nav.getByTestId("nav-project-filter-approximate"),
    ).toBeVisible();

    // An exact query still matches without the hint.
    await filter.fill("archive-0");
    await expect(nav.getByRole("link", { name: "archive-0" })).toBeVisible();
    await expect(nav.getByTestId("nav-project-filter-approximate")).toHaveCount(
      0,
    );
  });
});
