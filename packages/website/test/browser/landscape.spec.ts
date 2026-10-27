import { expect, test } from "@playwright/test";

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
  await expect(graph.locator(".landscape-pin")).toHaveCount(3);
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
  await page.getByRole("radio", { name: "2 Knowledge", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("radio", { name: "3 Recall", exact: true }),
  ).toBeChecked();
  await expect(page.locator("#memory-stage-recall")).toBeVisible();
  await expect(
    page.getByRole("radio", { name: "3 Recall", exact: true }).locator(".."),
  ).toHaveCSS("outline-style", "solid");
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
  await page.getByRole("radio", { name: "2 Knowledge", exact: true }).check();
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
  await page.getByRole("radio", { name: "2 Knowledge", exact: true }).check();
  await expect(page.locator('[data-marker="knowledge"]')).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(page.locator("#memory-stage-knowledge")).toBeVisible();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(art).toHaveAttribute("data-renderer", "static");
  await expect(art.locator("canvas")).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(art).toHaveAttribute("data-renderer", "webgl");
  await expect(
    page.getByRole("radio", { name: "2 Knowledge", exact: true }),
  ).toBeChecked();
  await expect(page.locator('[data-marker="knowledge"]')).toHaveAttribute(
    "data-selected",
    "true",
  );
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
  await page.getByRole("radio", { name: "3 Recall", exact: true }).check();
  const rotation = page.getByRole("slider", { name: "Rotate landscape" });
  await rotation.fill("24");
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
  await expect(graph.locator(".landscape-fallback")).toBeVisible();
  await page.evaluate(() =>
    (
      window as Window & { restoreGraphContext?: () => void }
    ).restoreGraphContext?.(),
  );
  await expect(graph).toHaveAttribute("data-renderer", "webgl");
  await expect(page.locator("#memory-stage-recall")).toBeVisible();
  await expect(graph.locator("canvas")).toHaveCount(1);
  await expect(rotation).toHaveValue("24");
});

async function regionPoint(
  page: import("@playwright/test").Page,
  phase: string,
) {
  const art = page.locator(".landscape-art");
  const bounds = await art.boundingBox();
  if (!bounds) throw new Error("Landscape has no layout bounds");
  // Broad terrain samples: exclude the label area to exercise the terrain raycaster.
  for (let y = 0.4; y <= 0.78; y += 0.06)
    for (let x = 0.25; x <= 0.78; x += 0.06) {
      const point = {
        x: bounds.x + bounds.width * x,
        y: bounds.y + bounds.height * y,
      };
      if (
        await page.locator(".landscape-labels span").evaluateAll(
          (labels, p) =>
            labels.some((label) => {
              const b = label.getBoundingClientRect();
              return (
                p.x >= b.left - 10 &&
                p.x <= b.right + 10 &&
                p.y >= b.top - 10 &&
                p.y <= b.bottom + 10
              );
            }),
          point,
        )
      )
        continue;
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
    ["knowledge", "2 Knowledge"],
    ["recall", "3 Recall"],
    ["conversation", "1 Conversation"],
  ]) {
    const point = await regionPoint(page, phase);
    if (isMobile) await page.touchscreen.tap(point.x, point.y);
    else await page.mouse.click(point.x, point.y);
    await expect(page.getByRole("radio", { name, exact: true })).toBeChecked();
    await expect(page.getByRole("radio", { name, exact: true })).toBeFocused();
    await expect(page.locator(`#memory-stage-${phase}`)).toBeVisible();
    await expect(page.locator(`[data-marker="${phase}"]`)).toHaveAttribute(
      "data-selected",
      "true",
    );
  }
  expect(errors).toEqual([]);
});

test("dragging away and back rotates without selecting a region; keyboard rotation and reset remain available", async ({
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
  const slider = page.getByRole("slider", { name: "Rotate landscape" });
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveValue("1");
  await page.getByRole("button", { name: "Reset view", exact: true }).click();
  await expect(slider).toHaveValue("0");
  const target = await regionPoint(page, "recall");
  await page.mouse.click(target.x, target.y);
  await expect(
    page.getByRole("radio", { name: "3 Recall", exact: true }),
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
    page.getByRole("radio", { name: "2 Knowledge", exact: true }),
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
  await page.getByRole("radio", { name: "3 Recall", exact: true }).check();
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

test("forward stage selection traces once, then the terrain settles without idle motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const art = page.locator(".landscape-art");
  await art.scrollIntoViewIfNeeded();
  await expect(art).toHaveAttribute("data-renderer", "webgl");
  await page.getByRole("radio", { name: "3 Recall", exact: true }).check();
  await expect(art).toHaveAttribute("data-tracing", "2");
  await expect(art).not.toHaveAttribute("data-tracing");
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
    page.getByRole("radio", { name: "2 Knowledge", exact: true }),
  ).toBeChecked();
  await expect(art).not.toHaveAttribute("data-tracing");
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
  await expect(
    page.getByRole("slider", { name: "Rotate landscape" }),
  ).not.toHaveValue("0");
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
