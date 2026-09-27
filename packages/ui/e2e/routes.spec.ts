import { expect, test, type Page } from "@playwright/test";

async function fixtureIds(page: Page) {
  const projects = await (await page.request.get("/api/v1/projects")).json();
  const project = projects.find(
    (item: { name: string }) => item.name === "lore",
  );
  const knowledge = await (
    await page.request.get(`/api/v1/projects/${project.id}/knowledge`)
  ).json();
  const sessions = await (
    await page.request.get(`/api/v1/projects/${project.id}/sessions`)
  ).json();
  const entities = await (await page.request.get("/api/v1/entities")).json();
  const entity = entities.entities.find(
    (item: { canonical_name: string }) =>
      item.canonical_name === "Ada Lovelace",
  );
  if (!entity) throw new Error("the seeded Ada Lovelace entity is missing");
  return { project, entry: knowledge[0], session: sessions[0], entity };
}

test.describe("production route deep links", () => {
  test("every real route survives a fresh navigation and reload", async ({
    page,
  }) => {
    const { project, entry, session, entity } = await fixtureIds(page);
    const routes = [
      ["/ui", "Memory connected", "welcome"],
      [`/ui/projects/${project.id}`, project.name, "health"],
      [`/ui/projects/${project.id}/knowledge`, entry.title, "text"],
      [`/ui/projects/${project.id}/knowledge/${entry.id}`, entry.title, "text"],
      [`/ui/projects/${project.id}/sessions`, session.session_id, "text"],
      [
        `/ui/projects/${project.id}/sessions/${session.session_id}`,
        "Session history",
        "session",
      ],
      [`/ui/projects/${project.id}/search?q=SQLite`, "Recall Results", "text"],
      [`/ui/knowledge/${entry.id}`, entry.title, "text"],
      ["/ui/entities", "People, projects & things", "entities"],
      [`/ui/entities/${entity.id}`, "Ada Lovelace", "entity-detail"],
      ["/ui/contradictions", "Contradictions", "contradictions"],
      ["/ui/warming", "Cache warming", "warming"],
      ["/ui/costs", "Cost intelligence", "costs"],
    ] as const;
    for (const [path, text, kind] of routes) {
      await page.goto(path);
      const target =
        kind === "welcome"
          ? page.getByTestId("connection-status")
          : kind === "health"
            ? page
                .locator("main:visible")
                .getByText(text, { exact: false })
                .first()
            : kind === "session"
              ? page.getByLabel("Session history")
              : kind === "entities"
                ? page.getByTestId("entities-page")
                : kind === "entity-detail"
                  ? page.getByTestId("entity-page")
                  : kind === "contradictions"
                    ? page.getByTestId("contradictions-page")
                    : kind === "warming"
                      ? page.getByTestId("warming-page")
                      : kind === "costs"
                        ? page.getByTestId("costs-page")
                        : page
                            .locator("main:visible")
                            .getByText(text, { exact: false })
                            .first();
      await expect(target).toBeVisible();
      if (kind === "session") {
        await expect(target).toHaveAttribute("aria-label", text);
      } else {
        await expect(target).toContainText(text);
      }
      const before = page.url();
      await page.reload();
      await expect(page).toHaveURL(before);
      await expect(target).toBeVisible();
      if (kind === "session") {
        await expect(target).toHaveAttribute("aria-label", text);
      } else {
        await expect(target).toContainText(text);
      }
    }
  });

  test("dev-only production routes render the not-found screen", async ({
    page,
  }) => {
    for (const path of ["/ui/fixture", "/ui/_compat"]) {
      await page.goto(path);
      await expect(page.getByTestId("not-found")).toBeVisible();
    }
  });

  test("light and dark themes change the rendered token background", async ({
    page,
  }) => {
    const { project, entry, session, entity } = await fixtureIds(page);
    const paths = [
      ["/ui", "connection-status"],
      [`/ui/projects/${project.id}`, "health"],
      [`/ui/projects/${project.id}/knowledge`, "knowledge-row"],
      [
        `/ui/projects/${project.id}/knowledge/${entry.id}`,
        "knowledge-document",
      ],
      [`/ui/projects/${project.id}/sessions`, session.session_id, "text"],
      [
        `/ui/projects/${project.id}/sessions/${session.session_id}`,
        "session-rows",
      ],
      [`/ui/projects/${project.id}/search?q=SQLite`, "Recall Results", "text"],
      [`/ui/knowledge/${entry.id}`, "knowledge-document"],
      ["/ui/entities", "entities-page"],
      [`/ui/entities/${entity.id}`, "entity-page"],
      ["/ui/contradictions", "contradictions-page"],
      ["/ui/warming", "warming-page"],
      ["/ui/costs", "costs-page"],
    ] as const;
    for (const [path, marker, kind = "testid"] of paths) {
      await page.goto(path);
      const target =
        kind === "text"
          ? page
              .locator("main:visible")
              .getByText(marker, { exact: false })
              .first()
          : page.getByTestId(marker).first();
      await expect(target).toBeVisible();
      await page.getByTestId("theme-light").click();
      const light = await page.evaluate(() => ({
        dark: document.documentElement.classList.contains("dark"),
        background: getComputedStyle(
          document.querySelector("[data-pane='detail']") ?? document.body,
        ).backgroundColor,
      }));
      await page.getByTestId("theme-dark").click();
      const dark = await page.evaluate(() => ({
        dark: document.documentElement.classList.contains("dark"),
        background: getComputedStyle(
          document.querySelector("[data-pane='detail']") ?? document.body,
        ).backgroundColor,
      }));
      expect(light.dark).toBe(false);
      expect(dark.dark).toBe(true);
      expect(dark.background).not.toBe(light.background);
    }
  });
});
