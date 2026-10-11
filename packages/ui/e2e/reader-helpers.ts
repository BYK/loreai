/** Shared session-reader e2e helpers (seeded `e2e-reader` session). */
import { expect, type Page } from "@playwright/test";

export async function openReader(page: Page, query = "") {
  const projects = await (await page.request.get("/api/v1/projects")).json();
  const lore = projects.find((p: { name: string }) => p.name === "lore");
  await page.goto(`/ui/projects/${lore.id}/sessions/e2e-reader${query}`);
  await expect(page.getByTestId("session-view")).toBeVisible();
  await expect(page.getByTestId("reader-coverage")).toHaveAttribute(
    "data-coverage",
    "partial",
  );
  return lore.id as string;
}

/** Stored message ids are derived server-side, so rows are found by content. */
export function rowWith(page: Page, text: string) {
  return page.locator("[data-row-key]").filter({ hasText: text });
}

/** The quick-search bar is collapsed until Ctrl/Cmd+F or the Find button opens it. */
export async function openSearch(page: Page) {
  await page.getByTestId("search-open").click();
  await expect(page.getByTestId("search-input")).toBeFocused();
}

/** Bring the (possibly unmounted) row mentioning `marker` into view via search. */
export async function revealRow(page: Page, marker: string) {
  await openSearch(page);
  await page.getByTestId("search-input").fill(marker);
  await expect(page.getByTestId("search-summary")).toContainText("1 match");
  await page.getByTestId("search-next").click();
  await expect(rowWith(page, marker)).toBeVisible();
  await page.getByTestId("search-clear").click();
  await expect(page.locator("mark.passage-search")).toHaveCount(0);
}

/** Select displayed text `needle` inside the row that mentions `marker` with a real Range. */
export async function selectInRow(page: Page, marker: string, needle: string) {
  await revealRow(page, marker);
  const row = rowWith(page, marker);
  await expect(row).toHaveCount(1);
  await row
    .locator("[data-block][data-part]")
    .first()
    .evaluate((el, text) => {
      // Search the part's whole text: existing marks split it into nodes.
      const at = (el.textContent ?? "").indexOf(text);
      if (at < 0) throw new Error(`"${text}" not found in ${el.textContent}`);
      const point = (offset: number, end: boolean): [Node, number] => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let seen = 0;
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const len = (n as Text).data.length;
          if (offset < seen + len || (end && offset === seen + len)) {
            return [n, offset - seen];
          }
          seen += len;
        }
        throw new Error(`offset ${offset} outside ${el.textContent}`);
      };
      const range = document.createRange();
      range.setStart(...point(at, false));
      range.setEnd(...point(at + text.length, true));
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    }, needle);
  await row.dispatchEvent("pointerup");
}
