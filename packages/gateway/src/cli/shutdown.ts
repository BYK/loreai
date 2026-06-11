/**
 * Graceful-but-bounded process shutdown helpers.
 *
 * The gateway only exits via `safeExit()`, which is reached *after* the
 * `shutdown()` closure resolves. Several shutdown steps (batch-queue drain,
 * embedding-worker exit) can, in pathological cases, take a long time — which
 * is why Ctrl+C used to appear to "hang for minutes" with no way to break out.
 *
 * These helpers guarantee that:
 *   1. shutdown can never block the process longer than a hard deadline, and
 *   2. a *second* SIGINT/SIGTERM forces an immediate exit.
 */
import { safeExit } from "./exit";

const DEFAULT_SHUTDOWN_DEADLINE_MS = 4000;

/**
 * Hard cap on how long `shutdown()` may run before we force-exit. Override with
 * `LORE_SHUTDOWN_TIMEOUT_MS`. Invalid / non-positive / non-finite values fall
 * back to the default (mirrors the `LORE_MAX_RETRIES` parsing convention so a
 * typo can never *disable* the safety net).
 */
export const SHUTDOWN_DEADLINE_MS: number = (() => {
  const raw = process.env.LORE_SHUTDOWN_TIMEOUT_MS;
  if (!raw) return DEFAULT_SHUTDOWN_DEADLINE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SHUTDOWN_DEADLINE_MS;
  return n;
})();

const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGTERM: 15,
};

/** POSIX-conventional exit code for a signal death (128 + signal number). */
export function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + (SIGNAL_NUMBERS[signal] ?? 1);
}

/**
 * Run `shutdown()` but never block longer than `deadlineMs`. A shutdown error
 * is logged and swallowed (so the caller still proceeds to exit), and a timeout
 * resolves the race so the caller can force-exit. Always resolves — never
 * rejects.
 */
export async function runShutdownWithDeadline(
  shutdown: () => Promise<void>,
  deadlineMs: number = SHUTDOWN_DEADLINE_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.error(
        `[lore] Shutdown timed out after ${deadlineMs}ms — forcing exit.`,
      );
      resolve();
    }, deadlineMs);
    // Intentionally NOT unref'd: keep the event loop alive for the duration of
    // the (bounded) shutdown so the caller deterministically reaches
    // `safeExit()` with the right code — under Bun that uses the `_exit` FFI to
    // dodge a NAPI teardown crash. The timer is cleared the instant shutdown
    // resolves (see finally), so a fast shutdown still exits immediately.
  });
  try {
    await Promise.race([
      shutdown().catch((e) => {
        console.error("[lore] Error during shutdown:", e);
      }),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Install SIGINT/SIGTERM handlers for a command that *directly owns* teardown
 * (i.e. no child agent to forward to — `lore start`, `lore run` with no agent).
 *
 *   - First signal:  run `shutdown()` deadline-bounded, then exit.
 *   - Second signal: force an immediate exit (don't wait for the in-flight
 *     graceful shutdown). This is what makes repeated Ctrl+C responsive.
 */
export function installSignalShutdown(shutdown: () => Promise<void>): void {
  let count = 0;
  const handle = async (signal: NodeJS.Signals): Promise<void> => {
    count++;
    const code = signalExitCode(signal);
    if (count >= 2) {
      console.error("[lore] Received second interrupt — forcing exit.");
      safeExit(code);
    }
    await runShutdownWithDeadline(shutdown);
    safeExit(code);
  };
  process.on("SIGINT", () => void handle("SIGINT"));
  process.on("SIGTERM", () => void handle("SIGTERM"));
}
