import { expect, test } from "@playwright/test";

test("keeps tabs aligned with document-pane width through resize", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 850 });
  const projects = await (await page.request.get("/api/v1/projects")).json();
  const lore = projects.find(
    (project: { name: string }) => project.name === "lore",
  );
  await page.goto(`/ui/projects/${lore.id}/sessions/e2e-reader`);
  await expect(page.getByTestId("session-view")).toBeVisible();
  const tabs = page.getByRole("tablist", { name: "Session panes" });
  const transcript = page.getByTestId("session-view");
  const context = page.getByTestId("context-window");
  await expect(tabs).toBeVisible();
  await expect(page.getByRole("tabpanel")).toHaveCount(1);
  await page.getByTestId("session-tab-context").click();
  await expect(context).toBeVisible();
  await expect(transcript).toBeHidden();
  // The viewport is wide, but the nav and list leave less than 900px for the
  // document pane, so the workspace keeps its tabs instead of squeezing both.
  await expect(tabs).toBeVisible();
  await page.setViewportSize({ width: 1700, height: 850 });
  await expect(tabs).toBeHidden();
  await expect(transcript).toBeVisible();
  await expect(context).toBeVisible();
  const transcriptBox = await transcript.boundingBox();
  const contextBox = await context.boundingBox();
  if (!transcriptBox || !contextBox)
    throw new Error("Session panes are missing");
  expect(transcriptBox.width).toBeGreaterThanOrEqual(500);
  expect(contextBox.x).toBeGreaterThanOrEqual(
    transcriptBox.x + transcriptBox.width,
  );
  await page.setViewportSize({ width: 1280, height: 850 });
  await expect(tabs).toBeVisible();
  await expect(page.getByTestId("session-tab-context")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("tabpanel")).toHaveCount(1);
  await expect(transcript).toBeHidden();
  await expect(context).toBeVisible();
});
