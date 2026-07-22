/**
 * Vendor the native `onnxruntime-node` runtime for every build target.
 *
 * The SEA (fossilize) binary has no `node_modules`, so `onnxruntime-node`'s
 * `binding.js` — which does `require("../bin/napi-v<N>/<platform>/<arch>/
 * onnxruntime_binding.node")` — can't find its native addon inside the binary.
 * Instead we embed the addon + its shared libraries as SEA assets (one set per
 * target) and extract them at runtime (see `native-loader.cjs`, which sets
 * `globalThis.__LORE_ORT_BINDING_PATH__`, the path the patched `binding.js`
 * requires — see `ort-native-plugin.ts`).
 *
 * Unlike `sqlite-vec` (whose per-platform binaries live in separate npm
 * packages), `onnxruntime-node` ships EVERY platform's binaries in one package
 * under `bin/napi-v<N>/<platform>/<arch>/`. So there is no download step: we copy
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

/** Map a build target to onnxruntime-node's `bin/napi-v<N>/<platform>/<arch>`
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

/** onnxruntime-node's `bin/napi-v<N>` root, under which each platform's files
 *  live in `<process.platform>/<process.arch>/` subdirs. The N-API ABI dir name
 *  (napi-v3, napi-v6, …) changes across onnxruntime-node releases, so discover
 *  it from the installed package instead of hard-coding it — a version bump that
 *  moves the dir would otherwise silently break every SEA/npm native build. */
export function ortNodeBinRoot(): string {
  const binDir = join(ortNodeDir(), "bin");
  const napiDirs = existsSync(binDir)
    ? readdirSync(binDir).filter((d) => /^napi-v\d+$/.test(d))
    : [];
  if (napiDirs.length !== 1) {
    throw new Error(
      `vendor-ort-native: expected exactly one bin/napi-v<N> dir in ` +
        `onnxruntime-node, found [${napiDirs.join(", ")}]`,
    );
  }
  return join(binDir, napiDirs[0]);
}

/**
 * A shared library filename split into (stem, version, ext) if it carries an
 * embedded numeric version, else `null`. Handles both linker conventions:
 *   linux : `libonnxruntime.so.1`      → { stem:"libonnxruntime", ver:"1",      ext:".so" }
 *           `libonnxruntime.so.1.27.0` → { stem:"libonnxruntime", ver:"1.27.0", ext:".so" }
 *   darwin: `libonnxruntime.1.dylib`   → { stem:"libonnxruntime", ver:"1",      ext:".dylib" }
 *           `libonnxruntime.1.27.0.dylib` → { stem:"libonnxruntime", ver:"1.27.0", ext:".dylib" }
 * Files without an embedded numeric version (the addon, distinct `.dll`s) → null.
 */
function parseVersionedLib(
  file: string,
): { stem: string; version: string; ext: string } | null {
  // darwin: <stem>.<numeric-version>.dylib
  let m = /^(.+?)\.(\d+(?:\.\d+)*)\.dylib$/.exec(file);
  if (m) return { stem: m[1], version: m[2], ext: ".dylib" };
  // linux/elf: <stem>.so.<numeric-version>
  m = /^(.+?\.so)\.(\d+(?:\.\d+)*)$/.exec(file);
  if (m) return { stem: m[1], version: m[2], ext: "" };
  return null;
}

/**
 * Given a flat list of a platform's native files, drop longer-versioned
 * duplicates of a shared library, keeping only the canonical (shortest-version)
 * member of each (stem, ext) group. Pure/deterministic — the filesystem-reading
 * `collectOrtFiles` delegates its dedup here so the rule is unit-testable with
 * synthetic file sets. See `collectOrtFiles` for the rationale/examples.
 */
export function dropVersionedLibAliases(all: readonly string[]): string[] {
  const versionComponents = (v: string): number => v.split(".").length;
  return all.filter((f) => {
    const info = parseVersionedLib(f);
    if (!info) return true; // no embedded version → always keep
    // Drop F if a sibling shares its (stem, ext) but has a shorter version.
    return !all.some((g) => {
      if (g === f) return false;
      const gi = parseVersionedLib(g);
      return (
        gi !== null &&
        gi.stem === info.stem &&
        gi.ext === info.ext &&
        versionComponents(gi.version) < versionComponents(info.version)
      );
    });
  });
}

/**
 * The native files for one onnxruntime-node platform, given its `bin/napi-v<N>`
 * subdir (e.g. `"linux/x64"`, `"win32/arm64"`). Returns every file in the dir
 * MINUS longer-versioned aliases of another shared library. A library can ship
 * multiple version-named copies of identical bytes that a single linker
 * install-name/SONAME resolves to:
 *   linux : `libonnxruntime.so.1` (the SONAME the addon NEEDs) alongside a
 *           historical `libonnxruntime.so.1.<version>`;
 *   darwin (onnxruntime-node ≥ 1.27): `libonnxruntime.1.dylib` (the addon's
 *           `@rpath` install-name) alongside `libonnxruntime.1.27.0.dylib`.
 * For each (stem, ext) group we keep ONLY the shortest-versioned member (fewest
 * dotted components — the alias the addon actually references) and drop the
 * longer duplicates, saving ~21 MB (linux) / ~38 MB (darwin) per platform.
 * Files with no embedded numeric version (the addon, distinct windows DLLs like
 * `onnxruntime.dll` / `DirectML.dll`) are always kept. Version-robust: no
 * hard-coded library filenames. Throws if the dir is missing or lacks the addon.
 */
export function collectOrtFiles(
  binSubdir: string,
): Array<{ file: string; srcPath: string }> {
  const dir = join(ortNodeBinRoot(), binSubdir);
  if (!existsSync(dir)) {
    throw new Error(
      `vendor-ort-native: onnxruntime-node bin dir missing: ${dir}`,
    );
  }
  const all = readdirSync(dir).filter((f) => !f.startsWith("."));
  const kept = dropVersionedLibAliases(all);
  if (!kept.includes(ORT_BINDING_FILE)) {
    throw new Error(
      `vendor-ort-native: ${ORT_BINDING_FILE} not found in ${dir}`,
    );
  }
  return kept.map((file) => ({ file, srcPath: join(dir, file) }));
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
  const out = new Map<
    VendorTarget,
    Array<{ assetKey: string; srcPath: string; file: string }>
  >();
  for (const target of targets) {
    out.set(
      target,
      collectOrtFiles(ORT_TARGET_SUBDIR[target]).map(({ file, srcPath }) => ({
        file,
        srcPath,
        assetKey: ortAssetKey(target, file),
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
