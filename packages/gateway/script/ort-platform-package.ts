/**
 * Generate per-platform npm packages that carry the native `onnxruntime-node`
 * addon + its shared libraries — the esbuild distribution model (see
 * `@esbuild/<os>-<arch>`), replicated for ONNX Runtime.
 *
 * WHY: the `@loreai/gateway` npm bundle ships a self-contained WASM ONNX runtime
 * so that dist-only installs (AUR, vendored `dist/`) work with zero
 * `node_modules` (#763). But WASM is single-threaded and 2.7–4.1× slower than
 * native (#999), and every normal `npm i` / plugin install DOES have a
 * `node_modules`. We can't just depend on `onnxruntime-node` directly: its
 * native binary arrives via a **postinstall download** from GitHub releases,
 * which npm 12 will stop running automatically and which fails in offline / air-
 * gapped / proxied installs.
 *
 * esbuild's answer — which we copy — is per-platform packages gated by npm's
 * `os`/`cpu` fields and resolved at runtime with plain `require.resolve`:
 *   - `@loreai/onnxruntime-<os>-<arch>` holds only that platform's ORT files.
 *   - `os`/`cpu` make npm install ONLY the matching one (and, as an
 *     optionalDependency, silently skip it when it can't — e.g. dist-only).
 *   - `preferUnplugged: true` keeps the addon a real on-disk file under Yarn PnP.
 *   - There is **no install script** — the addon is found at runtime via
 *     `require.resolve("@loreai/onnxruntime-<target>/onnxruntime_binding.node")`
 *     (see the runtime resolver), so this is fully npm-12-safe.
 * When no platform package resolves (dist-only), the gateway falls back to its
 * bundled WASM runtime — analogous to esbuild's `esbuild-wasm` fallback.
 *
 * Runs under Node (via tsx). Importing this module has no side effects.
 */
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  ORT_BINDING_FILE,
  collectOrtFiles,
  ortNodeVersion,
} from "./vendor-ort-native";

/** A native-ORT npm target, keyed by `<process.platform>-<process.arch>` so the
 *  runtime resolver can build the package name with no OS-name translation
 *  (unlike the SEA's VendorTarget, which uses "windows"). */
export interface OrtNpmPlatform {
  /** `${process.platform}-${process.arch}`, e.g. "linux-x64", "win32-arm64". */
  target: string;
  /** onnxruntime-node `bin/napi-v3` subdir, e.g. "linux/x64". */
  subdir: string;
  /** npm `os` field value (== process.platform). */
  os: string;
  /** npm `cpu` field value (== process.arch). */
  cpu: string;
}

/** The platforms onnxruntime-node@1.21 ships prebuilt binaries for. */
export const ORT_NPM_PLATFORMS: readonly OrtNpmPlatform[] = [
  { target: "linux-x64", subdir: "linux/x64", os: "linux", cpu: "x64" },
  { target: "linux-arm64", subdir: "linux/arm64", os: "linux", cpu: "arm64" },
  { target: "darwin-x64", subdir: "darwin/x64", os: "darwin", cpu: "x64" },
  {
    target: "darwin-arm64",
    subdir: "darwin/arm64",
    os: "darwin",
    cpu: "arm64",
  },
  { target: "win32-x64", subdir: "win32/x64", os: "win32", cpu: "x64" },
  { target: "win32-arm64", subdir: "win32/arm64", os: "win32", cpu: "arm64" },
] as const;

/** The scoped npm package name for a target, e.g. `@loreai/onnxruntime-linux-x64`. */
export function ortPackageName(target: string): string {
  return `@loreai/onnxruntime-${target}`;
}

/** The subpath within a platform package that resolves to the native addon —
 *  what the runtime resolver passes to `require.resolve` and what the patched
 *  onnxruntime-node binding.js ultimately loads. The addon's shared-library
 *  siblings live in the same dir (package root), so $ORIGIN / @loader_path /
 *  Windows DLL-search resolve them by construction. */
export const ORT_PACKAGE_BINDING_SUBPATH = ORT_BINDING_FILE;

