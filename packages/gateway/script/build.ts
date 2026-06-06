/**
 * Build @loreai/gateway.
 *
 * Two build modes:
 *
 *   1. `bun run script/build.ts` (default)
 *      Produces dist/index.js — publishable ESM bundle for npm.
 *      @loreai/core is external (workspace dep, installed alongside).
 *
 *   2. `bun run script/build.ts --binary`
 *      Delegates to `script/build-binary-sea.ts` which produces a
 *      standalone Node SEA binary via fossilize. The legacy Bun
 *      `--compile` pipeline was removed in #551 in favor of Node SEA
 *      because Bun's WASM engine has unfixed bugs that cause ONNX
 *      embedding OOM on all platforms (oven-sh/bun#18145, #25677, #31158).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(here);
const distDir = join(packageDir, "dist");

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

const { values: flags } = parseArgs({
  args: process.argv.slice(2),
  options: {
    binary: { type: "boolean", default: false },
    release: { type: "boolean", default: false },
    platforms: { type: "string" },
    "no-vendor": { type: "boolean", default: false },
  },
  allowPositionals: false,
  strict: true,
});

// ---------------------------------------------------------------------------
// Library build (npm publish)
// ---------------------------------------------------------------------------

async function buildLibrary() {
  // Create lightweight dev shims so workspace consumers can resolve
  // the "bun" export condition without running the full `bun run bundle`.
  // Real bundle builds (bundle.ts) wipe dist/ first, so these shims
  // never interfere with production artifacts.
  mkdirSync(distDir, { recursive: true });

  const shims: Array<[string, string]> = [
    ["index.bun.js", 'export * from "../src/index.ts";\n'],
    [
      "embedding-worker.js",
      'export * from "../../core/src/embedding-worker.ts";\n',
    ],
  ];

  for (const [filename, content] of shims) {
    const filePath = join(distDir, filename);
    if (existsSync(filePath)) {
      // Don't overwrite real bundle output (minified, large files).
      const existing = readFileSync(filePath, "utf8");
      if (!existing.startsWith("export *")) {
        console.log(`  ${filename}: skipped (real bundle exists)`);
        continue;
      }
    }
    writeFileSync(filePath, content);
    console.log(`  ${filename}: dev shim created`);
  }

  console.log(
    "✓ @loreai/gateway: dev shims ready (use `bun run bundle` for npm build)",
  );
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

if (flags.binary) {
  // Delegate to the fossilize-based pipeline. Forward relevant flags.
  const args: string[] = [];
  if (flags.platforms) args.push("--platforms", flags.platforms);
  if (flags.release) args.push("--release");
  if (flags["no-vendor"]) args.push("--no-vendor");

  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(
    "bun",
    ["run", join(here, "build-binary-sea.ts"), ...args],
    {
      cwd: packageDir,
      stdio: "inherit",
    },
  );
  process.exit(result.status ?? 1);
} else {
  await buildLibrary();
}
