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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function commandStop(): Promise<void> {
  const pid = readPidFile();
  const port = readPortFile();
  const portAlive = port
    ? await probeGateway(`http://127.0.0.1:${port}`)
    : false;
  const plan = planStop({
    pid,
    pidAlive: pid !== null && isProcessAlive(pid),
    port,
    portAlive,
  });

  switch (plan.action) {
    case "signal": {
      try {
        process.kill(plan.pid, "SIGTERM");
      } catch {
        // Raced with exit — fall through to cleanup.
      }
      // Wait for the process to exit (bounded a bit beyond its own shutdown
      // deadline so a clean graceful shutdown has time to finish).
      const deadline = Date.now() + SHUTDOWN_DEADLINE_MS + 3000;
      while (Date.now() < deadline) {
        if (!isProcessAlive(plan.pid)) break;
        await sleep(200);
      }
      if (isProcessAlive(plan.pid)) {
        console.error(
          `[lore] Gateway (pid ${plan.pid}) did not stop within the deadline.`,
        );
        process.exitCode = 1;
        return;
      }
      removePidFile(plan.pid);
      console.log(`[lore] Gateway stopped (pid ${plan.pid}).`);
      return;
    }
    case "foreground":
      console.error(
        `[lore] A gateway is running on port ${plan.port} but no PID file was found.`,
      );
      console.error(
        `[lore] It's likely a foreground \`lore start\` — stop it with Ctrl+C in its terminal.`,
      );
      process.exitCode = 1;
      return;
    case "stale":
      removePidFile(plan.pid);
      console.log(
        `[lore] No running gateway found (cleaned up stale PID file).`,
      );
      return;
    case "none":
      console.log(`[lore] No running gateway found.`);
      return;
  }
}
