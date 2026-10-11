/**
 * Reply-to-selection (APP-02) against the BUILT gateway and the seeded
 * `e2e-reader` session. Each test anchors on its own message (needle-N) so
 * discussions created by one test never overlap another's.
 */
import { expect, test, type Page } from "@playwright/test";

import { openReader, rowWith, selectInRow } from "./reader-helpers";

const isMobile = () => test.info().project.name.includes("mobile");

function isCreate(url: string, method: string) {
  return method === "POST" && /\/api\/v1\/discussions(\?|$)/.test(url);
}

/** Project of each discussion a test started, for direct API calls. */
const projectOf = new Map<string, string>();

async function startThread(page: Page, text: string) {
  await page.getByTestId("start-thread").click();
  const composer = page.getByTestId("start-thread-composer");
  await composer.getByRole("textbox").fill(text);
  const created = page.waitForResponse((r) =>
    isCreate(r.url(), r.request().method()),
  );
  await composer.getByTestId("composer-submit").click();
  const res = await created;
  expect(res.status()).toBe(201);
  const { discussion } = await res.json();
  projectOf.set(discussion.id, discussion.project_id);
  return discussion.id as string;
}

const indicator = (page: Page, id: string) =>
  page.locator(
    `[data-testid="discussion-indicator"][data-discussion-id="${id}"]`,
  );
const thread = (page: Page, id: string) =>
  page.locator(`[data-testid="discussion-thread"][data-discussion-id="${id}"]`);

/** Drafts held in the browser's IndexedDB `drafts` store. */
async function storedDrafts(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    const name = dbs.find((d) => d.name?.includes("lore"))?.name;
    if (!name) return [];
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const rows = await new Promise<{ body: { text?: string } }[]>(
      (resolve, reject) => {
        const req = db.transaction("drafts").objectStore("drafts").getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      },
    );
    db.close();
    return rows.map((r) => r.body.text ?? "");
  });
}

