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
// point. CJS path uses __filename (always defined). ESM path uses
// import.meta.url via a dynamic expression that esbuild can't statically
// analyze, avoiding the "empty-import-meta" warning in CJS output.
const isMainModule = (() => {
  try {
    // CJS bundles and Node.js CJS: __filename is always defined.
    if (typeof __filename === "string") {
      return process.argv[1] === __filename;
    }
    // ESM (Bun, tsx): derive __filename from import.meta.url.
    // Dynamic property access prevents esbuild from warning about
    // import.meta usage in CJS output — this branch is unreachable
    // in CJS anyway since __filename is always defined there.
    const meta = import.meta as unknown as Record<string, unknown>;
    const url = meta.url;
    return typeof url === "string" && process.argv[1] === fileURLToPath(url);
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
