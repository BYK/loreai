import { expect, test } from "@playwright/test";
import {
  PHASES,
  pointOnTerrain,
  refinementElevation,
  projectPoint,
  SVG_WIDTH,
  SVG_HEIGHT,
  TERRAIN_STEP,
} from "../../src/lib/memory-landscape";

test.beforeEach(async ({ page }) => {
  await page.route(
    "https://api.github.com/repos/BYK/loreai/releases/latest",
    (route) => route.fulfill({ json: { tag_name: "0.34.0" } }),
  );
});

test("the landscape and native stage controls work without JavaScript", async ({
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
  const graph = page.locator(".memory-landscape");
  await expect(graph.locator("svg.landscape-fallback")).toBeVisible();
  await expect(graph.locator(".landscape-pin, [data-marker]")).toHaveCount(0);
  await expect(graph.locator(".landscape-projects")).toContainText("Payments");
  await expect(graph.locator(".landscape-projects")).toContainText("Orders");
  const connection = graph.locator(".landscape-transfer");
  const quiet = await connection.evaluate(
    (path) => getComputedStyle(path).opacity,
  );
  await graph.getByRole("radio", { name: "2 Distilled", exact: true }).check();
  await expect(graph.locator("#memory-stage-knowledge")).toBeVisible();
  await expect(graph.locator("#memory-stage-knowledge")).toContainText(
    ".lore.md",
  );
  await graph.getByRole("radio", { name: "3 Relevant", exact: true }).check();
  await expect(connection).not.toHaveCSS("opacity", quiet);
  await expect(graph.locator("#memory-stage-recall")).toContainText("Orders");
  await expect(graph.locator("#memory-stage-recall")).toBeVisible();
  await expect(graph.getByRole("button", { name: /motion/i })).toHaveCount(0);
  await context.close();
});

test("reduced motion retains the landscape and loads no GPU renderer", async ({
  page,
}) => {
  const gpuRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("memory-landscape-renderer"))
      gpuRequests.push(request.url());
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator(".landscape-fallback")).toBeVisible();
  await expect(page.locator(".memory-landscape canvas")).toHaveCount(0);
  const upperFace = page
    .locator('.landscape-face[data-land-region="recall"]:not(.landscape-wall)')
    .first();
  const initialFill = await upperFace.evaluate(
    (face) => getComputedStyle(face).fill,
  );
  await page.getByRole("radio", { name: "2 Distilled", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("radio", { name: "3 Relevant", exact: true }),
  ).toBeChecked();
  await expect(page.locator("#memory-stage-recall")).toBeVisible();
  await expect(
    page.getByRole("radio", { name: "3 Relevant", exact: true }).locator(".."),
  ).toHaveCSS("outline-style", "solid");
  await expect(upperFace).not.toHaveCSS("fill", initialFill);
  expect(gpuRequests).toEqual([]);
});

test("blocked WebGL retains a usable static landscape and readable example", async ({
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
  await expect(page.locator(".landscape-art")).toHaveAttribute(
    "data-renderer",
    "static",
  );
  await expect(page.locator(".landscape-fallback")).toBeVisible();
  await page.getByRole("radio", { name: "2 Distilled", exact: true }).check();
  await expect(page.locator("#memory-stage-knowledge")).toBeVisible();
  await expect(page.locator(".memory-landscape canvas")).toHaveCount(0);
});

test("native stage selection highlights the terrain, and motion preference changes preserve selection", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const art = page.locator(".landscape-art");
  await art.scrollIntoViewIfNeeded();
  await expect(art).toHaveAttribute("data-renderer", "webgl");
  const canvas = art.locator("canvas");
  const lowerBand = await canvas.screenshot();
  await page.getByRole("radio", { name: "2 Distilled", exact: true }).check();
  await expect
    .poll(async () => !(await canvas.screenshot()).equals(lowerBand))
    .toBe(true);
  await expect(art).toHaveAttribute("data-selected-band", "knowledge");
  await expect(page.locator("#memory-stage-knowledge")).toBeVisible();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(art).toHaveAttribute("data-renderer", "static");
  await expect(art.locator("canvas")).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(art).toHaveAttribute("data-renderer", "webgl");
  await expect(
    page.getByRole("radio", { name: "2 Distilled", exact: true }),
  ).toBeChecked();
  await expect(art).toHaveAttribute("data-selected-band", "knowledge");
});

