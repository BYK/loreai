import { expect, test } from "@playwright/test";
import { expectConnectionStatus, setTheme } from "./helpers";

const FUTURE_ACTIONS = [
  "Save note",
  "Ask agent",
  "Explore separately",
  "Start with selected context",
  "Share finding",
];

test.describe("real data browsing", () => {
  test("projects → knowledge → document, with stable ids in the URL", async ({
    page,
  }) => {
    const projects = await (await page.request.get("/api/v1/projects")).json();
    const lore = projects.find(
      (project: { name: string }) => project.name === "lore",
    );
    await page.goto(`/ui/projects/${lore.id}`);
    await expectConnectionStatus(page);

    await page.getByRole("link", { name: /Browse knowledge/ }).click();
    await expect(page).toHaveURL(/\/ui\/projects\/[^/]+\/knowledge$/);
    const rows = page.getByTestId("knowledge-row");
    // 12 base entries + 1 cross-project contradiction fixture in lore (#1919).
    await expect(rows).toHaveCount(13);
    await rows.filter({ hasText: "Keep SQLite as the only store" }).click();

    const doc = page.getByTestId("knowledge-document");
    await expect(doc).toBeVisible();
    await expect(doc).toContainText("Keep SQLite as the only store");
    await expect(doc).toContainText("single-file SQLite database");

    const url = new URL(page.url());
    const match = url.pathname.match(
      /^\/ui\/projects\/[^/]+\/knowledge\/([^/]+)$/,
    );
    const knowledgeId = decodeURIComponent(match?.[1] ?? "");
    expect(knowledgeId).not.toBe("");
    await expect(doc).toHaveAttribute("data-knowledge-id", knowledgeId);
    // The external id is the stable logical id: it is what the API returns too.
    const detail = await page.request.get(`/api/v1/knowledge/${knowledgeId}`);
    expect(detail.ok()).toBe(true);
    expect((await detail.json()).id).toBe(knowledgeId);

    for (const label of FUTURE_ACTIONS) {
      const button = doc.getByRole("button", { name: new RegExp(`^${label}`) });
      await expect(button).toBeDisabled();
      await expect(button).toContainText("not available yet");
    }
  });

  test("deep link reload lands on the same document", async ({ page }) => {
    const projects = await (await page.request.get("/api/v1/projects")).json();
    const lore = projects.find((p: { name: string }) => p.name === "lore");
    const knowledge = await (
      await page.request.get(`/api/v1/projects/${lore.id}/knowledge`)
    ).json();
    const entry = knowledge.find(
      (k: { title: string }) =>
        k.title === "Gateway serves the SPA from embedded assets",
    );

    await page.goto(`/ui/projects/${lore.id}/knowledge/${entry.id}`);
    await expect(page.getByTestId("knowledge-document")).toContainText(
      "Gateway serves the SPA from embedded assets",
    );
    await page.reload();
    await expect(page.getByTestId("knowledge-document")).toContainText(
      "Gateway serves the SPA from embedded assets",
    );

    // Entry-only deep link resolves its project from the entry.
    await page.goto(`/ui/knowledge/${entry.id}`);
    await expect(page.getByTestId("knowledge-document")).toContainText(
      "Gateway serves the SPA from embedded assets",
    );
  });

  test("unknown entry renders a not-found state, not a crash", async ({
    page,
  }) => {
    await page.goto("/ui/knowledge/does-not-exist");
    await expect(page.getByText("Knowledge entry not found")).toBeVisible();
    await expectConnectionStatus(page);
  });

  test("search entry opens workspace-wide knowledge search", async ({
    page,
  }) => {
    await page.goto("/ui");
    await page
      .locator('form:has([data-testid="search-entry"])')
      .evaluate((form) => {
        const input = form.querySelector<HTMLInputElement>('[name="q"]');
        if (!input) throw new Error("workspace search input missing");
        input.value = "SQLite";
        (form as HTMLFormElement).requestSubmit();
      });
    await expect(page).toHaveURL("/ui/search?q=SQLite");
    await expect(
      page.getByRole("textbox", { name: "Search all knowledge" }),
    ).toHaveValue("SQLite");
    await expect(page.getByTestId("search-hit").first()).toBeVisible();
  });

  test("theme defaults to system; forcing dark persists across reload", async ({
    page,
  }) => {
    await page.goto("/ui");
    const html = page.locator("html");
    await expect(page.getByTestId("theme-toggle")).toHaveAttribute(
      "data-theme-choice",
      "system",
    );
    await expect(html).not.toHaveClass(/dark/);
    await setTheme(page, "dark");
    await expect(html).toHaveClass(/dark/);
    await page.reload();
    await expect(html).toHaveClass(/dark/);
    await expect(page.getByTestId("theme-toggle")).toHaveAttribute(
      "data-theme-choice",
      "dark",
    );
    await setTheme(page, "system");
    await expect(html).not.toHaveClass(/dark/);
  });

  test("dev-only screens are not shipped in the production build", async ({
    page,
  }) => {
    for (const path of [
      "/ui/fixture",
      "/ui/fixture?view=focus",
      "/ui/_compat",
    ]) {
      await page.goto(path);
      await expect(page.getByTestId("not-found")).toBeVisible();
      await expect(page.getByTestId("fixture-banner")).toHaveCount(0);
    }
  });

  test("the main script is served precompressed with brotli", async ({
    page,
  }) => {
    const script = page.waitForResponse((res) =>
      /\/ui\/assets\/[^/?]+\.js$/.test(res.url()),
    );
    await page.goto("/ui");
    const res = await script;
    expect(res.status()).toBe(200);
    const accepted =
      (await res.request().allHeaders())["accept-encoding"] ?? "";
    expect(accepted).toMatch(/\bbr\b/);
    const headers = await res.allHeaders();
    expect(headers["content-encoding"]).toBe("br");
    expect(headers["vary"]).toMatch(/accept-encoding/i);
    // The page actually booted from the encoded script.
    await expectConnectionStatus(page);
  });
});
