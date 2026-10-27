import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route(
    "https://api.github.com/repos/BYK/loreai/releases/latest",
    (route) => route.fulfill({ json: { tag_name: "0.34.0" } }),
  );
});

test("the 3D graph and native stage controls work without JavaScript", async ({
  browser,
  baseURL,
  viewport,
  colorScheme,
  isMobile,
  hasTouch,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport,
    colorScheme,
    isMobile,
    hasTouch,
  });
  const page = await context.newPage();
  await page.goto(`${baseURL}/`);
  const graph = page.locator(".memory-sculpture");
  await expect(graph.locator("svg.memory-graph-fallback")).toBeVisible();
  await expect(graph.locator("circle[data-memory-node]")).toHaveCount(9);
  await graph.getByRole("radio", { name: "2 Knowledge", exact: true }).check();
  await expect(graph.locator("#memory-stage-knowledge")).toBeVisible();
  await expect(graph.locator("#memory-stage-knowledge")).toContainText(
    ".lore.md",
  );
  await graph.getByRole("radio", { name: "3 Recall", exact: true }).check();
  await expect(graph.locator("#memory-stage-recall")).toBeVisible();
  await expect(graph.getByRole("button", { name: /motion/i })).toHaveCount(0);
  await context.close();
});

test("reduced motion retains the sculpture and loads no GPU renderer", async ({
  page,
}) => {
  const gpuRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("memory-graph-renderer"))
      gpuRequests.push(request.url());
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator(".memory-graph-fallback")).toBeVisible();
  await expect(page.locator(".memory-sculpture canvas")).toHaveCount(0);
  await page.getByRole("radio", { name: "2 Knowledge", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("radio", { name: "3 Recall", exact: true }),
  ).toBeChecked();
  await expect(page.locator("#memory-stage-recall")).toBeVisible();
  expect(gpuRequests).toEqual([]);
});

test("blocked WebGL retains a usable static graph and readable example", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      kind: string,
      ...args: unknown[]
    ) {
      return kind.startsWith("webgl")
        ? null
        : Reflect.apply(original, this, [kind, ...args]);
    } as typeof original;
  });
  await page.goto("/");
  await expect(page.locator(".memory-graph")).toHaveAttribute(
    "data-renderer",
    "static",
  );
  await expect(page.locator(".memory-graph-fallback")).toBeVisible();
  await page.getByRole("radio", { name: "2 Knowledge", exact: true }).check();
  await expect(page.locator("#memory-stage-knowledge")).toBeVisible();
  await expect(page.locator(".memory-sculpture canvas")).toHaveCount(0);
});

test("the GPU sculpture responds to pointer and stage selection with controllable motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const graph = page.locator(".memory-graph");
  await graph.scrollIntoViewIfNeeded();
  await expect(graph).toHaveAttribute("data-renderer", "webgl");
  await page
    .getByRole("button", { name: "Pause graph motion", exact: true })
    .click();
  const play = page.getByRole("button", {
    name: "Play graph motion",
    exact: true,
  });
  await expect(play).toBeVisible();
  await page.mouse.move(0, 0);
  const canvas = graph.locator("canvas");
  // Wait for the paused rest pose to settle before comparing real rendered pixels.
  await page.waitForTimeout(500);
  const before = await canvas.screenshot();
  const bounds = await graph.boundingBox();
  if (!bounds) throw new Error("Graph is missing its layout bounds");
  await page.mouse.move(
    bounds.x + bounds.width * 0.8,
    bounds.y + bounds.height * 0.25,
  );
  await expect
    .poll(async () => !(await canvas.screenshot()).equals(before))
    .toBe(true);
  await page.getByRole("radio", { name: "2 Knowledge", exact: true }).check();
  await expect(page.locator("#memory-stage-knowledge")).toContainText(
    "Idempotent webhooks",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(graph).toHaveAttribute("data-renderer", "static");
  await expect(graph.locator("canvas")).toHaveCount(0);
  await expect(graph.locator(".memory-graph-fallback")).toBeVisible();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(graph).toHaveAttribute("data-renderer", "webgl");
  await expect(graph.locator("canvas")).toHaveCount(1);
  await expect(page.locator("#memory-stage-knowledge")).toBeVisible();
});

test("failed GPU initialization releases its partial canvas", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() => {
    const observe = ResizeObserver.prototype.observe;
    ResizeObserver.prototype.observe = function (target, options) {
      if (target.classList.contains("memory-graph")) {
        document.documentElement.dataset.graphInitAttempted = "true";
        throw new Error("Simulated observer initialization failure");
      }
      return observe.call(this, target, options);
    };
  });
  await page.goto("/");
  await page.locator(".memory-graph").scrollIntoViewIfNeeded();
  await expect(page.locator("html")).toHaveAttribute(
    "data-graph-init-attempted",
    "true",
  );
  await expect(page.locator(".memory-graph-fallback")).toBeVisible();
  await expect(page.locator(".memory-graph canvas")).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".memory-graph canvas")).toHaveCount(0);
});

test("canvas privacy restrictions preserve cleanup and the static alternative", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() => {
    CanvasRenderingContext2D.prototype.getImageData = function () {
      document.documentElement.dataset.graphReadbackAttempted = "true";
      throw new DOMException("Canvas readback blocked", "SecurityError");
    };
  });
  await page.goto("/");
  await page.locator(".memory-graph").scrollIntoViewIfNeeded();
  await expect(page.locator("html")).toHaveAttribute(
    "data-graph-readback-attempted",
    "true",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".memory-graph canvas")).toHaveCount(0);
  await expect(page.locator(".memory-graph-fallback")).toBeVisible();
});

test("WebGL context loss shows the fallback and restores the selected stage", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const graph = page.locator(".memory-graph");
  await graph.scrollIntoViewIfNeeded();
  await expect(graph).toHaveAttribute("data-renderer", "webgl");
  await page.getByRole("radio", { name: "3 Recall", exact: true }).check();
  const supported = await graph
    .locator("canvas")
    .evaluate((canvas: HTMLCanvasElement) => {
      const extension = canvas
        .getContext("webgl2")
        ?.getExtension("WEBGL_lose_context");
      if (!extension) return false;
      (
        window as Window & { restoreGraphContext?: () => void }
      ).restoreGraphContext = () => extension.restoreContext();
      extension.loseContext();
      return true;
    });
  expect(supported).toBe(true);
  await expect(graph).toHaveAttribute("data-renderer", "static");
  await expect(graph.locator(".memory-graph-fallback")).toBeVisible();
  await page.evaluate(() =>
    (
      window as Window & { restoreGraphContext?: () => void }
    ).restoreGraphContext?.(),
  );
  await expect(graph).toHaveAttribute("data-renderer", "webgl");
  await expect(page.locator("#memory-stage-recall")).toBeVisible();
  await expect(graph.locator("canvas")).toHaveCount(1);
});
