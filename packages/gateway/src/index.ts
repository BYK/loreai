/**
 * Lore Gateway — package entry point.
 *
 * Library exports for programmatic use, plus `_cli()` for the CLI binary.
 *
 * Library usage:
 *   import { startServer, loadConfig } from "@loreai/gateway";
 *
 * CLI usage (via bin wrapper):
 *   lore start
 *   lore run claude
 */
import "../instrument";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Library API
// ---------------------------------------------------------------------------

export { loadConfig, DEFAULT_PORTS, DEFAULT_PORT } from "./config";
export type { GatewayConfig } from "./config";
export { startServer } from "./server";
export { handleRequest, resetPipelineState } from "./pipeline";
export { readPortFile } from "./portfile";
export { startGateway, probeGateway } from "./cli/start";
export type { GatewayHandle, StartOptions } from "./cli/start";

// ---------------------------------------------------------------------------
// CLI entry — called by dist/bin.cjs or `bun run src/index.ts`
// ---------------------------------------------------------------------------

export { _cli } from "./cli/main";

// ---------------------------------------------------------------------------
// Direct execution — `bun run src/index.ts` (or tsx) still works as before
// ---------------------------------------------------------------------------

// Direct execution detection: only auto-start when this module is the entry
// point. Under the esbuild CJS bundle, `import.meta.url` is replaced with
// `""` so the IIFE returns false — the block becomes dead code (the bin.cjs
// wrapper handles entry). Under tsx/bun ESM, the check works correctly.
const isMainModule = (() => {
  if (!import.meta.url) return false;
  try {
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMainModule) {
  // Direct execution (e.g. `bun run src/index.ts` from the OpenCode plugin)
  // defaults to `start` (no agent auto-launch), not `run` — there's no TTY
  // and no reason to auto-detect agents when launched as an embedded server.
  import("./cli/start").then(({ commandStart }) =>
    commandStart({ quiet: true }),
  );
}
