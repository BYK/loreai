// Measure the local-embedding OOM *ceiling* on the REAL bundled WASM worker
// (the runtime users actually run, #999) by binary-searching the largest token
// cap that completes vs the smallest that OOMs. Complements measure-embed-cap.mjs
// (which fits the baseline + K·L² footprint model up to a safe length).
//
// WHY a separate ceiling matters: the bundled `ort-wasm-simd-threaded` build
// declares `Memory({ initial: 256, maximum: 65536, shared: true })` → 65536
// pages × 64 KiB = 4 GiB MAXIMUM_MEMORY. That cap is FIXED regardless of host
// RAM, so a token cap sized purely from `os.freemem()` can exceed it on a
// memory-rich box and OOM the WASM heap on every cold start. embedding-cap.ts
// bounds the freemem-derived cap by WASM_SUSTAINABLE_MAX_TOKENS (derived from
// this 4 GiB cap); this script is how you re-measure/verify that boundary.
//
// Each candidate gets a FRESH worker: WASM linear memory never shrinks, and an
// OOM exits the worker with EMBED_OOM_EXIT_CODE (75). A candidate is:
//   OK      → worker returned a result vector
//   OOM     → worker exited 75 (exceeded the WASM heap)
//   SLOW    → >90s with no result (host-memory thrashing, NOT a WASM OOM; only
//             happens when free RAM is marginal — treated as inconclusive)
//
// Prereqs (same as measure-embed-cap.mjs):
//   1. pnpm --filter @loreai/gateway run bundle
//   2. LORE_MODEL_CACHE=<transformers cache root with nomic-ai/…> \
//        node packages/core/eval/measure-embed-ceiling.mjs
//   LORE_DIST_DIR overrides the gateway dist dir (defaults to packages/gateway/dist).
//   LO/HI override the initial binary-search bounds (defaults 2048 / 8192).

import { existsSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const EMBED_OOM_EXIT_CODE = 75;
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const distDir =
  process.env.LORE_DIST_DIR ?? path.join(repoRoot, "packages/gateway/dist");
const modelCache = process.env.LORE_MODEL_CACHE;
const wrapper = path.join(here, "measure-embed-cap-wrapper.cjs");

for (const [label, p] of [
  ["worker", path.join(distDir, "embedding-worker.cjs")],
  ["wasm", path.join(distDir, "ort-wasm-simd-threaded.wasm")],
  ["wrapper", wrapper],
  [
    "model",
    path.join(modelCache ?? "", "nomic-ai/nomic-embed-text-v1.5/config.json"),
  ],
]) {
  if (!existsSync(p)) {
    console.error(
      `missing ${label}: ${p}\n(build the bundle and set LORE_MODEL_CACHE — see header)`,
    );
    process.exit(1);
  }
}

// Long enough that the worker's tokenizer truncates down to any target L.
const longText = "lorem ipsum dolor sit amet consectetur ".repeat(2000);

/** Run one candidate cap on a fresh worker. Resolves "OK" | "OOM" | "SLOW". */
function testCap(N) {
  return new Promise((resolve) => {
    const w = new Worker(wrapper, {
      workerData: {
        _distDir: distDir,
        modelId: "nomic-ai/nomic-embed-text-v1.5",
        dimensions: 768,
        vendorModel: { localModelPath: modelCache },
        maxTokens: 8192,
      },
    });
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      w.terminate().catch(() => {});
      resolve(v);
    };
    const timer = setTimeout(() => finish("SLOW"), 90_000);
    w.on("message", (m) => {
      if (m.type === "result") finish("OK");
      else if (m.type === "error" || m.type === "init-error")
        finish(`ERR:${String(m.error).slice(0, 48)}`);
    });
    w.on("exit", (code) => finish(code === EMBED_OOM_EXIT_CODE ? "OOM" : "OK"));
    w.on("error", (e) => finish(`THREW:${String(e).slice(0, 48)}`));
    w.postMessage({
      type: "embed",
      id: 1,
      texts: [longText],
      inputType: "document",
      priority: "normal",
      maxTokens: N,
    });
  });
}

console.log(
  `free=${(freemem() / 2 ** 30).toFixed(1)}GiB total=${(totalmem() / 2 ** 30).toFixed(1)}GiB` +
    ` — NOTE: SLOW results mean host-memory thrashing; run on a box with ≥6 GiB free for a clean WASM-OOM boundary.\n`,
);

let lo = Number(process.env.LO || 2048); // expected OK
let hi = Number(process.env.HI || 8192); // expected OOM
const rLo = await testCap(lo);
const rHi = await testCap(hi);
console.log(`probe lo=${lo} → ${rLo}`);
console.log(`probe hi=${hi} → ${rHi}`);
if (rLo !== "OK") {
  console.log(`lo=${lo} not OK (${rLo}); lower LO or free up RAM.`);
  process.exit(0);
}
if (rHi === "OK") {
  console.log(`hi=${hi} is OK — ceiling ≥ model max on this host.`);
  process.exit(0);
}

// Binary-search the OK/OOM boundary. SLOW is inconclusive (host pressure) — we
// nudge the window down and keep the last confirmed OK as the reported floor.
let bestOk = lo;
let firstOom = hi;
while (firstOom - bestOk > 128) {
  const mid = (bestOk + firstOom) >> 1;
  const r = await testCap(mid);
  console.log(`  test ${mid} → ${r}`);
  if (r === "OK") bestOk = mid;
  else if (r === "OOM") firstOom = mid;
  else firstOom = mid; // SLOW: treat as an upper bound; don't claim it OOMed
}
console.log(
  `\n=== confirmed OK ≤ ${bestOk} tokens; OOM/inconclusive from ${firstOom} ===`,
);
console.log(
  "The clean WASM-OOM boundary derives from the 4 GiB MAXIMUM_MEMORY and the\n" +
    "measured baseline/K (footprint(L) ≈ 680 MB + 120·L²): 4 GiB ⇒ L ≈ 5460.",
);
process.exit(0);
