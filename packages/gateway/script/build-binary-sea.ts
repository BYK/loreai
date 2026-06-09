/**
 * Build @loreai/gateway standalone binary via Node SEA + fossilize.
 *
 * This replaces the legacy `bun build --compile` pipeline. The new
 * pipeline uses:
 *
 *   1. esbuild → single CJS bundle (target: Node 22)
 *   2. esbuild → worker CJS bundle
 *   3. fossilize → Node SEA per target, with WASM files + model
 *      files + worker CJS embedded as SEA assets
 *
 * At runtime, the binary uses the WASM backend of
 * `@huggingface/transformers` (i.e. `onnxruntime-web`'s Node entry).
 * This is the path of least resistance: WASM runs correctly under
 * Node's V8 engine (the bugs that forced this migration were
 * specific to Bun's WASM engine — see `oven-sh/bun#18145`, `#25677`,
 * `#31158`).
 *
 * Targets: 4 currently supported (Apple Silicon-only macOS, plus
 * Linux x64/arm64 and Windows x64). Intel Macs and Windows-arm64 are
 * intentionally not supported (see `vendor-paths.ts:18`).
 *
 * Example:
 *   bun run script/build-binary-sea.ts -- --platforms linux-x64
 *   bun run script/build-binary-sea.ts -- --platforms "darwin-arm64,linux-arm64,linux-x64,windows-x64" --release
 */
import * as esbuild from "esbuild";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { PLACEHOLDER_DEBUG_ID, injectDebugId } from "./debug-id";
import { MODEL_DIR_NAME, MODEL_FILES } from "./vendor-paths";
import { fossilize } from "fossilize";

const require = createRequire(import.meta.url);

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(here);
const repoRoot = dirname(dirname(packageDir));
const distBinDir = join(packageDir, "dist-bin");

// Fossilize wipes its out-dir before running, so we stage the esbuild
// output in a separate temp dir (outside distBinDir to avoid being wiped)
// and pass that path as the entrypoint. The final binaries end up in
// distBinDir (fossilize's --out-dir).
const stagingDir = join(packageDir, ".sea-staging");

const pkg = JSON.parse(
  readFileSync(join(packageDir, "package.json"), "utf8"),
) as { version: string };

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

const { values: flags } = parseArgs({
  args: process.argv.slice(2),
  options: {
    platforms: { type: "string" },
    release: { type: "boolean", default: false },
    /** Skip embedding the model even for targets that support it.
     *  Produces a smaller binary (~140 MB lighter) but local embeddings
     *  require a network download on first use.
     *  Useful for iteration speed during local dev. */
    "no-vendor": { type: "boolean", default: false },
    /** Run esbuild + asset staging only — skip fossilize and everything
     *  after it. The .sea-staging/ directory is the output artifact,
     *  suitable for transfer to another machine (e.g. macOS) where
     *  fossilize runs natively for V8 code cache + native codesign.
     *  Sentry sourcemap upload still runs in this mode. */
    "prepare-only": { type: "boolean", default: false },
    /** Skip esbuild — reuse a pre-built .sea-staging/ directory
     *  (e.g. downloaded as a CI artifact from a --prepare-only run).
     *  Runs fossilize, gzip, and rename steps only. */
    "from-staging": { type: "string" },
  },
  allowPositionals: false,
  strict: true,
});

const VALID_TARGETS = [
  "darwin-arm64",
  "linux-arm64",
  "linux-x64",
  "windows-x64",
] as const;
type CompileTarget = (typeof VALID_TARGETS)[number];

