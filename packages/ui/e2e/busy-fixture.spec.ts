/**
 * `/ui/fixture?view=busy` — the deterministic busy-session fixture (plan
 * §16.1) on the real `SessionView`. Dev-only (Vite dev server). Proves that
 * selection, anchors, focus and the scroll position survive virtualisation
 * and streaming, that the queue and the mounted DOM stay bounded, and
 * records the measured budgets as JSON in the test output directory.
 */
import { expect, test, type Page } from "@playwright/test";

/** Structural bounds: independent of machine speed, always asserted. */
const MAX_MOUNTED_ROWS = 60;
const MAX_QUEUE_HIGH_WATER = 400;
/**
 * Timing bounds. Wall-clock numbers depend on the machine and on how many
 * Playwright workers share it, so the README budget (250 ms, measured on an
 * otherwise idle box) is only asserted with `LORE_E2E_STRICT_BUDGET=1`; the
 * default bound catches pathologies (an O(n²) apply, a mount that blocks
 * the thread for seconds), not scheduler noise.
 */
const STRICT_BUDGET = process.env.LORE_E2E_STRICT_BUDGET === "1";
const MAX_LONG_TASK_MS = STRICT_BUDGET ? 250 : 2_000;

interface Report {
  inputToPaintP95: number | null;
  frames: { count: number; p95: number | null; max: number | null };
  longTasks: { count: number; totalMs: number; maxMs: number | null };
  apply: { count: number; totalMs: number; p95: number | null };
  queueHighWater: number;
  heapUsedBytes: number | null;
  deltas: { count: number; chars: number; minChars: number; maxChars: number };
  blocks: number;
  mounted: number;
  generateMs: number;
  received: number;
  applied: number;
  appended: number;
  approvals: number;
}

async function openBusy(page: Page, query = "") {
  await page.goto(`/ui/fixture?view=busy${query}`);
  await expect(page.getByTestId("fixture-banner")).toContainText(
    "NOT PRODUCTION",
  );
  await expect(page.getByTestId("session-view")).toBeVisible();
  await expect(page.getByTestId("busy-mounted")).not.toContainText(
    "mounted rows 0",
  );
}

async function mountedRows(page: Page) {
  return page.locator('[data-testid="session-rows"] [data-row-key]').count();
}

/** Select a 12-character run inside the first mounted prose part with a real Range. */
async function selectSomePassage(page: Page): Promise<string> {
  const part = page
    .locator('[data-testid="session-rows"] [data-block][data-part="0"] p')
    .first();
  await expect(part).toBeVisible();
  const quote = await part.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n as Text;
      if (text.data.trim().length < 20) continue;
      const range = document.createRange();
      range.setStart(text, 2);
      range.setEnd(text, 14);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      return text.data.slice(2, 14);
    }
    throw new Error("no long enough text node");
  });
  await part
    .locator("xpath=ancestor::*[@data-row-key]")
    .dispatchEvent("pointerup");
  return quote;
}

async function snapshotReport(page: Page): Promise<Report> {
  await page.getByTestId("busy-metrics").click();
  const json = await page.getByTestId("busy-report-json").textContent();
  return JSON.parse(json ?? "{}") as Report;
}

async function settle(page: Page) {
  await expect(page.getByTestId("busy-pending")).toHaveText("pending 0");
}

