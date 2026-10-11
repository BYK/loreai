import { expect, test } from "@playwright/test";

test.describe("activity search navigation", () => {
  test("updates the header range when infinite scroll loads another page", async ({
    page,
  }) => {
    let activityResponses = 0;
    let loadedActivityCount = 0;
    page.on("response", (response) => {
      if (new URL(response.url()).pathname.endsWith("/api/v1/activity")) {
        void response.json().then((page) => {
          activityResponses += 1;
          loadedActivityCount += page.items.length;
        });
      }
    });
    await page.goto("/ui");

    const scroller = page.getByTestId("activity-list-body");
    const header = page.getByTestId("activity-list-header");
    await expect(header).toContainText("Inbox 1 – 50");
    await expect.poll(() => activityResponses).toBe(1);
    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect.poll(() => activityResponses).toBe(2);
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollHeight))
      .toBeGreaterThan(4000);
    await expect.poll(() => loadedActivityCount).toBeGreaterThan(50);
    await expect(header).toContainText(`Inbox 1 – ${loadedActivityCount}`);
  });

  test("searches with grammar and highlights the active built-in search", async ({
    page,
  }) => {
    await page.goto("/ui");
    const search = page.getByRole("searchbox", { name: "Search list" });
    await search.fill("type:session");
    await search.press("Enter");

    await expect(page).toHaveURL(/\/ui\/?\?q=type%3Asession$/);
    if (await page.getByTestId("open-nav").isVisible()) {
      await page.getByTestId("open-nav").click();
    }
    await expect(
      page.getByRole("link", { name: "Sessions", exact: true }),
    ).toHaveClass(/bg-selected/);
    const rows = page.getByTestId("activity-item");
    await expect(rows).not.toHaveCount(0);
    await expect
      .poll(() =>
        rows.evaluateAll((items) =>
          items.every(
            (item) => item.getAttribute("data-activity-kind") === "session",
          ),
        ),
      )
      .toBe(true);
    await expect(page.getByTestId("activity-list-header")).toContainText(
      "Sessions",
    );
  });

  test("shows a parse error without requesting invalid queries", async ({
    page,
  }) => {
    let activityRequests = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.endsWith("/api/v1/activity")) {
        activityRequests++;
      }
    });
    await page.goto("/ui");
    await expect(page.getByTestId("activity-item").first()).toBeVisible();
    const before = activityRequests;

    const search = page.getByRole("searchbox", { name: "Search list" });
    await search.fill("unknown:value");
    await search.press("Enter");
    await expect(page.getByTestId("activity-query-error")).toBeVisible();
    await expect(page.getByTestId("activity-query-error")).toContainText(
      "unknown:value",
    );
    await expect.poll(() => activityRequests).toBe(before);
  });

  test("resets the query to the inbox when Escape is pressed", async ({
    page,
  }) => {
    await page.goto("/ui");
    const search = page.getByRole("searchbox", { name: "Search list" });
    await search.fill("type:session");
    await search.press("Enter");
    await expect(page).toHaveURL(/\/ui\/?\?q=type%3Asession$/);

    await search.fill("type:knowledge");
    await search.press("Escape");
    await expect(page).toHaveURL(/\/ui\/?$/);
    await expect(search).toHaveValue("");
    await expect(page.getByTestId("activity-list-header")).toContainText(
      "Inbox",
    );
  });

  test("saves, edits, reloads, and deletes a search", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name.includes("mobile"), "desktop navigation");
    await page.goto("/ui");
    const search = page.getByRole("searchbox", { name: "Search list" });
    await search.fill("type:session with:codex");
    await search.press("Enter");
    await page.getByTestId("save-search-open").click();

    await page.getByTestId("saved-search-title").fill("Codex sessions");
    await page.getByTestId("saved-search-submit").click();
    const saved = page.getByTestId("saved-search");
    await expect(saved).toContainText("Codex sessions");
    await expect(saved).toHaveAttribute(
      "href",
      /q=type%3Asession(?:%20|\+)with%3Acodex/,
    );

    await page.getByTestId("saved-search-edit").click();
    await page.getByTestId("saved-search-title").fill("Recent Codex");
    await page
      .getByTestId("saved-search-query")
      .fill("type:session with:codex after:2024-01-01");
    await page.getByTestId("saved-search-submit").click();
    await expect(saved).toContainText("Recent Codex");
    await page.reload();
    await expect(page.getByTestId("saved-search")).toContainText(
      "Recent Codex",
    );

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("saved-search-delete").click();
    await expect(page.getByTestId("saved-search")).toHaveCount(0);
  });

  test("pins an active project, persists it, and opens its search", async (
    { page },
    testInfo,
  ) => {
    test.skip(testInfo.project.name.includes("mobile"), "desktop navigation");
    const projects = await (await page.request.get("/api/v1/projects")).json();
    const lore = projects.find(
      (project: { name: string }) => project.name === "lore",
    );
    await page.goto(`/ui/projects/${lore.id}`);
    const pin = page.getByTestId("toggle-active-project-pin");
    await expect(pin).toBeVisible();
    await pin.click();
    await expect(pin).toHaveAttribute("aria-pressed", "true");
    const pinned = page.getByTestId("pinned-project-search");
    await expect(pinned).toBeVisible();
    await pinned.click();
    await expect(page).toHaveURL(/\/ui\/?\?q=project%3A/);
    await expect(page.getByTestId("activity-item").first()).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("pinned-project-search")).toBeVisible();

    await page.goto(`/ui/projects/${lore.id}`);
    const unpin = page.getByTestId("toggle-active-project-pin");
    await expect(unpin).toHaveAttribute("aria-pressed", "true");
    await unpin.click();
    await expect(page.getByTestId("pinned-project-search")).toHaveCount(0);
  });
});
