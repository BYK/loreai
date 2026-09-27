/**
 * Context window pane + transcript markers (#1924) against the BUILT gateway
 * and the seeded `e2e-reader` session (injections, one prompt delta, two
 * gradient-stamped turns). Desktop shows the aside; mobile switches via the
 * tablist. Markers live inside the virtualised transcript, so the spec
 * scrolls the session container instead of searching for them.
 */
import { expect, test, type Page } from "@playwright/test";

async function openReader(page: Page) {
  const projects = await (await page.request.get("/api/v1/projects")).json();
  const lore = projects.find((p: { name: string }) => p.name === "lore");
  await page.goto(`/ui/projects/${lore.id}/sessions/e2e-reader`);
  await expect(page.getByTestId("session-view")).toBeVisible();
}

/** Scroll the transcript to its newest rows so the tail markers mount. */
async function scrollToNewest(page: Page) {
  await page
    .getByTestId("session-scroll")
    .evaluate((el) => el.scrollTo(0, el.scrollHeight));
}

test.describe("context window", () => {
  test("desktop: pane shows summary, injections, delta and markers", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name.includes("mobile"), "desktop layout only");
    await openReader(page);

    const pane = page.getByTestId("context-window");
    await expect(pane).toBeVisible();
    const summary = pane.getByTestId("context-summary");
    await expect(summary).toContainText("Sent to model:");
    await expect(summary).toContainText("6,100");
    await expect(summary).toContainText("18,400");
    await expect(summary).toContainText("Layer 1");

    const injections = pane.getByTestId("context-injections");
    const link = injections.locator("a").first();
    await expect(link).toBeVisible();
    expect(await link.getAttribute("href")).toContain("/knowledge/");

    const deltas = pane.getByTestId("context-deltas");
    await expect(deltas).toContainText("seq 0");
    // The delta text sits behind <details> as inert text.
    await deltas.locator("summary").click();
    await expect(deltas).toContainText("[memory refreshed] e2e delta text");

    // Markers interleave the transcript; the seeded events sit near the
    // newest messages, mounted once the container is scrolled to the end.
    await scrollToNewest(page);
    await expect(page.locator('[data-marker="compaction"]')).toBeVisible();
    await expect(page.locator('[data-marker="injection"]')).toBeVisible();
    await expect(page.locator('[data-marker="delta"]')).toBeVisible();
    await expect(
      page.locator('[data-marker="compaction"]').first(),
    ).toContainText("Layer 1 · 18,400 raw → 6,100 sent");
  });

  test("mobile: the tablist switches panes and keeps the transcript mounted", async ({
    page,
  }, testInfo) => {
    test.skip(!testInfo.project.name.includes("mobile"), "mobile layout only");
    await openReader(page);

    const transcriptTab = page.getByTestId("session-tab-transcript");
    const contextTab = page.getByTestId("session-tab-context");
    await expect(transcriptTab).toBeVisible();
    await expect(transcriptTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("context-window")).toBeHidden();

    await contextTab.click();
    await expect(contextTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("context-window")).toBeVisible();
    await expect(page.getByTestId("session-view")).toBeHidden();
    // Still mounted, just hidden.
    await expect(page.getByTestId("session-view")).toHaveCount(1);

    await contextTab.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(transcriptTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("session-view")).toBeVisible();
    await expect(page.getByTestId("context-window")).toBeHidden();
  });
});
