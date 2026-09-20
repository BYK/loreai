/**
 * Session reader (UI-06) against the BUILT gateway and the seeded
 * `e2e-reader` session (230 messages → 100 on the first page, two older
 * pages). Runs on the desktop and mobile projects.
 */
import { expect, test, type Page } from "@playwright/test";

const FUTURE_ACTIONS = [
  "Save note",
  "Ask agent",
  "Explore separately",
  "Start with selected context",
  "Share finding",
];
const PASSAGE = "portability is a requirement";

async function openReader(page: Page, query = "") {
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
function rowWith(page: Page, text: string) {
  return page.locator("[data-row-key]").filter({ hasText: text });
}

/** Bring the (possibly unmounted) row mentioning `marker` into view via search. */
async function revealRow(page: Page, marker: string) {
  await page.getByTestId("search-input").fill(marker);
  await expect(page.getByTestId("search-summary")).toContainText("1 match");
  await page.getByTestId("search-next").click();
  await expect(rowWith(page, marker)).toBeVisible();
  await page.getByTestId("search-clear").click();
  await expect(page.locator("mark.passage-search")).toHaveCount(0);
}

/** Select displayed text `needle` inside the row that mentions `marker` with a real Range. */
async function selectInRow(page: Page, marker: string, needle: string) {
  await revealRow(page, marker);
  const row = rowWith(page, marker);
  await expect(row).toHaveCount(1);
  await row
    .locator("[data-block][data-part]")
    .first()
    .evaluate((el, text) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const at = (n as Text).data.indexOf(text);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(n, at);
        range.setEnd(n, at + text.length);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      throw new Error(`"${text}" not found in ${el.textContent}`);
    }, needle);
  await row.dispatchEvent("pointerup");
}

