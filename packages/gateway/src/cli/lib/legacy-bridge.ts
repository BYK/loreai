/**
 * Bridge between Stricli's typed command surface and the legacy
 * `commandX(args, values)` shape.
 *
 * The legacy CLI commands read from `process.argv`, accept
 * `(_positionals: string[], values: Record<string, unknown>)`, and
 * print via `console.log` / `console.error` / `process.exit` directly.
 * `runLegacyAndCollect` is the single seam that bridges those
 * mutations into the typed pipeline:
 *
 *   - replaces `console.log`/`console.error` with push-to-array shims
 *     (mirroring Node's trailing-newline behavior so multi-call output
 *     joins correctly — Seer findings #6 and #7)
 *   - replaces `process.exit` with a throwing shim that surfaces as a
 *     __legacy_exit:<code> sentinel (Seer finding — process.exit can
 *     otherwise kill the test runner mid-flight)
 *   - restores all three originals in a finally block
 *   - returns the captured output as a single string plus the
 *     exit-code stamp; the typed wrapper translates that into a
 *     typed `CommandOutput<T>` envelope.
 *
 * Used by `commands/log.ts`, `commands/stop.ts`, and `commands/lint.ts`.
 * When a fourth caller lands, consider promoting to a typed
 * `LegacyBridgeOptions` shape with positional/values injection.
 */
export interface LegacyRunResult {
  /** Captured stdout + stderr joined exactly as the legacy handler emitted it. */
  captured: string;
  /**
   * The exit code the legacy handler wanted. `0` if it returned
   * normally, `1` if it called `process.exit(1)`, etc.
   */
  exitCode: number;
}

export async function runLegacyAndCollect(
  call: () => Promise<void> | void,
): Promise<LegacyRunResult> {
  const captured: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  const realExit = process.exit;
  const priorExitCode = process.exitCode;
  process.exitCode = 0;
  console.log = (...args: unknown[]) => {
    if (args.length === 0) {
      captured.push("\n");
      return;
    }
    for (const a of args) captured.push(typeof a === "string" ? a : String(a));
    captured.push("\n");
  };
  console.error = (...args: unknown[]) => {
    if (args.length === 0) {
      captured.push("\n");
      return;
    }
    for (const a of args) captured.push(typeof a === "string" ? a : String(a));
    captured.push("\n");
  };
  process.exit = (code?: number): never => {
    throw new Error(`__legacy_exit:${code ?? "undefined"}`);
  };
  let thrown: unknown;
  try {
    await call();
  } catch (err) {
    thrown = err;
  } finally {
    console.log = realLog;
    console.error = realError;
    process.exit = realExit;
  }
  const exitCode = process.exitCode ?? 0;
  process.exitCode = priorExitCode;
  if (thrown instanceof Error && /__legacy_exit:/.test(thrown.message)) {
    return { exitCode: 1, captured: captured.join("") };
  }
  if (thrown) throw thrown;
  return { exitCode, captured: captured.join("") };
}
