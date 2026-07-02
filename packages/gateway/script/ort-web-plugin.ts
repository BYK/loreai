/**
 * esbuild plugin: redirect `onnxruntime-node` → `onnxruntime-web` (WASM, Node
 * entry) and patch transformers.js' CDN wasmPaths fallback.
 *
 * Used ONLY by `bundle.ts` (the npm package): it ships the WASM files in `dist/`
 * and sets `globalThis.__LORE_NPM_WASM_PATHS__` at runtime (see
 * embedding-worker.ts). Without this redirect, the npm worker bundle leaves
 * `onnxruntime-node` (a native `.node` backend that esbuild can't bundle) as an
 * external `require`, which fails for dist-only installs (npm/AUR) with
 * "Cannot find module 'onnxruntime-node'" (see GitHub issue #763).
 *
 * The standalone SEA binary does NOT use this: it bundles the native
 * onnxruntime-node addon as a per-target SEA asset (see `ort-native-plugin.ts`),
 * which is faster and has no 4 GiB WASM-heap cap (#999).
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type * as esbuild from "esbuild";

/**
 * Resolve the onnxruntime-web package directory using Node's module
 * resolution. onnxruntime-web is a transitive dep of
 * @huggingface/transformers → we resolve from @loreai/core (which has
 * transformers as a direct dep), then from transformers to onnxruntime-web.
 * Works with any package manager layout (bun, pnpm, npm) because it uses
 * require.resolve, not filesystem scanning.
 */
export function findOrtWebDir(repoRoot: string): string {
  const coreDir = join(repoRoot, "packages", "core");
  const coreRequire = createRequire(`${coreDir}/`);
  // Step 1: find @huggingface/transformers
  const tfEntry = coreRequire.resolve("@huggingface/transformers");
  let tfDir = dirname(tfEntry);
  while (tfDir !== "/" && !existsSync(join(tfDir, "package.json"))) {
    tfDir = dirname(tfDir);
  }
  // Step 2: from transformers, find onnxruntime-web
  const tfRequire = createRequire(`${tfDir}/`);
  const ortEntry = tfRequire.resolve("onnxruntime-web");
  let ortDir = dirname(ortEntry);
  while (ortDir !== "/" && !existsSync(join(ortDir, "package.json"))) {
    ortDir = dirname(ortDir);
  }
  return ortDir;
}

export interface OrtWebPluginOptions {
  /** Monorepo root (used to resolve onnxruntime-web). */
  repoRoot: string;
  /**
   * The replacement RHS for transformers.js' `ONNX_ENV.wasm.wasmPaths = <CDN>`
   * assignment. The value is read at runtime to locate the local WASM files
   * (npm path): `globalThis.__LORE_NPM_WASM_PATHS__ || ONNX_ENV.wasm.wasmPaths`.
   */
  wasmPathsExpr: string;
}

/**
 * esbuild plugin that:
 * 1. Stubs `sharp` (vision models, unused for text embeddings).
 * 2. Redirects `onnxruntime-node` → `onnxruntime-web`'s Node entry
 *    (`dist/ort.node.min.mjs`). The WASM runtime is API-compatible and
 *    registers its backend under both "cpu" and "wasm" names, so the
 *    worker's `device: "cpu"` request works unchanged.
 * 3. Also redirects `onnxruntime-web` → the same Node-targeted entry.
 * 4. Patches transformers.js' CDN `wasmPaths` fallback (in both the `.mjs`
 *    and `.cjs` transformers variants) to read from globalThis instead, so
 *    the local WASM files are used at runtime (no network / CDN dependency).
 */
export function ortWebRedirectPlugin(
  opts: OrtWebPluginOptions,
): esbuild.Plugin {
  const ortWebDir = findOrtWebDir(opts.repoRoot);
  const ortWebNodeEntry = join(ortWebDir, "dist", "ort.node.min.mjs");
  const ortWebPkgJson = join(ortWebDir, "package.json");
  const ortWebPkg = JSON.parse(readFileSync(ortWebPkgJson, "utf8")) as {
    main: string;
  };
  // Resolve `onnxruntime-web` to its package main entry. Note this is the
  // package's `main` (`dist/ort.node.min.js`, CJS), which differs from the
  // `.mjs` node entry used for the onnxruntime-node redirect below — the
  // asymmetry is intentional and preserved from the original binary plugin.
  // In practice transformers.js (`device:"cpu"`) only imports the
  // `onnxruntime-node` specifier, so the `onnxruntime-web` redirect is a
  // belt-and-suspenders catch for any direct import and is rarely exercised.
  const ortWebMainEntry = join(ortWebDir, ortWebPkg.main);

  return {
    name: "ort-web-redirect",
    setup(build) {
      // Stub sharp as an empty module.
      build.onResolve({ filter: /^sharp$/ }, (args) => ({
        path: args.path,
        namespace: "empty-module",
      }));
      build.onLoad({ filter: /.*/, namespace: "empty-module" }, () => ({
        contents: "module.exports = {};",
        loader: "js",
      }));

      // Redirect onnxruntime-node → onnxruntime-web's Node.js entry.
      build.onResolve({ filter: /^onnxruntime-node$/ }, () => ({
        path: ortWebNodeEntry,
      }));

      // Also redirect onnxruntime-web → its package main entry (in case
      // transformers.js or anything else imports it directly). See the note
      // on ortWebMainEntry above re: the .js/.mjs asymmetry.
      build.onResolve({ filter: /^onnxruntime-web$/ }, () => ({
        path: ortWebMainEntry,
      }));

      // Patch transformers.js onnx.js to read wasmPaths from globalThis
      // instead of the CDN URL. transformers.js sets `ONNX_ENV.wasm.wasmPaths`
      // to a jsdelivr CDN URL that only ships the `jsep` WASM variant (wrong
      // filename for ort-web 1.22 + requires network). We replace that with a
      // globalThis read so the locally shipped/vendored WASM is used instead.
      // Match both the `.mjs` (binary) and `.cjs` (npm) transformers variants.
      build.onLoad({ filter: /transformers\.node\.(mjs|cjs)$/ }, (args) => {
        const src = readFileSync(args.path, "utf8");
        const cdnAssign =
          /ONNX_ENV\.wasm\.wasmPaths\s*=\s*`https:\/\/cdn\.jsdelivr\.net[^`]*`;/;
        // Fail the build loudly if transformers.js changes/removes the CDN
        // wasmPaths assignment we patch. A silent no-op here would ship a
        // bundle that falls back to the jsdelivr CDN at runtime (network +
        // wrong WASM variant) — exactly the failure mode we're fixing (#763).
        if (!cdnAssign.test(src)) {
          throw new Error(
            `ort-web-plugin: expected CDN wasmPaths assignment not found in ` +
              `${args.path}. transformers.js likely changed its onnx.js — ` +
              `update the regex in ort-web-plugin.ts.`,
          );
        }
        const patched = src.replace(
          cdnAssign,
          `ONNX_ENV.wasm.wasmPaths = ${opts.wasmPathsExpr};`,
        );
        return {
          contents: patched,
          loader: "js",
          resolveDir: dirname(args.path),
        };
      });
    },
  };
}
