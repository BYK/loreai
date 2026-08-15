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
 * Runs under Node (via tsx) — no Bun runtime required.
 *
 * Example:
 *   tsx script/build-binary-sea.ts --platforms linux-x64
 *   tsx script/build-binary-sea.ts --platforms "darwin-arm64,linux-arm64,linux-x64,windows-x64" --release
 *   (or via the package script: `pnpm run build:binary:sea -- --platforms linux-x64`)
 */
import * as esbuild from "esbuild";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
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
import { ortNativePlugin } from "./ort-native-plugin";
import { jsoncParserEsmPlugin } from "./jsonc-parser-plugin";
import { ensureVecBinaries, vecAssetKey } from "./vendor-sqlite-vec";
import { ortNativeAssets } from "./vendor-ort-native";
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
  // Run under Node (via tsx) — no Bun runtime required. tsx is resolved from
  // node_modules so this works regardless of cwd / PATH.
  const tsxCli = require.resolve("tsx/cli");
  const result = spawnSync(
    process.execPath,
    [tsxCli, join(packageDir, "script/vendor-embeddings.ts")],
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
// esbuild: native onnxruntime-node (NOT WASM) for the SEA binary
// ---------------------------------------------------------------------------
// The SEA binary bundles the REAL native onnxruntime-node (2.7–4.1× faster than
// single-threaded WASM, scales with cores, no 4 GiB WASM-heap cap — #999). The
// native addon (.node) + its shared libs ride along as per-target SEA assets
// (staged below via ortNativeAssets) and native-loader.cjs extracts them + sets
// globalThis.__LORE_ORT_BINDING_PATH__ before any worker evaluates; the plugin
// rewrites onnxruntime-node's binding.js to require that path. See
// ort-native-plugin.ts / vendor-ort-native.ts.
function binaryExternalsPlugin(): esbuild.Plugin {
  return ortNativePlugin({ repoRoot });
}

// ---------------------------------------------------------------------------
// esbuild: stub `sqlite-vec`'s path resolver in the SEA bundle
// ---------------------------------------------------------------------------
// The `sqlite-vec` npm wrapper resolves its native loadable extension from a
// platform optionalDependency in node_modules — which doesn't exist inside the
// fossilize binary, so its `getLoadablePath()` can't work there. We replace the
// wrapper with a no-op so the bundle builds without dragging in (or failing to
// resolve) the platform package.
//
// This does NOT disable native vector search: the extension is embedded as a
// per-target SEA asset (`vec0-<target>.<ext>`, staged below) and extracted at
// runtime by native-loader.cjs, which sets `globalThis.__LORE_VEC_EXTENSION_PATH__`.
// `db/vec.ts` prefers that global over `getLoadablePath()`, so the stubbed
// fallback is simply never reached in the SEA. If the asset is somehow missing,
// `getLoadablePath()` returns undefined and the binary transparently uses the JS
// brute-force fallback. See #956 / #999.
function stubSqliteVecPlugin(): esbuild.Plugin {
  return {
    name: "stub-sqlite-vec",
    setup(build) {
      build.onResolve({ filter: /^sqlite-vec$/ }, () => ({
        path: "sqlite-vec",
        namespace: "stub-sqlite-vec",
      }));
      build.onLoad({ filter: /.*/, namespace: "stub-sqlite-vec" }, () => ({
        contents:
          "export function getLoadablePath(){return undefined;}export function load(){}",
        loader: "js",
      }));
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
  manifestByTarget: Map<CompileTarget, string>,
  _stagingDirPath: string,
): Promise<void> {
  // Fossilize embeds a manifest's whole asset set into every binary it builds,
  // so to keep each binary's SEA blob small (only its own platform's native
  // libs — see the manifest-building comment) we invoke fossilize once per
  // target with that target's manifest. This also serializes the postject
  // inject() calls, keeping only one large WASM heap live at a time.
  //
  // Fossilize wipes its outDir at the start of every run, so each target gets
  // its own subdir; we move the produced binary up to distBinDir afterwards.
  // Without the per-target outDir, the 2nd..Nth run would delete the binaries
  // the earlier runs produced.
  for (const target of targets) {
    const fTarget = fossilizeTarget(target);
    const ext = fTarget.startsWith("win") ? ".exe" : "";
    const manifestPath = manifestByTarget.get(target);
    if (!manifestPath) {
      console.error(`✗ no asset manifest for target ${target}`);
      process.exit(1);
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    console.log(
      `→ fossilize: ${target}, ${Object.keys(manifest).length} asset(s)`,
    );
    // fossilize reads the "ort-manifest.json" asset by that literal filename
    // from the manifest's directory (it ignores the manifest's `src` field).
    // All targets share that one runtime key but need target-specific content,
    // so copy this target's persisted ort-manifest-<target>.json onto the
    // shared ort-manifest.json path right before its (serial) fossilize run.
    const stagingDir = dirname(manifestPath);
    copyFileSync(
      join(stagingDir, `ort-manifest-${target}.json`),
      join(stagingDir, "ort-manifest.json"),
    );
    const targetOutDir = join(distBinDir, target);
    try {
      await fossilize(
        {
          nodeVersion: "lts",
          platforms: [fTarget],
          noBundle: true,
          holePunch: true,
          // Make the binary ignore NODE_OPTIONS so user V8 flags (e.g.
          // `NODE_OPTIONS=--max-old-space-size=8192`, common for Claude Code)
          // don't change V8's flag-hash and reject our embedded code cache
          // ("Code cache data rejected"). process.env is untouched, so the
          // user's flags still reach the agent Lore launches.
          ignoreNodeOptions: true,
          outputName: "lore",
          outDir: targetOutDir,
          cacheDir: join(packageDir, ".node-cache"),
          assetManifest: manifestPath,
          sign: false,
          concurrencyLimit: 1,
        },
        bundlePath,
      );
    } catch (err) {
      console.error(`✗ fossilize failed for ${target}:`, err);
      process.exit(1);
    }

    // Move fossilize's output (named lore-<fTarget>[.exe]) up to distBinDir
    // under our naming convention (CI expects lore-windows-x64.exe), then
    // drop the now-empty per-target subdir.
    const fossilizePath = join(targetOutDir, `lore-${fTarget}${ext}`);
    if (!existsSync(fossilizePath)) {
      console.error(
        `✗ expected output not found: ${fossilizePath}. Check fossilize logs.`,
      );
      process.exit(1);
    }
    const ourPath = join(distBinDir, `lore-${target}${ext}`);
    renameSync(fossilizePath, ourPath);
    rmSync(targetOutDir, { recursive: true, force: true });
    console.log(`✓ Binary: ${ourPath}`);
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
    // A --prepare-only run writes one manifest per target
    // (asset-manifest-<target>.json).
    const manifestByTarget = new Map<CompileTarget, string>();
    for (const target of targets) {
      const manifestPath = join(
        externalStaging,
        `asset-manifest-${target}.json`,
      );
      if (!existsSync(manifestPath)) {
        console.error(
          `✗ asset-manifest-${target}.json not found in staging dir: ${externalStaging}`,
        );
        process.exit(1);
      }
      manifestByTarget.set(target, manifestPath);
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
    await runFossilize(targets, bundlePath, manifestByTarget, externalStaging);
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
  // Wipe staging first so a stale artifact from a previous build (e.g. an
  // old all-platforms ort-manifest.json) can never be picked up and mask a
  // regression. Everything below regenerates the staging dir from scratch.
  // (The --from-staging path returns earlier and never reaches here.)
  rmSync(stagingDir, { recursive: true, force: true });
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
    // sharp is for vision models, unused (also stubbed by the plugin).
    // onnxruntime-node is bundled natively; ort-native-plugin patches its
    // binding.js to load the addon extracted by native-loader.cjs.
    external: ["sharp"],
    plugins: [
      binaryExternalsPlugin(),
      sentryBunToNodePlugin(),
      jsoncParserEsmPlugin(packageDir),
      stubSqliteVecPlugin(),
    ],
    inject: [
      // Runs FIRST: extracts the native onnxruntime-node addon (+ sqlite-vec)
      // from SEA assets and registers __LORE_ORT_BINDING_PATH__ on globalThis.
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
    plugins: [binaryExternalsPlugin(), stubSqliteVecPlugin()],
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
  // Step 1c: esbuild vector-search worker bundle
  // -------------------------------------------------------------------------
  // The read-worker pool (core/vector-pool.ts) spawns this off the main thread.
  // Tiny and self-contained: node:sqlite (via the "node" condition) + the pure
  // runVectorQuery logic. No ONNX/transformers/WASM.
  //
  // It injects native-loader.cjs like the other bundles so that — inside the
  // SEA — each worker thread extracts the embedded sqlite-vec extension and sets
  // `globalThis.__LORE_VEC_EXTENSION_PATH__` in its own thread. Worker threads
  // don't share globalThis with the main process, so without this the pool's
  // `loadVecForConnection` would find no path and fall back to the JS scan,
  // defeating native vector search on the hot (off-thread) path.
  const vectorWorkerBundlePath = join(stagingDir, "sea-vector-worker.cjs");
  const vectorWorkerSrc = join(repoRoot, "packages/core/src/vector-worker.ts");

  await esbuild.build({
    entryPoints: [vectorWorkerSrc],
    bundle: true,
    format: "cjs",
    target: "node22",
    platform: "node",
    conditions: ["node"],
    external: ["sharp"],
    plugins: [binaryExternalsPlugin(), stubSqliteVecPlugin()],
    inject: [join(here, "native-loader.cjs")],
    outfile: vectorWorkerBundlePath,
    sourcemap: "linked",
    minify: true,
    logLevel: "info",
    legalComments: "none",
  });

  console.log(`✓ esbuild vector worker: ${vectorWorkerBundlePath}`);

  // Rename to `vector-worker.cjs` so the fossilize asset key matches what
  // sea-entry.ts reads at runtime (`vector-worker.cjs`).
  const vectorWorkerAssetPath = join(stagingDir, "vector-worker.cjs");
  renameSync(vectorWorkerBundlePath, vectorWorkerAssetPath);

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

  // worker.cjs / vector-worker.cjs were already moved to stagingDir by the
  // renameSync calls above. No need to stage again.

  if (vendorModelDir) {
    for (const rel of MODEL_FILES) {
      stageAsset(`model/${rel}`, join(vendorModelDir, rel));
    }
  }

  // Stage the native sqlite-vec loadable extension for every target in this
  // build. fossilize embeds a single shared asset set into each platform
  // binary, so we key each one as `vec0-<target>.<ext>`; at runtime
  // native-loader.cjs extracts only the one matching the running platform.
  // The binaries are tiny (~160 KB each), so embedding all targets is cheap.
  const vecBinaries = await ensureVecBinaries(targets);
  for (const [target, binPath] of vecBinaries) {
    stageAsset(vecAssetKey(target), binPath);
  }

  // Stage the native onnxruntime-node addon + its shared libraries for every
  // target. Like vec0, fossilize embeds one shared asset set into each binary,
  // so we key each file as `ort-<target>-<file>`; native-loader.cjs extracts
  // only the set matching the running platform into one dir (replicating the
  // package's sibling layout so the addon's $ORIGIN/@loader_path/DLL-search
  // resolution finds libonnxruntime). SEA selection omits optional GPU provider
  // libraries because Lore always uses the CPU execution provider. See
  // vendor-ort-native.ts.
  const ortAssets = ortNativeAssets(targets);
  for (const files of ortAssets.values()) {
    for (const { assetKey, srcPath } of files) {
      stageAsset(assetKey, srcPath);
    }
  }
  // Runtime manifest of the ORT native file set per target. native-loader.cjs
  // reads it to learn the (version-specific, e.g. libonnxruntime.<version>.dylib)
  // filenames to extract for the running platform — so filenames live in ONE
  // place (vendor-ort-native.ts) instead of being duplicated in the loader.
  // Written per-target below (aliased to the runtime "ort-manifest.json" key
  // inside each target's own asset manifest).
  const ortFileManifest: Record<string, string[]> = {};
  for (const [target, files] of ortAssets) {
    ortFileManifest[target] = files.map((f) => f.file);
  }

  // Build one Vite-style asset manifest PER TARGET. Fossilize embeds a
  // manifest's entire asset set into every binary it produces, so a single
  // combined manifest would pack all four platforms' native ORT + vec0 libs
  // (~200 MB) into each binary. postject@1.0.0-alpha.6's ELF injection aborts
  // once the SEA blob grows past ~300 MB (a 32-bit-WASM/LIEF memory ceiling in
  // its native-section rebuild), which is exactly what broke the 0.38.0 release
  // build after the onnxruntime-node 1.27 bump grew every platform's lib.
  //
  // Instead we embed only the running platform's native assets in each binary
  // (shared model + workers stay in all of them). That drops the blob from
  // ~305 MB to ~163 MB — comfortably under the ELF limit — and shrinks every
  // shipped binary by ~140 MB. Fossilize is then invoked once per target.
  interface ManifestEntry {
    file: string;
    src: string;
    isEntry?: boolean;
    name?: string;
  }
  const sharedManifest: Record<string, ManifestEntry> = {
    "worker.cjs": { file: "worker.cjs", src: "worker.cjs" },
    "vector-worker.cjs": {
      file: "vector-worker.cjs",
      src: "vector-worker.cjs",
    },
  };
  if (vendorModelDir) {
    for (const rel of MODEL_FILES) {
      const key = `model/${rel}`;
      sharedManifest[key] = { file: key, src: key };
    }
  }

  // Sentry sourcemap upload (runs before fossilize — the .map file lives
  // in stagingDir, not the final binary dir).
  uploadSentrySourcemap(stagingDir, mapPath);

  // Write each target's manifest = shared assets + that target's native libs
  // (vec0 + ORT set) + the shared "ort-manifest.json" runtime key. Returns
  // target → manifest path so runFossilize can build each binary from its own
  // manifest. NOTE: fossilize keys every asset by its `file` field and reads
  // the bytes from `<manifestDir>/<file>` — it ignores `src`. Since all targets
  // must use the identical runtime asset key "ort-manifest.json" but need
  // different content, we persist each target's content as
  // "ort-manifest-<target>.json" and runFossilize (which runs fossilize
  // serially, once per target) copies the right one onto the shared
  // "ort-manifest.json" path immediately before each target's build. This also
  // keeps the staging dir self-contained for --from-staging.
  const manifestByTarget = new Map<CompileTarget, string>();
  for (const target of targets) {
    const manifest: Record<string, ManifestEntry> = { ...sharedManifest };

    const vecKey = vecAssetKey(target);
    manifest[vecKey] = { file: vecKey, src: vecKey };

    for (const { assetKey } of ortAssets.get(target) ?? []) {
      manifest[assetKey] = { file: assetKey, src: assetKey };
    }

    // native-loader.cjs only ever reads the running platform's entry, so a
    // single-target manifest suffices.
    writeFileSync(
      join(stagingDir, `ort-manifest-${target}.json`),
      JSON.stringify({ [target]: ortFileManifest[target] ?? [] }),
    );
    manifest["ort-manifest.json"] = {
      file: "ort-manifest.json",
      src: "ort-manifest.json",
    };

    const manifestPath = join(stagingDir, `asset-manifest-${target}.json`);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    manifestByTarget.set(target, manifestPath);
  }

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
  await runFossilize(targets, bundlePath, manifestByTarget, stagingDir);
}

await buildBinary();
