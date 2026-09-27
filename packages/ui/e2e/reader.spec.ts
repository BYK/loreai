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

/**
 * Click load-older without scrolling: a real `.click()` scrolls the button
 * into view, and that scroll to the top pages a second older page in by
 * itself (#1923). dispatchEvent drives the handler in place.
 */
async function clickLoadOlder(page: Page) {
  await page.getByTestId("load-older").dispatchEvent("click");
}

/** `aria-setsize` is the logical row count — same on every mounted row. */
async function setsize(page: Page) {
  const value = await page
    .locator("[data-row-key]")
    .first()
    .getAttribute("aria-setsize");
  return Number(value);
}

/** The quick-search bar is collapsed until Ctrl/Cmd+F or the Find button opens it. */
async function openSearch(page: Page) {
  await page.getByTestId("search-open").click();
  await expect(page.getByTestId("search-input")).toBeFocused();
}

/** Bring the (possibly unmounted) row mentioning `marker` into view via search. */
async function revealRow(page: Page, marker: string) {
  await openSearch(page);
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
  test("lands at the newest message and pages older history in on an upward scroll", async ({
    page,
  }) => {
    await openReader(page);
    // The reader opens on the newest row, not the top of the loaded window.
    await expect(rowWith(page, "needle-229")).toBeInViewport();
    await expect(rowWith(page, "needle-130 ")).toHaveCount(0);
    await expect(page.getByTestId("reader-coverage-line")).toContainText(
      "100 of 230",
    );
    const scroll = page.getByTestId("session-scroll");
    const initial = await setsize(page);

    // Scrolling to the top pages older history in by itself — no button.
    await scroll.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect.poll(() => setsize(page)).toBe(initial + 100);
    await expect(page.getByTestId("reader-coverage-line")).toContainText(
      "200 of 230",
    );

    await scroll.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect(page.getByTestId("history-start")).toBeVisible();
    await expect.poll(() => setsize(page)).toBe(initial + 130);
    await expect(page.getByTestId("reader-coverage-line")).toContainText(
      "230 messages, complete as captured",
    );
  });

  test("UX-01: select a passage → stable link → reload → same passage highlighted", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openReader(page);
    await expect(page.getByTestId("reader-coverage-line")).toContainText(
      "100 of 230 captured messages loaded",
    );
    await expect(page.getByTestId("native-transcript")).toHaveCount(0);
    await expect(page.getByTestId("reader-coverage-line")).toHaveAttribute(
      "title",
      /Lore-captured history/,
    );
    // The first page is the newest 100 messages; message 5 is older history.
    await expect(rowWith(page, "needle-5)")).toHaveCount(0);
    await clickLoadOlder(page);
    await expect(page.getByTestId("reader-coverage-line")).toContainText(
      "200 of 230",
    );
    await clickLoadOlder(page);
    await expect(page.getByTestId("history-start")).toBeVisible();
    await expect(page.getByTestId("reader-coverage")).toHaveAttribute(
      "data-coverage",
      "captured",
    );
    await expect(
      page
        .getByTestId("reader-coverage")
        .getByText("Captured history", { exact: true }),
    ).toHaveCount(0);
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

  test("loading older history twice keeps the row under the eye where it was", async ({
    page,
  }) => {
    // The distillation over messages 0–9 is the first row throughout: the
    // prepended pages land after it, so a first-row witness would never see
    // them. The rows arrive unmeasured and are measured against the scroll
    // offset the virtualiser holds at that moment. Measured from the sticky
    // toolbar's edge, which the row is read against.
    await openReader(page);
    await revealRow(page, "needle-180 ");
    const rowTop = () =>
      rowWith(page, "needle-180 ").evaluate(
        (row) =>
          row.getBoundingClientRect().top -
          document
            .querySelector('[data-testid="reader-toolbar"]')!
            .getBoundingClientRect().bottom,
      );
    const before = await rowTop();
    await clickLoadOlder(page);
    await expect(page.getByTestId("reader-coverage-line")).toContainText(
      "200 of 230",
    );
    // The unmeasured prepended rows settle once the virtualiser measures
    // them; the row's position converges to where it was, never a fixed wait.
    await expect
      .poll(async () => Math.abs((await rowTop()) - before))
      .toBeLessThan(2);
    await clickLoadOlder(page);
    await expect(page.getByTestId("history-start")).toBeVisible();
    await expect
      .poll(async () => Math.abs((await rowTop()) - before))
      .toBeLessThan(2);
  });

  test("a distillation is labelled compressed context, placed after its sources and never a search hit", async ({
    page,
  }) => {
    await openReader(page);
    await clickLoadOlder(page);
    await clickLoadOlder(page);
    await expect(page.getByTestId("history-start")).toBeVisible();
    // Its text mentions needle-0 … needle-9, yet only the message counts.
    await openSearch(page);
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
    await clickLoadOlder(page);
    await clickLoadOlder(page);
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

  test("quick search opens on Ctrl+F, counts n/m, highlights all matches and returns focus on Escape", async ({
    page,
  }, testInfo) => {
    await openReader(page);
    const input = page.getByTestId("search-input");
    if (testInfo.project.name.includes("mobile")) {
      // Touch devices have no Ctrl+F: the toolbar Find button is the entry.
      await openSearch(page);
    } else {
      // Ctrl+F while a row has focus opens the bar and focuses the input.
      const row = page.locator("[data-row-key]").last();
      await row.focus();
      await page.keyboard.press("Control+f");
      await expect(input).toBeFocused();
    }

    await input.fill("needle-1");
    await expect(page.getByTestId("search-summary")).toContainText(
      /in loaded history/,
    );
    const count = page.getByTestId("search-count");
    await expect(count).toHaveText(/^\d+\/\d+$/);
    const total = Number(((await count.textContent()) ?? "0/0").split("/")[1]);
    expect(total).toBeGreaterThan(1);

    // Enter steps forward: the current-hit row changes and every mounted
    // match carries a mark.
    await page.keyboard.press("Enter");
    await expect(count).toHaveText("1/" + total);
    const currentRow = page.locator("[data-search-current]");
    await expect(currentRow).toHaveCount(1);
    const firstKey = await currentRow.getAttribute("data-row-key");
    await expect(page.locator("mark.passage-search")).toHaveCount(1);
    await page.keyboard.press("Enter");
    await expect(count).toHaveText("2/" + total);
    const secondKey = await page
      .locator("[data-search-current]")
      .getAttribute("data-row-key");
    expect(secondKey).not.toBe(firstKey);
    await expect
      .poll(() => page.locator("mark.passage-search-all").count())
      .toBeGreaterThan(0);
    await page.keyboard.press("Shift+Enter");
    await expect(count).toHaveText("1/" + total);

    // A second Ctrl+F inside the input falls through (no bar toggle).
    await page.keyboard.press("Control+f");
    await expect(page.getByTestId("quick-search")).toBeVisible();

    // Escape closes and focus returns inside the reader (the row, or the
    // scroller if stepping unmounted it).
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("quick-search")).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const scroll = document.querySelector(
            '[data-testid="session-scroll"]',
          );
          return scroll !== null && scroll.contains(document.activeElement);
        }),
      )
      .toBe(true);
  });

  test("in-session search covers unmounted rows and can select a hit as a source anchor", async ({
    page,
  }) => {
    await openReader(page);
    const rows = page.locator("[data-row-key]");
    const mounted = await rows.count();
    expect(mounted).toBeLessThan(100);
    // needle-150 lives on the first page, far above the landed viewport.
    await expect(rowWith(page, "needle-150")).toHaveCount(0);

    await openSearch(page);
    await page.getByTestId("search-input").fill("needle-150");
    await expect(page.getByTestId("search-summary")).toContainText(
      "1 match in loaded history",
    );
    await expect(page.getByTestId("search-coverage")).toContainText(
      "Searched the loaded history only",
    );
    await page.getByTestId("search-next").click();
    await expect(page.getByTestId("search-summary")).toContainText("1 of 1");
    const hit = page.locator("mark.passage-search");
    await expect(hit).toHaveText("needle-150");
    await expect(rowWith(page, "needle-150")).toBeVisible();

    await page.getByTestId("search-select").click();
    await expect(page.getByTestId("selection-quote")).toContainText(
      "needle-150",
    );
    await expect(page).toHaveURL(/[?&]a=1(~|%7E)m\.lore_tm_v1_/);
    await expect(page.locator("mark.passage-target")).toHaveText("needle-150");

    // A hit on an older page is not a hit until that page is loaded.
    await page.getByTestId("search-input").fill("needle-5)");
    await expect(page.getByTestId("search-summary")).toContainText(
      "No matches in loaded history",
    );
    await clickLoadOlder(page);
    await clickLoadOlder(page);
    await expect(page.getByTestId("search-summary")).toContainText(
      "1 match in loaded history",
    );
    await expect(page.getByTestId("search-coverage")).toHaveCount(0);
    // The selection made from the earlier hit is untouched by the new search.
    await expect(page.getByTestId("selection-quote")).toContainText(
      "needle-150",
    );
  });

  test("whole-session search reaches a hit two older pages back, highlights it and its link survives reload", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openReader(page);
    // Message 8 is on the oldest page; "needle-8 and" is a literal nothing on
    // the loaded page contains (needle-18x carries a different digit run).
    const query = "needle-8 and";
    await openSearch(page);
    await page.getByTestId("search-input").fill(query);
    await expect(page.getByTestId("search-summary")).toContainText(
      "No matches in loaded history",
    );
    await expect(page.locator("mark.passage-search")).toHaveCount(0);

    await page.getByTestId("search-whole").click();
    const whole = page.getByTestId("search-whole-summary");
    await expect(whole).toHaveAttribute("data-whole-state", "done");
    await expect(whole).toContainText(
      "1 matching message in the whole session · 1 in older history",
    );
    // Still nothing on screen: a server hit is not a highlight until loaded.
    await expect(page.locator("mark.passage-search")).toHaveCount(0);

    await page.getByTestId("search-whole-next").click();
    await expect(page.getByTestId("search-summary")).toContainText(
      "1 of 1 in loaded history",
    );
    const hit = page.locator("mark.passage-search");
    await expect(hit).toHaveText(query);
    await expect(hit).toBeInViewport();
    await expect(rowWith(page, "needle-8 and")).toBeVisible();
    await expect(page.getByTestId("reader-coverage-line")).toContainText(
      "230 messages, complete as captured",
    );
    await expect(whole).toContainText("nothing more in older history");
    await expect(page.getByTestId("search-whole-next")).toHaveCount(0);
    await expect(page.getByTestId("search-reach")).toHaveCount(0);

    // The hit becomes an addressable passage like any other selection.
    await page.getByTestId("search-select").click();
    await expect(page.getByTestId("selection-quote")).toContainText(query);
    await page.getByTestId("copy-with-source").click();
    await expect(page.getByTestId("copy-with-source")).toContainText("Copied");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    const copiedLink = copied.trim().split("\n").at(-1)!;

    // A fresh document (not a same-page fragment hop): the passage is three
    // pages back, so the reader pages through the real API again. The cached
    // window may show the passage first ("completeness unknown"); the server's
    // newest page then restarts the window and the link search re-pages to it.
    await page.goto("about:blank");
    await page.goto(copiedLink);
    await expect(page.getByTestId("reader-coverage-line")).toContainText(
      "230 messages, complete as captured",
    );
    await expect(page.getByTestId("stale-indicator")).toHaveCount(0);
    const marks = page.locator("mark.passage-target");
    await expect(marks).toHaveText([query]);
    // Viewport position after reload is #1863 (mobile lands under the panel).
    await expect(page.getByTestId("link-state")).toHaveCount(0);
  });

  test("keyboard: rows are focusable and Enter selects a whole block", async ({
    page,
  }) => {
    await openReader(page);
    // The landed reader mounts overscan rows beyond the viewport edge and
    // marker rows among the messages — focus a real message row or Enter
    // has no block to select.
    await revealRow(page, "needle-200");
    const first = rowWith(page, "needle-200");
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
