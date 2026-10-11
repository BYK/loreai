import { expect, test } from "@playwright/test";
import { fuzzyRank } from "../src/lib/fuzzy";

/**
 * #1918 project list: pinned projects survive reloads (localStorage), the filter
 * narrows the list, and "All projects" expands beyond the Recent limit.
 * The seed gives 14 core projects — lore, scratch, dedup-review, six
 * disposable apply projects and five empty archive-* projects — so `rest`
 * is non-empty.
 */

const LIST = '[data-pane="list"]';

test.describe("sidebar pinned / recent / filter", () => {
  test("pin persists across reload; unpin removes it", async ({ page }) => {
    await page.goto("/ui");
    const list = page.locator(LIST);

    const pin = list.getByRole("button", { name: "Pin lore" });
    await pin.click();
    await expect(
      list.getByRole("button", { name: "Unpin lore" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(list.locator('[data-section="pinned"]')).toContainText("lore");

    await page.reload();
    await expect(
      list.getByRole("button", { name: "Unpin lore" }),
    ).toBeVisible();
    await expect(list.locator('[data-section="pinned"]')).toContainText("lore");

    await list.getByRole("button", { name: "Unpin lore" }).click();
    await expect(list.locator('[data-section="pinned"]')).toHaveCount(0);
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
    const list = page.locator(LIST);

    const filter = list.getByTestId("nav-project-filter");
    await filter.fill("arch");
    await expect(list.locator('[data-section="matches"]')).toHaveCount(matches);
    expect(matches).toBeGreaterThanOrEqual(5);
    await expect(list.locator('[data-section="recent"]')).toHaveCount(0);

    await filter.press("Escape");
    await expect(list.locator('[data-section="recent"]')).toHaveCount(recent);

    const all = list.getByTestId("nav-all-projects");
    await expect(all).toHaveText(`All projects (${rest})`);
    await all.click();
    await expect(list.locator('[data-section="all"]')).toHaveCount(rest);
  });

  test("filter typo finds projects and shows the approximate hint", async ({
    page,
  }) => {
    await page.goto("/ui");
    const list = page.locator(LIST);

    const filter = list.getByTestId("nav-project-filter");
    await filter.fill("archve");
    await expect(list.getByRole("link", { name: "archive-0" })).toBeVisible();
    await expect(
      list.getByTestId("nav-project-filter-approximate"),
    ).toBeVisible();

    // An exact query still matches without the hint.
    await filter.fill("archive-0");
    await expect(list.getByRole("link", { name: "archive-0" })).toBeVisible();
    await expect(
      list.getByTestId("nav-project-filter-approximate"),
    ).toHaveCount(0);
  });
});
