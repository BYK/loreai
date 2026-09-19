#!/usr/bin/env node
/**
 * Cheap, browser-free smoke for the Lore UI as served by a BUILT gateway.
 *
 * Spawns the given gateway command (npm launcher or standalone binary) against
 * a throw-away data directory, then verifies with plain HTTP fetches that:
 *   - a deep link (`/ui/projects/<id>`) is answered with index.html (history
 *     fallback), no-cache, a strict CSP and X-Frame-Options: DENY
 *   - the hashed module/stylesheet referenced by index.html are served with
 *     the right MIME type and immutable caching
 *   - an unknown hashed asset is a 404, never an HTML fallback
 *   - `/` still redirects to `/ui`
 *
 * Usage:
 *   node scripts/ui-deep-link-smoke.mjs [-- <command> [args...]]
 *   (default command: node packages/gateway/dist/bin.cjs)
 */
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const command =
  sep === -1 || argv.length === sep + 1
    ? [process.execPath, join(repoRoot, "packages/gateway/dist/bin.cjs")]
    : argv.slice(sep + 1);

function req(url, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = httpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    r.on("error", reject);
    r.end();
  });
}

async function freePort() {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

async function waitForHealth(base, child) {
  const deadline = Date.now() + 30_000;
  let exited = false;
  child.once("exit", () => (exited = true));
  while (Date.now() < deadline) {
    if (exited) throw new Error("gateway exited before becoming healthy");
    try {
      const res = await req(`${base}/health`);
      if (res.status === 200) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("gateway did not become healthy within 30 s");
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = once(child, "exit");
  const timeout = new Promise((r) => setTimeout(r, 8_000, "timeout"));
  if ((await Promise.race([exited, timeout])) === "timeout") {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

let failures = 0;
function check(label, ok, detail = "") {
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const dataHome = mkdtempSync(join(tmpdir(), "lore-ui-smoke-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    XDG_DATA_HOME: dataHome,
    XDG_CONFIG_HOME: join(dataHome, "config"),
    XDG_STATE_HOME: join(dataHome, "state"),
    LORE_DB_PATH: join(dataHome, "lore.db"),
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

  console.log(`→ ${command.join(" ")} start --local (port ${port})`);
  const [bin, ...binArgs] = command;
  const child = spawn(bin, [...binArgs, "start", "--local"], {
    env,
    cwd: dataHome,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));

  try {
    await waitForHealth(base, child);

    const root = await req(`${base}/`);
    check(
      "GET / redirects to /ui",
      root.status === 302 && root.headers.location === "/ui",
      `${root.status} ${root.headers.location}`,
    );

    const deep = await req(`${base}/ui/projects/deep-link-smoke`);
    check("deep link → 200", deep.status === 200, String(deep.status));
    check(
      "deep link → text/html",
      (deep.headers["content-type"] ?? "").startsWith("text/html"),
      deep.headers["content-type"],
    );
    check("deep link → index.html body", deep.body.includes('<div id="root">'));
    check(
      "deep link → no-cache",
      deep.headers["cache-control"] === "no-cache",
      deep.headers["cache-control"],
    );
    const csp = deep.headers["content-security-policy"] ?? "";
    check(
      "deep link → strict CSP",
      csp.includes("default-src 'none'") &&
        csp.includes("script-src 'self'") &&
        csp.includes("frame-ancestors 'none'"),
      csp,
    );
    check(
      "deep link → X-Frame-Options DENY",
      deep.headers["x-frame-options"] === "DENY",
    );

    const script = /<script[^>]+src="(\/ui\/assets\/[^"]+\.js)"/.exec(
      deep.body,
    )?.[1];
    const style = /<link[^>]+href="(\/ui\/assets\/[^"]+\.css)"/.exec(
      deep.body,
    )?.[1];
    check("index.html references a hashed script", Boolean(script));
    check("index.html references a hashed stylesheet", Boolean(style));

    if (script) {
      const js = await req(`${base}${script}`);
      check(`${script} → 200`, js.status === 200, String(js.status));
      check(
        `${script} → text/javascript`,
        (js.headers["content-type"] ?? "").startsWith("text/javascript"),
        js.headers["content-type"],
      );
      check(
        `${script} → immutable cache`,
        (js.headers["cache-control"] ?? "").includes("immutable"),
        js.headers["cache-control"],
      );
    }
    if (style) {
      const css = await req(`${base}${style}`);
      check(`${style} → 200`, css.status === 200, String(css.status));
      check(
        `${style} → text/css`,
        (css.headers["content-type"] ?? "").startsWith("text/css"),
        css.headers["content-type"],
      );
      check(
        `${style} → immutable cache`,
        (css.headers["cache-control"] ?? "").includes("immutable"),
        css.headers["cache-control"],
      );
    }

    const missing = await req(`${base}/ui/assets/does-not-exist.js`);
    check(
      "unknown hashed asset → 404 (no HTML fallback)",
      missing.status === 404 &&
        !(missing.headers["content-type"] ?? "").startsWith("text/html"),
      `${missing.status} ${missing.headers["content-type"]}`,
    );
  } finally {
    await stopChild(child);
    rmSync(dataHome, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`\n✗ ${failures} UI deep-link check(s) failed`);
    if (stderr.trim()) console.error(`gateway stderr:\n${stderr}`);
    process.exit(1);
  }
  console.log("\n✓ UI deep-link smoke passed");
}

main().catch((error) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
