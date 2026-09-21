import { expect, test, type Page } from "@playwright/test";

const PAYLOAD = "<script>window.__pwned=1</script>";

async function hostileFixtures(page: Page) {
  const projects = await (await page.request.get("/api/v1/projects")).json();
  const project = projects.find(
    (item: { name: string }) => item.name === "hostile",
  );
  const entries = await (
    await page.request.get(`/api/v1/projects/${project.id}/knowledge`)
  ).json();
  const sessions = await (
    await page.request.get(`/api/v1/projects/${project.id}/sessions`)
  ).json();
  return { project, entry: entries[0], session: sessions[0] };
}

async function assertSafe(page: Page, literal = true) {
  await expect.poll(() => page.evaluate(() => window.__pwned)).toBe(0);
  const unsafe = await page.evaluate(() => {
    const main = document.querySelector("main");
    return {
      scripts: main?.querySelectorAll("script").length ?? 0,
      iframes: main?.querySelectorAll("iframe").length ?? 0,
      svgHandlers: main?.querySelectorAll("svg[onload]").length ?? 0,
      errorHandlers: main?.querySelectorAll("[onerror]").length ?? 0,
      javascriptLinks: Array.from(main?.querySelectorAll("a") ?? []).filter(
        (a) => a.href.toLowerCase().startsWith("javascript:"),
      ).length,
      text: main?.textContent ?? "",
    };
  });
  expect(unsafe.scripts).toBe(0);
  expect(unsafe.iframes).toBe(0);
  expect(unsafe.svgHandlers).toBe(0);
  expect(unsafe.errorHandlers).toBe(0);
  expect(unsafe.javascriptLinks).toBe(0);
  if (literal) expect(unsafe.text).toContain(PAYLOAD);
}

test.describe("hostile content stays inert", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.__pwned = 0;
    });
    page.on(
      "dialog",
      (dialog) =>
        void dialog.dismiss().then(() => {
          throw new Error(`unexpected dialog: ${dialog.message()}`);
        }),
    );
  });

  test("all production content surfaces render hostile text inertly", async ({
    page,
  }) => {
    const { project, entry, session } = await hostileFixtures(page);
    const screens = [
      [`/ui/projects/${project.id}`, false],
      [`/ui/projects/${project.id}/knowledge`, true],
      [`/ui/projects/${project.id}/knowledge/${entry.id}`, true],
      [`/ui/knowledge/${entry.id}`, true],
      [`/ui/projects/${project.id}/sessions`, false],
      [`/ui/projects/${project.id}/sessions/${session.session_id}`, true],
      [`/ui/projects/${project.id}/search?q=script&scope=all`, false],
    ] as const;
    for (const [path, showsPayload] of screens) {
      await page.goto(path);
      await assertSafe(page, showsPayload);
    }
  });

  test("version history and workspace search remain inert", async ({
    page,
  }) => {
    const { project, entry } = await hostileFixtures(page);
    await page.goto(`/ui/projects/${project.id}/knowledge/${entry.id}`);
    await page
      .getByTestId("version-history")
      .locator("summary")
      .first()
      .click();
    await assertSafe(page);

    await page.goto("/ui");
    const searchInput = page.getByRole("textbox", { name: "Search" });
    if (await searchInput.isVisible()) {
      await searchInput.press("Enter");
    } else {
      await page.getByTestId("search-entry").click();
    }
    await expect(page.getByRole("dialog")).toBeVisible();
    await assertSafe(page, false);
  });
});

declare global {
  interface Window {
    __pwned: number;
  }
}
