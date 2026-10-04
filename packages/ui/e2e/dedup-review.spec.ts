import { expect, test } from "@playwright/test";

async function projectByName(page: import("@playwright/test").Page) {
  const response = await page.request.get("/api/v1/projects");
  expect(response.ok()).toBe(true);
  const projects = (await response.json()) as Array<{
    id: string;
    name: string;
  }>;
  const project = projects.find((item) => item.name === "dedup-review");
  if (!project) throw new Error("seeded dedup-review project is missing");
  return project.id;
}

test.describe("read-only duplicate review (MEM-01)", () => {
  test("previews groups, stores local decisions, and never mutates the server", async ({
    page,
  }, testInfo) => {
    const projectId = await projectByName(page);
    const knowledgePath = `/api/v1/projects/${projectId}/knowledge`;
    const beforeResponse = await page.request.get(knowledgePath);
    expect(beforeResponse.ok()).toBe(true);
    const before = await beforeResponse.json();
    const requests: Array<{ method: string; pathname: string }> = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/v1/")) {
        requests.push({ method: request.method(), pathname: url.pathname });
      }
    });

    await page.goto(`/ui/projects/${projectId}`);
    const navOpener = page.getByTestId("open-nav");
    const navDuplicates = page.getByTestId("nav-duplicates");
    if (await navOpener.isVisible()) {
      await navOpener.click();
      const drawerLink = page
        .getByTestId("nav-drawer")
        .getByTestId("nav-duplicates");
      await expect(drawerLink).toHaveAttribute(
        "href",
        `/ui/projects/${projectId}/duplicates`,
      );
      await drawerLink.click();
    } else {
      await expect(navDuplicates).toHaveAttribute(
        "href",
        `/ui/projects/${projectId}/duplicates`,
      );
      await navDuplicates.click();
    }
    await expect(page).toHaveURL(`/ui/projects/${projectId}/duplicates`);
    await page.goto(`/ui/projects/${projectId}`);
    await page.getByTestId("review-duplicates-link").click();
    await expect(page).toHaveURL(`/ui/projects/${projectId}/duplicates`);
    const review = page.getByTestId("duplicate-review");
    await expect(review).toBeVisible();
    await expect(
      review.getByTestId("duplicate-group").filter({
        hasText: "Duplicate review evidence sample candidate alpha",
      }),
    ).toHaveCount(1);
    await expect(
      review.getByTestId("duplicate-group").filter({
        hasText: "Shared-only evidence review seed alpha",
      }),
    ).toHaveCount(1);
    await expect(
      review
        .getByText("Duplicate review evidence sample candidate alpha")
        .first(),
    ).toBeVisible();
    await expect(review.getByText("Project scope").first()).toBeVisible();
    await expect(review.getByText("Title overlap").first()).toBeVisible();
    await expect(review.getByText(/\d+%/).first()).toBeVisible();
    await expect(review.getByTestId("duplicate-group").first()).toContainText(
      /\d+% match/,
    );
    await expect(review.getByText("v1").first()).toBeVisible();
    await expect(
      review.getByText(
        "First project candidate with complete review evidence.",
      ),
    ).toBeVisible();
    await expect(
      review.getByText(
        "Second project candidate with a separate full content body.",
      ),
    ).toBeVisible();
    await expect(
      review.getByRole("link", { name: "Open knowledge document" }),
    ).toHaveCount(2);
    await expect(
      review.getByRole("link", { name: "e2e-dedup-review" }).first(),
    ).toBeVisible();
    await expect(review.getByText(/Updated /).first()).toBeVisible();

    const sharedGroup = review.getByTestId("duplicate-group").filter({
      hasText: "Shared-only evidence review seed alpha",
    });
    await sharedGroup.click();
    await expect(review.getByText("Shared (no project)").first()).toBeVisible();
    await expect(review).not.toContainText(/\bglobal\b/i);
    await expect(review.getByText("Shared scope").first()).toBeVisible();
    await expect(
      review.getByText("Hostile text stays inert in the review screen:"),
    ).toBeVisible();
    await expect(review.locator("img")).toHaveCount(0);
    await expect(review).toContainText("<img src=x onerror=");
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as Window & { __pwned?: number }).__pwned ?? 0,
        ),
      )
      .toBe(0);
    const columns = review.getByTestId("duplicate-candidate");
    await expect(columns).toHaveCount(2);
    await expect(columns.first()).toContainText(/Match \d+%/);
    await expect(columns.first()).toContainText(/Confidence \d+%/);
    const firstBox = await columns.nth(0).boundingBox();
    const secondBox = await columns.nth(1).boundingBox();
    expect(firstBox).not.toBeNull();
    expect(secondBox).not.toBeNull();
    if (firstBox && secondBox && testInfo.project.name.includes("mobile")) {
      expect(Math.abs(firstBox.x - secondBox.x)).toBeLessThan(4);
      expect(secondBox.y).toBeGreaterThan(firstBox.y);
    } else if (firstBox && secondBox) {
      expect(secondBox.x).toBeGreaterThan(firstBox.x);
      expect(Math.abs(firstBox.y - secondBox.y)).toBeLessThan(4);
    }

    await review
      .getByTestId("duplicate-group")
      .filter({
        hasText: /^Duplicate review evidence sample candidate alpha/,
      })
      .click();
    await page.keyboard.press("a");
    await expect(review.getByTestId("review-summary")).toContainText(
      "1 accepted",
    );
    await page.reload();
    const reloaded = page.getByTestId("duplicate-review");
    await expect(reloaded.getByTestId("duplicate-group").first()).toContainText(
      "Accepted",
    );
    await expect(reloaded.getByTestId("review-summary")).toContainText(
      "1 accepted",
    );

    await page.getByLabel("Keep this one (2)").check();
    await expect(page.getByLabel("Keep this one (2)")).toBeChecked();
    const selectedKeepId = await page
      .getByLabel("Keep this one (2)")
      .getAttribute("value");
    if (!selectedKeepId) throw new Error("selected keeper id is missing");
    await expect
      .poll(() =>
        page.evaluate(
          async ({ projectId, keepId }) => {
            const database = await new Promise<IDBDatabase>(
              (resolve, reject) => {
                const request = indexedDB.open("lore-ui", 4);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
              },
            );
            try {
              const records = await new Promise<unknown[]>(
                (resolve, reject) => {
                  const request = database
                    .transaction("reviewDecisions", "readonly")
                    .objectStore("reviewDecisions")
                    .getAll();
                  request.onsuccess = () =>
                    resolve(request.result as unknown[]);
                  request.onerror = () => reject(request.error);
                },
              );
              return records.some((record) => {
                if (!record || typeof record !== "object") return false;
                const mark = record as {
                  kind?: string;
                  projectId?: string;
                  keepId?: string;
                };
                return (
                  mark.kind === "dedup" &&
                  mark.projectId === projectId &&
                  mark.keepId === keepId
                );
              });
            } finally {
              database.close();
            }
          },
          { projectId, keepId: selectedKeepId },
        ),
      )
      .toBe(true);
    await page.reload();
    await expect(page.getByLabel("Keep this one (2)")).toBeChecked();

    await sharedGroup.click();
    await page.keyboard.press("s");
    await expect(page.getByTestId("review-summary")).toContainText("1 skipped");
    await page.keyboard.press("u");
    await expect(page.getByTestId("review-summary")).toContainText(
      /1 accepted · 0 skipped · \d+ pending/,
    );

    const afterResponse = await page.request.get(knowledgePath);
    expect(afterResponse.ok()).toBe(true);
    expect(await afterResponse.json()).toEqual(before);

    const disallowed = requests.filter(
      ({ method, pathname }) =>
        method !== "GET" &&
        !(
          method === "POST" &&
          pathname === `/api/v1/projects/${projectId}/dedup`
        ),
    );
    expect(disallowed).toEqual([]);
    expect(
      requests.filter(
        ({ method, pathname }) =>
          method === "POST" &&
          pathname === `/api/v1/projects/${projectId}/dedup`,
      ),
    ).toHaveLength(4);
  });
});