test.describe("busy-session fixture", () => {
  test("10k blocks: bounded mounted rows, complete coverage, selection and focus survive streaming and a burst", async ({
    page,
  }, testInfo) => {
    await openBusy(page);
    await expect(page.getByTestId("busy-fixture")).toBeVisible();
    await expect(
      page.getByText(/10,000 synthetic blocks · seed 7/),
    ).toBeVisible();
    await expect(page.getByTestId("reader-coverage")).toHaveAttribute(
      "data-coverage",
      "captured",
    );
    await expect(page.getByTestId("native-transcript")).toContainText(
      "Native transcript not yet available",
    );
    const mountedBefore = await mountedRows(page);
    expect(mountedBefore).toBeGreaterThan(0);
    expect(mountedBefore).toBeLessThan(MAX_MOUNTED_ROWS);

    // Selection is logical: it survives a burst, streaming and re-mounts.
    const quote = await selectSomePassage(page);
    await expect(page.getByTestId("selection-quote")).toContainText(quote);
    await expect(page).toHaveURL(
      /[?&]a=1(~|%7E)m\.busy-\d{6}(~|%7E)0(~|%7E)\d+(~|%7E)\d+(~|%7E)[0-9a-z]+/,
    );
    const link = page.url();
    const anchor = new URL(link).searchParams.get("a")!;
    const rowKey = `m.${anchor.split("~")[1]!.slice(2)}`;
    const row = page.locator(`[data-row-key="${rowKey}"]`);
    await row.focus();
    await expect(row).toBeFocused();
    const scroll = page.getByTestId("session-scroll");
    const scrollTopBefore = await scroll.evaluate((el) => el.scrollTop);

    // Synthetic clicks: a real click would move focus onto the button, and
    // the point is that streaming itself never moves focus off the row.
    await page.getByTestId("busy-burst").dispatchEvent("click");
    await page.getByTestId("busy-start").dispatchEvent("click");
    await expect(page.getByTestId("busy-fixture")).toHaveAttribute(
      "data-streaming",
      "true",
    );
    await page.waitForTimeout(3_000);
    await page.getByTestId("busy-stop").dispatchEvent("click");
    await settle(page);

    // Rows appended below the viewport neither move the viewport nor the
    // selection; the focused row is still the focused row.
    expect(await scroll.evaluate((el) => el.scrollTop)).toBe(scrollTopBefore);
    await expect(page).toHaveURL(link);
    await expect(page.getByTestId("selection-quote")).toContainText(quote);
    await expect(row.locator("mark.passage-target")).toHaveText(quote);
    await expect(row).toBeFocused();
    expect(await mountedRows(page)).toBeLessThan(MAX_MOUNTED_ROWS);
    await expect(page.getByTestId("busy-applied")).toHaveText(/applied [1-9]/);

    await page.getByTestId("busy-verify").click();
    await expect(page.getByTestId("busy-verify-result")).toHaveAttribute(
      "data-verify",
      "ok",
    );

    const report = await snapshotReport(page);
    expect(report.blocks).toBeGreaterThan(10_000);
    expect(report.appended).toBeGreaterThan(4);
    expect(report.approvals).toBeGreaterThan(0);
    // 1,000 burst events plus 3 s of 4 × 50/s streaming arrived; frames
    // coalesce them per message, so fewer applies than events is the point.
    expect(report.received).toBeGreaterThanOrEqual(1_000);
    expect(report.applied).toBeGreaterThan(0);
    expect(report.applied).toBeLessThanOrEqual(report.received);
    expect(report.deltas.count).toBeGreaterThanOrEqual(1_000);
    expect(report.mounted).toBeLessThan(MAX_MOUNTED_ROWS);
    // Coalescing by message id: the queue never approaches the event count.
    expect(report.queueHighWater).toBeGreaterThan(0);
    expect(report.queueHighWater).toBeLessThan(MAX_QUEUE_HIGH_WATER);
    expect(report.longTasks.maxMs ?? 0).toBeLessThan(MAX_LONG_TASK_MS);
    await testInfo.attach("busy-report", {
      body: JSON.stringify({ project: testInfo.project.name, ...report }),
      contentType: "application/json",
    });
    console.log(
      `[busy-report ${testInfo.project.name}]`,
      JSON.stringify(report),
    );

    // Reload of the link made under streaming still resolves the passage.
    await page.goto(link);
    await expect(page.locator("mark.passage-target")).toHaveText(quote);
  });

  test("disconnect → stale snapshot is honest until refetch; fresh snapshot converges", async ({
    page,
  }) => {
    await openBusy(page, "&blocks=2000");
    await page.getByTestId("busy-start").click();
    await page.waitForTimeout(600);
    await page.getByTestId("busy-disconnect").click();
    await expect(page.getByTestId("busy-connection")).toHaveText(
      "disconnected",
    );
    // Offline, the reader is honest: it is serving what it has, unconfirmed.
    await expect(page.getByTestId("stale-indicator")).toHaveText("Cached");
    await page.waitForTimeout(1_500);
    await expect(page.getByTestId("busy-pending")).toHaveText("pending 0");

    await page.getByTestId("busy-reconnect-stale").click();
    await expect(page.getByTestId("busy-connection")).toHaveText("connected");
    await expect(page.getByTestId("busy-stale")).toBeVisible();
    await expect(page.getByTestId("stale-indicator")).toHaveText("Cached");
    await page.waitForTimeout(600);
    await page.getByTestId("busy-stop").click();
    await settle(page);
    await page.getByTestId("busy-verify").click();
    // Messages that started and finished while offline are missing from the
    // stale snapshot and never re-appear in the delta stream.
    await expect(page.getByTestId("busy-verify-result")).toHaveAttribute(
      "data-verify",
      "mismatch",
    );
    await expect(page.getByTestId("busy-verify-result")).toContainText(
      /[1-9]\d* missing/,
    );
    await page.getByTestId("busy-refetch").click();
    await expect(page.getByTestId("busy-stale")).toHaveCount(0);
    await expect(page.getByTestId("stale-indicator")).toHaveCount(0);
    await page.getByTestId("busy-verify").click();
    await expect(page.getByTestId("busy-verify-result")).toHaveAttribute(
      "data-verify",
      "ok",
    );

    // Fresh reconnect path.
    await page.getByTestId("busy-start").click();
    await page.getByTestId("busy-disconnect").click();
    await page.waitForTimeout(800);
    await page.getByTestId("busy-reconnect").click();
    await page.waitForTimeout(300);
    await page.getByTestId("busy-stop").click();
    await settle(page);
    await page.getByTestId("busy-verify").click();
    await expect(page.getByTestId("busy-verify-result")).toHaveAttribute(
      "data-verify",
      "ok",
    );
  });

  test("hidden tab queues coalesced work and replays it; cache-write failures do not touch the reader", async ({
    page,
  }) => {
    await openBusy(page, "&blocks=2000");
    await page.getByTestId("busy-cache-fail").click();
    await expect(page.getByTestId("busy-cache-fail")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByTestId("busy-start").click();
    await page.getByTestId("busy-hide").click();
    await expect(page.getByTestId("busy-state")).toContainText("tab hidden");
    await page.waitForTimeout(1_000);
    // Queue bounded by live message count while hidden, not by event count.
    const pending = await page.getByTestId("busy-pending").textContent();
    const queued = Number(pending?.replace(/\D/g, ""));
    expect(queued).toBeGreaterThan(0);
    expect(queued).toBeLessThan(MAX_QUEUE_HIGH_WATER);
    await expect(page.getByTestId("busy-state")).not.toContainText(
      "tab hidden",
      { timeout: 5_000 },
    );
    await page.getByTestId("busy-stop").click();
    await settle(page);
    await expect(page.getByTestId("busy-cache-failures")).toContainText(
      /cache write failed ×[1-9]/,
    );
    await page.getByTestId("busy-verify").click();
    await expect(page.getByTestId("busy-verify-result")).toHaveAttribute(
      "data-verify",
      "ok",
    );
  });

  test("editing the linked block shows the honest source-changed state", async ({
    page,
  }) => {
    await openBusy(page, "&blocks=500");
    const quote = await selectSomePassage(page);
    await expect(page.getByTestId("selection-quote")).toContainText(quote);
    await expect(page.getByTestId("busy-edit-linked")).toBeEnabled();
    await page.getByTestId("busy-edit-linked").click();
    await expect(page.getByTestId("link-state")).toContainText(
      "Source changed since this link was made",
    );
    await expect(page.locator("mark.passage-target")).toHaveCount(0);
    await expect(page.getByTestId("selection-panel")).toHaveCount(0);
  });

  test("search covers unmounted rows and turns a hit into a source anchor", async ({
    page,
  }) => {
    await openBusy(page, "&blocks=3000");
    const mounted = await mountedRows(page);
    expect(mounted).toBeLessThan(MAX_MOUNTED_ROWS);
    // Lore-injected blocks are rare (one in 97) and the reader opens at the
    // newest end, so every hit starts out unmounted.
    await expect(page.locator("mark.passage-search")).toHaveCount(0);
    await page.getByTestId("search-input").fill("Project knowledge");
    await expect(page.getByTestId("search-summary")).toContainText(
      /\d+ matches in loaded history/,
    );
    await page.getByTestId("search-next").click();
    await expect(page.locator("mark.passage-search")).toHaveText(
      "Project knowledge",
    );
    await page.getByTestId("search-prev").click();
    await expect(page.locator("mark.passage-search")).toHaveText(
      "Project knowledge",
    );
    await page.getByTestId("search-select").click();
    await expect(page.getByTestId("selection-quote")).toContainText(
      "Project knowledge",
    );
    await expect(page.locator("mark.passage-target")).toHaveText(
      "Project knowledge",
    );
    await expect(page).toHaveURL(/[?&]a=1(~|%7E)m\.busy-\d{6}(~|%7E)0(~|%7E)/);
  });

  test("leaving the fixture disposes timers and does not retain the session", async ({
    page,
  }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("HeapProfiler.enable");
    const heap = async () => {
      await cdp.send("HeapProfiler.collectGarbage");
      const { usedSize } = await cdp.send("Runtime.getHeapUsage");
      return usedSize;
    };
    const samples: number[] = [];
    for (let i = 0; i < 3; i++) {
      await openBusy(page, "&blocks=3000");
      await page.getByTestId("busy-start").click();
      await page.waitForTimeout(500);
      await page.getByTestId("busy-stop").click();
      await page.goto("/ui/fixture");
      await expect(page.getByTestId("fixture-document")).toBeVisible();
      samples.push(await heap());
    }
    // Three mount/unmount cycles: the last sample is within 25 % of the
    // first — a leaked 3k-block session would add far more.
    expect(samples[2]!).toBeLessThan(samples[0]! * 1.25);
  });
});
