/**
 * Minimal parent-process supervisor for a foreground `lore start` gateway.
 *
 * A shutdown deadline implemented by the gateway cannot fire while its main
 * event loop is blocked in synchronous/native work. This parent intentionally
 * loads none of the gateway runtime; its timer therefore remains independent
 * and can SIGKILL the gateway process group after the configured deadline.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { parseArgs } from "node:util";
import { SHUTDOWN_DEADLINE_MS } from "../shutdown-deadline";
import { LEGACY_OPTIONS } from "./legacy-options";
import {
  SHUTDOWN_REQUEST_MESSAGE,
  SHUTDOWN_STARTED_MESSAGE,
  SUPERVISED_CHILD_ENV,
  SUPERVISED_CHILD_READY_MESSAGE,
  SUPERVISOR_PID_ENV,
  initializeSupervisedGatewayChild,
} from "./supervision-protocol";

export {
  SHUTDOWN_STARTED_MESSAGE,
  SUPERVISED_CHILD_ENV,
  SUPERVISOR_PID_ENV,
  initializeSupervisedGatewayChild,
};

const SIGNAL_NUMBERS: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGKILL: 9,
  SIGTERM: 15,
};

const STRICLI_FALSE_VALUES = new Set(["false", "f", "no", "n", "off", "0"]);

function stricliBooleanEnabled(value: unknown): boolean {
  return typeof value === "string"
    ? !STRICLI_FALSE_VALUES.has(value.toLowerCase())
    : value === true;
}

export function shouldSuperviseGatewayCommand(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // The wrapper validates and initializes a marked child before calling this
  // classifier. Never recurse if that relationship changes immediately after
  // initialization; the child-side death watch will terminate instead.
  if (env[SUPERVISED_CHILD_ENV] === "1") return false;
  try {
    const { positionals, values } = parseArgs({
      args: argv,
      options: LEGACY_OPTIONS,
      allowPositionals: true,
      strict: false,
    });
    // `start` is a typed Stricli route only when it is argv[0]. Its booleans
    // accept false/f/no/n/off/0; option-leading invocations still use the
    // legacy dispatcher, where every inline string is truthy.
    const daemonized =
      argv[0] === "start"
        ? stricliBooleanEnabled(values.bg) ||
          stricliBooleanEnabled(values.daemon)
        : Boolean(values.bg || values.daemon);
    return (
      positionals[0] === "start" &&
      !daemonized &&
      !values["print-vendor-info"] &&
      !values["check-embeddings"] &&
      !values["check-vec"] &&
      !values["check-read-offload"]
    );
  } catch {
    // Let the real CLI render malformed-argument diagnostics.
    return false;
  }
}

interface GracefulShutdownChild {
  connected: boolean;
  send: (message: unknown) => boolean;
}

/** Request graceful teardown over IPC; never emulate POSIX signals on Windows. */
export function requestGracefulGatewayShutdown(
  child: GracefulShutdownChild,
  signal: "SIGINT" | "SIGTERM",
): boolean {
  if (!child.connected) return false;
  return child.send({ type: SHUTDOWN_REQUEST_MESSAGE, signal });
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  return signal ? 128 + (SIGNAL_NUMBERS[signal] ?? 1) : 1;
}

function signalProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
  ownsProcessGroup: boolean,
): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (ownsProcessGroup && child.pid !== undefined) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    // ESRCH means the child won the race and its close event will settle us.
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export interface GatewaySupervisorOptions {
  /** Arguments passed after process.execPath (bin path + CLI args for npm). */
  childArgs: string[];
  deadlineMs?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Spawn and supervise one gateway child, returning its shell-style exit code.
 * The first SIGINT/SIGTERM is forwarded; the second signal or deadline sends
 * SIGKILL from this independent event loop.
 */
export function runGatewaySupervisor(
  options: GatewaySupervisorOptions,
): Promise<number> {
  const deadlineMs = options.deadlineMs ?? SHUTDOWN_DEADLINE_MS;
  const ownsProcessGroup = process.platform !== "win32";
  let child: ChildProcess | undefined;
  let requestedShutdownSignal: "SIGINT" | "SIGTERM" | undefined;
  let signalCount = 0;
  let childReady = false;
  let shutdownRequestSent = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  const hardStop = (): void => {
    if (!child) return;
    console.error(
      `[lore] Gateway did not stop within ${deadlineMs}ms — supervisor is forcing exit.`,
    );
    signalProcessGroup(child, "SIGKILL", ownsProcessGroup);
  };

  const armDeadline = (): void => {
    deadlineTimer ??= setTimeout(hardStop, deadlineMs);
  };

  const sendShutdownRequest = (): void => {
    if (
      !child ||
      !childReady ||
      !requestedShutdownSignal ||
      shutdownRequestSent
    ) {
      return;
    }
    try {
      shutdownRequestSent = requestGracefulGatewayShutdown(
        child as GracefulShutdownChild,
        requestedShutdownSignal,
      );
    } catch {
      // Disconnect/exit races settle through close or the hard deadline.
    }
  };

  const handle = (
    signal: NodeJS.Signals,
    shutdownSignal: "SIGINT" | "SIGTERM" = signal as "SIGINT" | "SIGTERM",
  ): void => {
    signalCount++;
    requestedShutdownSignal ??= shutdownSignal;
    if (signalCount >= 2) {
      hardStop();
      return;
    }
    armDeadline();
    sendShutdownRequest();
  };
  const onSigint = (): void => handle("SIGINT");
  const onSigterm = (): void => handle("SIGTERM");
  const onSighup = (): void => handle("SIGHUP", "SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("SIGHUP", onSighup);

  const cleanup = (): void => {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("SIGHUP", onSighup);
  };

  return new Promise<number>((resolve) => {
    try {
      child = spawn(process.execPath, options.childArgs, {
        // A separate process group prevents console-generated Ctrl+C from
        // reaching both parent and child (double shutdown on Windows), while
        // also giving POSIX escalation an exact group to terminate.
        detached: true,
        windowsHide: true,
        env: {
          ...(options.env ?? process.env),
          [SUPERVISED_CHILD_ENV]: "1",
          [SUPERVISOR_PID_ENV]: String(process.pid),
        },
        stdio: ["inherit", "inherit", "inherit", "ipc"],
      });
    } catch (error) {
      cleanup();
      console.error("[lore] Failed to start gateway child:", error);
      resolve(1);
      return;
    }

    // A signal can arrive after handler installation but before spawn returns.
    if (signalCount >= 2) hardStop();

    child.once("error", (error) => {
      console.error("[lore] Gateway child process failed:", error);
    });
    child.on("message", (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        (message as { type?: unknown }).type === SUPERVISED_CHILD_READY_MESSAGE
      ) {
        childReady = true;
        sendShutdownRequest();
        return;
      }
      if (
        typeof message === "object" &&
        message !== null &&
        (message as { type?: unknown }).type === SHUTDOWN_STARTED_MESSAGE
      ) {
        armDeadline();
      }
    });
    child.once("close", (code, signal) => {
      cleanup();
      resolve(code ?? signalExitCode(signal));
    });
  });
}
