// @loreai/sqlite-vec-vendored
//
// A drop-in replacement for the `sqlite-vec` npm package that ships our own
// prebuilt loadable extensions built from sqlite-vec 0.1.10-alpha.4 source with
// DiskANN + rescore enabled (see SOURCE.md). The upstream npm releases compile
// only the brute-force path; DiskANN/rescore require building from source, so
// we vendor the binaries here instead of pulling platform optionalDependencies.
//
// The public surface mirrors `sqlite-vec`'s `getLoadablePath()` so consumers
// (core/db/vec.ts) can swap the import with no other change. We additionally
// expose per-target resolution for the SEA binary packer (gateway), which must
// embed every platform's extension, not just the host's.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Platforms we ship a prebuilt extension for. */
export type VecTarget =
  | "linux-x64"
  | "linux-arm64"
  | "darwin-arm64"
  | "windows-x64";

export const VEC_TARGETS: readonly VecTarget[] = [
  "linux-x64",
  "linux-arm64",
  "darwin-arm64",
  "windows-x64",
] as const;

/** Loadable-extension file suffix per target. */
const TARGET_EXT: Record<VecTarget, "so" | "dylib" | "dll"> = {
  "linux-x64": "so",
  "linux-arm64": "so",
  "darwin-arm64": "dylib",
  "windows-x64": "dll",
};

// Resolve the package root from this module's location. This file lives at
// either <root>/src/index.ts (dev/test, via the workspace vitest alias) or
// <root>/dist/index.js (published) — both are exactly one directory below the
// package root, so the prebuilt/ lookup is identical in both layouts. Keeping
// this package EXTERNAL in consumer bundles (core esbuild, gateway bundle) is
// what makes `import.meta.url` point at the installed package rather than the
// consumer's dist — see SOURCE.md.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The `vec0.<ext>` filename for a target. */
export function vecFileName(target: VecTarget): string {
  return `vec0.${TARGET_EXT[target]}`;
}

/**
 * Absolute path to the prebuilt extension for an ARBITRARY target. Does not
 * check existence — the SEA packer (gateway/script/vendor-sqlite-vec.ts) needs
 * every target's path and verifies presence itself so a missing binary fails
 * the build loudly.
 */
export function getLoadablePathForTarget(target: VecTarget): string {
  return join(packageRoot, "prebuilt", target, vecFileName(target));
}

/** The current process's target, or undefined on an unsupported platform/arch. */
export function currentTarget(): VecTarget | undefined {
  const arch =
    process.arch === "x64"
      ? "x64"
      : process.arch === "arm64"
        ? "arm64"
        : undefined;
  if (!arch) return undefined;
  const os =
    process.platform === "linux"
      ? "linux"
      : process.platform === "darwin"
        ? "darwin"
        : process.platform === "win32"
          ? "windows"
          : undefined;
  if (!os) return undefined;
  const target = `${os}-${arch}` as VecTarget;
  return VEC_TARGETS.includes(target) ? target : undefined;
}

/**
 * Drop-in replacement for `sqlite-vec`'s `getLoadablePath()`: the absolute path
 * to the current platform's vec0 extension, or `undefined` when the platform is
 * unsupported or the binary is missing. Callers (core/db/vec.ts) treat
 * `undefined` as "no native extension" and fall back to JS brute-force search.
 */
export function getLoadablePath(): string | undefined {
  const target = currentTarget();
  if (!target) return undefined;
  const path = getLoadablePathForTarget(target);
  return existsSync(path) ? path : undefined;
}
