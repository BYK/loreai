import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route(
    "https://api.github.com/repos/BYK/loreai/releases/latest",
    (route) => route.fulfill({ json: { tag_name: "0.34.0" } }),
  );
});

test("the camp and native stage controls work without JavaScript", async ({
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
  const graph = page.locator(".memory-camp");
  await expect(graph.locator("svg.camp-fallback")).toBeVisible();
  await expect(
    graph.locator("[data-camp-region=knowledge]").first(),
  ).toBeVisible();
  await graph
    .getByRole("radio", { name: "Scribe’s desk · Knowledge", exact: true })
    .check();
  await expect(graph.locator("#memory-stage-knowledge")).toBeVisible();
  await expect(graph.locator("#memory-stage-knowledge")).toContainText(
    ".lore.md",
  );
  await graph
    .getByRole("radio", { name: "Quest gate · Next session", exact: true })
    .check();
  await expect(graph.locator("#memory-stage-recall")).toBeVisible();
  await expect(graph.getByRole("button", { name: /motion/i })).toHaveCount(0);
  await context.close();
});

test("reduced motion retains the camp and loads no GPU renderer", async ({
  page,
}) => {
  const gpuRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("memory-camp-renderer"))
      gpuRequests.push(request.url());
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator(".camp-fallback")).toBeVisible();
  await expect(page.locator(".memory-camp canvas")).toHaveCount(0);
  await page
    .getByRole("radio", { name: "Scribe’s desk · Knowledge", exact: true })
    .focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("radio", { name: "Quest gate · Next session", exact: true }),
  ).toBeChecked();
  await expect(page.locator("#memory-stage-recall")).toBeVisible();
  await expect(
    page
      .getByRole("radio", { name: "Quest gate · Next session", exact: true })
      .locator(".."),
  ).toHaveCSS("outline-style", "solid");
  expect(gpuRequests).toEqual([]);
});

test("blocked WebGL retains a usable static camp and readable example", async ({
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
  await expect(page.locator(".camp-art")).toHaveAttribute(
    "data-renderer",
    "static",
  );
  await expect(page.locator(".camp-fallback")).toBeVisible();
  await page
    .getByRole("radio", { name: "Scribe’s desk · Knowledge", exact: true })
    .check();
  await expect(page.locator("#memory-stage-knowledge")).toBeVisible();
  await expect(page.locator(".memory-camp canvas")).toHaveCount(0);
});

test("native stage selection highlights the camp, and motion preference changes preserve selection", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const art = page.locator(".camp-art");
  await art.scrollIntoViewIfNeeded();
  await expect(art).toHaveAttribute("data-renderer", "webgl");
  await page
    .getByRole("radio", { name: "Scribe’s desk · Knowledge", exact: true })
    .check();
  await expect(page.locator("#memory-stage-knowledge")).toBeVisible();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(art).toHaveAttribute("data-renderer", "static");
  await expect(art.locator("canvas")).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(art).toHaveAttribute("data-renderer", "webgl");
  await expect(
    page.getByRole("radio", { name: "Scribe’s desk · Knowledge", exact: true }),
  ).toBeChecked();
});

test("failed GPU initialization releases its partial canvas", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() => {
    const observe = ResizeObserver.prototype.observe;
    ResizeObserver.prototype.observe = function (target, options) {
      if (target.classList.contains("camp-art")) {
        document.documentElement.dataset.graphInitAttempted = "true";
        throw new Error("Simulated observer initialization failure");
      }
      return observe.call(this, target, options);
    };
  });
  await page.goto("/");
  await page.locator(".camp-art").scrollIntoViewIfNeeded();
  await expect(page.locator("html")).toHaveAttribute(
    "data-graph-init-attempted",
    "true",
  );
  await expect(page.locator(".camp-fallback")).toBeVisible();
  await expect(page.locator(".camp-art canvas")).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".camp-art canvas")).toHaveCount(0);
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
  await page.locator(".camp-art").scrollIntoViewIfNeeded();
  await expect(page.locator(".camp-art")).toHaveAttribute(
    "data-renderer",
    "webgl",
  );
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-graph-readback-attempted",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".camp-art canvas")).toHaveCount(0);
  await expect(page.locator(".camp-fallback")).toBeVisible();
});

test("WebGL context loss shows the fallback and restores the selected stage", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const graph = page.locator(".camp-art");
  await graph.scrollIntoViewIfNeeded();
  await expect(graph).toHaveAttribute("data-renderer", "webgl");
  await page
    .getByRole("radio", { name: "Quest gate · Next session", exact: true })
    .check();
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
  await expect(graph.locator(".camp-fallback")).toBeVisible();
  await page.evaluate(() =>
    (
      window as Window & { restoreGraphContext?: () => void }
    ).restoreGraphContext?.(),
  );
  await expect(graph).toHaveAttribute("data-renderer", "webgl");
  await expect(page.locator("#memory-stage-recall")).toBeVisible();
  await expect(graph.locator("canvas")).toHaveCount(1);
});

