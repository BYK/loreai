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
import {
  readGatewayProcessFile,
  inspectPidFile,
  removeGatewayProcessFile,
  removeLegacyPidFile,
  type GatewayProcessRecord,
  type LegacyPidFileRecord,
  type LegacyPidRemovalResult,
  type PidFileInspection,
} from "../pidfile";
import { readPortFile } from "../portfile";
import {
  probeGateway,
  probeGatewayProcess,
  probeUrlFor,
  requestGatewayShutdown,
  type GatewayShutdownRequestResult,
} from "./start";
import { SHUTDOWN_DEADLINE_MS } from "./shutdown";
import {
  inspectProcessGeneration,
  withLifecycleLock,
  type ProcessInspection,
} from "../lifecycle-lock";

export type StopPlan =
  | { action: "signal"; pid: number }
  | { action: "foreground"; port: number }
  | { action: "stale"; pid: number }
  | { action: "uncertain"; pid: number }
  | { action: "none" };

/** Decide what `lore stop` should do from the observed process/port state. */
export function planStop(input: {
  pid: number | null;
  pidState: ProcessInspection["state"];
  port: number | null;
  portAlive: boolean;
  pidMatchesGateway: boolean;
}): StopPlan {
  // Signal only when the live PID is confirmed by the gateway control response.
  // PID numbers are reused, so liveness alone cannot establish ownership.
  if (
    input.pid !== null &&
    input.pidState === "alive" &&
    input.pidMatchesGateway
  ) {
    return { action: "signal", pid: input.pid };
  }
  if (input.port !== null && input.portAlive) {
    return { action: "foreground", port: input.port };
  }
  if (input.pid !== null && input.pidState === "dead") {
    return { action: "stale", pid: input.pid };
  }
  if (input.pid !== null) return { action: "uncertain", pid: input.pid };
  return { action: "none" };
}

/** Injectable IO for the stop orchestration, so `runStop` is testable. */
export interface StopIO {
  inspectPidFile: () => PidFileInspection;
  readRecord: () => GatewayProcessRecord | null;
  readPort: () => number | null;
  authenticate: (record: GatewayProcessRecord) => Promise<boolean>;
  requestShutdown: (
    record: GatewayProcessRecord,
  ) => Promise<GatewayShutdownRequestResult>;
  probeHealth: (url: string) => Promise<boolean>;
  inspectProcess?: (pid: number) => ProcessInspection;
  isAlive: (pid: number) => boolean;
  kill: (pid: number) => void;
  removeRecord: (record: GatewayProcessRecord) => void;
  removeLegacyPid: (record: LegacyPidFileRecord) => LegacyPidRemovalResult;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  logInfo: (msg: string) => void;
  logError: (msg: string) => void;
  /** How long to wait for the signalled process to exit (ms). */
  timeoutMs?: number;
}

function sameProcessRecord(
  current: GatewayProcessRecord | null,
  expected: GatewayProcessRecord,
): current is GatewayProcessRecord {
  return (
    current?.version === expected.version &&
    current.pid === expected.pid &&
    current.port === expected.port &&
    current.token === expected.token &&
    current.processIdentity === expected.processIdentity &&
    current.hosts.length === expected.hosts.length &&
    current.hosts.every((host, index) => host === expected.hosts[index])
  );
}

/**
 * Stop orchestration: resolve the running gateway, signal it, and wait for it
 * to exit. Returns the process exit code. Pure of process.exit/real IO.
 */
