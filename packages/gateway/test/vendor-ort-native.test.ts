import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  ORT_BINDING_FILE,
  ortAssetKey,
  ortNativeAssets,
} from "../script/vendor-ort-native";
import { VENDOR_TARGETS, type VendorTarget } from "../script/vendor-paths";

// The SEA native-ORT path has THREE copies of the target→asset-key derivation
// that MUST agree, or a platform silently loses local embeddings (getRawAsset
// throws → FTS fallback) with no build-time error:
//   1. build-binary-sea.ts stages assets as `ort-<target>-<file>` (ortAssetKey)
//      and writes ort-manifest.json keyed by VendorTarget.
//   2. native-loader.cjs (runtime) derives `ortTarget` from process.platform/
//      arch and reads `ort-${ortTarget}-${f}` + `ortManifest[ortTarget]`.
//   3. This test pins both to the (platform, arch) → VendorTarget mapping.
// The Windows case is the trap: build target is "windows-x64" but
// process.platform is "win32", so the loader MUST map win32→windows.

/** The (process.platform, process.arch) each build target runs on. */
const RUNTIME_PLATFORM: Record<
  VendorTarget,
  { platform: string; arch: string }
> = {
  "darwin-arm64": { platform: "darwin", arch: "arm64" },
  "linux-arm64": { platform: "linux", arch: "arm64" },
  "linux-x64": { platform: "linux", arch: "x64" },
  "windows-x64": { platform: "win32", arch: "x64" },
};

/** EXACT replica of native-loader.cjs's runtime `ortTarget` derivation. If you
 *  change this, change native-loader.cjs (and vice versa) — the source-level
 *  assertions below guard that the loader still uses this shape. */
function runtimeTarget(platform: string, arch: string): string {
  return `${platform === "win32" ? "windows" : platform}-${arch}`;
}

const here = dirname(fileURLToPath(import.meta.url));
const loaderSrc = readFileSync(
  join(here, "..", "script", "native-loader.cjs"),
  "utf8",
);

describe("vendor-ort-native ⇄ native-loader key contract", () => {
  test("runtime (platform,arch) derivation reproduces the VendorTarget", () => {
    for (const target of VENDOR_TARGETS) {
      const { platform, arch } = RUNTIME_PLATFORM[target];
      expect(runtimeTarget(platform, arch)).toBe(target);
    }
  });

  test("windows maps win32→windows (the danger case)", () => {
    expect(runtimeTarget("win32", "x64")).toBe("windows-x64");
    // The asset key the loader computes on Windows must match the build's key.
    expect(`ort-${runtimeTarget("win32", "x64")}-${ORT_BINDING_FILE}`).toBe(
      ortAssetKey("windows-x64", ORT_BINDING_FILE),
    );
  });

  test("build asset key === loader-derived asset key for every target", () => {
    for (const target of VENDOR_TARGETS) {
      const { platform, arch } = RUNTIME_PLATFORM[target];
      const loaderKey = `ort-${runtimeTarget(platform, arch)}-${ORT_BINDING_FILE}`;
      expect(ortAssetKey(target, ORT_BINDING_FILE)).toBe(loaderKey);
    }
  });

  test("native-loader.cjs still uses the matching key shape + constants", () => {
    // Binds the loader text so a divergent edit on either side fails here.
    expect(loaderSrc).toContain('process.platform === "win32" ? "windows"');
    expect(loaderSrc).toContain("`ort-${ortTarget}-${f}`");
    expect(loaderSrc).toContain('"ort-manifest.json"');
    expect(loaderSrc).toContain('"onnxruntime_binding.node"');
    expect(loaderSrc).toContain("__LORE_ORT_BINDING_PATH__");
  });
});

describe("vendor-ort-native asset selection (real package)", () => {
  const assets = ortNativeAssets(VENDOR_TARGETS);

  test("every target includes the addon and keys match ortAssetKey", () => {
    for (const target of VENDOR_TARGETS) {
      const files = assets.get(target);
      expect(files, `${target} has staged files`).toBeTruthy();
      const names = files!.map((f) => f.file);
      expect(names).toContain(ORT_BINDING_FILE);
      for (const { file, assetKey } of files!) {
        expect(assetKey).toBe(ortAssetKey(target, file));
      }
    }
  });

  test("alias-drop keeps the linux SONAME and skips the versioned duplicate", () => {
    const linux = assets.get("linux-x64")!.map((f) => f.file);
    expect(linux).toContain("libonnxruntime.so.1");
    // The identical, longer-versioned alias must NOT be embedded twice.
    expect(linux).not.toContain("libonnxruntime.so.1.21.0");
  });

  test("darwin keeps its version-named dylib (no shorter alias to drop)", () => {
    const darwin = assets.get("darwin-arm64")!.map((f) => f.file);
    expect(darwin.some((f) => /^libonnxruntime\..*\.dylib$/.test(f))).toBe(
      true,
    );
  });
});
