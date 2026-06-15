/**
 * Runtime loader for fossilize-based standalone binary.
 *
 * This file is auto-injected at the top of the bundled CJS by esbuild's
 * `inject:` config. It runs before any other module evaluates, in both
 * the main process and any worker thread spawned by it.
 *
 * The standalone binary uses the WASM backend of `@huggingface/transformers`
 * (i.e. `onnxruntime-web`'s Node entry — same approach the prior Bun
 * `--compile` build used). This is the path of least resistance: WASM
 * runs correctly under Node's V8 engine (the bugs that forced this
 * migration were specific to Bun's WASM engine — see
 * `oven-sh/bun#18145`, `#25677`, `#31158`).
 *
 * Responsibilities:
 *
 * 1. If running inside a Node SEA (fossilize binary):
 *    a. Extract the two WASM runtime files
 *       (`ort-wasm-simd-threaded.mjs` and `ort-wasm-simd-threaded.wasm`)
 *       from SEA assets to a stable tmp dir on disk.
 *    b. Register their paths on `globalThis.__LORE_VENDOR_WASM_PATHS__`
 *       so the bundled `transformers.js` (patched via the shared
 *       `ortWebRedirectPlugin` in `ort-web-plugin.ts`) can load them
 *       without going to the CDN fallback.
 *
 * 2. If NOT running inside a SEA (npm CJS bundle, dev mode, tests):
 *    Do nothing. The npm CJS bundle handles WASM itself — it ships
 *    `ort-wasm-simd-threaded.{mjs,wasm}` in `dist/` and `embedding-worker.ts`
 *    registers `globalThis.__LORE_NPM_WASM_PATHS__` at runtime (also patched
 *    away from the CDN by `ortWebRedirectPlugin`). Dev/test use the real
 *    native `onnxruntime-node` from `node_modules`.
 *
 * The extraction uses a per-pid tmp dir, so each process gets a
 * fresh copy. The OS reaps /tmp on reboot, so disk leaks are
 * bounded. The `--worker` argv flag causes the binary to run as a
 * worker thread (see sea-entry.ts); the shim is harmless in worker
 * mode — both threads need their own copy of the WASM files (cheap
 * at ~11 MB and avoids cross-thread fs races).
 *
 * IMPORTANT: This file is intentionally CJS (not TS) so esbuild's
 * `inject:` mechanism treats it as the very first module in the bundle
 * without any transpilation or hoisting surprises. The corresponding
 * `node:sea` and `node:fs` requires are Node built-ins and resolve
 * at runtime.
 */
"use strict";

// Idempotency guard: if the shim already ran in this process, exit.
if (globalThis.__LORE_WASM_READY__) {
  // No-op on second injection.
} else {
  // Detect SEA mode. `node:sea` is only available in Node 20+; the
  // require itself is safe to attempt because Node throws synchronously
  // if the module doesn't exist, which we catch and treat as "not SEA".
  let isSea = false;
  try {
    isSea = require("node:sea").isSea();
  } catch {
    isSea = false;
  }

  if (isSea) {
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");
    const sea = require("node:sea");

    // Expose `Worker` as a global so the WASM runtime (loaded via
    // dynamic `import()`) can spawn pthreads. Node doesn't ship
    // `Worker` as a global — only via `require("node:worker_threads")`
    // — but the WASM bundle references it as a free variable. Bun's
    // runtime provides it natively; under Node we polyfill it here.
    // (The original Bun-compiled binary worked for this same reason.)
    if (typeof globalThis.Worker === "undefined") {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      globalThis.Worker = require("node:worker_threads").Worker;
    }

    // The WASM runtime's `new Worker(new URL(import.meta.url), ...)`
    // call expects `import.meta.url` to be a string. When the WASM file
    // is loaded as ESM in a CJS bundle, this works. But the Worker
    // constructor in Node also needs the URL to be parseable as a
    // file URL or string. We ensure the path is absolute so the URL
    // conversion always succeeds.
    // (No-op — handled by the WASM file's URL construction.)

    // Per-pid tmp dir so concurrent worker threads don't race on file
    // writes. The OS reaps /tmp on reboot, so leaks are bounded.
    const targetDir = path.join(os.tmpdir(), "lore-wasm", `pid-${process.pid}`);

    // The two WASM runtime files we need. The asset keys are the
    // paths passed to fossilize's --assets flag (see build-binary-sea.ts).
    const wasmMjsKey =
      typeof __LORE_WASM_MJS_ASSET__ === "string"
        ? __LORE_WASM_MJS_ASSET__
        : "ort-wasm-simd-threaded.mjs";
    const wasmBinKey =
      typeof __LORE_WASM_BIN_ASSET__ === "string"
        ? __LORE_WASM_BIN_ASSET__
        : "ort-wasm-simd-threaded.wasm";

    fs.mkdirSync(targetDir, { recursive: true });
    const mjsPath = path.join(targetDir, "ort-wasm-simd-threaded.mjs");
    const wasmPath = path.join(targetDir, "ort-wasm-simd-threaded.wasm");
    fs.writeFileSync(mjsPath, Buffer.from(sea.getRawAsset(wasmMjsKey)));
    fs.writeFileSync(wasmPath, Buffer.from(sea.getRawAsset(wasmBinKey)));

    // Register for the bundled transformers.js (patched via
    // binaryExternalsPlugin to read wasmPaths from this global).
    // On Windows, absolute paths (e.g. C:\...) passed to dynamic
    // import() are rejected because 'C:' looks like a URL scheme.
    // Convert the mjs path to a file:// URL so the ESM loader
    // accepts it on all platforms. The wasm path is read via fs
    // (not import()), so it stays as a plain file path.
    globalThis.__LORE_VENDOR_WASM_PATHS__ = {
      mjs: require("node:url").pathToFileURL(mjsPath).href,
      wasm: wasmPath,
    };

    globalThis.__LORE_WASM_READY__ = true;
  }
}