test("a shader failure restores the static camp and usable stage controls", async ({
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
  await page.locator(".camp-art").scrollIntoViewIfNeeded();
  await expect(page.locator("html")).toHaveAttribute(
    "data-land-shader-failed",
    "true",
  );
  await expect(page.locator(".camp-fallback")).toBeVisible();
  await expect(page.locator(".camp-art canvas")).toHaveCount(0);
  await page
    .getByRole("radio", { name: "Quest gate · Next session", exact: true })
    .check();
  await expect(page.locator("#memory-stage-recall")).toBeVisible();
});

test("leaving and re-entering the canvas cancels an un-dragged region press", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const art = page.locator(".camp-art");
  await art.scrollIntoViewIfNeeded();
  await expect(art).toHaveAttribute("data-renderer", "webgl");
  const point = await landmarkPoint(page, "knowledge");
  await page.mouse.down();
  await page.mouse.move(0, 0);
  await page.mouse.move(point.x, point.y);
  await page.mouse.up();
  await expect(
    page.getByRole("radio", { name: "Campfire · Conversation", exact: true }),
  ).toBeChecked();
});

test("forward stage selection traces once, then the camp settles without idle motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const art = page.locator(".camp-art");
  await art.scrollIntoViewIfNeeded();
  await expect(art).toHaveAttribute("data-renderer", "webgl");
  await page
    .getByRole("radio", { name: "Quest gate · Next session", exact: true })
    .check();
  await expect(art).toHaveAttribute("data-tracing", "2");
  await expect(art).not.toHaveAttribute("data-tracing");
  await page.mouse.move(0, 0);
  await page.waitForTimeout(500);
  const canvas = art.locator("canvas"),
    first = await canvas.screenshot();
  await page.waitForTimeout(200);
  expect((await canvas.screenshot()).equals(first)).toBe(true);
  await page
    .getByRole("radio", { name: "Campfire · Conversation", exact: true })
    .focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("radio", { name: "Scribe’s desk · Knowledge", exact: true }),
  ).toBeChecked();
  await expect(art).not.toHaveAttribute("data-tracing");
});

async function landmarkPoint(
  page: import("@playwright/test").Page,
  phase: string,
) {
  const art = page.locator(".camp-art"),
    bounds = await art.boundingBox();
  if (!bounds) throw new Error("Missing camp bounds");
  for (let y = 0.29; y <= 0.78; y += 0.035)
    for (let x = 0.2; x <= 0.83; x += 0.035) {
      const point = {
        x: bounds.x + bounds.width * x,
        y: bounds.y + bounds.height * y,
      };
      await page.mouse.move(point.x, point.y);
      if ((await art.getAttribute("data-target-phase")) === phase) return point;
    }
  throw new Error(`No ${phase} landmark found`);
}

test("each camp landmark selects its matching native stage with a mouse or touch", async ({
  page,
  isMobile,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const art = page.locator(".camp-art");
  await art.scrollIntoViewIfNeeded();
  await expect(art).toHaveAttribute("data-renderer", "webgl");
  for (const phase of ["knowledge", "recall", "conversation"]) {
    const point = await landmarkPoint(page, phase);
    if (isMobile) await page.touchscreen.tap(point.x, point.y);
    else await page.mouse.click(point.x, point.y);
    await expect(
      page.locator(`.memory-camp input[value="${phase}"]`),
    ).toBeChecked();
    await expect(
      page.locator(`.memory-camp input[value="${phase}"]`),
    ).toBeFocused();
    await expect(page.locator(`#memory-stage-${phase}`)).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test("dragging away and returning never selects a landmark or rotates the camp", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const art = page.locator(".camp-art");
  await art.scrollIntoViewIfNeeded();
  await expect(art).toHaveAttribute("data-renderer", "webgl");
  const point = await landmarkPoint(page, "knowledge");
  await page.mouse.move(0, 0);
  await expect(art).not.toHaveAttribute("data-target-phase");
  const before = await art.locator("canvas").screenshot();
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 40, point.y);
  await page.mouse.move(point.x, point.y);
  await page.mouse.up();
  await page.mouse.move(0, 0);
  await expect(
    page.locator(".memory-camp input[value=conversation]"),
  ).toBeChecked();
  expect((await art.locator("canvas").screenshot()).equals(before)).toBe(true);
  await expect(page.getByRole("slider")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Reset view", exact: true }),
  ).toHaveCount(0);
});

test("static camp landmarks select stages without loading GPU code on low-memory devices", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "deviceMemory", { get: () => 2 }),
  );
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("memory-camp-renderer")) requests.push(r.url());
  });
  await page.goto("/");
  const art = page.locator(".camp-art");
  await art.scrollIntoViewIfNeeded();
  for (const phase of ["knowledge", "recall", "conversation"]) {
    const point = await staticLandmarkPoint(page, phase);
    expect(point).not.toBeNull();
    await page.mouse.click(point!.x, point!.y);
    await expect(
      page.locator(`.memory-camp input[value="${phase}"]`),
    ).toBeChecked();
  }
  await expect(art.locator("canvas")).toHaveCount(0);
  expect(requests).toEqual([]);
});

