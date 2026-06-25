/**
 * Build @loreai/gateway.
 *
 * Two build modes:
 *
 *   1. `tsx script/build.ts` (default; via `pnpm run build`)
 *      Produces dist/index.js — publishable ESM bundle for npm.
 *      @loreai/core is external (workspace dep, installed alongside).
 *
 *   2. `tsx script/build.ts --binary` (via `pnpm run build:binary`)
 *      Delegates to `script/build-binary-sea.ts` which produces a
 *      standalone Node SEA binary via fossilize. The legacy Bun
 *      `--compile` pipeline was removed in #551 in favor of Node SEA
 *      because Bun's WASM engine has unfixed bugs that cause ONNX
 *      embedding OOM on all platforms (oven-sh/bun#18145, #25677, #31158).
 *
 * Lore's build pipeline runs entirely under Node (via tsx) — it never
 * requires the Bun runtime. (The `bun` export condition / dist/index.bun.js
 * artifact still exists for the @loreai/opencode plugin, which runs under
 * Bun; it is produced by esbuild here, not by Bun.)
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
  // the "bun" export condition without running the full `pnpm run bundle`.
  // Real bundle builds (bundle.ts) wipe dist/ first, so these shims
  // never interfere with production artifacts.
  mkdirSync(distDir, { recursive: true });

  const shims: Array<[string, string]> = [
    // The "bun" export condition (./dist/index.bun.js) is what the
    // @loreai/opencode plugin loads when it starts the gateway in-process
    // under Bun. Point it at current source so a workspace/dev checkout can
    // never run a stale bundle: when source changes (e.g. a renamed export),
    // the in-process gateway picks it up immediately instead of failing with
    // "Export named '…' not found". @loreai/core stays a separate workspace
    // module (bundle.ts keeps it external), so the plugin and gateway still
    // share a single core instance — see bundle.ts for why that matters.
    ["index.bun.js", 'export * from "../src/index.ts";\n'],
    [
      "embedding-worker.js",
      'export * from "../../core/src/embedding-worker.ts";\n',
    ],
    ["vector-worker.js", 'export * from "../../core/src/vector-worker.ts";\n'],
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
    "✓ @loreai/gateway: dev shims ready (use `pnpm run bundle` for npm build)",
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

  // Run the SEA build script under Node (via tsx) — Lore's build pipeline
  // never requires the Bun runtime. tsx is resolved from node_modules so this
  // works regardless of cwd / PATH.
  const { spawnSync } = await import("node:child_process");
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const tsxCli = require.resolve("tsx/cli");
  const result = spawnSync(
    process.execPath,
    [tsxCli, join(here, "build-binary-sea.ts"), ...args],
    {
      cwd: packageDir,
      stdio: "inherit",
    },
  );
  process.exit(result.status ?? 1);
} else {
  await buildLibrary();
}