test.describe("reply to selection", () => {
  test("select → start thread → reply → reload → still there", async ({
    page,
  }) => {
    test.skip(
      isMobile(),
      "inline threads are desktop; mobile is covered below",
    );
    await openReader(page);
    await selectInRow(page, "needle-229 ", "discusses needle-229");
    await expect(page.getByTestId("selection-actions")).toBeVisible();
    for (const label of ["Ask agent", "Explore separately", "Share finding"]) {
      await expect(
        page
          .getByTestId("selection-actions")
          .getByRole("button", { name: new RegExp(`^${label}`) }),
      ).toHaveAttribute("aria-disabled", "true");
    }
    const id = await startThread(page, "First thought on 229");

    // A new discussion starts collapsed, with focus on its indicator.
    await expect(indicator(page, id)).toBeFocused();
    await expect(thread(page, id)).toHaveCount(0);
    await expect(
      indicator(page, id).getByTestId("discussion-reply-count"),
    ).toHaveText("1");
    await page.keyboard.press("Enter");
    await expect(thread(page, id)).toBeVisible();
    await expect(thread(page, id).getByTestId("discussion-reply")).toHaveCount(
      1,
    );
    await thread(page, id).getByRole("textbox").fill("A reply on 229");
    // While the reply is in flight the box is read-only, so nothing typed
    // then can be left behind as a draft.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route(
      /\/api\/v1\/discussions\/[^/]+\/replies/,
      async (route) => {
        await held;
        await route.continue();
      },
    );
    await thread(page, id).getByTestId("composer-submit").click();
    await expect(thread(page, id).getByRole("textbox")).not.toBeEditable();
    release();
    await expect(thread(page, id).getByTestId("discussion-reply")).toHaveCount(
      2,
    );
    await page.unrouteAll();

    await page.reload();
    await expect(page.getByTestId("session-view")).toBeVisible();
    await expect(indicator(page, id)).toBeVisible();
    await expect(
      indicator(page, id).getByTestId("discussion-reply-count"),
    ).toHaveText("2");
    await expect(page.locator(`mark[data-discussion="${id}"]`)).toContainText(
      "discusses needle-229",
    );
    await indicator(page, id).click();
    await expect(thread(page, id)).toContainText("First thought on 229");
    await expect(thread(page, id)).toContainText("A reply on 229");

    // Escape collapses back to the indicator, which keeps focus.
    await thread(page, id).getByRole("textbox").focus();
    await page.keyboard.press("Escape");
    await expect(thread(page, id)).toHaveCount(0);
    await expect(indicator(page, id)).toBeFocused();
    await expect(indicator(page, id)).toHaveAttribute("aria-expanded", "false");

    // Re-expanding refetches, so a reply posted elsewhere shows up.
    const project = projectOf.get(id)!;
    const { discussion } = await (
      await page.request.get(`/api/v1/discussions/${id}?project=${project}`)
    ).json();
    const posted = await page.request.post(
      `/api/v1/discussions/${id}/replies?project=${project}`,
      {
        data: {
          expected_revision: discussion.revision,
          body: "Posted elsewhere on 229",
        },
      },
    );
    expect(posted.status()).toBe(201);
    await indicator(page, id).click();
    await expect(thread(page, id)).toContainText("Posted elsewhere on 229");
    await thread(page, id).getByRole("textbox").focus();
    await page.keyboard.press("Escape");
    await expect(thread(page, id)).toHaveCount(0);

    // The posted first reply is not left behind as a draft at its anchor.
    await selectInRow(page, "needle-229 ", "discusses needle-229");
    await page.getByTestId("start-thread").click();
    await expect(
      page.getByTestId("start-thread-composer").getByRole("textbox"),
    ).toHaveValue("");
    await expect(page.getByTestId("draft-restored")).toHaveCount(0);
  });

  test("overlapping selections start independent threads", async ({ page }) => {
    test.skip(isMobile(), "inline threads are desktop");
    await openReader(page);
    await selectInRow(page, "needle-228 ", "e2e reader session");
    const first = await startThread(page, "Outer thread");

    await selectInRow(page, "needle-228 ", "session discusses");
    const actions = page.getByTestId("selection-actions");
    await expect(actions.getByTestId("reply-in-existing")).toHaveCount(1);
    await expect(actions.getByTestId("start-thread")).toHaveText(
      "Start independent thread",
    );
    const second = await startThread(page, "Independent thread");
    expect(second).not.toBe(first);

    // Overlapping marks split at each other's edges; each discussion's
    // fragments still cover exactly its own selection.
    const row = rowWith(page, "needle-228 ");
    const covered = async (id: string) =>
      (
        await row.locator(`mark[data-discussion="${id}"]`).allTextContents()
      ).join("");
    await expect.poll(() => covered(first)).toBe("e2e reader session");
    await expect.poll(() => covered(second)).toBe("session discusses");
    for (const id of [first, second]) {
      await expect(
        indicator(page, id).getByTestId("discussion-reply-count"),
      ).toHaveText("1");
    }

    // Replying in the existing discussion from an overlapping selection
    // adds to that one only.
    await selectInRow(page, "needle-228 ", "reader");
    await page
      .getByTestId("selection-actions")
      .getByTestId("reply-in-existing")
      .first()
      .click();
    const target = page.getByTestId("discussion-thread");
    await expect(target).toHaveCount(1);
    await target.getByRole("textbox").fill("Joining the outer thread");
    await target.getByTestId("composer-submit").click();
    await expect(target.getByTestId("discussion-reply")).toHaveCount(2);
    const joined = (await target.getAttribute("data-discussion-id"))!;
    const other = joined === first ? second : first;
    await expect(
      indicator(page, other).getByTestId("discussion-reply-count"),
    ).toHaveText("1");
  });

  test("focused view → Back to source restores the passage", async ({
    page,
  }) => {
    test.skip(isMobile(), "mobile focused view is covered separately");
    const projectId = await openReader(page);
    await selectInRow(page, "needle-227 ", "discusses needle-227");
    const id = await startThread(page, "Thread to focus");
    await indicator(page, id).click();
    await thread(page, id).getByTestId("discussion-open").click();

    await expect(page).toHaveURL(
      new RegExp(`/ui/projects/${projectId}/discussions/${id}$`),
    );
    await expect(page.getByTestId("discussion-quote")).toHaveText(
      "discusses needle-227",
    );
    await expect(page.getByTestId("discussion-author")).toContainText("You");
    await expect(page.getByTestId("discussion-focus")).toContainText(
      "Thread to focus",
    );

    await page.getByTestId("back-to-source").click();
    await expect(page).toHaveURL(/\/sessions\/e2e-reader\?a=/);
    await expect(page.locator("mark.passage-target")).toHaveText(
      "discusses needle-227",
    );
    await expect(page.locator("mark.passage-target")).toBeInViewport();
  });

  test("mobile: a discussion opens as its own view", async ({ page }) => {
    test.skip(!isMobile(), "mobile only");
    await openReader(page);
    await selectInRow(page, "needle-226 ", "discusses needle-226");
    const id = await startThread(page, "Mobile thread");
    // An overlapping second discussion grows the selection panel on return.
    await selectInRow(page, "needle-226 ", "needle-226 and");
    await startThread(page, "Overlapping mobile thread");
    await indicator(page, id).click();

    await expect(page).toHaveURL(new RegExp(`/discussions/${id}$`));
    await expect(page.getByTestId("discussion-focus")).toBeVisible();
    await expect(page.getByTestId("session-view")).toHaveCount(0);
    await page
      .getByTestId("discussion-focus")
      .getByRole("textbox")
      .fill("From the phone");
    await page.getByTestId("composer-submit").click();
    await expect(page.getByTestId("discussion-reply")).toHaveCount(2);

    await page.getByTestId("back-to-source").click();
    await expect(page.getByTestId("session-view")).toBeVisible();
    // The restored passage sits above the selection panel, not behind it.
    const target = page.locator("mark.passage-target").first();
    await expect(target).toBeInViewport();
    await expect
      .poll(async () => {
        const mark = await target.boundingBox();
        const panel = await page.getByTestId("selection-panel").boundingBox();
        return !!mark && (!panel || mark.y + mark.height <= panel.y);
      })
      .toBe(true);
    await indicator(page, id).click();
    await expect(page).toHaveURL(new RegExp(`/discussions/${id}$`));
  });

  test("Save note creates one note however fast it is clicked", async ({
    page,
  }) => {
    const creates: string[] = [];
    page.on("request", (req) => {
      if (isCreate(req.url(), req.method())) creates.push(req.url());
    });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route(/\/api\/v1\/discussions(\?|$)/, async (route) => {
      if (route.request().method() === "POST") await held;
      await route.continue();
    });
    await openReader(page);
    const needle = isMobile() ? "discusses needle-220" : "discusses needle-221";
    const marker = isMobile() ? "needle-220 " : "needle-221 ";
    await selectInRow(page, marker, needle);
    const save = page.getByTestId("save-note");
    await save.dblclick();
    await expect(save).toBeDisabled();
    release();
    await expect(
      rowWith(page, marker).getByTestId("discussion-indicator"),
    ).toHaveCount(1);
    await page.unrouteAll();
    expect(creates).toHaveLength(1);
  });

  test("drafts persist across reload and are never sent", async ({ page }) => {
    const sent: string[] = [];
    page.on("request", (req) => {
      if (
        req.method() === "POST" &&
        req.url().includes("/api/v1/discussions")
      ) {
        sent.push(req.url());
      }
    });
    await openReader(page);
    const needle = isMobile() ? "discusses needle-224" : "discusses needle-225";
    const marker = isMobile() ? "needle-224 " : "needle-225 ";
    await selectInRow(page, marker, needle);
    await page.getByTestId("start-thread").click();
    await page
      .getByTestId("start-thread-composer")
      .getByRole("textbox")
      .fill("Unsent draft text");
    await expect.poll(() => storedDrafts(page)).toContain("Unsent draft text");

    await page.reload();
    await expect(page.getByTestId("session-view")).toBeVisible();
    await selectInRow(page, marker, needle);
    await page.getByTestId("start-thread").click();
    const box = page.getByTestId("start-thread-composer").getByRole("textbox");
    await expect(box).toHaveValue("Unsent draft text");
    await expect(page.getByTestId("draft-restored")).toBeVisible();
    expect(sent).toEqual([]);
  });
});
