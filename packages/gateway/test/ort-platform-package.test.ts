import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
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
  test("covers the 5 onnxruntime-node platforms, no dupes", () => {
    expect(ORT_NPM_PLATFORMS.map((p) => p.target).sort()).toEqual([
      "darwin-arm64",
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
    expect(linux.files).not.toContain("libonnxruntime.so.1.27.0");
  });

  test("darwin keeps the install-name dylib and drops the versioned duplicate; win32 ships both DLLs", () => {
    const darwin = built.find((b) => b.target === "darwin-arm64")!;
    // Keep the addon's `@rpath` install-name; drop the identical longer-versioned copy.
    expect(darwin.files).toContain("libonnxruntime.1.dylib");
    expect(darwin.files).not.toContain("libonnxruntime.1.27.0.dylib");
    const win = built.find((b) => b.target === "win32-x64")!;
    expect(win.files).toContain("onnxruntime.dll");
    expect(win.files).toContain("DirectML.dll");
  });
});

test.skipIf(process.platform !== "linux")(
  "semantic lint prepares a private native package discoverable by a fresh worker",
  () => {
    const root = resolve(import.meta.dirname, "../../..");
    const workflow = readFileSync(
      join(root, ".github/workflows/semantic-linter.yml"),
      "utf8",
    );
    const preparation = workflow.match(
      /      - name: Prepare native embedding runtime\n        shell: bash\n        run: \|\n((?:          [^\n]*\n|\n)+)/,
    );
    if (!preparation) {
      throw new Error("The trusted workflow must prepare native embeddings");
    }
    const script = preparation[1]
      .split("\n")
      .map((line) => line.slice(10))
      .join("\n");
    const directory = mkdtempSync(join(tmpdir(), "lore-semantic-native-test-"));
    try {
      const exported = join(directory, "github-env");
      // Do not give the packaging subprocess provider credentials or inherited
      // Node module overrides; this must work with the locked source install.
      const env = {
        PATH: [dirname(process.execPath), process.env.PATH]
          .filter(Boolean)
          .join(delimiter),
        HOME: directory,
        RUNNER_TEMP: directory,
        GITHUB_ENV: exported,
        NODE_ENV: "test",
        SENTRY_ENABLED: "0",
      };
      const staged = spawnSync("bash", ["-euo", "pipefail", "-c", script], {
        cwd: root,
        env,
        timeout: 60_000,
      });
      expect(staged.status, "native preparation must succeed").toBe(0);
      const assignment = readFileSync(exported, "utf8").trim();
      expect(assignment).toMatch(/^NODE_PATH=[^\r\n]+$/);
      const modulePath = assignment.slice("NODE_PATH=".length);
      expect(modulePath.startsWith(`${directory}/`)).toBe(true);
      expect(statSync(dirname(modulePath)).mode & 0o777).toBe(0o700);
      const workerProgram = `
        const { createRequire } = require("node:module");
        const load = createRequire(${JSON.stringify(join(directory, "worker.cjs"))});
        const addon = load.resolve(${JSON.stringify(`${ortPackageName(ortPlatformTarget())}/${ORT_PACKAGE_BINDING_SUBPATH}`)});
        if (!addon.startsWith(${JSON.stringify(`${modulePath}/`)})) process.exit(1);
        if (typeof load(addon).listSupportedBackends !== "function") process.exit(1);
      `;
      const worker = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
            import { Worker } from "node:worker_threads";
            const worker = new Worker(${JSON.stringify(workerProgram)}, {
              eval: true, execArgv: [], stdout: true, stderr: true,
            });
            worker.stdout.resume();
            worker.stderr.resume();
            worker.once("error", () => { process.exitCode = 1; });
            worker.once("exit", (code) => { if (code !== 0) process.exitCode = 1; });
          `,
        ],
        {
          cwd: root,
          env: { ...env, NODE_PATH: modulePath },
          timeout: 15_000,
        },
      );
      expect(
        worker.status,
        "a fresh worker must load the staged native addon",
      ).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
