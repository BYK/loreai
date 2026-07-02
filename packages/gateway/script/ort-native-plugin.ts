/**
 * esbuild plugin: bundle the REAL native `onnxruntime-node` (not the WASM
 * `onnxruntime-web`) for the standalone SEA binary.
 *
 * Native ORT is 2.7–4.1× faster than the single-threaded WASM backend we shipped
 * before, scales with cores, and has no fixed 4 GiB WASM-heap ceiling (#999).
 * The WASM backend was only ever chosen because Bun's WASM engine had bugs
 * (oven-sh/bun#18145/#25677/#31158) and esbuild can't inline a `.node` addon —
 * both moot now: we're on Node SEA, and the addon rides along as a per-target
 * SEA asset that `native-loader.cjs` extracts at runtime (exactly how the native
 * `sqlite-vec`/vec0 extension already ships).
 *
 * What this plugin does (vs the WASM `ortWebRedirectPlugin`):
 *   1. Stub `sharp` (vision models, unused for text embeddings) → empty module.
 *   2. Stub `onnxruntime-web` → empty module. transformers.js unconditionally
 *      `import * as ONNX_WEB from 'onnxruntime-web'`, but under Node
 *      (`apis.IS_NODE_ENV`) it selects `ONNX_NODE` and only touches `ONNX_WEB`
 *      in the unreachable browser branch — so stubbing it avoids bundling the
 *      ~MBs of WASM glue (and shipping the `.wasm`) with zero behavioral change.
 *   3. Rewrite `onnxruntime-node`'s `binding.js` native-addon `require(...)` —
 *      which resolves `../bin/napi-v3/<platform>/<arch>/onnxruntime_binding.node`
 *      relative to node_modules (absent in a SEA) — to require the path
 *      `native-loader.cjs` exposes on `globalThis.__LORE_ORT_BINDING_PATH__`
 *      after extracting the addon from a SEA asset.
 *
 * There is NO `onnxruntime-node` → web redirect and NO transformers CDN
 * `wasmPaths` patch: native ORT never loads WASM, so the CDN assignment (which
 * targets the selected backend's unused `env.wasm`) is dead and harmless.
 */
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import type * as esbuild from "esbuild";

/** The exact native-addon `require` in onnxruntime-node@1.21's `dist/binding.js`
 *  (a tagged-template path). Matching it precisely lets us fail loudly if a
 *  future bump changes the shape, rather than silently shipping a broken addon
 *  loader. */
const ORT_BINDING_REQUIRE =
  /require\(`\.\.\/bin\/napi-v3\/\$\{process\.platform\}\/\$\{process\.arch\}\/onnxruntime_binding\.node`\)/;

/** Replacement: require the runtime-extracted addon path, throwing a clear error
 *  if the loader shim didn't run (so a broken SEA fails loudly, not with a
 *  cryptic "path must be a string, received undefined"). */
const ORT_BINDING_REPLACEMENT =
  'require((globalThis.__LORE_ORT_BINDING_PATH__ ?? (() => { throw new Error("lore: __LORE_ORT_BINDING_PATH__ is unset — the native onnxruntime-node addon was not extracted from SEA assets (native-loader.cjs did not run?)"); })()))';

export interface OrtNativePluginOptions {
  /** Monorepo root (reserved for symmetry with ortWebRedirectPlugin; unused). */
  repoRoot?: string;
}

export function ortNativePlugin(
  _opts: OrtNativePluginOptions = {},
): esbuild.Plugin {
  return {
    name: "ort-native",
    setup(build) {
      // 1 + 2: stub sharp and onnxruntime-web as empty modules.
      build.onResolve({ filter: /^(sharp|onnxruntime-web)$/ }, (args) => ({
        path: args.path,
        namespace: "ort-native-empty",
      }));
      build.onLoad({ filter: /.*/, namespace: "ort-native-empty" }, () => ({
        contents: "module.exports = {};",
        loader: "js",
      }));

      // 3: rewrite the native-addon require in onnxruntime-node's binding.js.
      build.onLoad(
        { filter: /onnxruntime-node[\\/]dist[\\/]binding\.js$/ },
        (args) => {
          const src = readFileSync(args.path, "utf8");
          if (!ORT_BINDING_REQUIRE.test(src)) {
            throw new Error(
              `ort-native-plugin: expected native-addon require not found in ` +
                `${args.path}. onnxruntime-node likely changed binding.js — ` +
                `update ORT_BINDING_REQUIRE in ort-native-plugin.ts.`,
            );
          }
          return {
            contents: src.replace(ORT_BINDING_REQUIRE, ORT_BINDING_REPLACEMENT),
            loader: "js",
            resolveDir: dirname(args.path),
          };
        },
      );
    },
  };
}
