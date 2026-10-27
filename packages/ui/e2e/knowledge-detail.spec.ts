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
  for (const width of [320, 1280]) {
    test(`reader aligns sections and exposes complete technical values at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const { project, live } = await projectAndEntry(page);
      const first = "Full stored paragraph " + "word ".repeat(70).trim();
      const last = "Final stored paragraph remains complete and readable.";
      const model = "provider/" + "long-recorded-model-".repeat(18);
      const mutations: string[] = [];
      page.on("request", (request) => {
        if (
          ["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) &&
          new URL(request.url()).pathname.startsWith("/api/v1/")
        )
          mutations.push(request.method() + " " + request.url());
      });
      await page.route(`**/api/v1/knowledge/${live.id}`, async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          response,
          json: {
            ...(await response.json()),
            content: first + "\n\n" + last,
            confidence: 0.45,
          },
        });
      });
      await page.route(
        `**/api/v1/knowledge/${live.id}/versions`,
        async (route) => {
          const response = await route.fetch();
          const history = await response.json();
          for (const version of history.versions)
            version.source_refs.worker_model_id = model;
          await route.fulfill({ response, json: history });
        },
      );
      await page.goto(`/ui/projects/${project.id}/knowledge/${live.id}`);
      const paragraph = page.getByText(first, { exact: true });
      await expect(paragraph).toBeVisible();
      await expect(page.getByText(last, { exact: true })).toBeVisible();
      const header = await page
        .getByRole("heading", { name: live.title, exact: true })
        .boundingBox();
      const body = await paragraph.boundingBox();
      const promotion = await page.getByTestId("promotion-panel").boundingBox();
      if (!header || !body || !promotion)
        throw new Error("Missing reader geometry");
      expect(Math.abs(header.x - body.x)).toBeLessThan(2);
      expect(Math.abs(promotion.x - body.x)).toBeLessThan(2);
      const edit = await page
        .getByRole("button", { name: "Edit", exact: true })
        .boundingBox();
      const remove = await page
        .getByRole("button", { name: "Delete", exact: true })
        .boundingBox();
      if (!edit || !remove) throw new Error("Missing reader actions");
      expect(
        Math.abs(edit.y + edit.height / 2 - remove.y - remove.height / 2),
      ).toBeLessThan(2);
      expect(remove.x - edit.x - edit.width).toBeGreaterThanOrEqual(8);
      if (width === 320) {
        expect(edit.height).toBeGreaterThanOrEqual(44);
        expect(remove.height).toBeGreaterThanOrEqual(44);
      }
      await page.getByText("Source & history", { exact: true }).click();
      const technical = page
        .getByText("Technical details", { exact: true })
        .locator("..");
      await technical.locator("summary").click();
      const value = technical.getByText(model, { exact: true });
      await expect(value).toBeVisible();
      const fits = await value.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(element);
        return (
          element.scrollWidth <= element.clientWidth &&
          Array.from(range.getClientRects()).every(
            (rect) => rect.left >= box.left - 1 && rect.right <= box.right + 1,
          )
        );
      });
      expect(fits).toBe(true);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
      expect(mutations).toEqual([]);
    });
  }
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
    await page.getByText("Source & history", { exact: true }).click();
    const current = page.getByTestId("knowledge-version-2");
    await current.locator("summary").click();
    const content = current.getByTestId("version-content");
    await expect(content.locator("del")).toHaveText("rollback");
    await expect(content.locator("ins")).toHaveText("WAL");
    const fullText = current.getByRole("button", {
      name: "Full text",
      exact: true,
    });
    const changes = current.getByRole("button", {
      name: "Changes",
      exact: true,
    });
    const selector = current.getByRole("group", { name: "Version 2 view" });
    await changes.click();
    await expect(changes).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("ArrowRight");
    await expect(fullText).toBeFocused();
    await expect(changes).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Enter");
    await expect(fullText).toHaveAttribute("aria-pressed", "true");
    await fullText.click();
    await expect(fullText).toHaveAttribute("aria-pressed", "true");
    await expect(selector.getByRole("button", { pressed: true })).toHaveCount(
      1,
    );
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(fullText).toBeFocused();
    await expect(content).toHaveText(
      "Use WAL journaling.\nKeep lexical recall.",
    );
    await expect(content.locator("ins, del")).toHaveCount(0);
    await page.keyboard.press("Home");
    await expect(changes).toBeFocused();
    await page.keyboard.press("Space");
    await expect(changes).toHaveAttribute("aria-pressed", "true");
    await expect(content.locator("del")).toHaveText("rollback");
  });

  test("shows exact complete text without a view selector for oversized history", async ({
    page,
  }) => {
    const { project, live } = await projectAndEntry(page);
    const content = "Use WAL journaling.\n".repeat(1000);
    await page.route(
      `**/api/v1/knowledge/${live.id}/versions`,
      async (route) => {
        const response = await route.fetch();
        const history = await response.json();
        for (const version of history.versions) {
          version.content = version.is_current
            ? content
            : "Old journal.\n".repeat(1000);
        }
        await route.fulfill({ response, json: history });
      },
    );
    await page.goto(`/ui/projects/${project.id}/knowledge/${live.id}`);
    await page.getByText("Source & history", { exact: true }).click();
    const current = page.getByTestId("knowledge-version-2");
    await current.locator("summary").click();
    await expect(current).toContainText(
      "Changes too large to compare. Showing full text.",
    );
    await expect(
      current.getByRole("group", { name: "Version 2 view" }),
    ).toHaveCount(0);
    expect(await current.getByTestId("version-content").textContent()).toBe(
      content,
    );
    await expect(current.locator("ins, del")).toHaveCount(0);
  });

  test("shows current and superseded versions with old content", async ({
    page,
  }) => {
    const { project, live } = await projectAndEntry(page);
    await page.goto(`/ui/projects/${project.id}/knowledge/${live.id}`);
    await page.getByText("Source & history", { exact: true }).click();
    const history = page.getByTestId("version-history");
    await expect(history).toBeVisible();
    await expect(history.getByText("Current")).toHaveCount(1);
    await expect(history.getByText(/Superseded/)).toHaveCount(1);
    await history.getByTestId("knowledge-version-1").locator("summary").click();
    await expect(history).toContainText("Portability is a requirement");
  });

  test("explains unavailable project context for a workspace source", async ({
    page,
  }) => {
    const { live } = await projectAndEntry(page);
    await page.route(`**/api/v1/knowledge/${live.id}`, async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        json: { ...(await response.json()), project_id: null },
      });
    });
    await page.goto(`/ui/knowledge/${live.id}`);
    const message =
      "Source project unavailable; source availability cannot be checked.";
    await expect(page.getByTestId("knowledge-source-summary")).toHaveText(
      message,
    );
    await page.getByText("Source & history", { exact: true }).click();
    await expect(page.getByTestId("trust-section")).toContainText(message);
    await expect(page.getByText("Checking source…")).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Distilled from session" }),
    ).toHaveCount(0);
  });

  test("links live source evidence to the exact session", async ({ page }) => {
    const { project, live } = await projectAndEntry(page);
    await page.goto(`/ui/projects/${project.id}/knowledge/${live.id}`);
    await page.getByText("Source & history", { exact: true }).click();
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
    await page.getByText("Source & history", { exact: true }).click();
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
    await page.getByText("Source & history", { exact: true }).click();
    await expect(
      page.getByText("Source session no longer available", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("e2e-session-expired").first()).toBeVisible();
  });

  test("opens retained summary text for expired evidence", async ({ page }) => {
    const { project, summary } = await projectAndEntry(page);
    await page.goto(`/ui/projects/${project.id}/knowledge/${summary.id}`);
    await expect(page.getByTestId("knowledge-source-summary")).toContainText(
      "retained summary only",
    );
    await page.getByText("Source & history", { exact: true }).click();
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
