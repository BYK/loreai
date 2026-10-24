import { setWorkspaceTheme } from "./workspace-helpers";
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
      ["/ui", "Choose a project", "welcome"],
      [`/ui/projects/${project.id}`, project.name, "health"],
      [`/ui/projects/${project.id}/knowledge`, entry.title, "text"],
      [
        `/ui/projects/${project.id}/duplicates`,
        "Duplicate review",
        "duplicate-review",
      ],
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
          ? page.getByRole("heading", { name: "Choose a project", exact: true })
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
                    : kind === "duplicate-review"
                      ? page.getByTestId("duplicate-review")
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

  // Each page gets its own deadline: opening account/navigation layers twice
  // per route must not consume one shared timeout for the entire workspace.
  const themeRoutes: Array<{
    name: string;
    path: (ids: Awaited<ReturnType<typeof fixtureIds>>) => string;
    marker: string;
    kind?: "text";
  }> = [
    {
      name: "project directory",
      path: () => "/ui",
      marker: "project-directory",
    },
    {
      name: "project overview",
      path: ({ project }) => `/ui/projects/${project.id}`,
      marker: "health",
    },
    {
      name: "knowledge table",
      path: ({ project }) => `/ui/projects/${project.id}/knowledge`,
      marker: "knowledge-row",
    },
    {
      name: "duplicate review",
      path: ({ project }) => `/ui/projects/${project.id}/duplicates`,
      marker: "duplicate-review",
    },
    {
      name: "project knowledge reader",
      path: ({ project, entry }) =>
        `/ui/projects/${project.id}/knowledge/${entry.id}`,
      marker: "knowledge-document",
    },
    {
      name: "session list",
      path: ({ project }) => `/ui/projects/${project.id}/sessions`,
      marker: "Sessions",
      kind: "text",
    },
    {
      name: "session reader",
      path: ({ project, session }) =>
        `/ui/projects/${project.id}/sessions/${session.session_id}`,
      marker: "session-rows",
    },
    {
      name: "project search",
      path: ({ project }) => `/ui/projects/${project.id}/search?q=SQLite`,
      marker: "Recall Results",
      kind: "text",
    },
    {
      name: "workspace knowledge reader",
      path: ({ entry }) => `/ui/knowledge/${entry.id}`,
      marker: "knowledge-document",
    },
    { name: "entities", path: () => "/ui/entities", marker: "entities-page" },
    {
      name: "entity details",
      path: ({ entity }) => `/ui/entities/${entity.id}`,
      marker: "entity-page",
    },
    {
      name: "contradictions",
      path: () => "/ui/contradictions",
      marker: "contradictions-page",
    },
    { name: "warming", path: () => "/ui/warming", marker: "warming-page" },
    { name: "costs", path: () => "/ui/costs", marker: "costs-page" },
  ];
  for (const { name, path, marker, kind } of themeRoutes) {
    test(`light and dark themes change the rendered background on ${name}`, async ({
      page,
    }) => {
      await page.goto(path(await fixtureIds(page)));
      const target =
        kind === "text"
          ? page
              .locator("main:visible")
              .getByText(marker, { exact: false })
              .first()
          : page.getByTestId(marker).first();
      await expect(target).toBeVisible();
      await setWorkspaceTheme(page, "light");
      const light = await page.evaluate(() => ({
        dark: document.documentElement.classList.contains("dark"),
        background: getComputedStyle(
          document.querySelector("[data-pane='detail']") ?? document.body,
        ).backgroundColor,
      }));
      await setWorkspaceTheme(page, "dark");
      const dark = await page.evaluate(() => ({
        dark: document.documentElement.classList.contains("dark"),
        background: getComputedStyle(
          document.querySelector("[data-pane='detail']") ?? document.body,
        ).backgroundColor,
      }));
      expect(light.dark).toBe(false);
      expect(dark.dark).toBe(true);
      expect(dark.background).not.toBe(light.background);
    });
  }
});
