import { expect, test, type Page } from "@playwright/test";
import type { ProjectSummary } from "../src/contracts";

const projects: ProjectSummary[] = [
  {
    id: "short",
    name: "App",
    path: "/work/app",
    git_remote: "git@example.test:app",
    last_activity: 1_700_000_000_000,
  },
  {
    id: "checkout",
    name: "App release",
    path: "/work/app-release",
    git_remote: "git@example.test:app",
    last_activity: 1_600_000_000_000,
  },
  {
    id: "long",
    name: "Unbroken" + "x".repeat(140),
    path: "/work/" + "p".repeat(200),
    git_remote: "git@example.test:" + "r".repeat(150),
    last_activity: null,
  },
  {
    id: "local",
    name: "Local",
    path: "/work/local",
    git_remote: null,
    last_activity: null,
  },
  {
    id: "unattributed",
    name: "Unattributed",
    path: "/__lore_unattributed__/sessions",
    git_remote: null,
    last_activity: null,
  },
].map((project) => ({
  ...project,
  created_at: 1,
  knowledge_count: 2,
  session_count: 3,
  message_count: 4,
  distillation_count: 1,
}));

async function openDirectory(page: Page, query = "") {
  await page.route("**/api/v1/projects", (route) =>
    route.fulfill({ json: projects }),
  );
  await page.goto(`/ui${query}`);
  await expect(page.getByTestId("project-directory")).toBeVisible();
}

for (const width of [320, 390]) {
  test(`clear project filter has a mobile target and restores every checkout at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await openDirectory(
      page,
      "?section=sessions&projectFilter=not-recorded&projectSort=name",
    );
    const clear = page.getByRole("button", { name: "Clear project filter" });
    await expect(clear).toBeVisible();
    const box = await clear.boundingBox();
    if (!box) throw new Error("Missing clear-project-filter target");
    expect.soft(box.height).toBeGreaterThanOrEqual(44);
    await clear.click();
    await expect(page).toHaveURL("/ui?section=sessions&projectSort=name");
    await expect(
      page.getByRole("textbox", { name: "Filter projects" }),
    ).toHaveValue("");
    await expect(page.getByTestId("project-card")).toHaveCount(projects.length);
    for (const project of projects) {
      await expect(
        page.locator(
          `[data-testid="project-card"][href="/ui/projects/${project.id}/sessions"]`,
        ),
      ).toHaveAttribute("href", `/ui/projects/${project.id}/sessions`);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

for (const width of [320, 390, 1280]) {
  test(`directory keeps all checkout metadata readable without overflow at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await openDirectory(page, "?projectSort=name");
    await expect(
      page
        .getByRole("list", { name: "Repository groups" })
        .locator(":scope > li"),
    ).toHaveCount(2);
    await expect(
      page.getByRole("region", { name: "Local projects", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Unattributed sessions", exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("project-card")).toHaveCount(projects.length);
    for (const project of projects) {
      const row = page.locator(
        `[data-testid="project-card"][href="/ui/projects/${project.id}"]`,
      );
      await expect(row).toHaveAttribute("href", `/ui/projects/${project.id}`);
      if (!project.name) throw new Error("Missing project fixture name");
      await expect(row).toContainText(project.name);
      await expect(row).toContainText("2 entries · 3 sessions");
      const bounds = await row.boundingBox();
      if (!bounds) throw new Error(`Missing checkout ${project.id}`);
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(
        await row.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
    }
    const short = page
      .getByTestId("project-card")
      .filter({ hasText: "/work/app-release" });
    const bounds = await short.boundingBox();
    if (!bounds) throw new Error("Missing short checkout");
    if (width === 1280) expect(bounds.height).toBeLessThanOrEqual(72);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}
