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
import { forcedExit } from "./exit";

const DEFAULT_SHUTDOWN_DEADLINE_MS = 4000;

/**
 * Parse a shutdown-deadline value (ms). Invalid / non-positive / non-finite
 * values fall back to `fallback` — mirrors the `LORE_MAX_RETRIES` parsing
 * convention so a typo can never *disable* the safety net. Exported for tests.
 */
export function parseShutdownDeadline(
  raw: string | undefined,
  fallback: number = DEFAULT_SHUTDOWN_DEADLINE_MS,
): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/**
 * Hard cap (ms) on how long graceful shutdown may run before the gateway
 * force-exits, so Ctrl+C can never hang. Env: `LORE_SHUTDOWN_TIMEOUT_MS`
 * (default 4000). Invalid / non-positive / non-finite values fall back to the
 * default — the timeout can never be disabled.
 */
export const SHUTDOWN_DEADLINE_MS: number = parseShutdownDeadline(
  process.env.LORE_SHUTDOWN_TIMEOUT_MS,
);

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
 * Outcome of `runShutdownWithDeadline`. `timedOut` is true when the deadline
 * fired before `shutdown()` completed — callers MUST use `forcedExit` on that
 * path because the embedding worker may still be mid-inference in a native
 * call that `worker.terminate()` could not interrupt, and `safeExit` →
 * `process.exit()` would walk NAPI destructors under it → SIGABRT.
 */
export interface ShutdownResult {
  /** True if the deadline fired before shutdown() resolved. */
  timedOut: boolean;
}

/**
 * Run `shutdown()` but never block longer than `deadlineMs`. A shutdown error
 * is logged and swallowed (so the caller still proceeds to exit); a timeout
 * resolves the race and is reported via `timedOut: true` so the caller can
 * pick the right exit path. Always resolves — never rejects.
 */
export async function runShutdownWithDeadline(
  shutdown: () => Promise<void>,
  deadlineMs: number = SHUTDOWN_DEADLINE_MS,
): Promise<ShutdownResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      console.error(
        `[lore] Shutdown timed out after ${deadlineMs}ms — forcing exit.`,
      );
      resolve();
    }, deadlineMs);
    // Intentionally NOT unref'd: keep the event loop alive for the duration of
    // the (bounded) shutdown so the caller deterministically reaches
    // `safeExit()` with the right code. The timer is cleared the instant
    // shutdown resolves (see finally), so a fast shutdown still exits
    // immediately.
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
  return { timedOut };
}

/**
 * Build the SIGINT/SIGTERM handler for a command that *directly owns* teardown
 * (no child agent — `lore start`, `lore run` with no agent).
 *
 *   - First signal:  run `shutdown()` deadline-bounded, then exit.
 *   - Second signal: force an immediate exit (don't wait for the in-flight
 *     graceful shutdown). This is what makes repeated Ctrl+C responsive.
 *
 * On every exit path we use `forcedExit` (not `safeExit`) because the deadline
 * or the second-interrupt shortcut means the embedding worker may still be
 * mid-inference in a native call — `safeExit` would walk NAPI destructors
 * under it and SIGABRT (the "💣 Program crashed" report).
 *
 * Exported for testing; prefer `installSignalShutdown` at call sites.
 */
export function makeSignalShutdownHandler(
  shutdown: () => Promise<void>,
): (signal: NodeJS.Signals) => Promise<void> {
  let count = 0;
  return async (signal: NodeJS.Signals): Promise<void> => {
    count++;
    const code = signalExitCode(signal);
    if (count >= 2) {
      console.error("[lore] Received second interrupt — forcing exit.");
      forcedExit(code);
    }
    await runShutdownWithDeadline(shutdown);
    // Bounded shutdown could have timed out → worker may still be alive.
    // Use forcedExit unconditionally on this path for the same reason
    // second-signal does — the 4000ms cap is the only timing guarantee we have.
    forcedExit(code);
  };
}

/** Install the direct-owns-teardown signal handler (see makeSignalShutdownHandler). */
export function installSignalShutdown(shutdown: () => Promise<void>): void {
  const handle = makeSignalShutdownHandler(shutdown);
  process.on("SIGINT", () => void handle("SIGINT"));
  process.on("SIGTERM", () => void handle("SIGTERM"));
}

/**
 * Build the SIGINT/SIGTERM handler for `lore run <agent>`: forward the first
 * signal to the child (whose exit then drives gateway teardown) and force-exit
 * on a second interrupt so the user is never stuck on a hung child/shutdown.
 *
 * Uses `forcedExit` on the second interrupt because the first one may already
 * have triggered a deadline-bounded shutdown that left the embedding worker
 * mid-inference. See `makeSignalShutdownHandler` for the full rationale.
 *
 * Exported for testing; prefer `installChildSignalForwarding` at call sites.
 */
export function makeChildForwardHandler(child: {
  kill: (signal: NodeJS.Signals) => void;
}): (signal: NodeJS.Signals) => void {
  let count = 0;
  return (signal: NodeJS.Signals): void => {
    count++;
    if (count >= 2) {
      console.error("[lore] Received second interrupt — forcing exit.");
      forcedExit(signalExitCode(signal));
    }
    try {
      child.kill(signal);
    } catch {
      // Child already gone — the exit handler will clean up.
    }
  };
}

/** Install the forward-to-child signal handler (see makeChildForwardHandler). */
export function installChildSignalForwarding(child: {
  kill: (signal: NodeJS.Signals) => void;
}): void {
  const handle = makeChildForwardHandler(child);
  process.on("SIGINT", () => handle("SIGINT"));
  process.on("SIGTERM", () => handle("SIGTERM"));
}
