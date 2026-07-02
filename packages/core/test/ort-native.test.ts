import { describe, expect, test } from "vitest";
import {
  ORT_NATIVE_BINDING_FILE,
  ortNativePackageName,
  ortPlatformTarget,
  resolveNativeOrtBindingPath,
} from "../src/ort-native";

// These derivations MUST match the per-platform packages published by
// packages/gateway/script/ort-platform-package.ts (asserted there too). The
// literal `@loreai/onnxruntime-<os>-<arch>` shape is the contract binding the
// build-time package names to this runtime require.resolve key.

describe("ort-native runtime resolution", () => {
  test("ortPlatformTarget = <platform>-<arch>; win32 is NOT translated", () => {
    expect(ortPlatformTarget("linux", "x64")).toBe("linux-x64");
    expect(ortPlatformTarget("linux", "arm64")).toBe("linux-arm64");
    expect(ortPlatformTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(ortPlatformTarget("darwin", "x64")).toBe("darwin-x64");
    expect(ortPlatformTarget("win32", "x64")).toBe("win32-x64");
    expect(ortPlatformTarget("win32", "arm64")).toBe("win32-arm64");
  });

  test("package name is the published @loreai/onnxruntime-<target> shape", () => {
    expect(ortNativePackageName("linux-x64")).toBe(
      "@loreai/onnxruntime-linux-x64",
    );
    expect(ortNativePackageName("win32-arm64")).toBe(
      "@loreai/onnxruntime-win32-arm64",
    );
  });

  test("ortNativePackageName() defaults to the running platform's target", () => {
    expect(ortNativePackageName()).toBe(
      `@loreai/onnxruntime-${ortPlatformTarget()}`,
    );
  });

  test("binding file is the addon the shim/loader points at", () => {
    expect(ORT_NATIVE_BINDING_FILE).toBe("onnxruntime_binding.node");
  });

  test("resolveNativeOrtBindingPath returns null (never throws) when the package is absent", () => {
    // No @loreai/onnxruntime-* is installed above this isolated base path, so
    // resolution must fail SOFTLY → null (the dist-only WASM-fallback signal).
    expect(
      resolveNativeOrtBindingPath("/nonexistent/lore-test/x.js"),
    ).toBeNull();
  });
});
