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
  return { project, entry: knowledge[0], session: sessions[0] };
}

test.describe("production route deep links", () => {
  test("every real route survives a fresh navigation and reload", async ({
    page,
  }) => {
    const { project, entry, session } = await fixtureIds(page);
    const routes = [
      ["/ui", "Choose a project"],
      [`/ui/projects/${project.id}`, project.name],
      [`/ui/projects/${project.id}/knowledge`, entry.title],
      [`/ui/projects/${project.id}/knowledge/${entry.id}`, entry.title],
      [`/ui/projects/${project.id}/sessions`, session.session_id],
      [
        `/ui/projects/${project.id}/sessions/${session.session_id}`,
        "Session history",
      ],
      [`/ui/projects/${project.id}/search?q=SQLite`, "Recall Results"],
      [`/ui/knowledge/${entry.id}`, entry.title],
    ] as const;
    for (const [path, text] of routes) {
      await page.goto(path);
      const target =
        text === "Choose a project"
          ? page.getByTestId("connection-status")
          : text === project.name
            ? page.getByTestId("health")
            : text === "Session history"
              ? page.getByLabel("Session history")
              : page.locator("main").getByText(text, { exact: false }).first();
      await expect(target).toBeVisible();
      const before = page.url();
      await page.reload();
      await expect(page).toHaveURL(before);
      await expect(target).toBeVisible();
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
    const { project, entry, session } = await fixtureIds(page);
    const paths = [
      "/ui",
      `/ui/projects/${project.id}`,
      `/ui/projects/${project.id}/knowledge`,
      `/ui/projects/${project.id}/knowledge/${entry.id}`,
      `/ui/projects/${project.id}/sessions`,
      `/ui/projects/${project.id}/sessions/${session.session_id}`,
      `/ui/projects/${project.id}/search?q=SQLite`,
      `/ui/knowledge/${entry.id}`,
    ];
    for (const path of paths) {
      await page.goto(path);
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
