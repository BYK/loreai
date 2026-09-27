import { expect, test, type Page } from "@playwright/test";

const PAYLOAD = "<script>window.__pwned=1</script>";
const ALIAS_PAYLOAD = '<img src=x onerror="window.__pwned=1">';
const ROLE_PAYLOAD = '<a href="javascript:window.__pwned=1">link</a>';
const DESCRIPTION_PAYLOAD =
  '<iframe srcdoc="<script>window.__pwned=1</script>"></iframe>';
const NOTES_PAYLOAD = "[x](javascript:window.__pwned=1)";

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

async function assertSafe(
  page: Page,
  literal = true,
  container = page.locator("main"),
) {
  if (literal) await expect(container).toContainText(PAYLOAD);
  await expect.poll(() => page.evaluate(() => window.__pwned)).toBe(0);
  const unsafe = await container.evaluate((main) => {
    return {
      scripts: main.querySelectorAll("script").length,
      iframes: main.querySelectorAll("iframe").length,
      svgHandlers: main.querySelectorAll("svg[onload]").length,
      errorHandlers: main.querySelectorAll("[onerror]").length,
      javascriptLinks: Array.from(main.querySelectorAll("a")).filter((a) =>
        a.href.toLowerCase().startsWith("javascript:"),
      ).length,
      text: main.textContent ?? "",
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
  });

  test("all production content surfaces render hostile text inertly", async ({
    page,
  }) => {
    const dialogs: string[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    const { project, entry, session } = await hostileFixtures(page);
    await page.goto(`/ui/projects/${project.id}`);
    await expect(page.getByTestId("health")).toContainText("knowledge");
    await assertSafe(page, false);

    await page.goto(`/ui/projects/${project.id}/knowledge`);
    await expect(page.getByTestId("knowledge-row").first()).toBeVisible();
    await expect(
      page.getByTestId("knowledge-row").filter({ hasText: "<script>" }).first(),
    ).toBeVisible();
    await assertSafe(page);

    await page.goto(`/ui/projects/${project.id}/knowledge/${entry.id}`);
    await expect(page.getByTestId("knowledge-document")).toBeVisible();
    await assertSafe(page);

    await page.goto(`/ui/knowledge/${entry.id}`);
    await expect(page.getByTestId("knowledge-document")).toBeVisible();
    await assertSafe(page);

    await page.goto(`/ui/projects/${project.id}/sessions`);
    await expect(page.getByText(session.session_id)).toBeVisible();
    await assertSafe(page, false);

    await page.goto(
      `/ui/projects/${project.id}/sessions/${session.session_id}`,
    );
    await expect(page.getByTestId("session-rows")).toContainText(PAYLOAD);
    await assertSafe(page);

    await page.goto(`/ui/projects/${project.id}/search?q=pwned&scope=all`);
    await expect(page.locator("main")).toContainText(PAYLOAD);
    await expect(
      page.locator("main p").filter({ hasText: PAYLOAD }).first(),
    ).toBeVisible();
    await assertSafe(page);
    expect(dialogs).toEqual([]);
  });

  test("version history and workspace search remain inert", async ({
    page,
  }) => {
    const dialogs: string[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    const { project, entry } = await hostileFixtures(page);
    await page.goto(`/ui/projects/${project.id}/knowledge/${entry.id}`);
    await page
      .getByTestId("version-history")
      .locator("summary")
      .first()
      .click();
    await expect(page.getByTestId("version-history")).toContainText(PAYLOAD);
    await assertSafe(page);

    await page.goto("/ui");
    const searchInput = page.getByRole("textbox", { name: "Search" });
    if (await searchInput.isVisible()) {
      await searchInput.press("Enter");
    } else {
      await page.getByTestId("search-entry").click();
    }
    await expect(page.getByRole("dialog")).toBeVisible();
    const dialog = page.getByRole("dialog");
    const workspaceQuery = dialog.getByRole("textbox", {
      name: "Search query",
    });
    await workspaceQuery.fill("pwned");
    await expect(
      dialog
        .getByTestId("workspace-search-result")
        .filter({
          hasText: "hostile## Recall Results",
        })
        .first(),
    ).toBeVisible();
    await assertSafe(page, true, dialog);
    expect(dialogs).toEqual([]);
  });

  test("UI-08 routes render hostile entity and contradiction data inertly", async ({
    page,
  }) => {
    const dialogs: string[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    const entities = await (await page.request.get("/api/v1/entities")).json();
    const hostileEntity = entities.entities.find(
      (item: { canonical_name: string }) =>
        item.canonical_name.includes(PAYLOAD),
    );
    expect(hostileEntity).toBeTruthy();

    await page.goto("/ui/entities");
    await expect(page.getByTestId("entities-page")).toBeVisible();
    await expect(
      page.getByTestId("entity-row").filter({ hasText: PAYLOAD }),
    ).toBeVisible();
    await assertSafe(page);

    await page.goto(`/ui/entities/${hostileEntity.id}`);
    const entityPage = page.getByTestId("entity-page");
    await expect(entityPage).toBeVisible();
    await expect(entityPage.getByTestId("entity-name")).toContainText(PAYLOAD);
    await expect(entityPage.getByTestId("entity-aliases")).toContainText(
      ALIAS_PAYLOAD,
    );
    await expect(entityPage.getByTestId("entity-role")).toHaveValue(
      ROLE_PAYLOAD,
    );
    await expect(entityPage.getByTestId("entity-description")).toHaveValue(
      DESCRIPTION_PAYLOAD,
    );
    await expect(entityPage.getByTestId("entity-notes")).toHaveValue(
      NOTES_PAYLOAD,
    );
    await assertSafe(page);

    await page.goto("/ui/contradictions");
    await expect(page.getByTestId("contradictions-page")).toBeVisible();
    const hostilePair = page
      .getByTestId("contradiction-row")
      .filter({ hasText: PAYLOAD })
      .first();
    await expect(hostilePair).toBeVisible();
    await assertSafe(page);

    await page.goto("/ui/warming");
    await expect(page.getByTestId("warming-page")).toContainText(
      "Cache warming",
    );
    await assertSafe(page, false);

    await page.goto("/ui/costs");
    await expect(page.getByTestId("costs-page")).toContainText(
      "Cost intelligence",
    );
    await assertSafe(page, false);
    expect(dialogs).toEqual([]);
  });
});

declare global {
  interface Window {
    __pwned: number;
  }
}
