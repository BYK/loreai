/**
 * Vendor the native `sqlite-vec` loadable extension for every build target.
 *
 * The SEA (fossilize) binary has no `node_modules`, so the `sqlite-vec` npm
 * wrapper's `getLoadablePath()` — which resolves the per-platform optional
 * dependency at runtime — can't find the extension inside the binary. Instead
 * we embed the extension as a SEA asset (one per target) and extract it at
 * runtime (see `native-loader.cjs`, which sets
 * `globalThis.__LORE_VEC_EXTENSION_PATH__`, the path `db/vec.ts` prefers).
 *
 * This script produces the per-target binaries the build embeds. Lore's SEA
 * builds are cross-platform: a single Linux host builds linux/windows (and
 * stages darwin for the macOS `--from-staging` job), so we can't rely on the
 * host's own `sqlite-vec-<platform>` package being the right one. For each
 * requested target we:
 *   1. reuse the locally-installed package when the target IS the host, else
 *   2. download the `sqlite-vec-<os>-<arch>` tarball from the npm registry and
 *      extract its single `vec0.<ext>` file.
 * Results are cached under `.vendor-build/sqlite-vec/<version>/<target>/` so
 * repeat builds (and CI, which caches `.vendor-build/`) skip the network.
 *
 * The vendored version is pinned to the resolved `sqlite-vec` dependency, so
 * bumping the npm dep (e.g. the upcoming DiskANN 0.1.10 vendored build, #999)
 * automatically re-vendors matching binaries.
 *
 * Runs under Node (via tsx) — no Bun runtime required. Safe to import for its
 * path helpers (no side effects until `ensureVecBinaries` / the CLI runs).
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { x as tarExtract } from "tar";
import { VENDOR_TARGETS, type VendorTarget } from "./vendor-paths";

const require = createRequire(import.meta.url);

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(here);
const repoRoot = dirname(dirname(packageDir));

/** Per-target sqlite-vec platform package + loadable-extension file suffix.
 *  Mirrors the `sqlite-vec` wrapper's own `platformPackageName()` /
 *  `extensionSuffix()` (win32 → "windows"/"dll", darwin → "dylib", else "so"). */
const VEC_TARGET_INFO: Record<VendorTarget, { pkg: string; ext: string }> = {
  "darwin-arm64": { pkg: "sqlite-vec-darwin-arm64", ext: "dylib" },
  "linux-arm64": { pkg: "sqlite-vec-linux-arm64", ext: "so" },
  "linux-x64": { pkg: "sqlite-vec-linux-x64", ext: "so" },
  "windows-x64": { pkg: "sqlite-vec-windows-x64", ext: "dll" },
};

/** The SEA asset key under which a target's extension is embedded. The runtime
 *  loader (`native-loader.cjs`) computes the same key from `process.platform`/
 *  `process.arch` and extracts only the matching one. Keep the two in sync. */
export function vecAssetKey(target: VendorTarget): string {
  return `vec0-${target}.${VEC_TARGET_INFO[target].ext}`;
}

/** Host target string in VendorTarget form (e.g. "linux-x64", "windows-x64"). */
function hostTarget(): string {
  const os = process.platform === "win32" ? "windows" : process.platform;
  return `${os}-${process.arch}`;
}

/** Resolve the sqlite-vec version from the installed package, falling back to
 *  the gateway's declared dependency. Keeps vendored binaries ABI-matched to
 *  the wrapper the rest of the code loads. */
