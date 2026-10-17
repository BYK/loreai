import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

async function projectAndEntry(page: Page) {
  const projects = await (await page.request.get("/api/v1/projects")).json();
  const project = projects.find(
    (item: { name: string }) => item.name === "lore",
  );
  const knowledge = await (
    await page.request.get(`/api/v1/projects/${project.id}/knowledge`)
  ).json();
  return {
    project,
    live: knowledge.find(
      (item: { title: string }) =>
        item.title === "Keep SQLite as the only store",
    ),
    expired: knowledge.find(
      (item: { title: string }) =>
        item.title === "Expired source sessions remain identifiable",
    ),
    summary: knowledge.find(
      (item: { title: string }) =>
        item.title === "Retained summaries stay readable",
    ),
  };
}

async function fileLinkProjectAndEntry(page: Page) {
  const projects = await (await page.request.get("/api/v1/projects")).json();
  const project = projects.find(
    (item: { name: string }) => item.name === "file-links",
  );
  expect(project).toBeTruthy();
  const knowledge = await (
    await page.request.get(`/api/v1/projects/${project.id}/knowledge`)
  ).json();
  const entry = knowledge.find(
    (item: { title: string }) =>
      item.title === "GitHub file link provenance fixture",
  );
  expect(entry).toBeTruthy();
  return { project, entry };
}

test.describe("knowledge detail provenance and history", () => {
  test("compares consecutive versions and offers a keyboard-accessible full-text view", async ({
    page,
  }) => {
    const { project, live } = await projectAndEntry(page);
    await page.route(
      `**/api/v1/knowledge/${live.id}/versions`,
      async (route) => {
        const response = await route.fetch();
        const history = await response.json();
        for (const version of history.versions) {
          version.content = version.is_current
            ? "Use WAL journaling.\nKeep lexical recall."
            : "Use rollback journaling.\nKeep lexical recall.";
        }
        await route.fulfill({ response, json: history });
      },
    );
    await page.goto(`/ui/projects/${project.id}/knowledge/${live.id}`);
    const current = page.getByTestId("knowledge-version-2");
    await current.locator("summary").click();
    const content = current.getByTestId("version-content");
    await expect(content.locator("del")).toHaveText("rollback");
    await expect(content.locator("ins")).toHaveText("WAL");
    const fullText = current.getByRole("button", {
      name: "Full text",
      exact: true,
    });
    await fullText.focus();
    await page.keyboard.press("Enter");
    await expect(fullText).toHaveAttribute("aria-pressed", "true");
    await expect(content).toHaveText(
      "Use WAL journaling.\nKeep lexical recall.",
    );
    await expect(content.locator("ins, del")).toHaveCount(0);
    await current.getByRole("button", { name: "Changes", exact: true }).click();
    await expect(content.locator("del")).toHaveText("rollback");
  });

  test("shows current and superseded versions with old content", async ({
    page,
  }) => {
    const { project, live } = await projectAndEntry(page);
    await page.goto(`/ui/projects/${project.id}/knowledge/${live.id}`);
    const history = page.getByTestId("version-history");
    await expect(history).toBeVisible();
    await expect(history.getByText("Current")).toHaveCount(1);
    await expect(history.getByText(/Superseded/)).toHaveCount(1);
    await history.getByTestId("knowledge-version-1").locator("summary").click();
    await expect(history).toContainText("Portability is a requirement");
  });

  test("links live source evidence to the exact session", async ({ page }) => {
    const { project, live } = await projectAndEntry(page);
    await page.goto(`/ui/projects/${project.id}/knowledge/${live.id}`);
    const source = page.getByRole("link", {
      name: "Distilled from session",
    });
    await expect(source).toHaveAttribute(
      "href",
      `/ui/projects/${project.id}/sessions/e2e-session-sqlite`,
    );
    await source.click();
    await expect(page).toHaveURL(
      new RegExp(`/ui/projects/${project.id}/sessions/e2e-session-sqlite$`),
    );
  });

  test("links recorded knowledge files to the recorded GitHub commit", async ({
    page,
  }) => {
    const { project, entry } = await fileLinkProjectAndEntry(page);
    await page.goto(`/ui/projects/${project.id}/knowledge/${entry.id}`);
    await expect(page.getByRole("heading", { name: "Files" })).toBeVisible();
    await expect(
      page.getByText("packages/ui/src/contracts/url.ts"),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /GitHub at 0123456/ }),
    ).toHaveAttribute(
      "href",
      "https://github.com/BYK/loreai/blob/0123456789abcdef0123456789abcdef01234567/packages/ui/src/contracts/url.ts",
    );
  });

  test("shows expired evidence without redirecting to another session", async ({
    page,
  }) => {
    const { project, expired } = await projectAndEntry(page);
    await page.goto(`/ui/projects/${project.id}/knowledge/${expired.id}`);
    await expect(
      page.getByText("Source session no longer available"),
    ).toBeVisible();
    await expect(page.getByText("e2e-session-expired").first()).toBeVisible();
  });

  test("opens retained summary text for expired evidence", async ({ page }) => {
    const { project, summary } = await projectAndEntry(page);
    await page.goto(`/ui/projects/${project.id}/knowledge/${summary.id}`);
    await expect(page.getByText("retained summary only")).toBeVisible();
    await page.getByText("Show retained summary").click();
    await expect(
      page.getByText(
        "Retained summary for the expired session: the team chose WAL mode.",
      ),
    ).toBeVisible();
  });

  test.describe("mobile", () => {
    test.use({ viewport: { width: 393, height: 852 }, isMobile: true });

    test("back from detail preserves the table query", async ({ page }) => {
      const { project, live } = await projectAndEntry(page);
      await page.goto(
        `/ui/projects/${project.id}/knowledge?q=SQLite&sort=title:asc`,
      );
      await page.goto(
        `/ui/projects/${project.id}/knowledge/${live.id}?q=SQLite&sort=title:asc`,
      );
      await expect(page.getByTestId("knowledge-document")).toBeVisible();
      await page.getByTestId("mobile-back").click();
      await expect(page).toHaveURL(/\/knowledge\?q=SQLite&sort=title%3Aasc$/);
    });
  });
});
