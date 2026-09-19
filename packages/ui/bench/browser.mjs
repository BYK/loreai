// Same workload as bench.mjs, run inside headless Chromium via Playwright
// (the contracts execute in the browser, not in node). Each library is
// bundled with esbuild exactly like the shipped contracts would be, injected
// into a blank cross-origin-isolated page, and driven from the page context.
//
// Memory: Chromium is launched with `--js-flags=--expose-gc` so the page can
// force full GCs and read `performance.memory.usedJSHeapSize`;
// `performance.measureUserAgentSpecificMemory()` is also sampled where the
// page is cross-origin isolated (we serve it with COOP/COEP via route
// interception). Run: `npm run bench:browser` (uses the workspace's Playwright
// chromium). Not part of CI.
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

import { build } from "esbuild";

const require = createRequire(import.meta.url);
const { chromium } = require("../node_modules/@playwright/test");

const LIBS = (
  process.env.BENCH_LIBS ?? "zod,zod-mini,valibot,typebox,arktype"
).split(",");
const RUN_MS = Number(process.env.BENCH_RUN_MS ?? 10_000);
const WARM_MS = Number(process.env.BENCH_WARM_MS ?? 2_000);
const RETAIN = Number(process.env.BENCH_RETAIN ?? 100_000);
const PAYLOAD_NAMES = (
  process.env.BENCH_PAYLOADS ?? "entry,page,session"
).split(",");

async function bundle(name) {
  const r = await build({
    stdin: {
      contents: `
        import * as lib from "./schemas/${name}.mjs";
        import * as workload from "./workload.mjs";
        globalThis.__bench = { lib, workload };
      `,
      resolveDir: new URL(".", import.meta.url).pathname,
      loader: "js",
    },
    bundle: true,
    minify: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
    logLevel: "silent",
    define: { "process.env.BENCH_ARKTYPE_JIT": '"0"' },
  });
  return r.outputFiles[0].text;
}

const browser = await chromium.launch({
  headless: true,
  // Full chromium (not the headless shell) so measureUserAgentSpecificMemory exists.
  channel: "chromium",
  args: ["--js-flags=--expose-gc", "--enable-precise-memory-info"],
});

const results = [];
try {
  for (const name of LIBS) {
    const code = await bundle(name);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route("https://bench.local/**", (route) =>
      route.fulfill({
        status: 200,
        headers: {
          "content-type": "text/html",
          "cross-origin-opener-policy": "same-origin",
          "cross-origin-embedder-policy": "require-corp",
        },
        body: "<!doctype html><title>bench</title>",
      }),
    );
    await page.goto("https://bench.local/");
    await page.addScriptTag({ content: code });
    page.on("console", (m) => {
      if (m.type() === "error") console.error(`[${name}] ${m.text()}`);
    });

    const rows = await page.evaluate(
      async ({ warmMs, runMs, retain, payloads }) => {
        const { lib, workload } = globalThis.__bench;
        const host = {
          now: () => performance.now(),
          async settle() {
            for (let i = 0; i < 3; i++) {
              globalThis.gc();
              await new Promise((r) => setTimeout(r, 30));
            }
            return performance.memory.usedJSHeapSize;
          },
          keep(x) {
            globalThis.__keep = x;
          },
        };
        const uaMemory = async () => {
          if (
            !crossOriginIsolated ||
            !performance.measureUserAgentSpecificMemory
          )
            return null;
          try {
            const m = await performance.measureUserAgentSpecificMemory();
            return Math.round(m.bytes / 1024);
          } catch {
            return null; // not exposed in the headless shell
          }
        };
        workload.sanity(lib);
        const out = [];
        for (const payload of payloads) {
          const t = workload.throughput(lib, payload, host, { warmMs, runMs });
          const a = await workload.allocation(lib, payload, host, { n: 1000 });
          const uaBefore = await uaMemory();
          const r = await workload.retention(lib, payload, host, {
            parses: payload === "session" ? Math.round(retain / 10) : retain,
          });
          const uaAfter = await uaMemory();
          out.push({
            payload,
            ...t,
            ...a,
            ...r,
            uaMemoryKb: uaAfter,
            uaMemoryDeltaKb: uaAfter === null ? null : uaAfter - uaBefore,
          });
        }
        return out;
      },
      {
        warmMs: WARM_MS,
        runMs: RUN_MS,
        retain: RETAIN,
        payloads: PAYLOAD_NAMES,
      },
    );
    for (const row of rows) {
      const full = { lib: name, ...row };
      results.push(full);
      console.error(JSON.stringify(full));
    }
    await context.close();
  }
} finally {
  await browser.close();
}

console.log(
  `chromium ${browser.version()}, run=${RUN_MS} ms/payload, retain=${RETAIN} parses`,
);
console.table(results);
if (process.env.BENCH_JSON)
  writeFileSync(process.env.BENCH_JSON, JSON.stringify(results, null, 2));