test("rapid forward and reverse choices settle on the latest stage, including offscreen changes", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const art = page.locator(".camp-art");
  await art.scrollIntoViewIfNeeded();
  await expect(art).toHaveAttribute("data-renderer", "webgl");
  for (const phase of [
    "recall",
    "knowledge",
    "conversation",
    "recall",
    "knowledge",
  ])
    await page.locator(`.memory-camp input[value="${phase}"]`).check();
  await expect(art).not.toHaveAttribute("data-tracing");
  await expect(page.locator("#memory-stage-knowledge")).toBeVisible();
  await page.locator(".memory-camp input[value=recall]").check();
  await expect(art).toHaveAttribute("data-tracing", "2");
  await page.locator("footer").last().scrollIntoViewIfNeeded();
  await expect(art).not.toHaveAttribute("data-tracing");
  await page
    .locator(".memory-camp input[value=conversation]")
    .evaluate((input: HTMLInputElement) => {
      input.checked = true;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  await art.scrollIntoViewIfNeeded();
  await expect(art).not.toHaveAttribute("data-tracing");
  await expect(page.locator("#memory-stage-conversation")).toBeVisible();
});

test("vertical touch gestures scroll over the camp without choosing a stage", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "Real touch gesture needs a mobile project");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const art = page.locator(".camp-art");
  await art.scrollIntoViewIfNeeded();
  await expect(art).toHaveAttribute("data-renderer", "webgl");
  const b = await art.boundingBox();
  if (!b) throw new Error("Missing camp bounds");
  const session = await page.context().newCDPSession(page),
    start = { x: b.x + b.width * 0.5, y: b.y + b.height * 0.6 };
  const before = await page.evaluate(() => scrollY);
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [start],
  });
  for (let step = 1; step <= 8; step++)
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: start.x, y: start.y - (75 * step) / 8 }],
    });
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect
    .poll(() => page.evaluate(() => scrollY))
    .toBeGreaterThan(before + 10);
  await expect(
    page.locator(".memory-camp input[value=conversation]"),
  ).toBeChecked();
  await session.detach();
});

async function staticLandmarkPoint(
  page: import("@playwright/test").Page,
  phase: string,
) {
  return page
    .locator(
      `.camp-fallback [data-camp-region="${phase}"]:not([data-camp-ring]):not([data-camp-hero])`,
    )
    .evaluateAll((paths, phase) => {
      const belongs = (x: number, y: number) =>
        document
          .elementFromPoint(x, y)
          ?.closest<SVGElement>("[data-camp-region]")?.dataset.campRegion ===
        phase;
      for (const path of paths) {
        const b = path.getBoundingClientRect();
        for (let y = Math.ceil(b.top) + 2; y < b.bottom - 2; y += 2)
          for (let x = Math.ceil(b.left) + 2; x < b.right - 2; x += 2) {
            if (
              [
                [0, 0],
                [-2, 0],
                [2, 0],
                [0, -2],
                [0, 2],
              ].every(([dx, dy]) => belongs(x + dx, y + dy))
            )
              return { x, y };
          }
      }
      return null;
    }, phase);
}

test("lost WebGL context exposes selectable fallback landmarks before restoration", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const art = page.locator(".camp-art");
  await art.scrollIntoViewIfNeeded();
  await expect(art).toHaveAttribute("data-renderer", "webgl");
  await art
    .locator("canvas")
    .evaluate((canvas: HTMLCanvasElement) =>
      canvas
        .getContext("webgl2")!
        .getExtension("WEBGL_lose_context")!
        .loseContext(),
    );
  await expect(art).toHaveAttribute("data-renderer", "static");
  const point = await staticLandmarkPoint(page, "knowledge");
  expect(point).not.toBeNull();
  await page.mouse.click(point!.x, point!.y);
  await expect(
    page.locator(".memory-camp input[value=knowledge]"),
  ).toBeChecked();
  await expect(page.locator("#memory-stage-knowledge")).toBeVisible();
});

test("leaving a static landmark cancels the press while completed touch taps remain valid", async ({
  page,
  isMobile,
}) => {
  await page.goto("/");
  await page.locator(".camp-art").scrollIntoViewIfNeeded();
  const point = await staticLandmarkPoint(page, "knowledge");
  expect(point).not.toBeNull();
  await page.mouse.move(point!.x, point!.y);
  await page.mouse.down();
  await page.mouse.move(0, 0);
  await page.mouse.move(point!.x, point!.y);
  await page.mouse.up();
  await expect(
    page.locator(".memory-camp input[value=conversation]"),
  ).toBeChecked();
  // A mouse drag to the viewport edge may scroll the page. Tap the current landmark.
  await page.locator(".camp-art").scrollIntoViewIfNeeded();
  const target = await staticLandmarkPoint(page, "knowledge");
  expect(target).not.toBeNull();
  if (isMobile) await page.touchscreen.tap(target!.x, target!.y);
  else await page.mouse.click(target!.x, target!.y);
  await expect(
    page.locator(".memory-camp input[value=knowledge]"),
  ).toBeChecked();
});
