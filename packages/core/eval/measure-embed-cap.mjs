// Measure the local-embedding attention coefficient K (bytes/token²) and the
// resident baseline (model + ORT/WASM runtime) on the REAL bundled WASM worker
// — the runtime users actually run (#857). Drives the built worker at growing
// token lengths and least-squares fits RSS(L) = baseline + K·L². WASM linear
// memory never shrinks, so RSS(L) is the monotonic high-water = footprint at L.
//
// Prereqs:
//   1. Build the gateway so the bundled WASM worker exists:
//        pnpm --filter @loreai/gateway run bundle
//   2. Have the nomic model on disk as a transformers.js local-model dir
//      (a `<cache>/nomic-ai/nomic-embed-text-v1.5/` layout), e.g. an existing
//      HF cache. Point LORE_MODEL_CACHE at the `<cache>` root.
//
// Run from the repo root with a GC hook:
//   LORE_MODEL_CACHE=/path/to/hf/cache \
//     node --expose-gc packages/core/eval/measure-embed-cap.mjs
//
// LORE_DIST_DIR overrides the gateway dist dir (defaults to packages/gateway/dist).

import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

const distDir =
  process.env.LORE_DIST_DIR ?? path.join(repoRoot, "packages/gateway/dist");
const modelCache = process.env.LORE_MODEL_CACHE;
if (!modelCache) {
  console.error(
    "Set LORE_MODEL_CACHE to a transformers.js cache root containing " +
      "nomic-ai/nomic-embed-text-v1.5/ (config.json, tokenizer.json, onnx/).",
  );
  process.exit(1);
}
const wrapper = path.join(here, "measure-embed-cap-wrapper.cjs");

for (const [label, p] of [
  ["worker", path.join(distDir, "embedding-worker.cjs")],
  ["wasm", path.join(distDir, "ort-wasm-simd-threaded.wasm")],
  [
    "model",
    path.join(modelCache, "nomic-ai/nomic-embed-text-v1.5/config.json"),
  ],
]) {
  if (!existsSync(p)) {
    console.error(`missing ${label}: ${p}`);
    process.exit(1);
  }
}

const mb = (b) => (b / 1024 / 1024).toFixed(1);
const rss = () => process.memoryUsage().rss;
const settle = async () => {
  if (global.gc) global.gc();
  await new Promise((r) => setTimeout(r, 250));
  if (global.gc) global.gc();
};

const worker = new Worker(wrapper, {
  workerData: {
    _distDir: distDir,
    modelId: "nomic-ai/nomic-embed-text-v1.5",
    dimensions: 768,
    vendorModel: { localModelPath: modelCache },
    maxTokens: 8192,
  },
});

let nextId = 1;
const pending = new Map();
worker.on("message", (msg) => {
  if (msg.type === "init-error") {
    // init-error carries no id — fail every pending request and bail so the
    // script doesn't hang on the first await when the model fails to load.
    console.error("worker init-error:", msg.error);
    for (const p of pending.values()) p.reject(new Error(msg.error));
    pending.clear();
    process.exit(1);
  }
  const p = pending.get(msg.id);
  if (msg.type === "result") {
    if (p) {
      pending.delete(msg.id);
      p.resolve(msg.vectors);
    }
  } else if (msg.type === "error") {
    if (p) {
      pending.delete(msg.id);
      p.reject(new Error(msg.error));
    } else {
      console.error("worker error (no pending):", msg.error);
    }
  }
});
worker.on("error", (e) => {
  console.error("worker thread error:", e);
  process.exit(1);
});
worker.on("exit", (code) => {
  if (code !== 0) {
    console.error("worker exited with code", code);
    process.exit(1);
  }
});

const embed = (text, maxTokens) => {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({
      type: "embed",
      id,
      texts: [text],
      inputType: "document",
      priority: "normal",
      maxTokens,
    });
  });
};

// Long text so the worker's tokenizer truncates down to each target L.
const longText = "lorem ipsum dolor sit amet consectetur ".repeat(2000);

const rssPre = rss();
console.log(`RSS before model load: ${mb(rssPre)} MB`);

await embed("warmup", 64); // loads model + WASM runtime
await settle();
const rssLoaded = rss();
console.log(
  `RSS after model load:  ${mb(rssLoaded)} MB  (worker resident ≈ ${mb(rssLoaded - rssPre)} MB)\n`,
);

const Ls = [256, 512, 1024, 1536, 2048, 3072, 4096];
const points = [];
for (const L of Ls) {
  await embed(longText, L);
  await settle();
  const r = rss();
  points.push([L, r - rssPre]); // footprint = RSS minus the harness's own RSS
  console.log(
    `L=${String(L).padStart(4)}  RSS=${mb(r)} MB  footprint=${mb(r - rssPre)} MB`,
  );
}

// Least-squares fit of footprint (y) on L² (x): y = baseline + K·x.
const xs = points.map(([L]) => L * L);
const ys = points.map(([, f]) => f);
const n = xs.length;
const sx = xs.reduce((a, b) => a + b, 0);
const sy = ys.reduce((a, b) => a + b, 0);
const sxx = xs.reduce((a, b) => a + b * b, 0);
const sxy = xs.reduce((a, b, i) => a + b * ys[i], 0);
const K = (n * sxy - sx * sy) / (n * sxx - sx * sx);
const baseline = (sy - K * sx) / n;
// R² for fit quality.
const yMean = sy / n;
const ssTot = ys.reduce((a, y) => a + (y - yMean) ** 2, 0);
const ssRes = ys.reduce((a, y, i) => a + (y - (baseline + K * xs[i])) ** 2, 0);
const r2 = 1 - ssRes / ssTot;

console.log(
  `\n=== FIT  footprint(L) ≈ baseline + K·L²  (R²=${r2.toFixed(4)}) ===`,
);
console.log(
  `K        = ${K.toFixed(1)} bytes/token²   (current estimate: 192)`,
);
console.log(`baseline = ${mb(baseline)} MB   (current estimate: 400 MB)`);

worker.postMessage({ type: "shutdown" });
setTimeout(() => process.exit(0), 800);
