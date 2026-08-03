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
 *
 * Phase 3D.3b fix (F-1): Stricli's `determineExitCode` only fires for
 * thrown values from the command function, NOT for scanner errors
 * (unknown flag, extra positional). Scanner errors are hard-coded to
 * `ExitCode.InvalidArgument = -4` which Node truncates to 252 on
 * exit. We monitor stderr writes to detect scanner errors and remap
 * the exit code to 20 (UsageError) after `run()` returns.
 */
export async function runCli(): Promise<void> {
  const userArgv = process.argv.slice(2);
  const result = preprocessArgv(userArgv);

  if (result.useStricli) {
    const priorStderrWrite = process.stderr.write.bind(process.stderr);
    let scannerErrorDetected = false;
    process.stderr.write = (chunk: unknown, ...args: unknown[]) => {
      // Stricli's scanner-error path writes to stderr via
      // formatException -> formatMessageForArgumentScannerError.
      // Catch the message text as a signal that a scanner error
      // happened (rather than reaching for Stricli internals).
      const text =
        typeof chunk === "string"
          ? chunk
          : Buffer.isBuffer(chunk)
            ? chunk.toString("utf8")
            : String(chunk);
      if (
        /expected (at most|.*but encountered)/i.test(text) ||
        /No flag registered for --/.test(text) ||
        /Unknown (flag|positional|argument)/i.test(text)
      ) {
        scannerErrorDetected = true;
      }
      return priorStderrWrite(
        chunk as Parameters<typeof process.stderr.write>[0],
        ...(args as []),
      );
    };
    try {
      await run(app, userArgv, {
        process,
        // forCommand hook builds a `LoreCommandContext` from the global
        // process snapshot. Used to populate the handler's `this`.
        forCommand: () => buildContext(process),
      });
    } finally {
      process.stderr.write = priorStderrWrite;
    }
    if (
      scannerErrorDetected &&
      // Only remap when process.exitCode is still the Stricli default
      // (-4, InvalidArgument). The `determineExitCode` callback in
      // app.ts may have already remapped this to 2 (UsageError); in
      // that case leave it alone (Seer finding on PR #1561).
      (process.exitCode === -4 || process.exitCode === undefined)
    ) {
      // Stricli's scanner error path sets process.exitCode = -4
      // (InvalidArgument). Node would truncate to 252 on exit.
      // We remap to 20 (UsageError) for our exit-code convention.
      process.exitCode = 20;
    }
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
