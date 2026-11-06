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
 *      running platform into a private temporary directory (replicating the package's
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
 * Workers inherit the private directory's identity from the main thread and
 * verify its assets without rewriting them. NOTE: like the
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
    const { createHash } = require("node:crypto");
    const {
      isMainThread,
      getEnvironmentData,
      setEnvironmentData,
    } = require("node:worker_threads");
    const environmentKey = "lore.native.private-assets.v1";
    const uid = process.getuid?.();
    const unavailable = () => {
      throw new Error("Native extraction unavailable");
    };
    const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
    const privateIdentity = (stat) =>
      uid === undefined || (stat.uid === uid && (stat.mode & 0o077) === 0);

    try {
      const base = fs.realpathSync(os.tmpdir());
      // A random child is still replaceable if an attacker owns an ancestor.
      // POSIX sticky temporary roots protect children owned by this process;
      // other ancestors must be root/user-owned and not writable by others.
      for (let current = base; ; current = path.dirname(current)) {
        const stat = fs.lstatSync(current);
        if (
          !stat.isDirectory() ||
          (uid !== undefined &&
            ((stat.uid !== uid && stat.uid !== 0) ||
              ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)))
        )
          unavailable();
        if (current === path.dirname(current)) break;
      }
      const shared = !isMainThread && getEnvironmentData(environmentKey);
      if (
        shared &&
        (typeof shared.directory !== "string" ||
          path.dirname(shared.directory) !== base ||
          !path.basename(shared.directory).startsWith("lore-native-") ||
          typeof shared.dev !== "number" ||
          typeof shared.ino !== "number" ||
          !shared.files)
      )
        unavailable();
      // Never reuse a predictable cache/PID path or repair an unowned tree.
      const targetDir = shared
        ? shared.directory
        : fs.mkdtempSync(path.join(base, "lore-native-"));
      const root = shared || fs.lstatSync(targetDir);
      const files = shared ? shared.files : Object.create(null);
      const assertRoot = () => {
        const current = fs.lstatSync(targetDir);
        if (
          !current.isDirectory() ||
          !privateIdentity(current) ||
          !sameIdentity(root, current)
        )
          unavailable();
      };
      assertRoot();
      const writeAsset = (dest, key) => {
        assertRoot();
        if (
          path.dirname(dest) !== targetDir ||
          path.basename(dest) === "." ||
          path.basename(dest) === ".."
        )
          unavailable();
        const bytes = Buffer.from(sea.getRawAsset(key));
        if (!shared) {
          const fd = fs.openSync(
            dest,
            fs.constants.O_WRONLY |
              fs.constants.O_CREAT |
              fs.constants.O_EXCL |
              (fs.constants.O_NOFOLLOW || 0),
            0o600,
          );
          try {
            fs.writeFileSync(fd, bytes);
            const stat = fs.fstatSync(fd);
            files[path.basename(dest)] = { dev: stat.dev, ino: stat.ino };
          } finally {
            fs.closeSync(fd);
          }
        }
        const proof = files[path.basename(dest)];
        if (!proof) unavailable();
        const fd = fs.openSync(
          dest,
          fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
        );
        try {
          const stat = fs.fstatSync(fd);
          if (
            !stat.isFile() ||
            !privateIdentity(stat) ||
            stat.nlink !== 1 ||
            stat.size !== bytes.length ||
            !sameIdentity(stat, proof)
          )
            unavailable();
          const digest = (value) =>
            createHash("sha256").update(value).digest("hex");
          if (
            digest(fs.readFileSync(fd)) !== digest(bytes) ||
            !sameIdentity(stat, fs.lstatSync(dest))
          )
            unavailable();
          assertRoot();
        } finally {
          fs.closeSync(fd);
        }
      };
      let ortPath;
      let vecPath;

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
          ortPath = path.join(targetDir, "onnxruntime_binding.node");
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
        const vecOs =
          process.platform === "win32" ? "windows" : process.platform;
        const vecExt =
          process.platform === "win32"
            ? "dll"
            : process.platform === "darwin"
              ? "dylib"
              : "so";
        const vecKey = `vec0-${vecOs}-${process.arch}.${vecExt}`;
        vecPath = path.join(targetDir, `vec0.${vecExt}`);
        writeAsset(vecPath, vecKey);
      } catch {
        vecPath = undefined;
        // Asset absent (build without vec staging) or extraction failed — leave
        // the global unset so db/vec.ts uses the JS brute-force fallback.
      }

      // Publish only after every extraction and ownership check has settled.
      // Private ancestry prevents another OS user replacing paths before dlopen.
      assertRoot();
      setEnvironmentData(environmentKey, {
        directory: targetDir,
        dev: root.dev,
        ino: root.ino,
        files,
      });
      if (ortPath) globalThis.__LORE_ORT_BINDING_PATH__ = ortPath;
      if (vecPath) globalThis.__LORE_VEC_EXTENSION_PATH__ = vecPath;
    } catch {
      // Never load or repair native code from an unproven extraction directory.
    }
    globalThis.__LORE_NATIVE_READY__ = true;
  }
}