/** Compute the platform target for the *running* process. Kept here (next to
 *  ORT_NPM_PLATFORMS) so the build-time package names and the runtime
 *  `require.resolve` key can never drift. */
export function ortPlatformTarget(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  return `${platform}-${arch}`;
}

export interface BuiltOrtPackage {
  target: string;
  dir: string;
  packageName: string;
  files: string[];
}

/**
 * Materialize each platform's npm package under `outDir/onnxruntime-<target>/`:
 * a `package.json` (name/version/os/cpu/preferUnplugged/files) plus the native
 * files copied flat into the package root. `version` is normally the gateway's
 * version so the published packages stay version-locked with the
 * `optionalDependencies` that reference them.
 */
export function buildOrtPlatformPackages(
  outDir: string,
  version: string,
  platforms: readonly OrtNpmPlatform[] = ORT_NPM_PLATFORMS,
): BuiltOrtPackage[] {
  const built: BuiltOrtPackage[] = [];
  for (const platform of platforms) {
    const files = collectOrtFiles(platform.subdir);
    const packageName = ortPackageName(platform.target);
    const dir = join(outDir, `onnxruntime-${platform.target}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    for (const { file, srcPath } of files) {
      copyFileSync(srcPath, join(dir, file));
    }

    const fileNames = files.map((f) => f.file).sort();
    const pkg = {
      name: packageName,
      version,
      description: `Native ONNX Runtime (${platform.target}) for @loreai/gateway local embeddings. Auto-selected via os/cpu; not meant to be installed directly.`,
      license: "FSL-1.1-Apache-2.0",
      repository: {
        type: "git",
        url: "git+https://github.com/BYK/loreai.git",
        directory: "packages/gateway",
      },
      // os/cpu gate install to the matching platform only; as an
      // optionalDependency, npm silently skips the rest.
      os: [platform.os],
      cpu: [platform.cpu],
      // Keep the addon a real on-disk file under Yarn PnP (it's dlopen'd, and
      // its sibling libs must resolve next to it).
      preferUnplugged: true,
      // No "exports" field on purpose: the runtime resolver deep-imports the
      // addon file via require.resolve("<pkg>/onnxruntime_binding.node"), which
      // an "exports" map would block.
      files: fileNames,
      publishConfig: { access: "public" },
    };
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify(pkg, null, 2)}\n`,
    );
    writeFileSync(
      join(dir, "README.md"),
      `# ${packageName}\n\nThe ${platform.target} native ONNX Runtime for ` +
        `[\`@loreai/gateway\`](https://www.npmjs.com/package/@loreai/gateway) ` +
        `local embeddings.\n\nThis package is installed automatically (via ` +
        `\`optionalDependencies\` + \`os\`/\`cpu\`) on matching platforms and ` +
        `loaded at runtime. You should not depend on it directly.\n`,
    );

    built.push({ target: platform.target, dir, packageName, files: fileNames });
  }
  return built;
}

// ---------------------------------------------------------------------------
// CLI: `tsx script/ort-platform-package.ts --out <dir> [--version x.y.z]`
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      out: { type: "string" },
      version: { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  });
  if (!values.out) {
    console.error(
      "Usage: ort-platform-package.ts --out <dir> [--version x.y.z]",
    );
    process.exit(1);
  }
  // Default to the gateway's version so the packages stay version-locked with
  // the optionalDependencies that reference them (publishing passes it anyway).
  const gatewayPkg = JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
      "utf8",
    ),
  ) as { version: string };
  const version = values.version ?? gatewayPkg.version;
  console.log(
    `→ build ${ORT_NPM_PLATFORMS.length} @loreai/onnxruntime-* packages ` +
      `@ ${version} (onnxruntime-node ${ortNodeVersion()}) → ${values.out}`,
  );
  const built = buildOrtPlatformPackages(values.out, version);
  for (const b of built) {
    console.log(`✓ ${b.packageName}  [${b.files.join(", ")}]  → ${b.dir}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
