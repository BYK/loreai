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
   * normally, the actual code passed to `process.exit(N)` if it called
   * it (parsed from the `__legacy_exit:<code>` sentinel), or the value
   * the legacy handler stamped on `process.exitCode` before returning.
   */
  exitCode: number;
}

export async function runLegacyAndCollect(
  call: () => Promise<void> | void,
): Promise<LegacyRunResult> {
  const captured: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  const realStdoutWrite = process.stdout.write.bind(process.stdout);
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
  // Capture process.stdout.write too — `readline/promises` writes
  // interactive prompts directly via process.stdout.write (not via
  // console.log), so without this shim, login flows would leak prompt
  // text into the JSON envelope when `--json` is active (Seer finding
  // on PR #1559). We tee each write through to the original stdout
  // ONLY when stdin is a TTY (interactive session) so the user actually
  // sees the prompt and can answer it. For non-interactive sessions
  // (CI, `--json`, `makeSyncProgress` progress bars) we capture-only
  // to avoid double-output — `emitOutput` will write the captured text
  // once on stdout (Seer finding on PR #1561).
  const shouldTee = Boolean(process.stdin.isTTY);
  process.stdout.write = (chunk: unknown): boolean => {
    const text =
      typeof chunk === "string"
        ? chunk
        : Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : String(chunk);
    captured.push(text);
    if (shouldTee) {
      realStdoutWrite(chunk as Parameters<typeof process.stdout.write>[0]);
    }
    return true;
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
    process.stdout.write = realStdoutWrite;
    process.exit = realExit;
  }
  const exitCode = process.exitCode ?? 0;
  process.exitCode = priorExitCode;
  if (thrown instanceof Error) {
    // Parse the exit code the legacy handler asked for. The shim
    // emits `__legacy_exit:<code>` (or `__legacy_exit:undefined` if
    // no code was passed to process.exit). Anything not parseable as
    // a finite number falls back to 1 (the default Node behavior when
    // a handler exits without specifying a code).
    const sentinelMatch = thrown.message.match(/^__legacy_exit:(.+)$/);
    if (sentinelMatch) {
      const parsed = Number(sentinelMatch[1]);
      const code = Number.isFinite(parsed) ? parsed : 1;
      return { exitCode: code, captured: captured.join("") };
    }
  }
  if (thrown) throw thrown;
  return { exitCode, captured: captured.join("") };
}
