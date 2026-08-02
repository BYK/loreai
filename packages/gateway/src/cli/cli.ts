/**
 * Stricli orchestration layer — routes between the Stricli app and the
 * legacy dispatcher.
 *
 * Phase 1 behavior:
 *  - `lore help`, `lore --help`, `lore help --json` → Stricli app.
 *  - `lore version`, `lore --version` → Stricli app.
 *  - Every other invocation → legacy `_cli()` dispatcher.
 */
import { run } from "@stricli/core";
import { app } from "./app";
import { preprocessArgv } from "./lib/argv";
import { buildContext } from "./context";

/**
 * Top-level entry point used by `bin.ts`.
 *
 * Stricli's `run` reads `process.argv` for the user-supplied slice. When
 * routing to legacy we replace `process.argv` with the preprocessor's
 * rewritten slice so `_cli()` sees the same input it would have computed
 * on its own.
 */
export async function runCli(): Promise<void> {
  const userArgv = process.argv.slice(2);
  const result = preprocessArgv(userArgv);

  if (result.useStricli) {
    await run(app, userArgv, {
      process,
      // forCommand hook builds a `LoreCommandContext` from the global
      // process snapshot. Used to populate the handler's `this`.
      forCommand: () => buildContext(process),
    });
    return;
  }

  // Legacy path.
  const priorArgv = process.argv;
  process.argv = ["node", "lore", ...result.legacyArgv];
  try {
    const mod = await import("./main");
    await mod._cli();
  } finally {
    process.argv = priorArgv;
  }
}
