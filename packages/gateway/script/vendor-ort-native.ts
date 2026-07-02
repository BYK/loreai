/**
 * Vendor the native `onnxruntime-node` runtime for every build target.
 *
 * The SEA (fossilize) binary has no `node_modules`, so `onnxruntime-node`'s
 * `binding.js` — which does `require("../bin/napi-v3/<platform>/<arch>/
 * onnxruntime_binding.node")` — can't find its native addon inside the binary.
 * Instead we embed the addon + its shared libraries as SEA assets (one set per
 * target) and extract them at runtime (see `native-loader.cjs`, which sets
 * `globalThis.__LORE_ORT_BINDING_PATH__`, the path the patched `binding.js`
 * requires — see `ort-native-plugin.ts`).
 *
 * Unlike `sqlite-vec` (whose per-platform binaries live in separate npm
 * packages), `onnxruntime-node` ships EVERY platform's binaries in one package
 * under `bin/napi-v3/<platform>/<arch>/`. So there is no download step: we copy
 * straight from the installed package. Lore's SEA builds are cross-platform (a
 * single Linux host stages linux/windows and prepares darwin for the macOS
 * `--from-staging` job), and every target's files are present in `node_modules`,
 * so one host can stage all of them.
 *
 * The addon resolves its sibling `libonnxruntime.*` via `$ORIGIN` (linux
 * RUNPATH), `@loader_path` (darwin), and same-directory DLL search (windows) —
 * so extracting the whole set into ONE directory replicates the package's own
 * sibling layout and resolution works by construction (it works in node_modules
 * because they are siblings there too).
 *
 * Runs under Node (via tsx). Safe to import for its helpers — no side effects
 * until `ortNativeAssets` / the CLI runs.
 */
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { VENDOR_TARGETS, type VendorTarget } from "./vendor-paths";

const require = createRequire(import.meta.url);

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(here);
const repoRoot = dirname(dirname(packageDir));

/** Map a build target to onnxruntime-node's `bin/napi-v3/<platform>/<arch>`
 *  subdirectory (Node's `process.platform`/`process.arch` naming). */
const ORT_TARGET_SUBDIR: Record<VendorTarget, string> = {
  "darwin-arm64": "darwin/arm64",
  "linux-arm64": "linux/arm64",
  "linux-x64": "linux/x64",
  "windows-x64": "win32/x64",
};

/** The native addon file `binding.js` loads (constant across platforms). The
 *  runtime loader points `__LORE_ORT_BINDING_PATH__` at the extracted copy. */
export const ORT_BINDING_FILE = "onnxruntime_binding.node";

/** The SEA asset key for one of a target's native files. `native-loader.cjs`
 *  recomputes the same key from `process.platform`/`process.arch` at runtime,
 *  so keep the two in sync. Filenames are flat (no path separators) so a simple
 *  `ort-<target>-<file>` key is unambiguous. */
export function ortAssetKey(target: VendorTarget, file: string): string {
  return `ort-${target}-${file}`;
}

/** Resolve onnxruntime-node's package root (it's a transitive dep via
 *  @huggingface/transformers, and a devDependency of the gateway/core). */
function ortNodeDir(): string {
  const pjPath = require.resolve("onnxruntime-node/package.json", {
    paths: [packageDir, join(repoRoot, "packages/core")],
  });
  return dirname(pjPath);
}

/** onnxruntime-node's resolved version (keeps embedded libs ABI-matched to the
 *  `binding.js` we bundle + patch). */
export function ortNodeVersion(): string {
  const pjPath = require.resolve("onnxruntime-node/package.json", {
    paths: [packageDir, join(repoRoot, "packages/core")],
  });
  const v = JSON.parse(require("node:fs").readFileSync(pjPath, "utf8")).version;
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(
      "vendor-ort-native: could not determine onnxruntime-node version",
    );
  }
  return v;
}

/**
 * The set of files to embed for `target`: every file in the platform's bin dir,
 * MINUS longer-versioned aliases of another file. e.g. linux ships both
 * `libonnxruntime.so.1` (the SONAME the addon's NEEDED entry references) and
 * `libonnxruntime.so.1.21.0` (identical bytes); we keep the SONAME and drop the
 * duplicate to avoid embedding ~21 MB twice. darwin's `libonnxruntime.1.21.0.
 * dylib` has no shorter alias so it's kept; windows' `onnxruntime.dll` /
 * `DirectML.dll` are kept. Version-robust: no hard-coded library filenames.
 */
function targetFiles(dir: string): string[] {
  const all = readdirSync(dir).filter((f) => !f.startsWith("."));
  // Drop F when some other G is a strict prefix of F followed by "." — i.e. F is
  // a longer-versioned alias (libX.so.1.21.0 vs the SONAME libX.so.1).
  return all.filter((f) => !all.some((g) => g !== f && f.startsWith(`${g}.`)));
}

/** Absolute source path + asset key for every native file of every target.
 *  Returns target → array of { assetKey, srcPath }. No caching/download needed:
 *  onnxruntime-node ships all platforms in node_modules. */
export function ortNativeAssets(
  targets: readonly VendorTarget[],
): Map<
  VendorTarget,
  Array<{ assetKey: string; srcPath: string; file: string }>
> {
  const binRoot = join(ortNodeDir(), "bin", "napi-v3");
  const out = new Map<
    VendorTarget,
    Array<{ assetKey: string; srcPath: string; file: string }>
  >();
  for (const target of targets) {
    const dir = join(binRoot, ORT_TARGET_SUBDIR[target]);
    if (!existsSync(dir)) {
      throw new Error(
        `vendor-ort-native: onnxruntime-node bin dir missing for ${target}: ${dir}`,
      );
    }
    const files = targetFiles(dir);
    if (!files.includes(ORT_BINDING_FILE)) {
      throw new Error(
        `vendor-ort-native: ${ORT_BINDING_FILE} not found for ${target} in ${dir}`,
      );
    }
    out.set(
      target,
      files.map((file) => ({
        file,
        assetKey: ortAssetKey(target, file),
        srcPath: join(dir, file),
      })),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI: `tsx script/vendor-ort-native.ts [--platforms a,b,c]`
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { platforms: { type: "string" } },
    allowPositionals: false,
    strict: true,
  });
  const targets = (
    values.platforms
      ? values.platforms
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : VENDOR_TARGETS
  ) as VendorTarget[];
  for (const t of targets) {
    if (!VENDOR_TARGETS.includes(t)) {
      console.error(`Invalid target: ${t}`);
      console.error(`Valid targets: ${VENDOR_TARGETS.join(", ")}`);
      process.exit(1);
    }
  }
  console.log(
    `→ vendor onnxruntime-node ${ortNodeVersion()}: ${targets.join(", ")}`,
  );
  const assets = ortNativeAssets(targets);
  for (const [t, files] of assets) {
    console.log(`✓ ${t}:`);
    for (const { file, srcPath } of files)
      console.log(`    ${file}  ←  ${srcPath}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
