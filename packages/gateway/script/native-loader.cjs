/**
 * Runtime loader for the fossilize-based standalone binary.
 *
 * This file is auto-injected at the top of the bundled CJS by esbuild's
 * `inject:` config. It runs before any other module evaluates, in both the main
 * process and any worker thread spawned by it.
 *
 * The standalone binary runs the REAL native `onnxruntime-node` (not the WASM
 * `onnxruntime-web`). Native ORT is multiple times faster than the
 * single-threaded WASM backend, scales with cores, and has no fixed 4 GiB
 * WASM-heap ceiling (#999). esbuild can't inline a `.node` addon, so the addon
 * (+ its shared libraries) rides along as per-target SEA assets and is extracted
 * here at startup — exactly how the native `sqlite-vec`/vec0 extension ships.
 *
 * Responsibilities (only inside a Node SEA — a no-op otherwise):
 *
 *   1. Extract the native onnxruntime-node addon + its shared libraries for the
 *      running platform into a per-pid tmp dir (replicating the package's
 *      sibling layout so the addon's $ORIGIN/@loader_path/DLL-search resolution
 *      finds `libonnxruntime`), and register the addon path on
 *      `globalThis.__LORE_ORT_BINDING_PATH__`. The bundled onnxruntime-node's
 *      `binding.js` is patched (see `ort-native-plugin.ts`) to `require` that
 *      path instead of the node_modules-relative one that doesn't exist here.
 *
 *   2. Extract the native `sqlite-vec` loadable extension and register it on
 *      `globalThis.__LORE_VEC_EXTENSION_PATH__` (preferred by `db/vec.ts`).
 *
 * Outside a SEA (npm CJS bundle, dev mode, tests): do nothing. The npm bundle
 * uses the WASM backend and ships `ort-wasm-simd-threaded.{mjs,wasm}` in `dist/`
 * (see `ort-web-plugin.ts` / `bundle.ts`); dev/test use the real native
 * `onnxruntime-node` from `node_modules` directly.
 *
 * The extraction uses a per-pid tmp dir so concurrent worker threads don't race,
 * and the OS reaps /tmp on reboot so disk leaks are bounded. NOTE: like the
 * pre-existing vec0 extraction, the addon is `dlopen`ed from /tmp — a `noexec`
 * /tmp mount makes both fall back (native ORT → FTS-only; vec0 → JS scan).
 *
 * IMPORTANT: This file is intentionally CJS (not TS) so esbuild's `inject:`
 * mechanism treats it as the very first module in the bundle without any
 * transpilation or hoisting surprises. The `node:*` requires are Node built-ins
 * and resolve at runtime.
 */
"use strict";

// Idempotency guard: if the shim already ran in this process, exit.
if (globalThis.__LORE_NATIVE_READY__) {
  // No-op on second injection.
} else {
  // Detect SEA mode. `node:sea` is only available in Node 20+; the require
  // itself is safe to attempt because Node throws synchronously if the module
  // doesn't exist, which we catch and treat as "not SEA".
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
    const { isMainThread } = require("node:worker_threads");

    // Per-pid tmp dir so concurrent worker threads don't race on file writes.
    const targetDir = path.join(
      os.tmpdir(),
      "lore-native",
      `pid-${process.pid}`,
    );
    fs.mkdirSync(targetDir, { recursive: true });

    // The main thread runs first (at startup, before any worker spawns) and
    // (re)writes unconditionally — overwriting any stale file from a reused pid.
    // Worker threads share the pid/tmp dir, so they skip the write when the main
    // thread already produced it: avoids a concurrent-write race on the shared
    // path while still self-healing if it's somehow absent.
    const writeAsset = (dest, key) => {
      if (isMainThread || !fs.existsSync(dest)) {
        fs.writeFileSync(dest, Buffer.from(sea.getRawAsset(key)));
      }
    };

    // 1. Native onnxruntime-node addon + shared libraries. The build embeds one
    //    set per target as `ort-<target>-<file>` plus an `ort-manifest.json`
    //    listing the (version-specific) filenames per target. Extract only the
    //    running platform's set into `targetDir` and register the addon path.
    try {
      const ortTarget = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
      const ortManifest = JSON.parse(
        Buffer.from(sea.getRawAsset("ort-manifest.json")).toString("utf8"),
      );
      const files = ortManifest[ortTarget];
      if (Array.isArray(files) && files.length > 0) {
        for (const f of files) {
          writeAsset(path.join(targetDir, f), `ort-${ortTarget}-${f}`);
        }
        globalThis.__LORE_ORT_BINDING_PATH__ = path.join(
          targetDir,
          "onnxruntime_binding.node",
        );
      }
    } catch {
      // Asset missing / extraction failed — leave the global unset. The patched
      // binding.js then throws a clear error, the embedding provider marks
      // itself unavailable, and search degrades to FTS-only.
    }

    // 2. sqlite-vec native loadable extension. Extract the one matching this
    //    platform and register its path; `db/vec.ts` prefers this global over
    //    the (stubbed) npm wrapper. Runs in worker threads too (the vector
    //    pool's reader connections load it) — each thread has its own globalThis.
    try {
      const vecOs = process.platform === "win32" ? "windows" : process.platform;
      const vecExt =
        process.platform === "win32"
          ? "dll"
          : process.platform === "darwin"
            ? "dylib"
            : "so";
      const vecKey = `vec0-${vecOs}-${process.arch}.${vecExt}`;
      const vecPath = path.join(targetDir, `vec0.${vecExt}`);
      writeAsset(vecPath, vecKey);
      globalThis.__LORE_VEC_EXTENSION_PATH__ = vecPath;
    } catch {
      // Asset absent (build without vec staging) or extraction failed — leave
      // the global unset so db/vec.ts uses the JS brute-force fallback.
    }

    globalThis.__LORE_NATIVE_READY__ = true;
  }
}
