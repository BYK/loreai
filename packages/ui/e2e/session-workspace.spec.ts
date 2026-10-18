import { expect, test } from "@playwright/test";

// Browser preferences affect rem media queries even when author CSS sets
// the document's font size. Setting documentElement.style cannot cover this.
test.use({ launchOptions: { args: ["--blink-settings=defaultFontSize=20"] } });

test("keeps tabs aligned with the CSS breakpoint through resize", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1152, height: 850 });
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).fontSize,
    ),
  ).toBe("20px");
  const projects = await (await page.request.get("/api/v1/projects")).json();
  const lore = projects.find(
    (project: { name: string }) => project.name === "lore",
  );
  await page.goto(`/ui/projects/${lore.id}/sessions/e2e-reader`);
  await expect(page.getByTestId("session-view")).toBeVisible();
  // This changes the actual browser preference: author root font styles
  // would not affect the initial font used by media-query rem units.
  expect(
    await page.evaluate(() => matchMedia("(min-width: 64rem)").matches),
  ).toBe(false);
  const tabs = page.getByRole("tablist", { name: "Session panes" });
  const transcript = page.getByTestId("session-view");
  const context = page.getByTestId("context-window");
  await expect(tabs).toBeVisible();
  await expect(page.getByRole("tabpanel")).toHaveCount(1);
  await page.getByTestId("session-tab-context").click();
  await expect(context).toBeVisible();
  await expect(transcript).toBeHidden();
  await page.setViewportSize({ width: 1280, height: 850 });
  await expect(tabs).toBeHidden();
  await expect(transcript).toBeVisible();
  await expect(context).toBeVisible();
  const transcriptBox = await transcript.boundingBox();
  const contextBox = await context.boundingBox();
  if (!transcriptBox || !contextBox)
    throw new Error("Session panes are missing");
  expect(contextBox.x).toBeGreaterThanOrEqual(
    transcriptBox.x + transcriptBox.width,
  );
  await page.setViewportSize({ width: 1152, height: 850 });
  await expect(tabs).toBeVisible();
  await expect(page.getByTestId("session-tab-context")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("tabpanel")).toHaveCount(1);
  await expect(transcript).toBeHidden();
  await expect(context).toBeVisible();
});
