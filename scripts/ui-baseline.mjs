#!/usr/bin/env node
/**
 * Reproducible gateway baseline for the UI roadmap (UI-01 / UI-02).
 *
 * Spawns the npm bundle launcher (`packages/gateway/dist/bin.cjs`, which loads
 * `dist/index.cjs` — the size reported is that of `index.cjs`) and measures:
 *   - cold startup time: spawn -> first `200 /health`
 *   - RSS after start (settled ~1 s after health)
 *   - foreground proxy latency: `POST /v1/messages` against a local mock
 *     upstream that answers instantly, so the number is gateway overhead only
 *   - management read latency: `GET /api/v1/projects`
 *
 * Everything runs against a throw-away data directory; the real
 * `~/.local/share/lore` is never touched.
 *
 * Usage:
 *   pnpm --filter @loreai/gateway run bundle
 *   node scripts/ui-baseline.mjs [--runs 5] [--requests 40] [--json out.json]
 */
import { spawn, execSync } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import os from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const binPath = join(repoRoot, "packages/gateway/dist/bin.cjs");
const bundlePath = join(repoRoot, "packages/gateway/dist/index.cjs");

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
}
function positiveInt(name, fallback) {
  const raw = flag(name, fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--${name} must be an integer >= 1 (got ${String(raw)})`);
  }
  return value;
}
const WARMUP = 5;
const PORT_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 10_000;
let RUNS = 5;
let REQUESTS = 40;

function req(
  url,
  { method = "GET", headers = {}, body, timeoutMs = REQUEST_TIMEOUT_MS } = {},
) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = httpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: body
          ? { ...headers, "content-length": Buffer.byteLength(body) }
          : headers,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    r.on("error", reject);
    r.on("timeout", () =>
      r.destroy(
        new Error(`${method} ${url} did not answer within ${timeoutMs} ms`),
      ),
    );
    if (body) r.write(body);
    r.end();
  });
}

async function timed(fn) {
  const t0 = performance.now();
  const result = await fn();
  return { ms: performance.now() - t0, result };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx];
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: round(sorted[0]),
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    max: round(sorted[sorted.length - 1]),
  };
}

function round(n) {
  return Math.round(n * 100) / 100;
}

function rssKb(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const m = /VmRSS:\s+(\d+)\s+kB/.exec(status);
    if (m) return Number(m[1]);
  } catch {
    // not Linux — fall through to ps
  }
  return Number(execSync(`ps -o rss= -p ${pid}`).toString().trim());
}

async function startMockUpstream() {
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (c) => chunks.push(c));
    request.on("end", () => {
      if (request.url === "/v1/messages" && request.method === "POST") {
        const payload = JSON.stringify({
          id: "msg_baseline",
          type: "message",
          role: "assistant",
          model: "claude-baseline",
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
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "mock upstream: unknown route" }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}` };
}

