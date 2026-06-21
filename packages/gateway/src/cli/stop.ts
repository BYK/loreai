/**
 * `lore stop` — stop a gateway started in the background (`lore start --bg`)
 * or any foreground `lore start` that wrote a PID file.
 *
 * Resolution order:
 *   1. Live PID file       → SIGTERM the process, wait for it to exit.
 *   2. No live PID but a reachable gateway (port file) → it's a foreground
 *      process we can't signal by PID; tell the user to Ctrl+C it.
 *   3. Stale PID file (process already gone) → clean it up, report nothing.
 *   4. Nothing running     → no-op message.
 */
import { readPidFile, removePidFile, isProcessAlive } from "../pidfile";
import { readPortFile } from "../portfile";
import { probeGateway } from "./start";
import { SHUTDOWN_DEADLINE_MS } from "./shutdown";

export type StopPlan =
  | { action: "signal"; pid: number }
  | { action: "foreground"; port: number }
  | { action: "stale"; pid: number }
  | { action: "none" };

/**
 * Decide what `lore stop` should do given the observed pid/port state.
 * Pure and unit-testable — no process signalling or IO here.
 */
export function planStop(input: {
  pid: number | null;
  pidAlive: boolean;
  port: number | null;
  portAlive: boolean;
}): StopPlan {
  // A live PID always wins — we can signal it directly.
  if (input.pid !== null && input.pidAlive) {
    return { action: "signal", pid: input.pid };
  }
  // No signallable PID, but a gateway is still answering — it's a foreground
  // process (or one started without a PID file) we can't kill by PID.
  if (input.port !== null && input.portAlive) {
    return { action: "foreground", port: input.port };
  }
  // A PID file is present but the process is gone and nothing is serving.
  if (input.pid !== null) {
    return { action: "stale", pid: input.pid };
  }
  return { action: "none" };
}

/** Injectable IO for the stop orchestration, so `runStop` is testable. */
export interface StopIO {
  readPid: () => number | null;
  readPort: () => number | null;
  probe: (url: string) => Promise<boolean>;
  isAlive: (pid: number) => boolean;
  kill: (pid: number) => void;
  removePid: (pid: number) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  logInfo: (msg: string) => void;
  logError: (msg: string) => void;
  /** How long to wait for the signalled process to exit (ms). */
  timeoutMs?: number;
}

/**
 * Stop orchestration: resolve the running gateway, signal it, and wait for it
 * to exit. Returns the process exit code (0 = stopped/nothing-running,
 * 1 = foreground or stuck). Pure of `process.exit`/real IO so it is
 * unit-testable; `commandStop` is the thin shell that wires real IO.
 */
export async function runStop(io: StopIO): Promise<number> {
  const pid = io.readPid();
  const port = io.readPort();
  const portAlive = port ? await io.probe(`http://127.0.0.1:${port}`) : false;
  const plan = planStop({
    pid,
    pidAlive: pid !== null && io.isAlive(pid),
    port,
    portAlive,
  });

  switch (plan.action) {
    case "signal": {
      try {
        io.kill(plan.pid);
      } catch {
        // Raced with exit — fall through to cleanup.
      }
      // Wait for the process to exit (bounded a bit beyond its own shutdown
      // deadline so a clean graceful shutdown has time to finish).
      const deadline = io.now() + (io.timeoutMs ?? SHUTDOWN_DEADLINE_MS + 3000);
      while (io.now() < deadline) {
        if (!io.isAlive(plan.pid)) break;
        await io.sleep(200);
      }
      if (io.isAlive(plan.pid)) {
        io.logError(
          `Gateway (pid ${plan.pid}) did not stop within the deadline.`,
        );
        return 1;
      }
      io.removePid(plan.pid);
      io.logInfo(`Gateway stopped (pid ${plan.pid}).`);
      return 0;
    }
    case "foreground":
      io.logError(
        `A gateway is running on port ${plan.port} but no PID file was found.`,
      );
      io.logError(
        `It's likely a foreground \`lore start\` — stop it with Ctrl+C in its terminal.`,
      );
      return 1;
    case "stale":
      io.removePid(plan.pid);
      io.logInfo(`No running gateway found (cleaned up stale PID file).`);
      return 0;
    case "none":
      io.logInfo(`No running gateway found.`);
      return 0;
  }
}

/** Build the real (production) IO for {@link runStop}. */
export function realStopIO(): StopIO {
  return {
    readPid: readPidFile,
    readPort: readPortFile,
    probe: probeGateway,
    isAlive: isProcessAlive,
    kill: (pid) => process.kill(pid, "SIGTERM"),
    removePid: removePidFile,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: Date.now,
    logInfo: (msg) => console.log(`[lore] ${msg}`),
    logError: (msg) => console.error(`[lore] ${msg}`),
  };
}

export async function commandStop(): Promise<void> {
  const code = await runStop(realStopIO());
  if (code !== 0) process.exitCode = code;
}
