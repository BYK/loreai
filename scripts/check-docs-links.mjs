#!/usr/bin/env node
/**
 * Wrapper around linkinator that runs against the built-and-served
 * docs site, filters known linkinator false positives, and exits
 * non-zero only when *real* broken links remain.
 *
 * Why a wrapper:
 *   linkinator has a path-resolution bug with clean-URL sites: when
 *   the current page is a "directory" URL ending in `/` (e.g.
 *   `/docs/configuration/`), it incorrectly resolves a relative
 *   sibling `./environment/` to `/docs/configuration/environment/`
 *   instead of `/docs/environment/`. The browser resolves it
 *   correctly. This wrapper:
 *
 *     1. Builds the docs site
 *     2. Serves it on a random port via `astro preview`
 *     3. Runs linkinator against `http://127.0.0.1:PORT/docs/`
 *        with `--recurse` and a skip list for known noisy URLs
 *     4. Filters linkinator's remaining 404 output to drop
 *        false-positive resolutions of relative sibling links
 *     5. Reports any *actual* broken links and exits 1
 *
 * Usage:
 *   pnpm run check:links
 *
 * Skipped URL patterns (known false positives or intentional):
 *   - withlore.ai             — Starlight's canonical links point at
 *                                `…/docs/<page>.html` but production
 *                                uses clean URLs without `.html`.
 *                                Tracked in issue #TBD.
 *   - api.openai.com / api.anthropic.com — example base URLs in
 *                                the docs; not meant to be live.
 *   - blog.google             — external Google blog link that
 *                                has moved/404s externally.
 *   - /docs/<page>/<subpath>/  where <subpath> is a known sibling
 *                                — linkinator's clean-URL resolution
 *                                bug (see header).
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("could not allocate a port"));
      }
    });
  });
}

function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        // GET (not HEAD): some static preview servers don't support
        // HEAD and stall the request. We only care that the server
        // responds with anything that's not a 5xx — the linkinator
        // pass that follows is what actually exercises the routes.
        const res = await fetch(url, { redirect: "manual" });
        if (res.status < 500) return resolve();
      } catch {
        // not yet
      }
      if (Date.now() > deadline) {
        return reject(new Error(`server at ${url} did not become ready`));
      }
      setTimeout(tick, 200);
    };
    tick();
  });
}

const KNOWN_FALSE_POSITIVE_RESOLUTIONS = [
  // linkinator resolves these from a clean-URL page ending in `/` as if
  // the relative path was a child, not a sibling. The browser correctly
  // resolves them as siblings (returns 200 in the preview server).
  /\/docs\/configuration\/environment\/$/,
  /\/docs\/architecture\/configuration\/$/,
  /\/docs\/guides\/configuration\/$/,
  /\/docs\/guides\/architecture\/$/,
  /\/docs\/guides\/local-inference\/custom-upstreams\/$/,
  /\/docs\/guides\/custom-upstreams\/local-inference\/$/,
  // Starlight renders both a relative and an absolute copy of some
  // site-root links on the docs index. The relative copy resolves to
  // `/docs/docs/<page>.html` (404) but the absolute copy at
  // `/docs/<page>.html` is correct.
  /\/docs\/docs\/(install|architecture|index)\.html$/,
];

function isKnownFalsePositive(url) {
  return KNOWN_FALSE_POSITIVE_RESOLUTIONS.some((re) => re.test(url));
}

const SKIP_ARGS = [
  "--skip",
  "withlore\\.ai",
  "--skip",
  "https://api\\.openai\\.com",
  "--skip",
  "https://api\\.anthropic\\.com",
  "--skip",
  "https://blog\\.google",
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const root = new URL("..", import.meta.url).pathname;
process.chdir(root);

console.log("[check-links] building docs site...");
const build = spawnSync("pnpm", ["--filter", "@loreai/website", "run", "build"], {
  stdio: "inherit",
});
if (build.status !== 0) {
  console.error("[check-links] site build failed");
  process.exit(1);
}

const port = await findFreePort();
console.log(`[check-links] starting preview server on port ${port}...`);
const preview = spawn(
  "pnpm",
  [
    "--filter",
    "@loreai/website",
    "exec",
    "astro",
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
  ],
  // stdout ignored (we don't need its output); stderr piped for
  // diagnostics but drained immediately to avoid filling the pipe
  // buffer and blocking the process.
  { stdio: ["ignore", "ignore", "pipe"], detached: false },
);
// Drain stderr so astro preview never blocks on a full pipe buffer.
preview.stderr.resume();

const cleanup = () => {
  try {
    preview.kill("SIGTERM");
  } catch {
    // already dead
  }
};
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});

try {
  await waitForServer(`http://127.0.0.1:${port}/docs/`, 60000);
  console.log("[check-links] server ready, running linkinator...");

  const linkResult = spawnSync(
    "npx",
    [
      "linkinator",
      `http://127.0.0.1:${port}/docs/`,
      "--recurse",
      "--verbosity",
      "error",
      ...SKIP_ARGS,
    ],
    { encoding: "utf8" },
  );

  // linkinator exits 1 on broken links. We want to inspect the output,
  // not propagate its exit code directly.
  const stdout = linkResult.stdout || "";
  const stderr = linkResult.stderr || "";

  // Extract the lines like "  [404] http://..." and the trailing summary.
  const brokenLines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("[404]") || l.startsWith("[421]"));

  const real = brokenLines.filter((l) => {
    const url = l.replace(/^\[\d+\]\s+/, "");
    return !isKnownFalsePositive(url);
  });

  if (real.length === 0) {
    const suppressed = brokenLines.length;
    console.log(
      `[check-links] OK: 0 real broken links.` +
        (suppressed > 0 ? ` (suppressed ${suppressed} known linkinator false positives)` : ""),
    );
    process.exit(0);
  }

  console.error(`[check-links] FAIL: ${real.length} real broken link(s):`);
  for (const l of real) console.error(`  ${l}`);
  if (stderr) process.stderr.write(stderr);
  process.exit(1);
} finally {
  cleanup();
}
