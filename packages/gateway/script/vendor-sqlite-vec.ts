/**
 * Resolve the native sqlite-vec loadable extension for every SEA build target.
 *
 * The SEA (fossilize) binary has no `node_modules`, so the vendored package's
 * `getLoadablePath()` — which resolves its prebuilt binary relative to its own
 * install location — can't find the extension inside the binary. Instead we
 * embed the extension as a SEA asset (one per target) and extract it at runtime
 * (see `native-loader.cjs`, which sets `globalThis.__LORE_VEC_EXTENSION_PATH__`,
 * the path `db/vec.ts` prefers).
 *
 * Binaries come from `@loreai/sqlite-vec-vendored` — committed prebuilt
 * extensions built from sqlite-vec source with DiskANN + rescore enabled (one
 * per target). There is no download or cache: we resolve the committed file for
 * each requested target and fail loudly if one is missing. Lore's SEA builds are
 * cross-platform (a single Linux host builds linux/windows and stages darwin),
 * which is exactly why the package ships every target's binary rather than
 * relying on the host's own platform package.
 *
 * We resolve the binary by its committed REPO path
 * (`packages/sqlite-vec-vendored/prebuilt/<target>/vec0.<ext>`) rather than
 * importing the package's built JS, so this build step has no dependency on the
 * vendored package's `dist/` being compiled first.
 *
 * Runs under Node (via tsx) — no Bun runtime required. Safe to import for its
 * path helpers (no side effects until `ensureVecBinaries` / the CLI runs).
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { VENDOR_TARGETS, type VendorTarget } from "./vendor-paths";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(here); // packages/gateway
const repoRoot = dirname(dirname(packageDir));
const vendoredPrebuiltDir = join(
  repoRoot,
  "packages",
  "sqlite-vec-vendored",
  "prebuilt",
);

/** Loadable-extension file suffix per target. Mirrors the asset key the runtime
 *  loader (`native-loader.cjs`) computes — keep the two in sync. */
const TARGET_EXT: Record<VendorTarget, string> = {
  "darwin-arm64": "dylib",
  "linux-arm64": "so",
  "linux-x64": "so",
  "windows-x64": "dll",
};

/** The SEA asset key under which a target's extension is embedded. The runtime
 *  loader (`native-loader.cjs`) computes the same key from `process.platform`/
 *  `process.arch` and extracts only the matching one. Keep the two in sync. */
export function vecAssetKey(target: VendorTarget): string {
  return `vec0-${target}.${TARGET_EXT[target]}`;
}

/**
 * Absolute path to the committed prebuilt extension for `target`. Throws if the
 * binary is missing so a misconfigured build fails loudly instead of silently
 * shipping a binary with no native vector search.
 */
export function ensureVecBinary(target: VendorTarget): string {
  const path = join(vendoredPrebuiltDir, target, `vec0.${TARGET_EXT[target]}`);
  if (!existsSync(path)) {
    throw new Error(
      `vendor-sqlite-vec: missing prebuilt binary for ${target} at ${path}. ` +
        "Build it locally with " +
        `'pnpm --filter @loreai/sqlite-vec-vendored run build:native -- --target ${target}' ` +
        "(host target only) or commit the artifact from the build-sqlite-vec workflow.",
    );
  }
  return path;
}

/** Resolve binaries for several targets; returns target → absolute path.
 *  Async to preserve the call site in build-binary-sea.ts (resolution is now
 *  synchronous, but the signature stays stable). */
export async function ensureVecBinaries(
  targets: readonly VendorTarget[],
): Promise<Map<VendorTarget, string>> {
  const out = new Map<VendorTarget, string>();
  for (const t of targets) out.set(t, ensureVecBinary(t));
  return out;
}

// ---------------------------------------------------------------------------
// CLI: `tsx script/vendor-sqlite-vec.ts [--platforms a,b,c]` — verifies the
// committed prebuilt binaries resolve for the requested targets.
// ---------------------------------------------------------------------------
function main(): void {
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
  console.log(`→ verify vendored sqlite-vec binaries: ${targets.join(", ")}`);
  for (const t of targets) {
    console.log(`✓ ${t}: ${ensureVecBinary(t)}`);
  }
}

// Run only when invoked directly (not when imported by build-binary-sea.ts).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