export async function runStop(io: StopIO): Promise<number> {
  const pidFile = io.inspectPidFile();
  if (pidFile.state === "invalid") {
    io.logError(
      `Gateway PID record is invalid (${pidFile.reason}); preserving it without signalling any process.`,
    );
    return 1;
  }
  const record = pidFile.state === "process" ? pidFile.record : null;
  const legacyPid = pidFile.state === "legacy" ? pidFile.record : null;
  const inspect = (candidatePid: number): ProcessInspection =>
    io.inspectProcess?.(candidatePid) ??
    (io.isAlive(candidatePid)
      ? { state: "alive", identity: null }
      : { state: "dead" });
  const pid = record?.pid ?? legacyPid?.pid ?? null;
  const port = record?.port ?? io.readPort();
  if (pidFile.state === "absent") {
    const healthUrls = port ? [probeUrlFor("127.0.0.1", port)] : [];
    const healthResults = await Promise.all(
      healthUrls.map((url) => io.probeHealth(url)),
    );
    const plan = planStop({
      pid: null,
      pidState: "dead",
      port,
      portAlive: healthResults.some(Boolean),
      pidMatchesGateway: false,
    });
    if (plan.action === "foreground") {
      io.logError(
        `A gateway is running on port ${plan.port} but no matching PID was found.`,
      );
      io.logError(
        `It's likely a foreground \`lore start\` — stop it with Ctrl+C in its terminal.`,
      );
      return 1;
    }
    io.logInfo("No running gateway found.");
    return 0;
  }
  const pidMatchesGateway = record ? await io.authenticate(record) : false;
  const healthUrls = record
    ? record.hosts.map((host) => probeUrlFor(host, record.port))
    : port
      ? [probeUrlFor("127.0.0.1", port)]
      : [];
  const healthResults = pidMatchesGateway
    ? [true]
    : await Promise.all(healthUrls.map((url) => io.probeHealth(url)));
  const initialInspection =
    pid === null ? { state: "dead" as const } : inspect(pid);
  if (
    record?.version === 2 &&
    !pidMatchesGateway &&
    (initialInspection.state === "unknown" ||
      (initialInspection.state === "alive" &&
        (initialInspection.identity === null ||
          initialInspection.identity === record.processIdentity)))
  ) {
    io.logError(
      `Gateway process generation ${record.pid} is still live but control authentication is unavailable; preserving its process record.`,
    );
    return 1;
  }
  const plan = planStop({
    pid,
    pidState: initialInspection.state,
    port,
    portAlive: healthResults.some(Boolean),
    pidMatchesGateway,
  });

  switch (plan.action) {
    case "signal": {
      if (!record) {
        io.logError(
          `Refusing to signal pid ${plan.pid} without an authenticated process-generation record.`,
        );
        return 1;
      }
      // Revalidate the exact persisted generation and make the authenticated
      // request while serialized. The target schedules shutdown after flushing
      // the response, so this lock is released before it needs to acquire it.
      const graceful = await withLifecycleLock(
        "gateway-shutdown",
        async (lock) => {
          lock.assertOwned();
          const current = io.readRecord();
          if (!sameProcessRecord(current, record)) return "changed" as const;
          if (!(await io.authenticate(current))) return "changed" as const;
          lock.assertOwned();
          let request: GatewayShutdownRequestResult;
          try {
            request = await io.requestShutdown(current);
          } catch {
            request = "failed";
          }
          lock.assertOwned();
          return sameProcessRecord(io.readRecord(), record)
            ? request
            : ("changed" as const);
        },
      );

      if (graceful === "changed") {
        io.logError(
          `Gateway process record changed during the shutdown request for pid ${plan.pid}; nothing was removed or signalled.`,
        );
        return 1;
      }
      if (graceful === "failed") {
        io.logError(
          `Authenticated graceful shutdown request failed for pid ${plan.pid}; preserving the process record without signalling it.`,
        );
        return 1;
      }

      const expectedProcessIdentity = record.processIdentity;
      const hasStrongIdentity =
        record.version === 2 &&
        expectedProcessIdentity !== undefined &&
        !expectedProcessIdentity.startsWith("unverified:");

      if (graceful === "unsupported") {
        // Version-transition fallback only: an authenticated GET from an older
        // gateway may not implement POST. Never signal without a matching strong
        // process generation.
        if (!hasStrongIdentity) {
          io.logError(
            `Gateway does not support authenticated graceful shutdown and pid ${plan.pid} lacks a verified start identity; nothing was signalled.`,
          );
          return 1;
        }
        const signalled = await withLifecycleLock(
          "gateway-shutdown",
          async (lock) => {
            lock.assertOwned();
            const current = io.readRecord();
            if (
              !sameProcessRecord(current, record) ||
              !(await io.authenticate(current))
            ) {
              return false;
            }
            const inspection = inspect(current.pid);
            if (
              inspection.state !== "alive" ||
              inspection.identity !== expectedProcessIdentity
            ) {
              return false;
            }
            lock.assertOwned();
            try {
              io.kill(current.pid);
            } catch (error) {
              const afterSignalFailure = inspect(current.pid);
              if (
                afterSignalFailure.state === "dead" ||
                (afterSignalFailure.state === "alive" &&
                  afterSignalFailure.identity !== null &&
                  afterSignalFailure.identity !== expectedProcessIdentity)
              ) {
                return true;
              }
              throw error;
            }
            return true;
          },
        );
        if (!signalled) {
          io.logError(
            `Gateway process generation changed before signalling pid ${plan.pid}; nothing was signalled.`,
          );
          return 1;
        }
      }

      const deadline = io.now() + (io.timeoutMs ?? SHUTDOWN_DEADLINE_MS + 3000);
      let stopped = false;
      let recordChanged = false;
      while (io.now() < deadline) {
        const currentRecord = io.readRecord();
        if (currentRecord === null) {
          stopped = true;
          break;
        }
        if (!sameProcessRecord(currentRecord, record)) {
          recordChanged = true;
          break;
        }
        const current = inspect(plan.pid);
        if (
          current.state === "dead" ||
          (hasStrongIdentity &&
            current.state === "alive" &&
            current.identity !== null &&
            current.identity !== expectedProcessIdentity)
        ) {
          stopped = true;
          break;
        }
        await io.sleep(200);
      }
      if (recordChanged) {
        io.logError(
          `Gateway process record was replaced while waiting for pid ${plan.pid}; preserving the replacement.`,
        );
        return 1;
      }
      if (!stopped) {
        io.logError(
          `Gateway (pid ${plan.pid}) did not stop within the deadline.`,
        );
        return 1;
      }
      await withLifecycleLock("gateway-shutdown", (lock) => {
        lock.assertOwned();
        const current = io.readRecord();
        if (sameProcessRecord(current, record)) {
          io.removeRecord(record);
        }
      });
      io.logInfo(`Gateway stopped (pid ${plan.pid}).`);
      return 0;
    }
    case "foreground":
      io.logError(
        `A gateway is running on port ${plan.port} but no matching PID was found.`,
      );
      io.logError(
        `It's likely a foreground \`lore start\` — stop it with Ctrl+C in its terminal.`,
      );
      return 1;
    case "stale":
      if (record) {
        const currentInspection = inspect(record.pid);
        if (currentInspection.state !== "dead") {
          io.logError(
            `Gateway process generation ${record.pid} is live or could not be inspected; preserving its process record.`,
          );
          return 1;
        }
        io.removeRecord(record);
      } else if (legacyPid) {
        const result = await withLifecycleLock(
          "gateway-shutdown",
          (lock): LegacyPidRemovalResult | "process-changed" => {
            lock.assertOwned();
            if (inspect(legacyPid.pid).state !== "dead") {
              return "process-changed";
            }
            lock.assertOwned();
            return io.removeLegacyPid(legacyPid);
          },
        );
        if (result === "process-changed") {
          io.logError(
            `PID ${legacyPid.pid} is live or could not be inspected; preserving its process record without signalling it.`,
          );
          return 1;
        }
        if (result === "changed") {
          io.logError(
            "Gateway PID record changed before stale cleanup; preserving the replacement record.",
          );
          return 1;
        }
        if (result === "absent") {
          io.logInfo("No running gateway found.");
          return 0;
        }
      }
      io.logInfo("No running gateway found (cleaned up stale PID file).");
      return 0;
    case "uncertain":
      io.logError(
        `PID ${plan.pid} is live or could not be inspected; preserving its process record without signalling it.`,
      );
      return 1;
    case "none":
      io.logInfo("No running gateway found.");
      return 0;
  }
}

/** Build the real (production) IO for {@link runStop}. */
export function realStopIO(): StopIO {
  return {
    inspectPidFile,
    readRecord: readGatewayProcessFile,
    readPort: readPortFile,
    authenticate: probeGatewayProcess,
    requestShutdown: requestGatewayShutdown,
    probeHealth: probeGateway,
    inspectProcess: inspectProcessGeneration,
    isAlive: (pid) => inspectProcessGeneration(pid).state === "alive",
    kill: (pid) => process.kill(pid, "SIGTERM"),
    removeRecord: removeGatewayProcessFile,
    removeLegacyPid: removeLegacyPidFile,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    logInfo: (msg) => console.log(`[lore] ${msg}`),
    logError: (msg) => console.error(`[lore] ${msg}`),
  };
}

export async function commandStop(): Promise<void> {
  const code = await runStop(realStopIO());
  if (code !== 0) process.exitCode = code;
}
