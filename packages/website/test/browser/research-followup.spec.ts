import { expect, test } from "@playwright/test";
import { themeButton } from "../helpers/theme";

test("setting search lands on the exact readable field, including after reload", async ({
  page,
}) => {
  await page.goto("/docs/configuration/");
  await page
    .getByRole("searchbox", { name: "Find a setting" })
    .fill("maxEntries");
  await page
    .locator("#setting-results")
    .getByRole("link", { name: "curator.maxEntries", exact: true })
    .click();
  const field = page.locator('[id="setting-curator.maxEntries"]');
  await expect(field).toBeVisible();
  await expect(page).toHaveURL(/#setting-curator\.maxEntries$/);
  await expect(field).toContainText("Default");
  const bounds = await field.boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(88);
  expect(bounds!.y).toBeLessThan(230);
  const name = field.locator(".reference-field-heading code");
  expect(await name.evaluate((el) => el.getClientRects().length)).toBe(1);
  await page.reload();
  await expect(field).toBeVisible();
  await expect(field).toHaveCSS("border-top-style", "solid");
});

test("environment result includes the variable, default and full explanation", async ({
  page,
}) => {
  await page.goto("/docs/environment/?setting=LORE_LISTEN_PORT");
  await page
    .locator("#setting-results")
    .getByRole("link", { name: "LORE_LISTEN_PORT", exact: true })
    .click();
  const field = page.locator('[id="setting-LORE_LISTEN_PORT"]');
  await expect(field).toBeVisible();
  await expect(field).toContainText("Default:");
  await expect(field.locator(".reference-description")).not.toBeEmpty();
});

test("platform installation choices and numbered desktop setup work without JavaScript", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 320, height: 844 },
  });
  try {
    const page = await context.newPage();
    await page.goto(baseURL + "/docs/install/");
    const install = page.locator(".platform-install");
    await install.getByRole("radio", { name: "Windows", exact: true }).check();
    await expect(install.locator('[data-platform="windows"]')).toContainText(
      "npm install -g @loreai/gateway",
    );
    await expect(install.locator('[data-platform="windows"]')).toContainText(
      "Node.js",
    );
    await expect(install.locator('[data-platform="unix"]')).toBeHidden();
    const setup = page.locator(".agent-setup");
    await setup
      .getByRole("radio", { name: "Codex Desktop", exact: true })
      .check();
    const panel = setup.locator('[data-setup-panel="codex-desktop"]');
    await expect(panel.locator(".setup-desktop-steps > li")).toHaveCount(4);
    await expect(panel).toContainText("fully quit");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await page.goto(
      baseURL + "/docs/configuration/#setting-curator.maxEntries",
    );
    await expect(
      page.locator('[id="setting-curator.maxEntries"]'),
    ).toBeInViewport();
  } finally {
    await context.close();
  }
});

test("each fit recommendation offers a next step without automatic navigation", async ({
  page,
}) => {
  await page.goto("/different/#landscape");
  const guide = page.locator(".fit-guide");
  for (const choice of [
    "Use an existing coding agent",
    "Keep a few stable rules",
    "Build an application",
    "Build an agent workflow",
  ]) {
    await guide.getByRole("radio", { name: choice, exact: true }).check();
    await expect(page).toHaveURL(/\/different\//);
    const action = guide.locator(".fit-explanation:visible a").first();
    await expect(action).toBeVisible();
    await expect(action).toHaveAttribute("href", /^(\/docs\/|https:\/\/)/);
  }
});

test("Docs is reachable directly from every desktop header", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const route of ["/", "/tour/", "/different/", "/blog/", "/docs/"]) {
    await page.goto(route);
    const docs = page
      .locator(".guide-triggers > li > a")
      .filter({ hasText: /^Docs$/ });
    await expect(docs).toBeVisible();
    await expect(docs).toHaveAttribute("href", "/docs/");
  }
});

