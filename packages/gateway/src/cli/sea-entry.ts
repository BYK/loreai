/**
 * Fossilize binary entry.
 *
 * This is the single entry point that fossilize bundles into the SEA.
 *
 * Architecture:
 * - The native loader shim (auto-injected by esbuild's `inject:`)
 *   runs FIRST and extracts the native onnxruntime-node addon (+ the
 *   sqlite-vec extension) to a per-pid tmp dir.
 * - This file (sea-entry.ts) reads the embedding worker source
 *   from a SEA asset and exposes it via
 *   `globalThis.__LORE_WORKER_SOURCE__` so `embedding.ts` can
 *   pass it to `new Worker(source, { eval: true, filename, workerData })`.
 * - If vendoring is enabled, we materialize the model files from
 *   SEA assets to `~/.lore/embeddings-vendored/`.
 * - We hand off to the main CLI in `bin.ts`.
 *
 * The `filename` option sets `__filename` inside the worker to an
 * absolute path, so the `createRequire` post-processing patch
 * (which replaces `createRequire(shim.url)` with
 * `createRequire(pathToFileURL(__filename).href)`) resolves correctly.
 * No actual file is written to disk — the path is purely virtual.
 *
 * See plan: `.opencode/plans/1780615975950-clever-canyon.md`
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

const VERSION = LORE_CLI_VERSION;

// Build-time constants injected by esbuild's `define` config in
// build-binary-sea.ts. They're never defined at runtime; the
// declarations here are just to keep TypeScript happy.
declare const LORE_CLI_VERSION: string;
declare const __LORE_VENDOR_ENABLED__: boolean;
declare const __LORE_MODEL_FILES__: string;
declare const __LORE_MODEL_DIR_NAME__: string;

// ---------------------------------------------------------------------------
// 1. Read worker source from SEA asset
// ---------------------------------------------------------------------------
const sea = require("node:sea") as typeof import("node:sea");
const data = sea.getRawAsset("worker.cjs");
(globalThis as Record<string, unknown>).__LORE_WORKER_SOURCE__ =
  Buffer.from(data).toString("utf8");

// Vector-search worker source (read-worker pool, core/vector-pool.ts). Same
// pattern as the embedding worker above: the pool reads this global and spawns
// `new Worker(src, { eval: true, ... })`.
const vectorWorkerData = sea.getRawAsset("vector-worker.cjs");
(globalThis as Record<string, unknown>).__LORE_VECTOR_WORKER_SOURCE__ =
  Buffer.from(vectorWorkerData).toString("utf8");

// ---------------------------------------------------------------------------
// 2. Vendor model materialization
// ---------------------------------------------------------------------------
// The build-time define `__LORE_VENDOR_ENABLED__` controls whether
// the model is embedded in the SEA blob. When `--no-vendor` is set
// at build time, this constant is `false` and the runtime downloads
// the model from HuggingFace Hub on first use (same as the npm path).
const vendorEnabled = __LORE_VENDOR_ENABLED__;

if (vendorEnabled) {
  // Materialize model files from SEA assets to
  // ~/.lore/embeddings-vendored/v{VERSION}-{TARGET}/<MODEL_DIR_NAME>/.
  // The layout matches HuggingFace repo structure that transformers.js
  // expects.
  /**
   * Platform target string used to locate the vendored embedding
   * model directory when running the SEA (single executable)
   * binary. Format: `${platform}-${arch}` (e.g. `darwin-arm64`,
   * `linux-x64`). Defaults to the current host. Override this to
   * pre-warm the embedding model cache on a machine of one
   * platform and run the binary on another (CI cross-builds, OCI
   * images). Env: `LORE_TARGET=<platform>-<arch>`.
   */
  const target =
    process.env.LORE_TARGET ?? `${process.platform}-${process.arch}`;
  const vendorRoot = join(
    homedir(),
    ".lore",
    "embeddings-vendored",
    `v${VERSION}-${target}`,
  );

  // MODEL_FILES is inlined by the build script as a comma-separated
  // string. See packages/gateway/script/vendor-paths.ts for the
  // source list. We split on "," to get the array.
  const modelFiles: string[] = __LORE_MODEL_FILES__.split(",");
  const modelDirName: string = __LORE_MODEL_DIR_NAME__;

  const modelDir = join(vendorRoot, modelDirName);

  // Race-safe materialization: write to a per-pid tmp then rename.
  // renameSync is atomic on the same filesystem, so concurrent
  // CLI invocations on the same machine each get their own
  // pid-suffixed tmp file and the last rename wins — no partial
  // files at the final destination.
  for (const relPath of modelFiles) {
    const assetKey = `model/${relPath}`;
    const buf = Buffer.from(sea.getRawAsset(assetKey));
    const dest = join(modelDir, relPath);
    const subdir = relPath.includes("/")
      ? relPath.slice(0, relPath.lastIndexOf("/"))
      : "";
    mkdirSync(join(modelDir, subdir), { recursive: true });
    // Skip if already extracted (a previous run beat us to it).
    if (existsSync(dest)) continue;
    const tmpDest = `${dest}.${process.pid}.tmp`;
    try {
      writeFileSync(tmpDest, buf, { mode: 0o644 });
      renameSync(tmpDest, dest);
    } catch (err) {
      // Best-effort cleanup of the orphaned tmp file on failure.
      try {
        unlinkSync(tmpDest);
      } catch {
        // Ignore — file may not exist if writeFileSync failed.
      }
      throw err;
    }
  }

  // Register for the LocalProvider.
  (globalThis as Record<string, unknown>).__LORE_VENDOR_MODEL__ = {
    localModelPath: vendorRoot,
    target,
    version: VERSION,
  };
}

// ---------------------------------------------------------------------------
// 3. Hand off to main CLI
// ---------------------------------------------------------------------------
// Dynamic import so the bin module body evaluates after the
// globalThis registrations above (static imports get hoisted).
// Wrapped in an IIFE because CJS bundles don't support top-level await.
(async () => {
  await import("./bin");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
