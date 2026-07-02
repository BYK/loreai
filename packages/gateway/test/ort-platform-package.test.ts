import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  buildOrtPlatformPackages,
  ORT_NPM_PLATFORMS,
  ORT_PACKAGE_BINDING_SUBPATH,
  ortPackageName,
  ortPlatformTarget,
} from "../script/ort-platform-package";

// The per-platform ORT packages are found at runtime via
//   require.resolve(`${ortPackageName(ortPlatformTarget())}/${ORT_PACKAGE_BINDING_SUBPATH}`)
// so the (process.platform, process.arch) → package-name derivation MUST match
// the names/os/cpu the generator publishes, or a platform silently loses native
// embeddings (resolve throws → WASM fallback). This binds both sides.

describe("ORT_NPM_PLATFORMS ⇄ runtime resolution key", () => {
  test("covers the 6 onnxruntime-node platforms, no dupes", () => {
    expect(ORT_NPM_PLATFORMS.map((p) => p.target).sort()).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "win32-arm64",
      "win32-x64",
    ]);
  });

  test("target === <os>-<cpu> === runtime key from those os/cpu", () => {
    for (const p of ORT_NPM_PLATFORMS) {
      // package identity: target is exactly os-cpu (npm os/cpu == process values)
      expect(p.target).toBe(`${p.os}-${p.cpu}`);
      // a process on this platform derives the same target → same package name
      expect(ortPlatformTarget(p.os, p.cpu)).toBe(p.target);
    }
  });

  test("package name mirrors @esbuild/<os>-<arch> shape", () => {
    expect(ortPackageName("linux-x64")).toBe("@loreai/onnxruntime-linux-x64");
    expect(ortPackageName("win32-arm64")).toBe(
      "@loreai/onnxruntime-win32-arm64",
    );
  });

  test("subdir is the onnxruntime-node bin layout (win32 stays win32)", () => {
    const byTarget = Object.fromEntries(
      ORT_NPM_PLATFORMS.map((p) => [p.target, p.subdir]),
    );
    expect(byTarget["linux-x64"]).toBe("linux/x64");
    expect(byTarget["win32-x64"]).toBe("win32/x64");
    expect(byTarget["darwin-arm64"]).toBe("darwin/arm64");
  });
});

describe("buildOrtPlatformPackages (real onnxruntime-node)", () => {
  const out = mkdtempSync(join(tmpdir(), "ort-pkgs-"));
  const built = buildOrtPlatformPackages(out, "9.9.9");
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  test("emits one package per platform with the addon present", () => {
    expect(built).toHaveLength(ORT_NPM_PLATFORMS.length);
    for (const b of built) {
      expect(b.files).toContain(ORT_PACKAGE_BINDING_SUBPATH);
      // the addon file physically exists at the resolve subpath
      expect(existsSync(join(b.dir, ORT_PACKAGE_BINDING_SUBPATH))).toBe(true);
    }
  });

  test("package.json: name/version/os/cpu/preferUnplugged, no exports", () => {
    for (const p of ORT_NPM_PLATFORMS) {
      const dir = join(out, `onnxruntime-${p.target}`);
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      expect(pkg.name).toBe(ortPackageName(p.target));
      expect(pkg.version).toBe("9.9.9");
      expect(pkg.os).toEqual([p.os]);
      expect(pkg.cpu).toEqual([p.cpu]);
      expect(pkg.preferUnplugged).toBe(true);
      // no "exports" — the runtime deep-imports the .node file via require.resolve
      expect(pkg.exports).toBeUndefined();
      // every declared file exists on disk
      for (const f of pkg.files) expect(existsSync(join(dir, f))).toBe(true);
    }
  });

  test("alias-drop keeps the linux SONAME, drops the versioned duplicate", () => {
    const linux = built.find((b) => b.target === "linux-x64")!;
    expect(linux.files).toContain("libonnxruntime.so.1");
    expect(linux.files).not.toContain("libonnxruntime.so.1.21.0");
  });

  test("darwin keeps its versioned dylib; win32 ships both DLLs", () => {
    const darwin = built.find((b) => b.target === "darwin-arm64")!;
    expect(
      darwin.files.some((f) => /^libonnxruntime\..*\.dylib$/.test(f)),
    ).toBe(true);
    const win = built.find((b) => b.target === "win32-x64")!;
    expect(win.files).toContain("onnxruntime.dll");
    expect(win.files).toContain("DirectML.dll");
  });
});