test("architecture diagrams follow theme changes and open a legible focused view", async ({
  page,
}) => {
  await page.goto("/docs/architecture/");
  const diagrams = page.locator(".mermaid");
  await expect(diagrams.locator(":scope > svg")).toHaveCount(5);
  await (await themeButton(page, "Dark")).click();
  if (await page.locator("starlight-menu-button button:visible").count())
    await page.locator("starlight-menu-button button:visible").click();
  await expect(diagrams.first()).toHaveAttribute("data-rendered-theme", "dark");
  const inherited = await diagrams
    .locator(".nodeLabel p")
    .evaluateAll((elements) =>
      elements.every(
        (el) =>
          getComputedStyle(el).color ===
          getComputedStyle(el.parentElement!).color,
      ),
    );
  expect(inherited).toBe(true);
  await diagrams
    .first()
    .getByRole("button", { name: "Expand diagram" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Expanded diagram" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".diagram-canvas > svg")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await (await themeButton(page, "Light")).click();
  await expect(diagrams.first()).toHaveAttribute(
    "data-rendered-theme",
    "light",
  );
});

test("desktop setup copies the specific numbered command, not the first command in the panel", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/docs/install/?agent=codex-desktop");
  const panel = page.locator('[data-setup-panel="codex-desktop"]');
  await panel
    .getByRole("button", {
      name: "Copy Codex Desktop gateway command",
      exact: true,
    })
    .click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "lore start --bg --local",
  );
  await expect(
    panel.locator(".ui-command").nth(1).getByRole("status"),
  ).toContainText("Copied");
  await expect(panel.locator(".setup-copy-status").first()).not.toContainText(
    "Copied",
  );
});

test("all reference result anchors survive category naming collisions", async ({
  page,
}) => {
  for (const route of ["configuration", "environment"]) {
    await page.goto(`/docs/${route}/`);
    const missing = await page
      .locator(".reference-finder a")
      .evaluateAll((links) =>
        links
          .filter(
            (link) =>
              !document.getElementById(
                decodeURIComponent((link as HTMLAnchorElement).hash.slice(1)),
              ),
          )
          .map((link) => link.textContent),
      );
    expect(missing).toEqual([]);
    const duplicate = await page
      .locator("[id]")
      .evaluateAll((elements) =>
        elements.map((e) => e.id).filter((id, i, ids) => ids.indexOf(id) !== i),
      );
    expect(duplicate).toEqual([]);
  }
});

test("changing installation platform keeps its command and the independently selected agent", async ({
  page,
}) => {
  await page.goto("/docs/install/?agent=codex-desktop&from=qa");
  const install = page.locator(".platform-install");
  await expect(
    install.getByRole("radio", { name: "macOS / Linux", exact: true }),
  ).toBeChecked();
  await install.getByRole("radio", { name: "Windows", exact: true }).check();
  await expect(install.locator('[data-platform="windows"]')).toBeVisible();
  await expect(page).toHaveURL(/agent=codex-desktop&from=qa$/);
  await page
    .locator(".setup-picker")
    .getByRole("radio", { name: "Pi", exact: true })
    .check();
  await expect(
    install.getByRole("radio", { name: "Windows", exact: true }),
  ).toBeChecked();
  await expect(install.locator('[data-platform="windows"]')).toBeVisible();
});

test("expanded diagrams use a centered modal and a readable scrollable canvas on phones", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/docs/architecture/");
  await page
    .locator(".mermaid")
    .first()
    .getByRole("button", { name: "Expand diagram", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Expanded diagram" });
  const rect = await dialog.boundingBox();
  expect(Math.abs(rect!.x + rect!.width / 2 - 195)).toBeLessThan(2);
  expect(Math.abs(rect!.y + rect!.height / 2 - 422)).toBeLessThan(2);
  expect(rect!.width).toBeLessThanOrEqual(390 - 24);
  expect(
    (await dialog.locator(".diagram-canvas > svg").boundingBox())!.width,
  ).toBeGreaterThanOrEqual(800);
  await expect(dialog.locator(".diagram-canvas")).toHaveCSS(
    "overflow-x",
    "auto",
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(
    page
      .locator(".mermaid")
      .first()
      .getByRole("button", { name: "Expand diagram" }),
  ).toBeFocused();
});