test("failed GPU initialization releases its partial canvas", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() => {
    const observe = ResizeObserver.prototype.observe;
    ResizeObserver.prototype.observe = function (target, options) {
      if (target.classList.contains("landscape-art")) {
        document.documentElement.dataset.graphInitAttempted = "true";
        throw new Error("Simulated observer initialization failure");
      }
      return observe.call(this, target, options);
    };
  });
  await page.goto("/");
  await page.locator(".landscape-art").scrollIntoViewIfNeeded();
  await expect(page.locator("html")).toHaveAttribute(
    "data-graph-init-attempted",
    "true",
  );
  await expect(page.locator(".landscape-fallback")).toBeVisible();
  await expect(page.locator(".landscape-art canvas")).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".landscape-art canvas")).toHaveCount(0);
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
  await page.locator(".landscape-art").scrollIntoViewIfNeeded();
  await expect(page.locator("html")).toHaveAttribute(
    "data-graph-readback-attempted",
    "true",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".landscape-art canvas")).toHaveCount(0);
  await expect(page.locator(".landscape-fallback")).toBeVisible();
});

test("WebGL context loss shows the fallback and restores the selected stage", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const graph = page.locator(".landscape-art");
  await graph.scrollIntoViewIfNeeded();
  await expect(graph).toHaveAttribute("data-renderer", "webgl");
  await page.getByRole("radio", { name: "3 Relevant", exact: true }).check();
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
  await expect(graph).not.toHaveAttribute("data-refining");
  await expect(graph.locator(".landscape-fallback")).toBeVisible();
  await page.evaluate(() =>
    (
      window as Window & { restoreGraphContext?: () => void }
    ).restoreGraphContext?.(),
  );
  await expect(graph).toHaveAttribute("data-renderer", "webgl");
  await expect(page.locator("#memory-stage-recall")).toBeVisible();
  await expect(graph.locator("canvas")).toHaveCount(1);
});

async function regionPoint(
  page: import("@playwright/test").Page,
  phase: string,
) {
  const art = page.locator(".landscape-art");
  const bounds = await art.boundingBox();
  if (!bounds) throw new Error("Landscape has no layout bounds");
  // Sample exposed terrace centres first, and verify them through the real raycaster.
  const index = PHASES.indexOf(phase as (typeof PHASES)[number]);
  for (const angle of [0.85, 0.55, 1.15, 0.25, 1.45]) {
    const height = refinementElevation(index),
      surface = pointOnTerrain(height, angle);
    const [x, y] = projectPoint([
      surface[0],
      Math.floor(height / TERRAIN_STEP) * TERRAIN_STEP + 1.5,
      surface[2],
    ]);
    const point = {
      x: bounds.x + (bounds.width * x) / SVG_WIDTH,
      y: bounds.y + (bounds.height * y) / SVG_HEIGHT,
    };
    await page.mouse.move(point.x, point.y);
    if ((await art.getAttribute("data-target-phase")) === phase) return point;
  }
  // Broad terrace samples exercise actual terrain raycasting without peak markers.
  for (let y = 0.22; y <= 0.82; y += 0.06)
    for (let x = 0.25; x <= 0.78; x += 0.06) {
      const point = {
        x: bounds.x + bounds.width * x,
        y: bounds.y + bounds.height * y,
      };
      await page.mouse.move(point.x, point.y);
      if ((await art.getAttribute("data-target-phase")) === phase) return point;
    }
  throw new Error(`No broad ${phase} terrain region found`);
}

