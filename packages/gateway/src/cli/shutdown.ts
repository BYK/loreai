/**
 * Graceful-but-bounded process shutdown helpers.
 *
 * The gateway exits normally only after the `shutdown()` closure resolves.
 * Several shutdown steps (batch-queue drain,
 * embedding-worker exit) can, in pathological cases, take a long time — which
 * is why Ctrl+C used to appear to "hang for minutes" with no way to break out.
 *
 * These helpers guarantee that:
 *   1. shutdown can never block the process longer than a hard deadline, and
 *   2. a *second* child-owning SIGINT/SIGTERM immediately escalates the child
 *      while retaining the hard wrapper deadline.
 */
import { forcedExit, safeExit } from "./exit";
import { SHUTDOWN_DEADLINE_MS } from "../shutdown-deadline";

export {
  parseShutdownDeadline,
  SHUTDOWN_DEADLINE_MS,
} from "../shutdown-deadline";

const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
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
  /** True if shutdown rejected before the deadline. */
  failed: boolean;
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
  let failed = false;
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
    // the process exit decision with the right code. The timer is cleared the instant
    // shutdown resolves (see finally), so a fast shutdown still exits
    // immediately.
  });
  try {
    await Promise.race([
      Promise.resolve()
        .then(shutdown)
        .catch((e) => {
          failed = true;
          console.error("[lore] Error during shutdown:", e);
        }),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return { timedOut, failed };
}

export interface ProcessShutdownOptions {
  deadlineMs?: number;
  safeExit?: (code: number) => never;
  forcedExit?: (code: number) => never;
}

export interface OwnedChildProcess {
  kill: (signal: NodeJS.Signals) => boolean;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
}

export interface ProcessShutdownController {
  (exitCode: number, childSignal?: NodeJS.Signals): Promise<never>;
  /** Attach the child owned by `lore run` before any shutdown trigger can fire. */
  attachChild: (child: OwnedChildProcess) => void;
  /** Whether any signal or authenticated request has started shutdown. */
  isShutdownStarted: () => boolean;
  /** Immediately SIGKILL a live child, then retain the shared reap deadline. */
  killChildAndWait: (exitCode: number) => Promise<never>;
  /** Record and reap a child outcome, upgrading a pending successful exit. */
  childExited: (exitCode: number) => Promise<never>;
}

/**
 * Create the one-shot shutdown controller used at process command/control
 * boundaries. The whole teardown gets one deadline; a timeout or rejection
 * force-exits nonzero, while a completed teardown exits normally. Repeated
 * signal/control requests share the same in-flight teardown.
 *
 * Do not apply this to ordinary library handles: exiting belongs to the CLI
 * process boundary, not to in-process plugin callers.
 */
export function makeProcessShutdownController(
  shutdown: () => Promise<void>,
  options: ProcessShutdownOptions = {},
): ProcessShutdownController {
  const exitNormally = options.safeExit ?? safeExit;
  const exitForcibly = options.forcedExit ?? forcedExit;
  const deadlineMs = options.deadlineMs ?? SHUTDOWN_DEADLINE_MS;
  // Leave half of the one shared deadline for the escalated child to exit and
  // for gateway teardown to finish. This is derived from (and strictly inside)
  // the outer bound rather than introducing a second independently-sized wait.
  const childGraceMs = Math.floor(deadlineMs / 2);
  let shutdownPromise: Promise<never> | undefined;
  let shutdownStartedAt: number | undefined;
  let requestedExitCode = 0;
  let requestedChildSignal: NodeJS.Signals = "SIGTERM";
  let child: OwnedChildProcess | undefined;
  let childSignalSent = false;
  let childKillSent = false;
  let childEscalationFailed = false;
  let childEscalationTimer: ReturnType<typeof setTimeout> | undefined;
  let childSettled = true;
  let resolveChildExit: (() => void) | undefined;
  let childExit = Promise.resolve();

  const preserveOutcome = (exitCode: number): void => {
    if (requestedExitCode === 0 && exitCode !== 0) requestedExitCode = exitCode;
  };

  const clearChildEscalation = (): void => {
    if (childEscalationTimer) clearTimeout(childEscalationTimer);
    childEscalationTimer = undefined;
  };

  const escalateChild = (): void => {
    if (!child || childSettled || childKillSent) return;
    childKillSent = true;
    try {
      if (!child.kill("SIGKILL")) {
        childEscalationFailed = true;
        console.error("[lore] Failed to force-stop child process.");
      }
    } catch (error) {
      childEscalationFailed = true;
      console.error("[lore] Failed to force-stop child process:", error);
    }
  };

  const scheduleChildEscalation = (): void => {
    if (
      !child ||
      childSettled ||
      childKillSent ||
      childEscalationTimer ||
      shutdownStartedAt === undefined
    ) {
      return;
    }
    const elapsed = Date.now() - shutdownStartedAt;
    childEscalationTimer = setTimeout(
      escalateChild,
      Math.max(0, childGraceMs - elapsed),
    );
    // Intentionally ref'ed: even if a ChildProcess implementation does not
    // hold the event loop open, the wrapper must reach escalation/reaping or
    // the outer forced-exit decision rather than silently orphaning the child.
  };

  const signalChild = (): void => {
    if (!child || childSettled || childSignalSent) return;
    childSignalSent = true;
    try {
      child.kill(requestedChildSignal);
    } catch {
      // A concurrent exit/error listener will reap the child. If it does not,
      // the shared process deadline still bounds the wait.
    }
    scheduleChildEscalation();
  };

  const controller = ((
    exitCode: number,
    childSignal?: NodeJS.Signals,
  ): Promise<never> => {
    preserveOutcome(exitCode);
    if (childSignal && !childSignalSent) requestedChildSignal = childSignal;
    shutdownPromise ??= (async (): Promise<never> => {
      shutdownStartedAt = Date.now();
      // Register escalation before the outer deadline. Even if both timers are
      // observed in one delayed timers turn, SIGKILL is therefore dispatched
      // first; the parsed deadline also keeps this timer strictly earlier.
      signalChild();
      const result = await runShutdownWithDeadline(async () => {
        const outcomes = await Promise.allSettled([
          Promise.resolve().then(shutdown),
          childExit,
        ]);
        const failure = outcomes.find(
          (outcome): outcome is PromiseRejectedResult =>
            outcome.status === "rejected",
        );
        if (failure) throw failure.reason;
      }, deadlineMs);
      clearChildEscalation();
      if (result.timedOut || result.failed || childEscalationFailed) {
        return exitForcibly(requestedExitCode === 0 ? 1 : requestedExitCode);
      }
      return exitNormally(requestedExitCode);
    })();
    return shutdownPromise;
  }) as ProcessShutdownController;

  controller.attachChild = (ownedChild): void => {
    if (shutdownPromise) {
      throw new Error("Cannot attach a child after shutdown has started");
    }
    if (child) throw new Error("A shutdown controller may own only one child");
    child = ownedChild;
    childSettled =
      ownedChild.exitCode !== undefined && ownedChild.exitCode !== null;
    if (childSettled) preserveOutcome(ownedChild.exitCode ?? 0);
    if (!childSettled && ownedChild.signalCode) {
      childSettled = true;
      preserveOutcome(signalExitCode(ownedChild.signalCode));
    }
    if (!childSettled) {
      childExit = new Promise<void>((resolve) => {
        resolveChildExit = resolve;
      });
    }
  };

  controller.isShutdownStarted = (): boolean => shutdownPromise !== undefined;

  controller.killChildAndWait = (exitCode): Promise<never> => {
    preserveOutcome(exitCode);
    const pending = controller(exitCode);
    escalateChild();
    return pending;
  };

  controller.childExited = (exitCode): Promise<never> => {
    preserveOutcome(exitCode);
    if (!childSettled) {
      childSettled = true;
      clearChildEscalation();
      resolveChildExit?.();
      resolveChildExit = undefined;
    }
    return controller(exitCode);
  };

  return controller;
}

/**
 * Build the SIGINT/SIGTERM handler for a command that *directly owns* teardown
 * (no child agent — `lore start`, `lore run` with no agent).
 *
 *   - First signal:  run `shutdown()` deadline-bounded, then exit.
 *   - Second signal: force an immediate exit (don't wait for the in-flight
 *     graceful shutdown). This is what makes repeated Ctrl+C responsive.
 *
 * A completed teardown uses `safeExit`; a deadline/error or second interrupt
 * uses `forcedExit` because native worker teardown may still be in flight.
 *
 * Exported for testing; prefer `installSignalShutdown` at call sites.
 */
export function makeSignalShutdownHandler(
  shutdown: () => Promise<void>,
  processShutdown = makeProcessShutdownController(shutdown),
): (signal: NodeJS.Signals) => Promise<void> {
  let count = 0;
  return async (signal: NodeJS.Signals): Promise<void> => {
    count++;
    const code = signalExitCode(signal);
    if (count >= 2) {
      console.error("[lore] Received second interrupt — forcing exit.");
      forcedExit(code);
    }
    await processShutdown(code);
  };
}

/** Install the direct-owns-teardown signal handler (see makeSignalShutdownHandler). */
export function installSignalShutdown(
  shutdown: () => Promise<void>,
  processShutdown?: ProcessShutdownController,
): void {
  const handle = makeSignalShutdownHandler(shutdown, processShutdown);
  process.on("SIGINT", () => void handle("SIGINT"));
  process.on("SIGTERM", () => void handle("SIGTERM"));
}

/**
 * Build the SIGINT/SIGTERM handler for `lore run <agent>`: the first signal
 * starts the shared child + gateway teardown deadline and forwards that signal
 * to the child. A second interrupt immediately escalates the child to SIGKILL
 * but keeps the wrapper alive until the child is reaped or the deadline fires.
 *
 * Exported for testing; prefer `installChildSignalForwarding` at call sites.
 */
export function makeChildForwardHandler(
  child: {
    kill: (signal: NodeJS.Signals) => boolean;
  },
  processShutdown: ProcessShutdownController,
): (signal: NodeJS.Signals) => void {
  processShutdown.attachChild(child);
  let count = 0;
  return (signal: NodeJS.Signals): void => {
    count++;
    if (count >= 2) {
      console.error("[lore] Received second interrupt — force-stopping child.");
      void processShutdown.killChildAndWait(signalExitCode(signal));
      return;
    }
    void processShutdown(signalExitCode(signal), signal);
  };
}

/** Install the forward-to-child signal handler (see makeChildForwardHandler). */
export function installChildSignalForwarding(
  child: {
    kill: (signal: NodeJS.Signals) => boolean;
  },
  processShutdown: ProcessShutdownController,
): void {
  const handle = makeChildForwardHandler(child, processShutdown);
  process.on("SIGINT", () => handle("SIGINT"));
  process.on("SIGTERM", () => handle("SIGTERM"));
}
