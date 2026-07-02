/**
 * Release packaging for the per-platform native ONNX Runtime packages
 * (`@loreai/onnxruntime-<os>-<arch>`) + wiring them into the gateway tarball as
 * `optionalDependencies`. Run by CI's "Pack tarballs" step on release branches,
 * AFTER the workspace tarballs are packed. See ort-platform-package.ts (the
 * esbuild-style per-platform model) and ort-npm-plugin.ts (the runtime that
 * prefers them over WASM).
 *
 * Steps, all at the release version (CRAFT_NEW_VERSION):
 *   1. Generate the 6 platform packages and `npm pack` each into the tarball dir
 *      → `loreai-onnxruntime-<target>-<version>.tgz` (Craft publishes them via a
 *      dedicated npm target keyed on that name).
 *   2. Inject `optionalDependencies` (the 6 packages, pinned EXACTLY to the
 *      release version) into the already-packed `loreai-gateway-<version>.tgz`
 *      by extract → edit package.json → repack. Done on the tarball — NOT the
 *      workspace package.json — so the repo + lockfile stay clean and
 *      release-branch `pnpm install --frozen-lockfile` keeps working. npm's
 *      os/cpu gating installs only the matching one; unresolved (dist-only)
 *      optionals are silently skipped → the bundle's WASM fallback (#763).
 *
 * Runs under Node (via tsx).
 */
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  ORT_NPM_PLATFORMS,
  buildOrtPlatformPackages,
  ortPackageName,
} from "./ort-platform-package";

function packPlatformPackages(tarballsDir: string, version: string): void {
  const staging = mkdtempSync(join(tmpdir(), "ort-npm-pack-"));
  try {
    const built = buildOrtPlatformPackages(staging, version);
    for (const b of built) {
      // `npm pack <dir>` names the tarball from package.json → loreai-<name>-<v>.tgz
      execFileSync("npm", ["pack", b.dir, "--pack-destination", tarballsDir], {
        stdio: "inherit",
      });
      console.log(`✓ packed ${b.packageName}@${version}`);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Add optionalDependencies (the 6 platform packages, pinned to `version`) to
 *  the packed gateway tarball's package.json, in place. */
function injectGatewayOptionalDeps(tarballsDir: string, version: string): void {
  const gatewayTarball = join(tarballsDir, `loreai-gateway-${version}.tgz`);
  const optionalDependencies = Object.fromEntries(
    ORT_NPM_PLATFORMS.map((p) => [ortPackageName(p.target), version]),
  );

  const work = mkdtempSync(join(tmpdir(), "gw-inject-"));
  try {
    execFileSync("tar", ["-xzf", gatewayTarball, "-C", work], {
      stdio: "inherit",
    });
    const pkgJsonPath = join(work, "package", "package.json");
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
      optionalDependencies?: Record<string, string>;
    };
    pkg.optionalDependencies = {
      ...(pkg.optionalDependencies ?? {}),
      ...optionalDependencies,
    };
    writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
    // Repack over the original. npm tarballs nest everything under `package/`.
    execFileSync("tar", ["-czf", gatewayTarball, "-C", work, "package"], {
      stdio: "inherit",
    });
    console.log(
      `✓ injected ${Object.keys(optionalDependencies).length} optionalDependencies into ${gatewayTarball}`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { version: { type: "string" }, tarballs: { type: "string" } },
    allowPositionals: false,
    strict: true,
  });
  const version = values.version ?? process.env.CRAFT_NEW_VERSION;
  const tarballsDir = values.tarballs;
  if (!version || !tarballsDir) {
    console.error(
      "Usage: pack-ort-npm.ts --version <x.y.z> --tarballs <dir>  " +
        "(version also read from CRAFT_NEW_VERSION)",
    );
    process.exit(1);
  }
  console.log(
    `→ pack ${ORT_NPM_PLATFORMS.length} @loreai/onnxruntime-* packages @ ${version} → ${tarballsDir}`,
  );
  packPlatformPackages(tarballsDir, version);
  injectGatewayOptionalDeps(tarballsDir, version);

  console.log("--- native-ORT tarballs: ---");
  for (const f of readdirSync(tarballsDir))
    if (f.startsWith("loreai-onnxruntime-")) console.log(`  ${f}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