test("clicking each broad terrain region selects and highlights its corresponding stage", async ({
  page,
  isMobile,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const art = page.locator(".landscape-art");
  await art.scrollIntoViewIfNeeded();
  await expect(art).toHaveAttribute("data-renderer", "webgl");
  for (const [phase, name] of [
    ["knowledge", "2 Distilled"],
    ["recall", "3 Relevant"],
    ["conversation", "1 Conversation"],
  ]) {
    const point = await regionPoint(page, phase);
    if (isMobile) await page.touchscreen.tap(point.x, point.y);
    else await page.mouse.click(point.x, point.y);
    await expect(page.getByRole("radio", { name, exact: true })).toBeChecked();
    await expect(page.getByRole("radio", { name, exact: true })).toBeFocused();
    await expect(page.locator(`#memory-stage-${phase}`)).toBeVisible();
    await expect(art).toHaveAttribute("data-selected-band", phase);
  }
  expect(errors).toEqual([]);
});

test("dragging away and back preserves selection without extra view controls", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const art = page.locator(".landscape-art");
  await art.scrollIntoViewIfNeeded();
  await expect(art).toHaveAttribute("data-renderer", "webgl");
  const point = await regionPoint(page, "knowledge");
  await page.mouse.down();
  await page.mouse.move(point.x + 30, point.y, { steps: 5 });
  await page.mouse.move(point.x, point.y, { steps: 5 });
  await page.mouse.up();
  await expect(
    page.getByRole("radio", { name: "1 Conversation", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("slider", { name: "Rotate landscape" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Reset view", exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(async () => {
      const first = await art.locator("canvas").screenshot();
      await page.waitForTimeout(100);
      return (await art.locator("canvas").screenshot()).equals(first);
    })
    .toBe(true);
  const target = await regionPoint(page, "recall");
  await page.mouse.click(target.x, target.y);
  await expect(
    page.getByRole("radio", { name: "3 Relevant", exact: true }),
  ).toBeChecked();
});

test("static terrain regions are selectable and the canvas is never loaded on low-memory devices", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "deviceMemory", { get: () => 2 }),
  );
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("memory-landscape-renderer"))
      requests.push(request.url());
  });
  await page.goto("/");
  const art = page.locator(".landscape-art");
  await art.scrollIntoViewIfNeeded();
  const selected = await art
    .locator(
      '.landscape-face[data-land-region="knowledge"]:not(.landscape-wall)',
    )
    .evaluateAll((paths) => {
      for (const path of paths) {
        const b = path.getBoundingClientRect();
        for (let y = b.top + 2; y < b.bottom; y += 3)
          for (let x = b.left + 2; x < b.right; x += 3) {
            const target = document
              .elementFromPoint(x, y)
              ?.closest<SVGElement>("[data-land-region]");
            if (target?.dataset.landRegion === "knowledge") return { x, y };
          }
      }
      return null;
    });
  expect(selected).not.toBeNull();
  await page.mouse.click(selected!.x, selected!.y);
  await expect(
    page.getByRole("radio", { name: "2 Distilled", exact: true }),
  ).toBeChecked();
  await expect(art.locator("canvas")).toHaveCount(0);
  expect(requests).toEqual([]);
});

test("a shader failure restores the static terrain and usable stage controls", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() => {
    const original = WebGL2RenderingContext.prototype.shaderSource;
    WebGL2RenderingContext.prototype.shaderSource = function (shader, source) {
      document.documentElement.dataset.landShaderFailed = "true";
      original.call(this, shader, source + "\nthis is an invalid shader;");
    };
  });
  await page.goto("/");
  await page.locator(".landscape-art").scrollIntoViewIfNeeded();
  await expect(page.locator("html")).toHaveAttribute(
    "data-land-shader-failed",
    "true",
  );
  await expect(page.locator(".landscape-fallback")).toBeVisible();
  await expect(page.locator(".landscape-art canvas")).toHaveCount(0);
  await page.getByRole("radio", { name: "3 Relevant", exact: true }).check();
  await expect(page.locator("#memory-stage-recall")).toBeVisible();
});

test("leaving and re-entering the canvas cancels an un-dragged region press", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const art = page.locator(".landscape-art");
  await art.scrollIntoViewIfNeeded();
  await expect(art).toHaveAttribute("data-renderer", "webgl");
  const point = await regionPoint(page, "knowledge");
  await page.mouse.down();
  await page.mouse.move(0, 0);
  await page.mouse.move(point.x, point.y);
  await page.mouse.up();
  await expect(
    page.getByRole("radio", { name: "1 Conversation", exact: true }),
  ).toBeChecked();
});

