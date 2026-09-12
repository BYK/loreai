import { Worker } from "node:worker_threads";

/** Private parent/child protocol for the foreground gateway supervisor. */
export const SUPERVISED_CHILD_ENV = "LORE_GATEWAY_SUPERVISED_CHILD";
export const SUPERVISOR_PID_ENV = "LORE_GATEWAY_SUPERVISOR_PID";
export const SHUTDOWN_STARTED_MESSAGE = "lore-gateway-shutdown-started";
export const SUPERVISED_CHILD_READY_MESSAGE =
  "lore-gateway-supervised-child-ready";
export const SHUTDOWN_REQUEST_MESSAGE = "lore-gateway-shutdown-request";

type ShutdownSignal = "SIGINT" | "SIGTERM";

interface SupervisionState {
  ownerPid: number;
  worker: Worker;
  pendingSignal?: ShutdownSignal;
  shutdownHandler?: (signal: ShutdownSignal) => void;
}

const supervisionStateKey = Symbol.for("lore.gateway.supervision-state");

function supervisionState(): SupervisionState | undefined {
  return (globalThis as Record<PropertyKey, unknown>)[supervisionStateKey] as
    | SupervisionState
    | undefined;
}

/**
 * Return the externally-owned process boundary for a genuine supervised child.
 *
 * Requiring both an IPC channel and an exact parent-PID match prevents a stale
 * or accidentally inherited environment marker from redirecting lifecycle
 * ownership to an unrelated process.
 */
export function supervisedGatewayOwnerPid(
  env: NodeJS.ProcessEnv = process.env,
  parentPid: number = process.ppid,
  ipcConnected: boolean = process.connected === true,
): number | null {
  if (env[SUPERVISED_CHILD_ENV] !== "1" || !ipcConnected) return null;
  const claimedPid = Number(env[SUPERVISOR_PID_ENV]);
  return Number.isSafeInteger(claimedPid) &&
    claimedPid > 0 &&
    claimedPid === parentPid
    ? claimedPid
    : null;
}

/**
 * Keep an independently scheduled watch on the supervisor process.
 *
 * A worker thread remains responsive when synchronous work starves the main JS
 * event loop. If the supervisor is killed or crashes, the worker immediately
 * terminates the whole gateway process instead of leaving an unreachable
 * orphan behind a stale supervisor PID record.
 */
export function initializeSupervisedGatewayChild(): boolean {
  if (process.env[SUPERVISED_CHILD_ENV] !== "1") return false;
  if (supervisionState()) return true;

  const supervisorPid = supervisedGatewayOwnerPid();
  if (supervisorPid === null) {
    throw new Error(
      "Refusing to start a supervised gateway without its owning parent",
    );
  }
  const source = String.raw`
    const { workerData } = require("node:worker_threads");
    const { supervisorPid } = workerData;
    setInterval(() => {
      if (process.ppid !== supervisorPid) {
        process.kill(process.pid, "SIGKILL");
        return;
      }
      try {
        process.kill(supervisorPid, 0);
      } catch (error) {
        if (error && error.code === "ESRCH") {
          process.kill(process.pid, "SIGKILL");
        }
      }
    }, 50);
  `;
  const worker = new Worker(source, {
    eval: true,
    workerData: { supervisorPid },
  });
  worker.unref();
  const state: SupervisionState = { ownerPid: supervisorPid, worker };
  (globalThis as Record<PropertyKey, unknown>)[supervisionStateKey] = state;

  process.on("message", (message: unknown) => {
    if (
      typeof message !== "object" ||
      message === null ||
      (message as { type?: unknown }).type !== SHUTDOWN_REQUEST_MESSAGE
    ) {
      return;
    }
    const signal = (message as { signal?: unknown }).signal;
    if (signal !== "SIGINT" && signal !== "SIGTERM") return;
    if (state.shutdownHandler) state.shutdownHandler(signal);
    else state.pendingSignal ??= signal;
  });
  // The gateway listener/resources, not the private control channel, own child
  // liveness. Startup errors must still be able to exit naturally.
  process.channel?.unref();
  process.send?.({ type: SUPERVISED_CHILD_READY_MESSAGE });
  return true;
}

/** Attach the full gateway lifecycle to the minimal wrapper's IPC handler. */
export function attachSupervisorShutdownHandler(
  handler: (signal: ShutdownSignal) => void,
): () => void {
  const state = supervisionState();
  if (!state) return () => {};
  if (state.shutdownHandler) {
    throw new Error("Supervisor shutdown handler is already attached");
  }
  state.shutdownHandler = handler;
  if (state.pendingSignal) {
    const signal = state.pendingSignal;
    state.pendingSignal = undefined;
    queueMicrotask(() => handler(signal));
  }
  return () => {
    if (state.shutdownHandler === handler) state.shutdownHandler = undefined;
  };
}