export function sqliteVecVersion(): string {
  try {
    const pjPath = require.resolve("sqlite-vec/package.json", {
      paths: [packageDir, join(repoRoot, "packages/core")],
    });
    const v = JSON.parse(readFileSync(pjPath, "utf8")).version;
    if (typeof v === "string" && v.length > 0) return v;
  } catch {
    // fall through to the declared-dependency fallback
  }
  const gw = JSON.parse(
    readFileSync(join(packageDir, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const declared = gw.dependencies?.["sqlite-vec"] ?? "";
  const cleaned = declared.replace(/[^\d.]/g, "");
  if (!cleaned) {
    throw new Error(
      "vendor-sqlite-vec: could not determine sqlite-vec version (not " +
        "resolvable and no declared dependency in packages/gateway/package.json)",
    );
  }
  return cleaned;
}

function cacheDirFor(version: string): string {
  return join(repoRoot, ".vendor-build", "sqlite-vec", version);
}

/** Absolute path to a target's cached `vec0.<ext>` (may not exist yet). */
export function vecBinaryCachePath(
  target: VendorTarget,
  version: string,
): string {
  return join(
    cacheDirFor(version),
    target,
    `vec0.${VEC_TARGET_INFO[target].ext}`,
  );
}

/** Place a file at `dest` atomically: `produce` writes to a temp path in the
 *  same directory, then we rename it into place. A rename on the same
 *  filesystem is atomic, so an interrupted run (CI cancel / OOM / SIGTERM)
 *  never leaves a truncated `vec0.*` at the cache-key path — which the next
 *  build (and the persisted `.vendor-build/` CI cache) would otherwise treat
 *  as a valid cache hit and embed, silently breaking native vector search. */
function placeAtomically(
  dest: string,
  produce: (tmpPath: string) => void,
): void {
  const tmp = `${dest}.tmp-${process.pid}`;
  try {
    produce(tmp);
    renameSync(tmp, dest);
  } finally {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // best-effort cleanup
    }
  }
}

async function downloadAndExtract(
  target: VendorTarget,
  version: string,
  dest: string,
): Promise<void> {
  const { pkg, ext } = VEC_TARGET_INFO[target];
  const url = `https://registry.npmjs.org/${pkg}/-/${pkg}-${version}.tgz`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `vendor-sqlite-vec: download failed for ${pkg}@${version} ` +
        `(${res.status} ${res.statusText}) — ${url}`,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  // Stage the download + extraction in a temp dir so a partial result never
  // lands at the cache path; only the finished file is renamed into place.
  const stage = join(dirname(dest), `.tmp-${process.pid}-${target}`);
  mkdirSync(stage, { recursive: true });
  try {
    const tmpTgz = join(stage, `${pkg}-${version}.tgz`);
    writeFileSync(tmpTgz, buf);
    // npm tarballs nest everything under `package/`; strip:1 drops it, and the
    // filter keeps only the single loadable-extension file.
    await tarExtract({
      file: tmpTgz,
      cwd: stage,
      strip: 1,
      filter: (p) => p === `package/vec0.${ext}`,
    });
    const extracted = join(stage, `vec0.${ext}`);
    if (!existsSync(extracted)) {
      throw new Error(
        `vendor-sqlite-vec: extracted ${pkg}@${version} but vec0.${ext} not found`,
      );
    }
    renameSync(extracted, dest);
  } finally {
    try {
      rmSync(stage, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

/**
 * Ensure the loadable extension for `target` exists in the vendor cache and
 * return its absolute path. Cache hit → no work. Cache miss → reuse the
 * locally-installed package when `target` is the host, else download.
 */
export async function ensureVecBinary(
  target: VendorTarget,
  version = sqliteVecVersion(),
): Promise<string> {
  const dest = vecBinaryCachePath(target, version);
  if (existsSync(dest)) return dest;

  mkdirSync(dirname(dest), { recursive: true });

  // Fast path: when building for the host, reuse the already-installed
  // extension instead of hitting the network. The per-platform package
  // (`sqlite-vec-<os>-<arch>`) is a *transitive* optionalDependency, so under
  // pnpm it isn't resolvable from packages/gateway|core — only the wrapper's
  // `getLoadablePath()` finds it (it resolves its own sibling in `.pnpm/`).
  if (target === hostTarget()) {
    try {
      const wrapper = require.resolve("sqlite-vec", {
        paths: [packageDir, join(repoRoot, "packages/core")],
      });
      const { getLoadablePath } = require(wrapper) as {
        getLoadablePath?: () => string;
      };
      const installed = getLoadablePath?.();
      if (installed && existsSync(installed)) {
        placeAtomically(dest, (tmp) => copyFileSync(installed, tmp));
        return dest;
      }
    } catch {
      // not installed / not resolvable — fall through to download
    }
  }

  await downloadAndExtract(target, version, dest);
  return dest;
}

/** Ensure binaries for several targets; returns target → absolute path. */
export async function ensureVecBinaries(
  targets: readonly VendorTarget[],
  version = sqliteVecVersion(),
): Promise<Map<VendorTarget, string>> {
  const out = new Map<VendorTarget, string>();
  for (const t of targets) {
    out.set(t, await ensureVecBinary(t, version));
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI: `tsx script/vendor-sqlite-vec.ts [--platforms a,b,c]`
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
  const version = sqliteVecVersion();
  console.log(`→ vendor sqlite-vec ${version}: ${targets.join(", ")}`);
  for (const t of targets) {
    const p = await ensureVecBinary(t, version);
    console.log(`✓ ${t}: ${p}`);
  }
}

// Run only when invoked directly (not when imported by build-binary-sea.ts).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
