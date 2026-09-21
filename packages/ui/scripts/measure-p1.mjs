#!/usr/bin/env node
/**
 * Reproducible UI-07 / P1 measurements.
 *
 * This intentionally uses only Node built-ins and the pinned Playwright
 * dependency already owned by @loreai/ui.  The gateway measurements use a
 * throw-away XDG data directory and an instant local Anthropic-compatible
 * upstream, so they do not touch a developer's Lore data or the network.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import os from "node:os";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import * as zlib from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const currentGatewayRoot = repoRoot;
const DEFAULT_RUNS = 5;
const DEFAULT_REQUESTS = 200;
const WARMUP = 5;
const REQUEST_TIMEOUT_MS = 10_000;
const PORT_RETRIES = 3;

const argv = process.argv.slice(2);
function flag(name, fallback = null) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}
function positiveInt(name, fallback) {
  const raw = flag(name, String(fallback));
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--${name} must be an integer >= 1 (got ${String(raw)})`);
  }
  return value;
}
function round(value) {
  return Math.round(value * 10) / 10;
}
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index];
}
function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: round(sorted[0] ?? 0),
    p50: round(percentile(sorted, 50) ?? 0),
    p95: round(percentile(sorted, 95) ?? 0),
    p99: round(percentile(sorted, 99) ?? 0),
    max: round(sorted.at(-1) ?? 0),
  };
}
function timed(fn) {
  const started = performance.now();
  return Promise.resolve(fn()).then((result) => ({
    ms: performance.now() - started,
    result,
  }));
}
function req(url, options = {}) {
  const {
    method = "GET",
    headers = {},
    body,
    timeoutMs = REQUEST_TIMEOUT_MS,
  } = options;
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method,
        headers: body
          ? { ...headers, "content-length": Buffer.byteLength(body) }
          : headers,
        timeout: timeoutMs,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    request.on("timeout", () =>
      request.destroy(
        new Error(`${method} ${url} did not answer within ${timeoutMs} ms`),
      ),
    );
    if (body) request.write(body);
    request.end();
  });
}
async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function rssKb(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = /VmRSS:\s+(\d+)\s+kB/.exec(status);
    if (match) return Number(match[1]);
  } catch {
    // macOS and other non-Linux hosts use ps below.
  }
  return Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)]));
}
async function waitForHealth(base, child, spawnError) {
  const deadline = Date.now() + 30_000;
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  while (Date.now() < deadline) {
    const error = spawnError();
    if (error) throw new Error(`failed to spawn gateway: ${error.message}`);
    if (exited) throw new Error("gateway exited before becoming healthy");
    try {
      if ((await req(`${base}/health`, { timeoutMs: 2_000 })).status === 200) {
        return;
      }
    } catch {
      // The listener is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("gateway did not become healthy within 30 seconds");
}
async function stopChild(child) {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (!child.kill("SIGTERM")) return;
  const exited = once(child, "exit");
  const timeout = new Promise((resolve) =>
    setTimeout(resolve, 8_000, "timeout"),
  );
  if ((await Promise.race([exited, timeout])) === "timeout") {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}
async function startMockUpstream() {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      if (request.method === "POST" && request.url === "/v1/messages") {
        const payload = JSON.stringify({
          id: "msg_p1",
          type: "message",
          role: "assistant",
          model: "claude-p1",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 1 },
        });
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        });
        response.end(payload);
        return;
      }
      response.writeHead(404);
      response.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
  };
}

function readUiManifest(root) {
  const manifestPath = join(
    root,
    "packages",
    "gateway",
    "dist",
    "ui",
    "ui-manifest.json",
  );
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}
function uiAssetPaths(root) {
  const manifest = readUiManifest(root);
  return Object.keys(manifest.files).filter(
    (path) => path.endsWith(".js") || path.endsWith(".css"),
  );
}
function largestJsPath(root) {
  const manifest = readUiManifest(root);
  return Object.entries(manifest.files)
    .filter(([path]) => path.endsWith(".js"))
    .sort(([, a], [, b]) => b.size - a.size)[0]?.[0];
}

async function startGateway(root, upstreamUrl) {
  const dataHome = mkdtempSync(join(tmpdir(), "lore-ui-p1-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    XDG_DATA_HOME: dataHome,
    XDG_CONFIG_HOME: join(dataHome, "config"),
    XDG_STATE_HOME: join(dataHome, "state"),
    LORE_DB_PATH: join(dataHome, "lore.db"),
    LORE_UPSTREAM_ANTHROPIC: upstreamUrl,
    LORE_LISTEN_PORT: String(port),
    LORE_LISTEN_HOST: "127.0.0.1",
    LORE_BATCH_DISABLED: "1",
    HF_HUB_OFFLINE: "1",
    NO_COLOR: "1",
  };
  writeFileSync(
    join(dataHome, ".lore.json"),
    JSON.stringify({ search: { embeddings: { enabled: false } } }),
  );
  const binPath = join(root, "packages", "gateway", "dist", "bin.cjs");
  const child = spawn(process.execPath, [binPath, "start", "--local"], {
    cwd: dataHome,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  let spawnError = null;
  child.on("error", (error) => {
    spawnError ??= error;
  });
  const started = performance.now();
  try {
    await waitForHealth(base, child, () => spawnError);
  } catch (error) {
    await stopChild(child);
    rmSync(dataHome, { recursive: true, force: true });
    throw new Error(`${error.message}${stderr ? `\n${stderr}` : ""}`);
  }
  return {
    base,
    child,
    dataHome,
    startupMs: performance.now() - started,
    async stop() {
      await stopChild(child);
      rmSync(dataHome, { recursive: true, force: true });
    },
  };
}

const proxyBody = JSON.stringify({
  model: "lore-p1-model",
  max_tokens: 64,
  system: "You are a P1 probe. Reply with a single word.",
  messages: [{ role: "user", content: "ping" }],
});
function latencyProbes(base, largestJs, includeUi) {
  const proxy = () =>
    req(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-ant-p1-not-a-real-key",
        "anthropic-version": "2023-06-01",
        "x-lore-agent": "coder",
      },
      body: proxyBody,
    });
  const probes = {
    "POST /v1/messages": proxy,
    "GET /health": () => req(`${base}/health`),
    "GET /api/v1/projects": () => req(`${base}/api/v1/projects`),
  };
  if (includeUi) {
    probes["GET /ui/"] = () => req(`${base}/ui/`);
    probes[`GET /ui/${largestJs}`] = () =>
      req(`${base}/ui/${largestJs}`, {
        headers: { "accept-encoding": "br" },
      });
  }
  return probes;
}
async function collectLatency(base, requests, root, includeUi) {
  const probes = latencyProbes(
    base,
    includeUi ? largestJsPath(root) : null,
    includeUi,
  );
  const result = {};
  for (const [name, probe] of Object.entries(probes)) {
    for (let i = 0; i < WARMUP; i++) {
      const response = await probe();
      if (response.status !== 200) {
        throw new Error(`${name} warmup returned ${response.status}`);
      }
    }
    const samples = [];
    for (let i = 0; i < requests; i++) {
      const sample = await timed(probe);
      if (sample.result.status !== 200) {
        throw new Error(`${name} returned ${sample.result.status}`);
      }
      samples.push(sample.ms);
    }
    result[name] = summarize(samples);
  }
  return result;
}
async function serveUi(base, root) {
  const index = await req(`${base}/ui`);
  if (index.status !== 200) throw new Error(`GET /ui returned ${index.status}`);
  const html = await req(`${base}/ui/index.html`);
  if (html.status !== 200) {
    throw new Error(`GET /ui/index.html returned ${html.status}`);
  }
  for (const asset of uiAssetPaths(root)) {
    const response = await req(`${base}/ui/${asset}`, {
      headers: { "accept-encoding": "br" },
    });
    if (response.status !== 200) {
      throw new Error(`GET /ui/${asset} returned ${response.status}`);
    }
  }
}

async function firstRender(root, base) {
  const { chromium } = await import("@playwright/test");
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    await page.goto(`${base}/ui`, { waitUntil: "load" });
    await page.waitForSelector('[data-testid="connection-status"]');
    const sample = await page.evaluate(() => {
      const navigation = performance.getEntriesByType("navigation")[0];
      const paints = Object.fromEntries(
        performance
          .getEntriesByType("paint")
          .map((entry) => [entry.name, entry.startTime]),
      );
      return {
        domContentLoadedEventEnd: navigation?.domContentLoadedEventEnd ?? null,
        loadEventEnd: navigation?.loadEventEnd ?? null,
        firstPaint: paints["first-paint"] ?? null,
        firstContentfulPaint: paints["first-contentful-paint"] ?? null,
        firstUsefulContentMs: performance.now(),
      };
    });
    samples.push(sample);
    await context.close();
    await browser.close();
  }
  return samples;
}

function frameSummary(samples) {
  const intervals = samples.filter((value) => value > 0);
  const sorted = [...intervals].sort((a, b) => a - b);
  return {
    count: intervals.length,
    p50: round(percentile(sorted, 50) ?? 0),
    p95: round(percentile(sorted, 95) ?? 0),
    max: round(Math.max(...intervals, 0)),
    over50Ms: intervals.filter((value) => value > 50).length,
  };
}
async function startVite(port, gatewayBase) {
  const child = spawn(
    "pnpm",
    ["exec", "vite", "--port", String(port), "--strictPort"],
    {
      cwd: join(repoRoot, "packages", "ui"),
      env: { ...process.env, LORE_UI_GATEWAY: gatewayBase },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        if (
          (await req(`${base}/ui/fixture?view=busy`, { timeoutMs: 1_000 }))
            .status === 200
        ) {
          return { child, base };
        }
      } catch {
        // Vite is still starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Vite did not become ready within 30 seconds");
  } catch (error) {
    await stopChild(child);
    throw new Error(`${error.message}${stderr ? `\n${stderr}` : ""}`);
  }
}
async function busyScroll(viewport, gatewayBase) {
  const { chromium } = await import("@playwright/test");
  const vitePort = await freePort();
  const vite = await startVite(vitePort, gatewayBase);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: viewport.width < 500 ? 3 : 1,
    hasTouch: viewport.width < 500,
  });
  const page = await context.newPage();
  try {
    await page.goto(`${vite.base}/ui/fixture?view=busy`, { waitUntil: "load" });
    await page.waitForSelector('[data-testid="busy-start"]');
    await page.waitForSelector('[data-testid="busy-mounted"]');
    await page.evaluate(() => {
      window.__p1Frames = [];
      window.__p1LongTasks = [];
      let previous = null;
      const frame = (timestamp) => {
        if (previous !== null) window.__p1Frames.push(timestamp - previous);
        previous = timestamp;
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      if (typeof PerformanceObserver !== "undefined") {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            window.__p1LongTasks.push(entry.duration);
          }
        });
        if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
          observer.observe({ type: "longtask", buffered: true });
        }
      }
    });
    await page.getByTestId("busy-start").click();
    const scroll = page.getByTestId("session-scroll");
    for (let i = 0; i < 40; i++) {
      await scroll.hover();
      await page.mouse.wheel(0, 1500);
    }
    await scroll.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const frames = await page.evaluate(() => window.__p1Frames);
    const longTasks = await page.evaluate(() => window.__p1LongTasks);
    await page.getByTestId("busy-metrics").click();
    const report = JSON.parse(
      (await page.getByTestId("busy-report-json").textContent()) ?? "{}",
    );
    return {
      viewport,
      frameIntervals: frameSummary(frames),
      longTasks: {
        count: longTasks.length,
        totalMs: round(longTasks.reduce((sum, value) => sum + value, 0)),
        maxMs: round(Math.max(...longTasks, 0)),
      },
      busyReport: report,
    };
  } finally {
    await context.close();
    await browser.close();
    await stopChild(vite.child);
  }
}
function walkFiles(dir, prefix = "") {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const relativePath = join(prefix, entry.name).split("\\").join("/");
    if (entry.isDirectory()) files.push(...walkFiles(path, relativePath));
    else files.push([path, relativePath]);
  }
  return files.sort(([, a], [, b]) => a.localeCompare(b));
}
function bundleSizes(root) {
  const uiDir = join(root, "packages", "gateway", "dist", "ui");
  const assets = walkFiles(uiDir)
    .filter(
      ([, relativePath]) =>
        !relativePath.endsWith(".br") && !relativePath.endsWith(".gz"),
    )
    .map(([path, relativePath]) => {
      const data = readFileSync(path);
      const compressedSize = (suffix, compress) => {
        const siblingPath = `${path}${suffix}`;
        if (existsSync(siblingPath)) {
          return {
            bytes: statSync(siblingPath).size,
            source: "sibling",
          };
        }
        return {
          bytes: compress(data).length,
          source: "script",
        };
      };
      const gzip = compressedSize(".gz", (value) =>
        zlib.gzipSync(value, { level: 9 }),
      );
      const brotli = compressedSize(".br", (value) =>
        zlib.brotliCompressSync(value, {
          params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
        }),
      );
      return {
        path: relativePath,
        raw: data.length,
        gzip: gzip.bytes,
        gzipSource: gzip.source,
        brotli: brotli.bytes,
        brotliSource: brotli.source,
      };
    });
  const total = assets.reduce(
    (sum, asset) => ({
      raw: sum.raw + asset.raw,
      gzip: sum.gzip + asset.gzip,
      brotli: sum.brotli + asset.brotli,
    }),
    { raw: 0, gzip: 0, brotli: 0 },
  );
  const bundlePath = join(root, "packages", "gateway", "dist", "index.cjs");
  return {
    assets,
    total,
    gatewayIndexCjs: statSync(bundlePath).size,
  };
}
function gitSha(root) {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}
function environment(root) {
  const cpus = os.cpus();
  return {
    cpuModel: cpus[0]?.model ?? "unknown",
    cpuCount: cpus.length,
    totalMemoryBytes: os.totalmem(),
    node: process.version,
    osRelease: os.release(),
    platform: os.platform(),
    arch: os.arch(),
    gitSha: gitSha(root),
    date: new Date().toISOString(),
    argv: process.argv,
  };
}
function deltaPercent(current, baseline) {
  if (baseline == null || baseline === 0) return null;
  return ((current - baseline) / baseline) * 100;
}
function formatDelta(current, baseline) {
  const delta = deltaPercent(current, baseline);
  if (delta == null) return "—";
  return `${delta >= 0 ? "+" : ""}${round(delta)}%`;
}
function shellQuote(value) {
  return /^[A-Za-z0-9_./:=+-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}
function medianOfRunSummaries(runs, key) {
  const values = runs
    .map((run) => run[key])
    .filter((value) => typeof value === "number");
  return values.length ? summarize(values) : null;
}
async function measureGateway(
  root,
  runs,
  requests,
  upstreamUrl,
  { render, serveUiAssets = true, includeUiLatency = true },
) {
  const runResults = [];
  for (let index = 0; index < runs; index++) {
    let gateway;
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          gateway = await startGateway(root, upstreamUrl);
          break;
        } catch (error) {
          if (
            attempt >= PORT_RETRIES ||
            !/EADDRINUSE|port/i.test(error.message)
          ) {
            throw error;
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const rssAfterStartMb = round(rssKb(gateway.child.pid) / 1024);
      if (serveUiAssets) await serveUi(gateway.base, root);
      const rssAfterUiMb = serveUiAssets
        ? round(rssKb(gateway.child.pid) / 1024)
        : null;
      const latency = await collectLatency(
        gateway.base,
        requests,
        root,
        includeUiLatency,
      );
      const result = {
        run: index + 1,
        startupMs: round(gateway.startupMs),
        rssAfterStartMb,
        rssAfterUiMb,
        latency,
      };
      if (render && index === runs - 1) {
        result.firstRender = await firstRender(root, gateway.base);
      }
      runResults.push(result);
      process.stderr.write(
        `run ${index + 1}/${runs}: startup ${result.startupMs} ms, RSS ${rssAfterStartMb} -> ${rssAfterUiMb} MB\n`,
      );
    } finally {
      await gateway?.stop();
    }
  }
  const firstRenderSamples =
    runResults.find((run) => run.firstRender)?.firstRender ?? [];
  const endpointNames = Object.keys(runResults[0].latency);
  const latency = Object.fromEntries(
    endpointNames.map((name) => [
      name,
      Object.fromEntries(
        ["p50", "p95", "p99"].map((percentileName) => [
          percentileName,
          summarize(runResults.map((run) => run.latency[name][percentileName]))[
            percentileName
          ],
        ]),
      ),
    ]),
  );
  return {
    runs: runResults,
    startupMs: medianOfRunSummaries(runResults, "startupMs"),
    rssAfterStartMb: medianOfRunSummaries(runResults, "rssAfterStartMb"),
    rssAfterUiMb: medianOfRunSummaries(runResults, "rssAfterUiMb"),
    latency,
    firstRender: firstRenderSamples.length
      ? {
          samples: firstRenderSamples,
          median: Object.fromEntries(
            Object.keys(firstRenderSamples[0]).map((key) => [
              key,
              round(
                firstRenderSamples
                  .map((sample) => sample[key])
                  .sort((a, b) => a - b)[
                  Math.floor(firstRenderSamples.length / 2)
                ],
              ),
            ]),
          ),
        }
      : null,
  };
}

async function baselineMeasurement(sha, runs, requests, upstreamUrl) {
  const worktree = join(tmpdir(), `lore-baseline-${sha}`);
  let buildError = null;
  let worktreeSha = "unknown";
  try {
    execFileSync("git", ["worktree", "add", worktree, sha], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    worktreeSha = gitSha(worktree);
    try {
      execFileSync("pnpm", ["install", "--frozen-lockfile"], {
        cwd: worktree,
        stdio: "inherit",
        timeout: 300_000,
      });
      execFileSync("pnpm", ["--filter", "@loreai/gateway", "run", "bundle"], {
        cwd: worktree,
        stdio: "inherit",
        timeout: 300_000,
      });
    } catch (error) {
      buildError = String(error);
    }
    if (buildError) {
      return { sha, worktreeSha, buildError, measurement: null };
    }
    return {
      sha,
      worktreeSha,
      buildError: null,
      measurement: await measureGateway(worktree, runs, requests, upstreamUrl, {
        render: false,
        serveUiAssets: false,
        includeUiLatency: false,
      }),
    };
  } catch (error) {
    return {
      sha,
      worktreeSha,
      buildError: buildError ?? String(error),
      measurement: null,
    };
  } finally {
    try {
      execFileSync("git", ["worktree", "remove", "--force", worktree], {
        cwd: repoRoot,
        stdio: "inherit",
      });
    } catch {
      // Preserve the useful build/measurement error; cleanup is best effort.
    }
  }
}

function formatBytes(bytes) {
  return `${bytes.toLocaleString("en-US")} B`;
}
function formatCompressedBytes(bytes, source) {
  return `${formatBytes(bytes)}${source === "script" ? "*" : ""}`;
}
function formatMaybe(value, suffix = " ms") {
  return value == null ? "—" : `${value}${suffix}`;
}
function formatNumber(value) {
  return value == null ? "—" : String(round(value));
}
function markdown(result) {
  const current = result.current;
  const baseline = result.baseline?.measurement;
  const command = result.environment.argv.map(shellQuote).join(" ");
  const hasBaselineUi = Boolean(baseline?.latency?.["GET /ui/"]);
  const baselineWorktree = result.baseline
    ? `; baseline worktree SHA ${result.baseline.worktreeSha ?? "unknown"}`
    : "";
  const lines = [
    "<!-- p1-measurements:start -->",
    "### UI-07 P1 measurements",
    "",
    `Command: \`${command}\``,
    "",
    `Machine: ${result.environment.cpuModel} × ${result.environment.cpuCount}; ${(result.environment.totalMemoryBytes / 1024 ** 3).toFixed(1)} GiB; Node ${result.environment.node}; ${result.environment.platform} ${result.environment.osRelease} ${result.environment.arch}${baselineWorktree}.`,
    "",
    `Git SHA: \`${result.environment.gitSha}\`; measured ${result.environment.date}.`,
    "",
    ...(result.baseline
      ? [
          `Baseline SHA: \`${result.baseline.sha}\` (worktree \`${result.baseline.worktreeSha ?? "unknown"}\`).`,
          "",
          ...(hasBaselineUi
            ? []
            : [
                `Baseline note: commit \`${result.baseline.sha}\` predates the current \`/ui\` surface, so UI-specific baseline rows are \`—\`.`,
                "",
              ]),
        ]
      : []),
    ...(result.baseline?.buildError
      ? [
          `Baseline \`${result.baseline.sha}\` build skipped: ${result.baseline.buildError}.`,
          "",
        ]
      : []),
    "| Metric | Current | Baseline | vs baseline (%) |",
    "|---|---:|---:|---:|",
    `| Startup → first 200 \`/health\` (median of ${current.runs.length} runs) | p50 ${current.startupMs.p50} ms | ${baseline ? `p50 ${baseline.startupMs.p50} ms` : "—"} | ${formatDelta(current.startupMs.p50, baseline?.startupMs.p50)} |`,
    `| RSS after start | p50 ${current.rssAfterStartMb.p50} MB | ${baseline ? `p50 ${baseline.rssAfterStartMb.p50} MB` : "—"} | ${formatDelta(current.rssAfterStartMb.p50, baseline?.rssAfterStartMb.p50)} |`,
    `| RSS after serving UI | p50 ${current.rssAfterUiMb.p50} MB | ${baseline?.rssAfterUiMb ? `p50 ${baseline.rssAfterUiMb.p50} MB` : "—"} | ${formatDelta(current.rssAfterUiMb.p50, baseline?.rssAfterUiMb?.p50)} |`,
    "",
    `Latency summaries use ${result.requests} warmed requests per endpoint; each value is the median of per-run percentiles.`,
    "",
    "| Endpoint | Current p50 / p95 / p99 | Baseline p50 / p95 / p99 | vs baseline p50 (%) | vs baseline p95 (%) |",
    "|---|---:|---:|---:|---:|",
  ];
  for (const name of Object.keys(current.latency)) {
    const values = (data) => {
      const value = data?.[name];
      return value ? `${value.p50} / ${value.p95} / ${value.p99} ms` : "—";
    };
    const baselineValues = baseline?.latency?.[name];
    const currentValues = current.latency[name];
    lines.push(
      `| \`${name}\` | ${values(current.latency)} | ${values(baseline?.latency)} | ${formatDelta(currentValues.p50, baselineValues?.p50)} | ${formatDelta(currentValues.p95, baselineValues?.p95)} |`,
    );
  }
  lines.push(
    "",
    "| Bundle asset | Raw | gzip-9 | Brotli-11 |",
    "|---|---:|---:|---:|",
  );
  for (const asset of current.bundle.assets) {
    lines.push(
      `| \`${asset.path}\` | ${formatBytes(asset.raw)} | ${formatCompressedBytes(asset.gzip, asset.gzipSource)} | ${formatCompressedBytes(asset.brotli, asset.brotliSource)} |`,
    );
  }
  lines.push(
    `| **Total staged UI** | **${formatBytes(current.bundle.total.raw)}** | **${formatBytes(current.bundle.total.gzip)}** | **${formatBytes(current.bundle.total.brotli)}** |`,
    `| \`dist/index.cjs\` | ${formatBytes(current.bundle.gatewayIndexCjs)} | — | — |`,
    ...(current.bundle.assets.some(
      (asset) =>
        asset.gzipSource === "script" || asset.brotliSource === "script",
    )
      ? ["", "* no precompressed sibling; compressed by the script"]
      : []),
    "",
    "| First render (5 fresh contexts) | Median |",
    "|---|---:|",
  );
  for (const [key, value] of Object.entries(
    current.firstRender?.median ?? {},
  )) {
    lines.push(`| ${key} | ${formatMaybe(value)} |`);
  }
  lines.push(
    "",
    "| Long-history scroll | Frame p50 / p95 / max | Frames >50 ms | Long tasks (count / total / max) | Fixture frame p95 / max |",
    "|---|---:|---:|---:|---:|",
  );
  for (const scroll of result.scroll) {
    const fixture = scroll.busyReport.frames ?? {};
    lines.push(
      `| ${scroll.name} | ${scroll.frameIntervals.p50} / ${scroll.frameIntervals.p95} / ${scroll.frameIntervals.max} ms | ${scroll.frameIntervals.over50Ms} | ${scroll.longTasks.count} / ${scroll.longTasks.totalMs} / ${scroll.longTasks.maxMs} ms | ${formatNumber(fixture.p95)} / ${formatNumber(fixture.max)} ms |`,
    );
  }
  lines.push("<!-- p1-measurements:end -->");
  return lines.join("\n");
}
function writeReadme(block) {
  const readmePath = join(repoRoot, "packages", "ui", "README.md");
  const readme = readFileSync(readmePath, "utf8");
  const start = "<!-- p1-measurements:start -->";
  const end = "<!-- p1-measurements:end -->";
  const startIndex = readme.indexOf(start);
  const endIndex = readme.indexOf(end);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error("README is missing p1-measurements markers");
  }
  writeFileSync(
    readmePath,
    `${readme.slice(0, startIndex)}${block}${readme.slice(endIndex + end.length)}`,
  );
}

async function main() {
  const runs = positiveInt("runs", DEFAULT_RUNS);
  const requests = positiveInt("requests", DEFAULT_REQUESTS);
  const baselineSha = flag("baseline");
  const jsonPath = flag("json");
  const markdownPath = flag("markdown");
  const writeReadmeFlag = argv.includes("--write-readme");
  const gatewayBin = join(
    currentGatewayRoot,
    "packages",
    "gateway",
    "dist",
    "bin.cjs",
  );
  if (!existsSync(gatewayBin)) {
    throw new Error(
      `missing ${gatewayBin}; run pnpm --filter @loreai/gateway run bundle first`,
    );
  }
  const upstream = await startMockUpstream();
  try {
    process.stderr.write(`measuring current gateway (${runs} runs)\n`);
    const current = await measureGateway(
      currentGatewayRoot,
      runs,
      requests,
      upstream.url,
      { render: true },
    );
    current.bundle = bundleSizes(currentGatewayRoot);
    const scroll = [];
    const fixtureGateway = await startGateway(repoRoot, upstream.url);
    try {
      const desktop = await busyScroll(
        { width: 1280, height: 800 },
        fixtureGateway.base,
      );
      desktop.name = "desktop (1280×800)";
      scroll.push(desktop);
      const mobile = await busyScroll(
        { width: 393, height: 852 },
        fixtureGateway.base,
      );
      mobile.name = "mobile (393×852, DPR 3)";
      scroll.push(mobile);
    } finally {
      await fixtureGateway.stop();
    }
    const baseline = baselineSha
      ? await baselineMeasurement(baselineSha, runs, requests, upstream.url)
      : null;
    const result = {
      environment: environment(repoRoot),
      command: process.argv,
      runs,
      requests,
      current,
      scroll,
      baseline,
    };
    const block = markdown(result);
    if (markdownPath) writeFileSync(markdownPath, `${block}\n`);
    if (writeReadmeFlag) writeReadme(block);
    if (jsonPath)
      writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
    console.log(block);
    if (jsonPath) process.stderr.write(`wrote ${jsonPath}\n`);
    if (markdownPath) process.stderr.write(`wrote ${markdownPath}\n`);
  } finally {
    await new Promise((resolve) => upstream.server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
