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
import { emitCliError, UsageError } from "./lib/errors";

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
    const json = userArgv.includes("--json");
    const stderrWrites: Array<[unknown, unknown[]]> = [];
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
        // Stricli 1.2.8's actual scanner-error wordings (verified in
        // node_modules/.pnpm/@stricli+core@1.2.8/dist/index.cjs lines
        // 312–507, 1134–1135):
        //   FlagNotFoundError:        "No flag registered for --X"
        //   UnsatisfiedFlagError:      "Expected input for flag --X"
        //   UnsatisfiedFlagError:      "...but encountered --Y instead"
        //   UnexpectedPositionalError: "Too many arguments, expected N but encountered \"X\""
        //   UnsatisfiedPositionalError:"Expected at least N argument(s) for X"
        //   AliasNotFoundError:        "No alias registered for -X"
        //   ParsedParameterError:      "Failed to parse --X: ..."
        // We match stable fragments because full wording wraps user input.
        /No (flag|alias) registered for/i.test(text) ||
        /expected (at most|.*but encountered)/i.test(text) ||
        /expected (input for (flag|argument)|.*argument(s)? for )/i.test(
          text,
        ) ||
        /failed to parse/i.test(text)
      ) {
        scannerErrorDetected = true;
      }
      if (json) {
        stderrWrites.push([chunk, args]);
        return true;
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
      (json ||
        // Only remap when process.exitCode is still the Stricli default
        // (-4, InvalidArgument). The `determineExitCode` callback in
        // app.ts may have already remapped this to 2 (UsageError); in
        // that case leave it alone (Seer finding on PR #1561).
        process.exitCode === -4 ||
        process.exitCode === undefined)
    ) {
      if (json) {
        emitCliError(
          new UsageError({ message: "Invalid command arguments." }),
          buildContext(process),
          true,
        );
      } else {
        // Stricli's scanner error path sets process.exitCode = -4
        // (InvalidArgument). Node would truncate to 252 on exit.
        // We remap to 20 (UsageError) for our exit-code convention.
        process.exitCode = 20;
      }
    } else if (json) {
      for (const [chunk, args] of stderrWrites) {
        priorStderrWrite(
          chunk as Parameters<typeof process.stderr.write>[0],
          ...(args as []),
        );
      }
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