function parseTargets(): CompileTarget[] {
  const raw =
    flags.platforms ??
    `${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
  const targets = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as CompileTarget[];
  for (const t of targets) {
    if (!VALID_TARGETS.includes(t)) {
      console.error(`Invalid target: ${t}`);
      console.error(`Valid targets: ${VALID_TARGETS.join(", ")}`);
      process.exit(1);
    }
  }
  return targets;
}

// ---------------------------------------------------------------------------
// Vendor model staging
// ---------------------------------------------------------------------------

const VENDORED_TARGETS = new Set<string>([
  "darwin-arm64",
  "linux-arm64",
  "linux-x64",
  "windows-x64",
]);

/**
 * Ensure the shared model cache is populated with the embedding model files.
 * Auto-runs `vendor-embeddings.ts` if missing.
 * Returns the absolute path to the model dir, or `null` if vendoring
 * is disabled / unsupported for this target.
 */
function prepareVendorModelCache(target: CompileTarget): string | null {
  if (flags["no-vendor"]) {
    console.log(`  Vendor: skipped (--no-vendor)`);
    return null;
  }
  if (!VENDORED_TARGETS.has(target)) {
    console.log(
      `  Vendor: skipped (${target} not in vendored targets — ` +
        `runtime downloads model on first use)`,
    );
    return null;
  }

  const sharedModelCache = join(repoRoot, ".vendor-build", ".model-cache");
  const modelDir = join(sharedModelCache, MODEL_DIR_NAME);

  // Required artefacts: every file transformers.js reads from the model
  // dir at runtime. If all are present, skip the vendor run.
  const requiredArtifacts = MODEL_FILES.map((f) => join(modelDir, f));
  if (requiredArtifacts.every((p) => existsSync(p))) {
    console.log(`  Vendor: cache hit — shared model ready`);
    return modelDir;
  }

  // Auto-build. The vendor script downloads the model (~137 MB) and is idempotent.
  console.log(
    `  Vendor: missing model artefacts — running vendor-embeddings.ts`,
  );
  const result = spawnSync(
    "bun",
    ["run", join(packageDir, "script/vendor-embeddings.ts")],
    { stdio: "inherit", cwd: repoRoot },
  );
  if (result.status !== 0) {
    console.error(`✗ vendor-embeddings.ts failed (exit ${result.status})`);
    process.exit(1);
  }
  for (const p of requiredArtifacts) {
    if (!existsSync(p)) {
      console.error(`✗ vendor run succeeded but artefact still missing: ${p}`);
      process.exit(1);
    }
  }
  return modelDir;
}

// ---------------------------------------------------------------------------
// esbuild: onnxruntime-node → onnxruntime-web (WASM) redirect
// ---------------------------------------------------------------------------

/** Resolve the onnxruntime-web package directory using Node's module
 *  resolution. onnxruntime-web is a transitive dep of
 *  @huggingface/transformers → we resolve from @loreai/core (which
 *  has transformers as a direct dep), then from transformers to
 *  onnxruntime-web. Works with any package manager layout (bun, pnpm,
 *  npm) because it uses require.resolve, not filesystem scanning. */
function findOrtWebDir(): string {
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

/**
 * esbuild plugin that:
 * 1. Stubs `sharp` (vision models, unused for text embeddings).
 * 2. Redirects `onnxruntime-node` → `onnxruntime-web`'s Node entry
 *    (`dist/ort.node.min.mjs`). The WASM runtime is API-compatible.
 * 3. Resolves transitive deps from Bun's `.bun/` store.
 * 4. Patches transformers.js to read WASM paths from globalThis
 *    (`__LORE_VENDOR_WASM_PATHS__`) instead of the CDN fallback.
 */
function binaryExternalsPlugin(): esbuild.Plugin {
  const ortWebDir = findOrtWebDir();
  const ortWebNodeEntry = join(ortWebDir, "dist", "ort.node.min.mjs");
  const ortWebPkgJson = join(ortWebDir, "package.json");
  const ortWebPkg = JSON.parse(readFileSync(ortWebPkgJson, "utf8")) as {
    main: string;
  };
  // Resolve `onnxruntime-web` to its dist/ort.node.min.mjs (matching the
  // redirect for onnxruntime-node). This ensures the bundled code
  // imports the same Node-targeted entry regardless of which name it uses.
  const ortWebMainEntry = join(ortWebDir, ortWebPkg.main);

  return {
    name: "binary-externals",
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

      // Also redirect onnxruntime-web → the same Node-targeted entry
      // (in case transformers.js or anything else imports it directly).
      build.onResolve({ filter: /^onnxruntime-web$/ }, () => ({
        path: ortWebMainEntry,
      }));

      // Patch transformers.js onnx.js to read wasmPaths from globalThis
      // instead of the CDN URL. The binary's native-loader.cjs sets
      // __LORE_VENDOR_WASM_PATHS__ = { mjs, wasm } before the worker
      // evaluates. transformers.js checks `!ONNX_ENV.wasm.wasmPaths`
      // and falls back to a CDN URL — we replace that fallback with a
      // globalThis read.
      build.onLoad({ filter: /transformers\.node\.mjs$/ }, (args) => {
        let src = readFileSync(args.path, "utf8");
        src = src.replace(
          /ONNX_ENV\.wasm\.wasmPaths\s*=\s*`https:\/\/cdn\.jsdelivr\.net[^`]*`;/,
          "ONNX_ENV.wasm.wasmPaths = globalThis.__LORE_VENDOR_WASM_PATHS__ || ONNX_ENV.wasm.wasmPaths;",
        );
        return { contents: src, loader: "js", resolveDir: dirname(args.path) };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// esbuild: @sentry/bun → @sentry/node redirect
// ---------------------------------------------------------------------------

/** Resolve @sentry/node from @sentry/bun (its direct dep). */
function sentryBunToNodePlugin(): esbuild.Plugin {
  const sentryBunEntry = require.resolve("@sentry/bun", {
    paths: [packageDir],
  });
  // Walk up from @sentry/bun to find @sentry/node in its node_modules
  const sentryNodeEntry = require.resolve("@sentry/node", {
    paths: [dirname(sentryBunEntry)],
  });
  return {
    name: "sentry-bun-to-node",
    setup(build) {
      build.onResolve({ filter: /^@sentry\/bun$/ }, () => ({
        path: sentryNodeEntry,
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// Sentry sourcemap upload
// ---------------------------------------------------------------------------

function uploadSentrySourcemap(stagingDirPath: string, mapPath: string): void {
  if (process.env.SENTRY_AUTH_TOKEN) {
    console.log(`  Uploading sourcemap to Sentry (release: ${pkg.version})...`);
    try {
      execSync(
        [
          "npx",
          "sentry",
          "sourcemap",
          "upload",
          // Sourcemap lives in .sea-staging/ (produced by esbuild
          // with sourcemap:"linked"). The final binary embeds the
          // debug ID that links errors back to this map.
          `${stagingDirPath}/`,
          "--release",
          pkg.version,
          "--org",
          "byk",
          "--project",
          "loreai-gateway",
          "--url-prefix",
          "~/sea-staging/",
        ].join(" "),
        { cwd: packageDir, stdio: "inherit" },
      );
      console.log("✓ Sourcemap uploaded to Sentry");
      // Delete the .map file after upload — it's not needed in the
      // staging artifact and would waste transfer bandwidth.
      try {
        unlinkSync(mapPath);
        console.log("✓ Sourcemap deleted (uploaded to Sentry)");
      } catch {
        // best-effort
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`⚠ Sourcemap upload failed: ${msg}`);
    }
  } else {
    console.log("  No SENTRY_AUTH_TOKEN — skipping sourcemap upload");
  }
}

// ---------------------------------------------------------------------------
// Fossilize: SEA binary creation, gzip, rename
// ---------------------------------------------------------------------------

const fossilizeTarget = (t: CompileTarget): string =>
  t.startsWith("windows") ? t.replace("windows", "win") : t;

async function runFossilize(
  targets: CompileTarget[],
  bundlePath: string,
  manifestPath: string,
  _stagingDirPath: string,
): Promise<void> {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  console.log(
    `→ fossilize: ${targets.length} platform(s), ${Object.keys(manifest).length} asset(s)`,
  );
  try {
    await fossilize(
      {
        nodeVersion: "lts",
        platforms: targets.map(fossilizeTarget),
        noBundle: true,
        holePunch: true,
        outputName: "lore",
        outDir: distBinDir,
        cacheDir: join(packageDir, ".node-cache"),
        assetManifest: manifestPath,
        sign: false,
        concurrencyLimit: 3,
      },
      bundlePath,
    );
  } catch (err) {
    console.error("✗ fossilize failed:", err);
    process.exit(1);
  }

  // fossilize creates output files with its own platform naming
  // (e.g. lore-win-x64 for our windows-x64). Verify the expected
  // paths exist, then rename to our naming convention for CI
  // compatibility (CI expects lore-windows-x64.exe).
  for (const target of targets) {
    const fTarget = fossilizeTarget(target);
    const ext = fTarget.startsWith("win") ? ".exe" : "";
    const fossilizePath = join(distBinDir, `lore-${fTarget}${ext}`);
    if (!existsSync(fossilizePath)) {
      console.error(
        `✗ expected output not found: ${fossilizePath}. Check fossilize logs.`,
      );
      process.exit(1);
    }
    if (fTarget !== target) {
      const ourPath = join(distBinDir, `lore-${target}${ext}`);
      renameSync(fossilizePath, ourPath);
      console.log(`✓ Binary: ${ourPath} (was ${fossilizePath})`);
    } else {
      console.log(`✓ Binary: ${fossilizePath}`);
    }
  }

  // gzip (if --release)
  if (flags.release) {
    for (const target of targets) {
      const ext = target.startsWith("windows") ? ".exe" : "";
      const binaryPath = join(distBinDir, `lore-${target}${ext}`);
      const raw = readFileSync(binaryPath);
      const compressed = gzipSync(raw, { level: 6 });
      const gzPath = `${binaryPath}.gz`;
      writeFileSync(gzPath, compressed);
      const ratio = ((compressed.length / raw.length) * 100).toFixed(1);
      console.log(
        `✓ gzip: ${gzPath} (${(compressed.length / 1024 / 1024).toFixed(1)}MB, ${ratio}% of original)`,
      );
    }
  }

  console.log(
    `\n✓ Binary build complete: ${targets.map((t) => `lore-${t}`).join(", ")} (v${pkg.version})`,
  );
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

async function buildBinary() {
  const targets = parseTargets();

  // --from-staging: skip esbuild, reuse a pre-built staging directory.
  // Jump straight to fossilize + gzip + rename.
  if (flags["from-staging"]) {
    const externalStaging = flags["from-staging"];
    if (!existsSync(externalStaging)) {
      console.error(`✗ --from-staging dir not found: ${externalStaging}`);
      process.exit(1);
    }
    const manifestPath = join(externalStaging, "asset-manifest.json");
    if (!existsSync(manifestPath)) {
      console.error(
        `✗ asset-manifest.json not found in staging dir: ${externalStaging}`,
      );
      process.exit(1);
    }
    const bundlePath = join(externalStaging, "sea-entry.cjs");
    if (!existsSync(bundlePath)) {
      console.error(
        `✗ sea-entry.cjs not found in staging dir: ${externalStaging}`,
      );
      process.exit(1);
    }
    console.log(`→ Using pre-built staging: ${externalStaging}`);
    mkdirSync(distBinDir, { recursive: true });
    await runFossilize(targets, bundlePath, manifestPath, externalStaging);
    return;
  }

  const firstTarget = targets[0];
  let vendorModelDir: string | null = null;
  if (targets.length === 1 && firstTarget) {
    vendorModelDir = prepareVendorModelCache(firstTarget);
  } else if (targets.length > 1) {
    // Multi-platform build: assume the shared model cache is already
    // populated (callers should have run a single-target build first
    // or staged the model manually).
    if (!flags["no-vendor"] && firstTarget) {
      const sample = firstTarget;
      if (!VENDORED_TARGETS.has(sample)) {
        console.log(
          `  Vendor: skipped (multi-platform, ${sample} not vendored)`,
        );
      } else {
        const sharedModelCache = join(
          repoRoot,
          ".vendor-build",
          ".model-cache",
        );
        const modelDir = join(sharedModelCache, MODEL_DIR_NAME);
        const requiredArtifacts = MODEL_FILES.map((f) => join(modelDir, f));
        if (!requiredArtifacts.every((p) => existsSync(p))) {
          console.error(
            `✗ multi-platform build needs .vendor-build/.model-cache populated; run with --platforms ${sample} first`,
          );
          process.exit(1);
        }
        // Use the shared model cache for staging — all platforms
        // share the same model files.
        vendorModelDir = modelDir;
        console.log(`  Vendor: cache hit for multi-platform build`);
      }
    }
  }

  mkdirSync(distBinDir, { recursive: true });
  mkdirSync(stagingDir, { recursive: true });

  // -------------------------------------------------------------------------
  // Step 1: esbuild main bundle
  // -------------------------------------------------------------------------
  const bundlePath = join(stagingDir, "sea-entry.cjs");
  const mapPath = join(stagingDir, "sea-entry.cjs.map");

  await esbuild.build({
    entryPoints: [join(packageDir, "src/cli/sea-entry.ts")],
    bundle: true,
    format: "cjs",
    target: "node22",
    platform: "node",
    conditions: ["node"],
    // sharp is for vision models, unused. onnxruntime-node is redirected
    // to onnxruntime-web by the plugin. The WASM runtime is API-compatible.
    external: ["sharp"],
    plugins: [binaryExternalsPlugin(), sentryBunToNodePlugin()],
    inject: [
      // Runs FIRST: extracts WASM files from SEA assets and registers
      // __LORE_VENDOR_WASM_PATHS__ on globalThis.
      join(here, "native-loader.cjs"),
    ],
    outfile: bundlePath,
    // "linked" produces an external .map file with a //# sourceMappingURL=
    // comment in the JS. This map is uploaded to Sentry (never shipped to users).
    sourcemap: "linked",
    minify: true,
    logLevel: "info",
    legalComments: "none",
    define: {
      LORE_CLI_VERSION: JSON.stringify(pkg.version),
      __SENTRY_DEBUG_ID__: JSON.stringify(PLACEHOLDER_DEBUG_ID),
      __LORE_VENDOR_ENABLED__: JSON.stringify(!flags["no-vendor"]),
      // Comma-separated list (avoids JSON.stringify folding which
      // doesn't reliably produce a stringified array in esbuild).
      __LORE_MODEL_FILES__: JSON.stringify(MODEL_FILES.join(",")),
      __LORE_MODEL_DIR_NAME__: JSON.stringify(MODEL_DIR_NAME),
      __LORE_WASM_MJS_ASSET__: JSON.stringify("ort-wasm-simd-threaded.mjs"),
      __LORE_WASM_BIN_ASSET__: JSON.stringify("ort-wasm-simd-threaded.wasm"),
      // (No __LORE_WORKER_PATH_ENV__ — the worker is now passed as
      // a source string at runtime via globalThis.__LORE_WORKER_SOURCE__,
      // not a file path. See packages/gateway/src/cli/sea-entry.ts.)
    },
  });

  console.log(`✓ esbuild main bundle: ${bundlePath}`);

  // -------------------------------------------------------------------------
  // Step 1b: esbuild worker bundle
  // -------------------------------------------------------------------------
  const workerBundlePath = join(stagingDir, "sea-worker.cjs");
  const workerSrc = join(repoRoot, "packages/core/src/embedding-worker.ts");

  await esbuild.build({
    entryPoints: [workerSrc],
    bundle: true,
    format: "cjs",
    target: "node22",
    platform: "node",
    conditions: ["node"],
    external: ["sharp"],
    plugins: [binaryExternalsPlugin()],
    inject: [join(here, "native-loader.cjs")],
    outfile: workerBundlePath,
    sourcemap: "linked",
    minify: true,
    logLevel: "info",
    legalComments: "none",
  });

  console.log(`✓ esbuild worker: ${workerBundlePath}`);

  // Rename worker to `worker.cjs` so the fossilize asset key matches
  // what sea-entry.ts reads at runtime (`worker.cjs`).
  const workerAssetPath = join(stagingDir, "worker.cjs");
  renameSync(workerBundlePath, workerAssetPath);

  // -------------------------------------------------------------------------
  // Post-process: patch createRequire in both bundles
  // -------------------------------------------------------------------------
  // In CJS output, esbuild shims import.meta to {}, making
  // createRequire(import.meta.url) → createRequire(shim.url) where
  // shim is {} and .url is undefined. This throws "The argument
  // 'filename' must be a file URL object..." when transformers.js's
  // bundled ONNX runtime initializes.
  //
  // We replace the call with createRequire(pathToFileURL(__filename).href)
  // which always resolves to a valid file URL from the script's path.
  // __filename is the actual path of the source file, so module
  // resolution remains correct.
  //
  // Only the worker bundle gets patched — the main bundle is used
  // from inside the SEA binary where __filename resolves to the
  // binary's path, and the main bundle's copy of the ONNX runtime
  // is only needed for the npm CJS path (which handles import.meta
  // naturally via file-based require resolution).
  const createRequirePattern =
    /\(0,\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\.createRequire\)\(([a-zA-Z_$][a-zA-Z0-9_$]*)\.url\)/g;
  const createRequireReplacement =
    '(0,$1.createRequire)(require("url").pathToFileURL(__filename).href)';
  const workerBundlePatched = join(stagingDir, "worker.cjs");
  const src = readFileSync(workerBundlePatched, "utf-8");
  const patched = src.replace(createRequirePattern, createRequireReplacement);
  if (patched !== src) {
    writeFileSync(workerBundlePatched, patched);
    console.log(`✓ patched createRequire in worker bundle`);
  }

  // -------------------------------------------------------------------------
  // Step 2: Inject Sentry debug IDs
  // -------------------------------------------------------------------------
  let debugId: string | undefined;
  try {
    const result = await injectDebugId(bundlePath, mapPath, {
      skipSnippet: true,
    });
    debugId = result.debugId;
    console.log(`✓ Debug ID injected: ${debugId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`⚠ Debug ID injection failed: ${msg}`);
  }

  // Replace the placeholder UUID with the real debug ID in the JS bundle.
  if (debugId) {
    try {
      const content = readFileSync(bundlePath, "utf-8");
      writeFileSync(
        bundlePath,
        content.replaceAll(PLACEHOLDER_DEBUG_ID, debugId),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`⚠ Debug ID placeholder replacement failed: ${msg}`);
    }
  }

  // -------------------------------------------------------------------------
  // Step 3: Build asset list for fossilize
  // -------------------------------------------------------------------------
  // Fossilize's --assets flag derives the SEA asset key from the path
  // (which becomes absolute after `path.resolve`). To use predictable,
  // short keys at runtime, we write a Vite-style manifest and pass
  // --asset-manifest. The manifest's `entry.file` field is the asset
  // key, and `entry.src` (or `file` path) is where fossilize reads
  // the bytes from.
  const ortWebDir = findOrtWebDir();
  const wasmMjsPath = join(ortWebDir, "dist", "ort-wasm-simd-threaded.mjs");
  const wasmBinPath = join(ortWebDir, "dist", "ort-wasm-simd-threaded.wasm");

  // Patch the WASM file to disable pthread Worker spawning. Node 24
  // doesn't expose `Worker` as a global, so the WASM file's
  // `new Worker(new URL(import.meta.url), ...)` call fails with
  // "Received undefined" when used from a Node CJS bundle. Since
  // lore's workload is single-text embedding and we already force
  // `numThreads=1` via transformers.js, pthreads aren't needed.
  // We replace the Qb function body with a no-op. The function
  // body is single-line in the minified WASM bundle, so a regex
  // anchored on its declaration and the trailing `}` works.
  const originalWasmMjs = readFileSync(wasmMjsPath, "utf-8");
  const patchedWasmMjs = originalWasmMjs.replace(
    /function Qb\(\)\{var a=new Worker\(new URL\(import\.meta\.url\),\{type:"module",workerData:"em-pthread",name:"em-pthread"\}\);Q\.push\(a\)\}/,
    "function Qb(){}",
  );
  // Verify the patch landed before writing to avoid leaving
  // unpatched content on disk if the upstream WASM layout changes.
  if (!patchedWasmMjs.includes("function Qb(){}")) {
    throw new Error(
      "Failed to patch WASM file (Qb() regex didn't match). " +
        "The onnxruntime-web WASM layout may have changed.",
    );
  }
  // Write patched WASM to a side path so we don't mutate the source.
  const patchedWasmMjsPath = join(stagingDir, "ort-wasm-simd-threaded.mjs");
  writeFileSync(patchedWasmMjsPath, patchedWasmMjs);
  const patchedWasmBinPath = join(stagingDir, "ort-wasm-simd-threaded.wasm");
  copyFileSync(wasmBinPath, patchedWasmBinPath);

  // Copy each asset into the staging dir under its final key name.
  // We use a hardlink (when possible) to avoid duplicating 132 MB of
  // model files. Falls back to copyFileSync on filesystems that don't
  // support hardlinks (e.g. some cross-device cases on Windows).
  const stageAsset = (key: string, src: string): string => {
    const dest = join(stagingDir, key);
    mkdirSync(dirname(dest), { recursive: true });
    try {
      // Unlink first in case the dest exists from a prior run.
      try {
        unlinkSync(dest);
      } catch {
        // not present, fine
      }
      linkSync(src, dest);
    } catch {
      copyFileSync(src, dest);
    }
    return dest;
  };

  // Patched files are already in stagingDir under their final keys.
  // No need to stage again (stageAsset would no-op or fail on
  // src == dest).
  // worker.cjs was already moved to stagingDir/worker.cjs by the
  // renameSync call above. No need to stage again.

  if (vendorModelDir) {
    for (const rel of MODEL_FILES) {
      stageAsset(`model/${rel}`, join(vendorModelDir, rel));
    }
  }

  // Write a Vite-style manifest. Fossilize uses `entry.file` as the
  // SEA asset key and joins the manifest's dir to locate the file.
  interface ManifestEntry {
    file: string;
    src: string;
    isEntry?: boolean;
    name?: string;
  }
  const manifest: Record<string, ManifestEntry> = {
    "ort-wasm-simd-threaded.mjs": {
      file: "ort-wasm-simd-threaded.mjs",
      src: "ort-wasm-simd-threaded.mjs",
    },
    "ort-wasm-simd-threaded.wasm": {
      file: "ort-wasm-simd-threaded.wasm",
      src: "ort-wasm-simd-threaded.wasm",
    },
    "worker.cjs": { file: "worker.cjs", src: "worker.cjs" },
  };
  if (vendorModelDir) {
    for (const rel of MODEL_FILES) {
      const key = `model/${rel}`;
      manifest[key] = { file: key, src: key };
    }
  }

  const manifestPath = join(stagingDir, "asset-manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // -------------------------------------------------------------------------
  // Sentry sourcemap upload (runs before fossilize — the .map file lives
  // in stagingDir, not the final binary dir)
  // -------------------------------------------------------------------------
  uploadSentrySourcemap(stagingDir, mapPath);

  // --prepare-only: stop here. The staging dir is the output artifact
  // for transfer to another machine (e.g. macOS for native fossilize).
  if (flags["prepare-only"]) {
    console.log(
      `\n✓ Staging prepared: ${stagingDir}\n` +
        `  Use --from-staging ${stagingDir} on the target machine to run fossilize.`,
    );
    return;
  }

  // -------------------------------------------------------------------------
  // Steps 4-5: fossilize + gzip + rename
  // -------------------------------------------------------------------------
  await runFossilize(targets, bundlePath, manifestPath, stagingDir);
}

await buildBinary();