async function freePort() {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

async function waitForHealth(base, child, spawnError) {
  const deadline = Date.now() + 30_000;
  let exited = false;
  child.once("exit", () => (exited = true));
  while (Date.now() < deadline) {
    const failure = spawnError();
    if (failure) {
      throw new Error(`failed to spawn the gateway: ${failure.message}`, {
        cause: failure,
      });
    }
    if (exited) {
      throw new Error("gateway exited before becoming healthy", {
        cause: "exited",
      });
    }
    try {
      const res = await req(`${base}/health`, { timeoutMs: 2_000 });
      if (res.status === 200) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("gateway did not become healthy within 30 s");
}

async function stopChild(child) {
  // `pid` is undefined when spawn() itself failed (ENOENT/EACCES): there is
  // no process to stop and no `exit` event will ever fire.
  if (child.pid === undefined || child.exitCode !== null) return;
  if (!child.kill("SIGTERM")) return;
  const exited = once(child, "exit");
  const timeout = new Promise((r) => setTimeout(r, 8_000, "timeout"));
  if ((await Promise.race([exited, timeout])) === "timeout") {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

class PortCollision extends Error {}

/**
 * `freePort()` is a probe-then-release check, so another process can grab the
 * port between the release and the gateway's bind. When the gateway dies on
 * EADDRINUSE we simply pick another port and try again; nothing has been
 * measured yet at that point.
 */
async function measureRun(upstreamUrl, opts) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await measureRunOnce(upstreamUrl, opts);
    } catch (error) {
      if (!(error instanceof PortCollision) || attempt >= PORT_RETRIES) {
        throw error;
      }
      process.stderr.write(
        `port ${error.port} was taken before the gateway bound it; retrying (${attempt}/${PORT_RETRIES})\n`,
      );
    }
  }
}

async function measureRunOnce(upstreamUrl, { withLatency }) {
  const dataHome = mkdtempSync(join(tmpdir(), "lore-ui-baseline-"));
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
    // Keep the run offline and deterministic: no background batch work, no
    // ~137 MB embedding-model download. The measured numbers are therefore
    // "gateway core + proxy", not "gateway + local embeddings".
    LORE_BATCH_DISABLED: "1",
    HF_HUB_OFFLINE: "1",
    NO_COLOR: "1",
  };
  writeFileSync(
    join(dataHome, ".lore.json"),
    JSON.stringify({ search: { embeddings: { enabled: false } } }),
  );
  const spawnedAt = performance.now();
  const child = spawn(process.execPath, [binPath, "start", "--local"], {
    env,
    cwd: dataHome,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  // spawn() failures (ENOENT/EACCES) and undeliverable kill() signals surface
  // as `error` events; without a listener they would crash the script.
  let spawnError = null;
  child.on("error", (error) => (spawnError ??= error));
  const out = {};
  try {
    await waitForHealth(base, child, () => spawnError);
    out.startupMs = round(performance.now() - spawnedAt);
    await new Promise((r) => setTimeout(r, 1_000));
    out.rssAfterStartMb = round(rssKb(child.pid) / 1024);

    if (withLatency) {
      // A model prefix outside the built-in routing table falls through to
      // LORE_UPSTREAM_ANTHROPIC (the mock); `x-lore-agent: coder` forces the
      // full conversation pipeline instead of the meta-request passthrough.
      const proxyBody = JSON.stringify({
        model: "lore-baseline-model",
        max_tokens: 64,
        system: "You are a baseline probe. Reply with a single word.",
        messages: [{ role: "user", content: "ping" }],
      });
      const proxy = () =>
        req(`${base}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": "sk-ant-baseline-not-a-real-key",
            "anthropic-version": "2023-06-01",
            "x-lore-agent": "coder",
          },
          body: proxyBody,
        });
      for (let i = 0; i < WARMUP; i++) {
        const r = await proxy();
        if (r.status !== 200) {
          throw new Error(
            `proxy warmup returned ${r.status}: ${r.body.slice(0, 300)}`,
          );
        }
      }
      const proxySamples = [];
      for (let i = 0; i < REQUESTS; i++) {
        const { ms, result } = await timed(proxy);
        if (result.status !== 200) {
          throw new Error(`proxy request returned ${result.status}`);
        }
        proxySamples.push(ms);
      }
      out.proxyLatencyMs = summarize(proxySamples);

      const health = () => req(`${base}/health`);
      const healthSamples = [];
      for (let i = 0; i < REQUESTS; i++) {
        healthSamples.push((await timed(health)).ms);
      }
      out.healthLatencyMs = summarize(healthSamples);

      const projects = () => req(`${base}/api/v1/projects`);
      for (let i = 0; i < WARMUP; i++) await projects();
      const apiSamples = [];
      for (let i = 0; i < REQUESTS; i++) {
        const { ms, result } = await timed(projects);
        if (result.status !== 200) {
          throw new Error(`/api/v1/projects returned ${result.status}`);
        }
        apiSamples.push(ms);
      }
      out.apiProjectsLatencyMs = summarize(apiSamples);
      out.rssAfterLoadMb = round(rssKb(child.pid) / 1024);
    }
  } catch (error) {
    if (
      error?.cause === "exited" &&
      /EADDRINUSE|port\b.*\bin use/i.test(stderr)
    ) {
      throw Object.assign(new PortCollision(error.message), { port });
    }
    console.error(stderr);
    throw error;
  } finally {
    await stopChild(child);
    rmSync(dataHome, { recursive: true, force: true });
  }
  return out;
}

function machineInfo() {
  const cpus = os.cpus();
  let commit = "unknown";
  try {
    commit = execSync("git rev-parse --short HEAD", { cwd: repoRoot })
      .toString()
      .trim();
  } catch {
    // not a git checkout
  }
  return {
    commit,
    date: new Date().toISOString(),
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: `${cpus[0]?.model ?? "unknown"} x${cpus.length}`,
    memoryGb: round(os.totalmem() / 1024 ** 3),
    node: process.version,
    bundleBytes: (() => {
      try {
        return readFileSync(bundlePath).length;
      } catch {
        return null;
      }
    })(),
  };
}

async function main() {
  RUNS = positiveInt("runs", 5);
  REQUESTS = positiveInt("requests", 40);
  const jsonOut = flag("json", null);
  try {
    readFileSync(binPath);
  } catch {
    console.error(
      `missing ${binPath}\nrun: pnpm --filter @loreai/gateway run bundle`,
    );
    process.exit(1);
  }
  const info = machineInfo();
  const upstream = await startMockUpstream();
  const startups = [];
  const rss = [];
  let latency = null;
  try {
    for (let i = 0; i < RUNS; i++) {
      const isLast = i === RUNS - 1;
      const run = await measureRun(upstream.url, { withLatency: isLast });
      startups.push(run.startupMs);
      rss.push(run.rssAfterStartMb);
      if (isLast) {
        latency = {
          proxyLatencyMs: run.proxyLatencyMs,
          healthLatencyMs: run.healthLatencyMs,
          apiProjectsLatencyMs: run.apiProjectsLatencyMs,
          rssAfterLoadMb: run.rssAfterLoadMb,
        };
      }
      process.stderr.write(
        `run ${i + 1}/${RUNS}: startup ${run.startupMs} ms, rss ${run.rssAfterStartMb} MB\n`,
      );
    }
  } finally {
    upstream.server.close();
  }

  const result = {
    machine: info,
    runs: RUNS,
    startupMs: summarize(startups),
    rssAfterStartMb: summarize(rss),
    ...latency,
  };

  const md = [
    `| Metric | Value |`,
    `|---|---|`,
    `| Commit | \`${info.commit}\` |`,
    `| Machine | ${info.platform}; ${info.cpu}; ${info.memoryGb} GB; Node ${info.node} |`,
    `| Gateway bundle size (\`dist/index.cjs\`) | ${info.bundleBytes} bytes |`,
    `| Startup (spawn -> 200 /health), ${RUNS} runs | p50 ${result.startupMs.p50} ms (min ${result.startupMs.min}, max ${result.startupMs.max}) |`,
    `| RSS after start | p50 ${result.rssAfterStartMb.p50} MB (min ${result.rssAfterStartMb.min}, max ${result.rssAfterStartMb.max}) |`,
    `| RSS after latency load | ${latency.rssAfterLoadMb} MB |`,
    `| Proxy \`POST /v1/messages\` (${REQUESTS} req, mock upstream) | p50 ${latency.proxyLatencyMs.p50} ms, p95 ${latency.proxyLatencyMs.p95} ms, max ${latency.proxyLatencyMs.max} ms |`,
    `| \`GET /health\` (${REQUESTS} req) | p50 ${latency.healthLatencyMs.p50} ms, p95 ${latency.healthLatencyMs.p95} ms |`,
    `| \`GET /api/v1/projects\` (${REQUESTS} req) | p50 ${latency.apiProjectsLatencyMs.p50} ms, p95 ${latency.apiProjectsLatencyMs.p95} ms |`,
  ].join("\n");

  console.log(md);
  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify(result, null, 2) + "\n");
    process.stderr.write(`wrote ${jsonOut}\n`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