test("elevation selection updates the highlighted band and settles without idle motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const art = page.locator(".landscape-art");
  await art.scrollIntoViewIfNeeded();
  await expect(art).toHaveAttribute("data-renderer", "webgl");
  const observed = await art.evaluateHandle((element) => {
    const counts: number[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records)
        if (record.oldValue !== null) counts.push(Number(record.oldValue));
      if (element.getAttribute("data-detail-count") !== null)
        counts.push(Number(element.getAttribute("data-detail-count")));
    });
    observer.observe(element, {
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ["data-detail-count"],
    });
    return { counts, observer };
  });
  await page.getByRole("radio", { name: "3 Relevant", exact: true }).check();
  await expect(art).toHaveAttribute("data-selected-band", "recall");
  await expect(art).toHaveAttribute("data-refining", "true");
  await expect(art).not.toHaveAttribute("data-refining");
  const counts = await observed.evaluate((state) => {
    state.observer.disconnect();
    return state.counts;
  });
  expect(Math.max(...counts)).toBeGreaterThan(20);
  expect(Math.min(...counts)).toBe(4);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(500);
  const canvas = art.locator("canvas"),
    first = await canvas.screenshot();
  await page.waitForTimeout(200);
  expect((await canvas.screenshot()).equals(first)).toBe(true);
  await page
    .getByRole("radio", { name: "1 Conversation", exact: true })
    .focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("radio", { name: "2 Distilled", exact: true }),
  ).toBeChecked();
  await expect(art).toHaveAttribute("data-selected-band", "knowledge");
});

test("mobile horizontal swipes rotate, while vertical gestures still scroll", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "Real touch gestures apply to touch viewport projects");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const art = page.locator(".landscape-art");
  await art.scrollIntoViewIfNeeded();
  await expect(art).toHaveAttribute("data-renderer", "webgl");
  const canvas = art.locator("canvas");
  const initial = await canvas.screenshot();
  const b = await art.boundingBox();
  if (!b) throw new Error("Missing terrain bounds");
  const session = await page.context().newCDPSession(page);
  const swipe = async (dx: number, dy: number) => {
    const start = { x: b.x + b.width * 0.5, y: b.y + b.height * 0.6 };
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [start],
    });
    for (let step = 1; step <= 8; step++)
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          { x: start.x + (dx * step) / 8, y: start.y + (dy * step) / 8 },
        ],
      });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  };
  await swipe(55, 0);
  await expect
    .poll(async () => !(await canvas.screenshot()).equals(initial))
    .toBe(true);
  await expect(
    page.getByRole("radio", { name: "1 Conversation", exact: true }),
  ).toBeChecked();
  const before = await page.evaluate(() => scrollY);
  await swipe(0, -65);
  await expect
    .poll(() => page.evaluate(() => scrollY))
    .toBeGreaterThan(before + 10);
  await expect(
    page.getByRole("radio", { name: "1 Conversation", exact: true }),
  ).toBeChecked();
  await session.detach();
});

test("rapid stage changes retarget the refinement and settle at the last choice", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const art = page.locator(".landscape-art");
  await art.scrollIntoViewIfNeeded();
  await expect(art).toHaveAttribute("data-renderer", "webgl");
  await page.getByRole("radio", { name: "2 Distilled", exact: true }).check();
  await expect(art).toHaveAttribute("data-refining", "true");
  await page.waitForTimeout(200);
  await page.getByRole("radio", { name: "3 Relevant", exact: true }).check();
  await expect(art).toHaveAttribute("data-refining", "true");
  await page.waitForTimeout(200);
  await page
    .getByRole("radio", { name: "1 Conversation", exact: true })
    .check();
  await expect(art).toHaveAttribute("data-selected-band", "conversation");
  await expect(art).not.toHaveAttribute("data-refining");
  await expect(art).not.toHaveAttribute("data-detail-count");
  await expect(page.locator("#memory-stage-conversation")).toBeVisible();
  await page.getByRole("radio", { name: "3 Relevant", exact: true }).check();
  await expect(art).toHaveAttribute("data-refining", "true");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(art).toHaveAttribute("data-renderer", "static");
  await expect(art).not.toHaveAttribute("data-refining");
  await expect(
    page.getByRole("radio", { name: "3 Relevant", exact: true }),
  ).toBeChecked();
});

test("leaving the viewport settles refinement and does not replay it on return", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const art = page.locator(".landscape-art");
  await art.scrollIntoViewIfNeeded();
  await expect(art).toHaveAttribute("data-renderer", "webgl");
  await page.getByRole("radio", { name: "3 Relevant", exact: true }).check();
  await expect(art).toHaveAttribute("data-refining", "true");
  await page.locator("#waitlist").scrollIntoViewIfNeeded();
  await expect(art).not.toHaveAttribute("data-refining");
  await art.scrollIntoViewIfNeeded();
  await expect(art).toHaveAttribute("data-selected-band", "recall");
  await expect(art).not.toHaveAttribute("data-refining");
  await expect(
    page.getByRole("radio", { name: "3 Relevant", exact: true }),
  ).toBeChecked();
});
