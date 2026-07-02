/**
 * esbuild plugin for the npm gateway's embedding-worker bundles: ship BOTH ONNX
 * Runtime backends and pick at runtime — native `onnxruntime-node` when the
 * per-platform `@loreai/onnxruntime-<os>-<arch>` package is installed, else the
 * bundled WASM `onnxruntime-web` (the dist-only fallback, #763).
 *
 * How: the bundled `onnxruntime-node` specifier is replaced with a tiny runtime
 * SHIM that re-exports either the real native module or onnxruntime-web based on
 * `globalThis.__LORE_ORT_BINDING_PATH__` (set by the worker before it imports
 * transformers). This matters because transformers.js selects its backend as:
 *   Symbol.for('onnxruntime') override → else IS_NODE_ENV → ONNX_NODE → else web
 * Only the IS_NODE_ENV branch registers the "cpu" device, and it uses ONNX_NODE.
 * So we keep transformers on that branch (as the old WASM-redirect did) but make
 * ONNX_NODE runtime-switchable — native OR web — instead of hard-wiring web.
 *
 * A shim (vs the SEA's throwing binding patch) is required because transformers
 * `import * as ONNX_NODE from 'onnxruntime-node'` eagerly, and onnxruntime-node's
 * index.js calls `binding.listSupportedBackends()` at load. The shim only pulls
 * in the real onnxruntime-node when the addon path is set, so binding.js never
 * runs (and never crashes) on the WASM fallback path.
 *
 * Steps:
 *   1. Stub `sharp` → empty module.
 *   2. `onnxruntime-node` → runtime shim (native-or-web).
 *   3. `onnxruntime-web` → its Node WASM entry (for transformers' own — unused
 *      in Node — import, and the shim's web branch).
 *   4. Patch the real onnxruntime-node binding.js addon require → the runtime
 *      path (graceful; only reached when native is selected).
 *   5. Patch transformers.js' CDN `wasmPaths` fallback to read from globalThis.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type * as esbuild from "esbuild";
import { findOrtWebDir } from "./ort-web-plugin";

/** onnxruntime-node@1.21's `dist/binding.js` native-addon require (tagged
 *  template). Kept in sync with `ort-native-plugin.ts`; a bump that changes it
 *  fails the build loudly rather than silently shipping a broken loader. */
const ORT_BINDING_REQUIRE =
  /require\(`\.\.\/bin\/napi-v3\/\$\{process\.platform\}\/\$\{process\.arch\}\/onnxruntime_binding\.node`\)/;

/** Graceful replacement: native addon when the worker set the path, else a
 *  dormant stub (index.js calls `binding.listSupportedBackends()` at load).
 *  The shim below only requires this module when the path IS set, so the native
 *  branch is the one actually exercised; the stub is pure defense-in-depth. */
const ORT_BINDING_GRACEFUL =
  "(globalThis.__LORE_ORT_BINDING_PATH__ ? require(globalThis.__LORE_ORT_BINDING_PATH__) : { listSupportedBackends: () => [] })";

export interface OrtNpmPluginOptions {
  repoRoot: string;
  /** RHS for transformers.js' `ONNX_ENV.wasm.wasmPaths = <CDN>` — read at
   *  runtime to locate the shipped WASM (e.g.
   *  `globalThis.__LORE_NPM_WASM_PATHS__ || ONNX_ENV.wasm.wasmPaths`). */
  wasmPathsExpr: string;
}

export function ortNpmDualPlugin(opts: OrtNpmPluginOptions): esbuild.Plugin {
  const ortWebDir = findOrtWebDir(opts.repoRoot);
  const ortWebNodeEntry = join(ortWebDir, "dist", "ort.node.min.mjs");
  const ortWebPkg = JSON.parse(
    readFileSync(join(ortWebDir, "package.json"), "utf8"),
  ) as { main: string };
  const ortWebMainEntry = join(ortWebDir, ortWebPkg.main);

  // The real native onnxruntime-node entry (resolved from core, which has it
  // transitively via @huggingface/transformers). The shim requires it by
  // absolute path so it doesn't re-trigger the `^onnxruntime-node$` intercept.
  const require2 = createRequire(join(opts.repoRoot, "packages/core/"));
  const realOrtNodeEntry = require2.resolve("onnxruntime-node");

  return {
    name: "ort-npm-dual",
    setup(build) {
      // 1: stub sharp.
      build.onResolve({ filter: /^sharp$/ }, (args) => ({
        path: args.path,
        namespace: "ort-npm-empty",
      }));
      build.onLoad({ filter: /.*/, namespace: "ort-npm-empty" }, () => ({
        contents: "module.exports = {};",
        loader: "js",
      }));

      // 2: onnxruntime-node → runtime shim. Selects native vs web by the addon
      // path the worker set before importing transformers. Requiring the real
      // native module lazily means its binding.js only loads when native is
      // actually used (never on the WASM fallback path).
      build.onResolve({ filter: /^onnxruntime-node$/ }, () => ({
        path: "onnxruntime-node",
        namespace: "ort-npm-shim",
      }));
      build.onLoad({ filter: /.*/, namespace: "ort-npm-shim" }, () => ({
        contents:
          `module.exports = globalThis.__LORE_ORT_BINDING_PATH__\n` +
          `  ? require(${JSON.stringify(realOrtNodeEntry)})\n` +
          `  : require(${JSON.stringify(ortWebNodeEntry)});\n`,
        loader: "js",
        resolveDir: dirname(realOrtNodeEntry),
      }));

      // 3: onnxruntime-web → its package main entry (transformers imports it but
      // only uses it in the unreachable browser branch under Node).
      build.onResolve({ filter: /^onnxruntime-web$/ }, () => ({
        path: ortWebMainEntry,
      }));

      // 4: rewrite the real onnxruntime-node binding.js addon require.
      build.onLoad(
        { filter: /onnxruntime-node[\\/]dist[\\/]binding\.js$/ },
        (args) => {
          const src = readFileSync(args.path, "utf8");
          if (!ORT_BINDING_REQUIRE.test(src)) {
            throw new Error(
              `ort-npm-plugin: expected native-addon require not found in ` +
                `${args.path}. onnxruntime-node likely changed binding.js — ` +
                `update ORT_BINDING_REQUIRE in ort-npm-plugin.ts.`,
            );
          }
          return {
            contents: src.replace(ORT_BINDING_REQUIRE, ORT_BINDING_GRACEFUL),
            loader: "js",
            resolveDir: dirname(args.path),
          };
        },
      );

      // 5: patch transformers.js' CDN wasmPaths fallback to read from globalThis.
      build.onLoad({ filter: /transformers\.node\.(mjs|cjs)$/ }, (args) => {
        const src = readFileSync(args.path, "utf8");
        const cdnAssign =
          /ONNX_ENV\.wasm\.wasmPaths\s*=\s*`https:\/\/cdn\.jsdelivr\.net[^`]*`;/;
        if (!cdnAssign.test(src)) {
          throw new Error(
            `ort-npm-plugin: expected CDN wasmPaths assignment not found in ` +
              `${args.path}. transformers.js likely changed its onnx.js — ` +
              `update the regex in ort-npm-plugin.ts.`,
          );
        }
        return {
          contents: src.replace(
            cdnAssign,
            `ONNX_ENV.wasm.wasmPaths = ${opts.wasmPathsExpr};`,
          ),
          loader: "js",
          resolveDir: dirname(args.path),
        };
      });
    },
  };
}
