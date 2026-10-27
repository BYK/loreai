import { expect, test, type Page } from "@playwright/test";

async function projectId(page: Page) {
  const response = await page.request.get("/api/v1/projects");
  expect(response.ok()).toBe(true);
  const projects = (await response.json()) as { id: string; name: string }[];
  const project = projects.find((item) => item.name === "lore");
  if (!project) throw new Error("Missing seeded lore project");
  return project.id;
}

test("main pagination preserves filters with keyboard navigation and fits at 320px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const id = await projectId(page);
  const cursor = "next/?#";
  await page.route(`**/api/v1/projects/${id}/knowledge?**`, (route) => {
    const second = new URL(route.request().url()).searchParams.has("cursor");
    return route.fulfill({
      json: {
        items: [
          {
            id: second ? "second" : "first",
            project_id: id,
            category: "pattern",
            title: second ? "Second page entry" : "First page entry",
            content: "Recorded pagination fixture.",
            confidence: 0.8,
            created_at: 1,
            updated_at: 2,
          },
        ],
        next_cursor: second ? null : cursor,
      },
    });
  });
  const query = new URLSearchParams({
    q: "cursor & details",
    sort: "title:asc",
    category: "pattern",
  });
  const base = `/ui/projects/${id}/knowledge?${query}`;
  await page.goto(base);
  const nav = page.getByRole("navigation", { name: "Knowledge pagination" });
  const next = nav.getByRole("button", { name: "Next page" });
  await expect(next).toHaveText("Next");
  await expect(nav.getByRole("button", { name: "Previous page" })).toHaveCount(
    0,
  );
  await next.press("Enter");
  await expect(
    page.getByRole("link", { name: "Second page entry", exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.get("cursor")).toBe(cursor);
  expect(new URL(page.url()).searchParams.get("q")).toBe("cursor & details");
  expect(new URL(page.url()).searchParams.get("sort")).toBe("title:asc");
  expect(new URL(page.url()).searchParams.get("category")).toBe("pattern");
  await expect(next).toBeDisabled();
  const previous = nav.getByRole("button", { name: "Previous page" });
  await expect(previous).toHaveText("Previous");
  for (const button of await nav.getByRole("button").all()) {
    const box = await button.boundingBox();
    if (!box) throw new Error("Unmeasured pagination control");
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    320,
  );
  await previous.press("Enter");
  await expect(
    page.getByRole("link", { name: "First page entry", exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.has("cursor")).toBe(false);
  await next.press("Enter");
  await expect(previous).toBeVisible();
  await nav.getByRole("button", { name: "First page" }).press("Enter");
  await expect(
    page.getByRole("link", { name: "First page entry", exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.has("cursor")).toBe(false);
  await page.goto(`${base}&cursor=unknown-direct-link`);
  await expect(next).toBeDisabled();
  await expect(nav.getByRole("button", { name: "Previous page" })).toHaveCount(
    0,
  );
  await expect(nav.getByRole("button", { name: "First page" })).toBeVisible();
});

test("compact session pagination has labeled icon controls and focus tooltips", async ({
  page,
}, testInfo) => {
  const id = await projectId(page);
  await page.route(`**/api/v1/projects/${id}/sessions?**`, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            session_id: "e2e-reader",
            title: "Recorded session",
            title_source: "explicit",
            message_count: 230,
            first_message_at: 1,
            last_message_at: 2,
            distilled_count: 0,
            undistilled_count: 230,
            distillation_count: 0,
          },
        ],
        next_cursor: new URL(route.request().url()).searchParams.has("cursor")
          ? null
          : "next/?#",
      },
    }),
  );
  await page.goto(
    `/ui/projects/${id}/sessions/e2e-reader?q=recorded&cursor=direct&a=source-anchor`,
  );
  if (testInfo.project.name.includes("mobile"))
    await page.getByTestId("context-toggle").click();
  const nav = page.getByRole("navigation", { name: "Session list pagination" });
  const first = nav.getByRole("button", { name: "First page" });
  const next = nav.getByRole("button", { name: "Next page" });
  await expect(first).toBeVisible();
  await expect(first).toHaveText("");
  await first.focus();
  await expect(page.getByRole("tooltip")).toHaveText("First page");
  await first.press("Enter");
  await expect(first).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe(
    `/ui/projects/${id}/sessions/e2e-reader`,
  );
  expect(new URL(page.url()).searchParams.get("q")).toBe("recorded");
  expect(new URL(page.url()).searchParams.get("a")).toBe("source-anchor");
  await expect(next).toBeEnabled();
  await expect(next).toHaveText("");
  await next.press("Enter");
  await expect(next).toBeDisabled();
  expect(new URL(page.url()).searchParams.get("cursor")).toBe("next/?#");
  expect(new URL(page.url()).searchParams.get("a")).toBe("source-anchor");
  for (const button of await nav.getByRole("button").all()) {
    const box = await button.boundingBox();
    if (!box) throw new Error("Unmeasured compact pagination control");
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
  }
});