test.describe("session reader", () => {
  test("UX-01: select a passage → stable link → reload → same passage highlighted", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openReader(page);
    await expect(page.getByTestId("reader-coverage-line")).toContainText(
      "100 of 230 captured messages loaded",
    );
    await expect(page.getByTestId("native-transcript")).toContainText(
      "Native transcript not yet available",
    );
    // The first page is the newest 100 messages; message 5 is older history.
    await expect(rowWith(page, "needle-5)")).toHaveCount(0);
    await page.getByTestId("load-older").click();
    await expect(page.getByTestId("reader-coverage-line")).toContainText(
      "200 of 230",
    );
    await page.getByTestId("load-older").click();
    await expect(page.getByTestId("history-start")).toBeVisible();
    await expect(page.getByTestId("reader-coverage")).toHaveAttribute(
      "data-coverage",
      "captured",
    );
    await expect(page.getByTestId("reader-coverage-line")).toContainText(
      "230 messages, complete as captured",
    );

    await selectInRow(page, "needle-5)", PASSAGE);
    const panel = page.getByTestId("selection-panel");
    await expect(panel).toBeVisible();
    await expect(page.getByTestId("selection-quote")).toContainText(PASSAGE);
    for (const label of FUTURE_ACTIONS) {
      const button = panel.getByRole("button", {
        name: new RegExp(`^${label}`),
      });
      await expect(button).toBeDisabled();
    }
    await expect(page).toHaveURL(
      /[?&]a=1(~|%7E)m\.lore_tm_v1_[^~%]+(~|%7E)0(~|%7E)\d+(~|%7E)\d+(~|%7E)[0-9a-z]+/,
    );
    const link = page.url();
    const blockId = new URL(link).searchParams.get("a")!.split("~")[1]!;

    await page.getByTestId("copy-with-source").click();
    await expect(page.getByTestId("copy-with-source")).toContainText("Copied");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain(PASSAGE);
    expect(copied).toContain(link);
    // The copied link is the route's `?a=` link plus the standard text
    // fragment for the quote (a hint browsers strip before scripts see it).
    const copiedLink = copied.trim().split("\n").at(-1)!;
    expect(copiedLink.startsWith(link)).toBe(true);
    expect(new URL(copiedLink).hash).toMatch(/^#:~:text=/);

    // Fresh load of the copied link: the passage is on an older page, so the
    // reader pages back through the real API until it finds the block.
    await page.goto(copiedLink);
    expect(new URL(page.url()).hash).toBe("");
    const marks = page.locator("mark.passage-target");
    await expect(marks.first()).toBeVisible();
    expect((await marks.allTextContents()).join("")).toBe(PASSAGE);
    await expect(page.getByTestId("selection-quote")).toContainText(PASSAGE);
    await expect(page.locator(`[data-row-key="${blockId}"]`)).toContainText(
      "needle-5)",
    );
    await expect(page.getByTestId("link-state")).toHaveCount(0);
    // The link search paged all the way back to the start of history.
    await expect(page.getByTestId("reader-coverage-line")).toContainText(
      "230 messages, complete as captured",
    );
  });

  test("a distillation is labelled compressed context, placed after its sources and never a search hit", async ({
    page,
  }) => {
    await openReader(page);
    await page.getByTestId("load-older").click();
    await page.getByTestId("load-older").click();
    await expect(page.getByTestId("history-start")).toBeVisible();
    // Its text mentions needle-0 … needle-9, yet only the message counts.
    await page.getByTestId("search-input").fill("needle-9");
    await expect(page.getByTestId("search-summary")).toContainText("1 match");
    await page.getByTestId("search-next").click();
    await expect(rowWith(page, "needle-9 and")).toBeVisible();
    await page.getByTestId("search-clear").click();

    const distillation = page.locator('[data-origin="distillation"]');
    await expect(distillation).toHaveCount(1);
    await expect(distillation).toContainText("Compressed context");
    await expect(distillation).toContainText("generation 0");
    await expect(distillation).toContainText("not what anyone said");
    await expect(distillation.locator("pre")).toHaveCount(0);
    // Placed after the newest message it summarises (message 9), before 10.
    const order = await page
      .locator("[data-row-key]")
      .evaluateAll((rows) =>
        rows.map((r) =>
          r.querySelector('[data-origin="distillation"]')
            ? "distillation"
            : (/needle-(\d+) and/.exec(r.textContent ?? "")?.[1] ?? "?"),
        ),
      );
    const at = order.indexOf("distillation");
    expect(at).toBeGreaterThan(0);
    expect(order[at - 1]).toBe("9");
    expect(order[at + 1]).toBe("10");

    await distillation.getByText("Show compressed context").click();
    await expect(distillation.locator("pre")).toContainText(
      "message 5 fixes SQLite as the store",
    );
  });

  test("UX-02: a link whose source changed shows an honest state and highlights nothing", async ({
    page,
  }) => {
    await openReader(page);
    await page.getByTestId("load-older").click();
    await page.getByTestId("load-older").click();
    await expect(page.getByTestId("history-start")).toBeVisible();
    await selectInRow(page, "needle-5)", PASSAGE);
    await expect(page).toHaveURL(/[?&]a=/);
    const url = new URL(page.url());
    const anchor = url.searchParams.get("a")!;
    // Same block, same span, a different content hash: what a link made
    // before the source was edited looks like.
    const fields = anchor.split("~");
    fields[5] = fields[5] === "deadbeef" ? "cafebabe" : "deadbeef";
    url.searchParams.set("a", fields.join("~"));

    await page.goto(url.toString());
    const state = page.getByTestId("link-state");
    await expect(state).toContainText(
      "Source changed since this link was made",
    );
    await expect(state).toHaveAttribute("data-tone", "warn");
    await expect(page.locator("mark.passage-target")).toHaveCount(0);
    await expect(page.getByTestId("selection-panel")).toHaveCount(0);

    // A block that is not in the captured history at all.
    url.searchParams.set("a", "1~m.never-existed~0~0~5~abc");
    await page.goto(url.toString());
    await expect(page.getByTestId("link-state")).toContainText(
      "not in this session's captured history",
    );
    await expect(page.getByTestId("history-start")).toBeVisible();
  });

  test("in-session search covers unmounted rows and can select a hit as a source anchor", async ({
    page,
  }) => {
    await openReader(page);
    const rows = page.locator("[data-row-key]");
    const mounted = await rows.count();
    expect(mounted).toBeLessThan(100);
    // needle-225 lives on the first page but far below the viewport.
    await expect(rowWith(page, "needle-225")).toHaveCount(0);

    await page.getByTestId("search-input").fill("needle-225");
    await expect(page.getByTestId("search-summary")).toContainText(
      "1 match in loaded history",
    );
    await expect(page.getByTestId("search-coverage")).toContainText(
      "Searched the loaded history only",
    );
    await page.getByTestId("search-next").click();
    await expect(page.getByTestId("search-summary")).toContainText("1 of 1");
    const hit = page.locator("mark.passage-search");
    await expect(hit).toHaveText("needle-225");
    await expect(rowWith(page, "needle-225")).toBeVisible();

    await page.getByTestId("search-select").click();
    await expect(page.getByTestId("selection-quote")).toContainText(
      "needle-225",
    );
    await expect(page).toHaveURL(/[?&]a=1(~|%7E)m\.lore_tm_v1_/);
    await expect(page.locator("mark.passage-target")).toHaveText("needle-225");

    // A hit on an older page is not a hit until that page is loaded.
    await page.getByTestId("search-input").fill("needle-5)");
    await expect(page.getByTestId("search-summary")).toContainText(
      "No matches in loaded history",
    );
    await page.getByTestId("load-older").click();
    await page.getByTestId("load-older").click();
    await expect(page.getByTestId("search-summary")).toContainText(
      "1 match in loaded history",
    );
    await expect(page.getByTestId("search-coverage")).toHaveCount(0);
    // The selection made from the earlier hit is untouched by the new search.
    await expect(page.getByTestId("selection-quote")).toContainText(
      "needle-225",
    );
  });

  test("keyboard: rows are focusable and Enter selects a whole block", async ({
    page,
  }) => {
    await openReader(page);
    const first = page.locator("[data-row-key]").first();
    await first.focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("selection-panel")).toContainText(
      /whole message/,
    );
    await expect(page).toHaveURL(
      /[?&]a=1(~|%7E)m\.lore_tm_v1_[^~%]+(~|%7E)(~|%7E)0(~|%7E)0(~|%7E)/,
    );
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("selection-panel")).toHaveCount(0);
    await expect(page).not.toHaveURL(/[?&]a=/);
  });
});
