/**
 * `lore start` — start the gateway server without auto-launching an agent.
 *
 * Extracted from the old top-level index.ts boot logic.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync } from "node:fs";
import { join } from "node:path";
import {
  assertGatewayAccessConfigured,
  loadConfig,
  DEFAULT_PORTS,
  type GatewayConfig,
} from "../config";
import { startServer, bracketHost } from "../server";
import { resetPipelineState } from "../pipeline";
import { writePortFile, removePortFile } from "../portfile";
import {
  writeGatewayProcessFile,
  readGatewayProcessFile,
  removeGatewayProcessFile,
  type GatewayProcessRecord,
} from "../pidfile";
import {
  dataDir,
  embedding,
  log,
  close as closeDb,
  shutdownVectorPoolAsync,
  DEFAULT_VECTOR_POOL_SHUTDOWN_DEADLINE_MS,
} from "@loreai/core";
import { safeExit } from "./exit";
import {
  installSignalShutdown,
  makeProcessShutdownController,
  SHUTDOWN_DEADLINE_MS,
  type ProcessShutdownController,
} from "./shutdown";
import { openRuntimeFileForAppend } from "../runtime-files";
import { nodeHttpFetch } from "../fetch";
import {
  currentProcessIdentity,
  inspectProcessGeneration,
  withoutLifecycleLock,
  withLifecycleLock,
  type LifecycleLock,
  type ProcessInspection,
} from "../lifecycle-lock";

/**
 * Bound for the in-flight document-embed drain on graceful shutdown (#1331).
 * Kept comfortably under {@link SHUTDOWN_DEADLINE_MS} so the drain plus the
 * subsequent worker `resetProvider()` both finish inside the hard shutdown
 * deadline — a slow/stuck embed can never reintroduce the Ctrl+C hang. Whatever
 * doesn't complete in time is re-indexed by `runStartupBackfill` on next boot.
 */
const EMBED_DRAIN_DEADLINE_MS = Math.max(
  500,
  Math.floor(SHUTDOWN_DEADLINE_MS * 0.6),
);

/**
 * Bound for the bounded vector-pool shutdown on graceful shutdown (#1599).
 * The pool teardown must wait for every worker's SQLite reader to close before
 * the writer can TRUNCATE the WAL — leaving readers up would strand the `-wal`
 * file and force WAL recovery on the next boot. Sized to fit under the global
 * deadline after the embedding drain (60%) so a stuck worker still leaves room
 * for the writer's checkpoint+close. Mirrors {@link EMBED_DRAIN_DEADLINE_MS}'s
 * safety floor of 500ms so an aggressive `LORE_SHUTDOWN_TIMEOUT_MS` (e.g.
 * 1000ms) doesn't shrink the pool budget into a guaranteed timeout.
 */
const VECTOR_POOL_SHUTDOWN_DEADLINE_MS = Math.max(
  Math.min(
    DEFAULT_VECTOR_POOL_SHUTDOWN_DEADLINE_MS,
    SHUTDOWN_DEADLINE_MS - 500,
  ),
  500,
);

export interface StartOptions {
  port?: number;
  hosts?: string[];
  debug?: boolean;
  /** Suppress verbose banner (env vars, export hints). Used in embedded mode. */
  quiet?: boolean;
  /** Remote gateway URL. When set, `lore run` delegates to this gateway
   *  instead of starting a local one. Overrides LORE_REMOTE_URL env var. */
  remoteUrl?: string;
  /**
   * When true, disables hosted mode even for `lore start`.
   * CLI: `--local` / `-l`.
   */
  local?: boolean;
  /** Allow non-loopback peers to access the dashboard and management API. */
  allowRemoteManagement?: boolean;
  /**
   * When true, `lore start` daemonizes: it re-spawns itself detached, polls
   * the gateway until healthy, prints the address + PID + log path, and exits 0.
   * CLI: `--bg` / `--daemon`.
   */
  bg?: boolean;
  /** @internal CLI-owned process boundary; never set by in-process plugins. */
  processBoundary?: boolean;
}

export interface GatewayHandle {
  config: GatewayConfig;
  port: number;
  /** Whether this process owns the server (started it). False when reusing an existing instance. */
  owned: boolean;
  /** Owner-only token used to authenticate the gateway control endpoint. */
  managementToken: string;
  /** Shut down the gateway. No-op when `owned` is false. */
  shutdown: () => Promise<void>;
  /** @internal One-shot CLI process shutdown shared by signals and control. */
  processShutdown?: ProcessShutdownController;
}

export interface GatewayHealthIdentity {
  pid: number;
}

export type GatewayIdentityProbe =
  | { kind: "authenticated"; identity: GatewayHealthIdentity }
  | { kind: "rejected" }
  | { kind: "unavailable" }
  | { kind: "timeout" };

export type GatewayShutdownRequestResult =
  | "accepted"
  | "unsupported"
  | "failed";

export interface StartGatewayIO {
  readProcess: () => GatewayProcessRecord | null;
  authenticate: (record: GatewayProcessRecord) => Promise<string | null>;
  writePort: (port: number, token: string) => void;
  removePort: (port: number, token: string) => void;
  writeProcess: (record: GatewayProcessRecord) => void;
  removeProcess: (pid: number, record?: GatewayProcessRecord) => void;
  startServer: typeof startServer;
  resetPipelineState: typeof resetPipelineState;
  createProcessShutdownController: typeof makeProcessShutdownController;
}

const realStartGatewayIO: StartGatewayIO = {
  readProcess: readGatewayProcessFile,
  authenticate: probeGatewayProcessHost,
  writePort: writePortFile,
  removePort: removePortFile,
  writeProcess: writeGatewayProcessFile,
  removeProcess: (pid, record) => {
    if (record) removeGatewayProcessFile(record);
    else {
      const current = readGatewayProcessFile();
      if (current?.pid === pid) removeGatewayProcessFile(current);
    }
  },
  startServer,
  resetPipelineState,
  createProcessShutdownController: makeProcessShutdownController,
};

function isLoopbackProbeUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "localhost." ||
      hostname === "::1" ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname)
    );
  } catch {
    return false;
  }
}

/**
 * Fetch an internal gateway endpoint without WHATWG's browser forbidden-port
 * list breaking valid loopback listeners. Non-loopback URLs retain the normal
 * Fetch transport and semantics used for remote/LAN gateways.
 */
export function internalProbeFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  return isLoopbackProbeUrl(url)
    ? nodeHttpFetch(url, init)
    : Promise.resolve(fetch(url, init));
}

/** Probe the owner-only control endpoint and return its process identity. */
export async function probeGatewayIdentity(
  baseURL: string,
  token: string,
  timeoutMs = 1500,
): Promise<GatewayHealthIdentity | null> {
  const result = await probeGatewayIdentityDetailed(baseURL, token, timeoutMs);
  return result.kind === "authenticated" ? result.identity : null;
}

export async function probeGatewayIdentityDetailed(
  baseURL: string,
  token: string,
  timeoutMs = 1500,
): Promise<GatewayIdentityProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await internalProbeFetch(`${baseURL}/_lore/control`, {
      signal: controller.signal,
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { kind: "rejected" };
    const body = (await res.json()) as {
      status?: unknown;
      service?: unknown;
      pid?: unknown;
    };
    return body.status === "ok" &&
      body.service === "lore" &&
      typeof body.pid === "number" &&
      Number.isSafeInteger(body.pid) &&
      body.pid > 0
      ? { kind: "authenticated", identity: { pid: body.pid } }
      : { kind: "rejected" };
  } catch (error) {
    return controller.signal.aborted || (error as Error).name === "AbortError"
      ? { kind: "timeout" }
      : { kind: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeGatewayProcessStatus(
  record: GatewayProcessRecord,
  timeoutMs = 1500,
): Promise<"authenticated" | "rejected" | "unavailable" | "timeout"> {
  const results = await Promise.all(
    record.hosts.map((host) =>
      probeGatewayIdentityDetailed(
        probeUrlFor(host, record.port),
        record.token,
        timeoutMs,
      ),
    ),
  );
  if (
    results.some(
      (result) =>
        result.kind === "authenticated" && result.identity.pid === record.pid,
    )
  ) {
    return "authenticated";
  }
  if (results.some((result) => result.kind === "timeout")) return "timeout";
  if (results.some((result) => result.kind === "rejected")) return "rejected";
  return "unavailable";
}

export type GatewayHealthStatus =
  | "healthy"
  | "not-running"
  | "error"
  | "timeout";

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function isConnectionRefused(error: unknown): boolean {
  if (error instanceof AggregateError) {
    return (
      error.errors.length > 0 &&
      error.errors.every((candidate) => isConnectionRefused(candidate))
    );
  }
  if (errorCode(error) === "ECONNREFUSED") return true;
  if (typeof error !== "object" || error === null) return false;
  return isConnectionRefused((error as { cause?: unknown }).cause);
}

/** Probe public health while preserving ambiguous failure states. */
export async function probeGatewayStatus(
  baseURL: string,
  timeoutMs = 1500,
): Promise<GatewayHealthStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await internalProbeFetch(`${baseURL}/health`, {
      signal: controller.signal,
    });
    return res.ok ? "healthy" : "error";
  } catch (error) {
    if (controller.signal.aborted || (error as Error).name === "AbortError") {
      return "timeout";
    }
    return isConnectionRefused(error) ? "not-running" : "error";
  } finally {
    clearTimeout(timer);
  }
}

/** Boolean compatibility wrapper for non-destructive health checks. */
export async function probeGateway(
  baseURL: string,
  timeoutMs = 1500,
): Promise<boolean> {
  return (await probeGatewayStatus(baseURL, timeoutMs)) === "healthy";
}

/**
 * Build the base URL for probing `host:port`, bracketing IPv6 literals so the
 * resulting URL is valid (e.g. `http://[::1]:3207`, not `http://::1:3207`).
 * A bare `:` in the host marks it as an IPv6 address (hostnames/IPv4 never
 * contain one); an already-bracketed value is left untouched.
 */
export function probeUrlFor(host: string, port: number): string {
  const connectHost =
    host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  return `http://${bracketHost(connectHost)}:${port}`;
}

/** Authenticate a persisted process record against every host it bound. */
export async function probeGatewayProcessHost(
  record: GatewayProcessRecord,
  timeoutMs = 1500,
): Promise<string | null> {
  const identities = await Promise.all(
    record.hosts.map((host) =>
      probeGatewayIdentity(
        probeUrlFor(host, record.port),
        record.token,
        timeoutMs,
      ),
    ),
  );
  const index = identities.findIndex(
    (identity) => identity?.pid === record.pid,
  );
  return index === -1 ? null : record.hosts[index];
}

/** Authenticate a persisted process record against every host it bound. */
export async function probeGatewayProcess(
  record: GatewayProcessRecord,
  timeoutMs = 1500,
): Promise<boolean> {
  return (await probeGatewayProcessHost(record, timeoutMs)) !== null;
}

/** Request graceful shutdown from the exact token-authenticated gateway. */
export async function requestGatewayShutdown(
  record: GatewayProcessRecord,
  timeoutMs = 1500,
): Promise<GatewayShutdownRequestResult> {
  const results = await Promise.all(
    record.hosts.map(async (host): Promise<GatewayShutdownRequestResult> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await internalProbeFetch(
          `${probeUrlFor(host, record.port)}/_lore/control`,
          {
            method: "POST",
            signal: controller.signal,
            headers: { authorization: `Bearer ${record.token}` },
          },
        );
        if (response.status === 404) return "unsupported";
        if (!response.ok) return "failed";
        const body = (await response.json()) as {
          status?: unknown;
          service?: unknown;
          pid?: unknown;
          shutdown?: unknown;
        };
        return body.status === "ok" &&
          body.service === "lore" &&
          body.pid === record.pid &&
          body.shutdown === "requested"
          ? "accepted"
          : "failed";
      } catch {
        return "failed";
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  if (results.some((result) => result === "accepted")) return "accepted";
  if (results.some((result) => result === "failed")) return "failed";
  return "unsupported";
}

/**
 * Probe several interfaces concurrently and return the FIRST host (by list
 * order) that answers `/health`, or `null` if none do. Concurrent so one
 * hanging/unreachable interface can't serialize the per-probe timeout onto the
 * rest. The `probe` is injectable so callers wired through `DaemonIO` (which
 * mocks/wraps the real probe) can reuse this.
 */
async function firstReachableHost(
  hosts: string[],
  port: number,
  probe: (url: string) => Promise<boolean> = probeGateway,
): Promise<string | null> {
  const results = await Promise.all(
    hosts.map((host) => probe(probeUrlFor(host, port))),
  );
  const idx = results.findIndex((alive) => alive);
  return idx === -1 ? null : hosts[idx];
}

/** Path to the daemon's combined stdout/stderr log. */
export function daemonLogPath(): string {
  return join(dataDir(), "gateway.log");
}

/** Open the daemon log for safe owner-only append. Caller must close it. */
export function openDaemonLogFile(): number {
  return openRuntimeFileForAppend("gateway.log");
}

/**
 * Reconstruct the argv for the detached child of `lore start --bg`.
 *
 * The child runs a plain foreground `start` with the same effective options,
 * MINUS the daemonize flag (or it would fork forever). Building from the typed
 * options — rather than mangling `process.argv` — keeps this deterministic and
 * unit-testable across the npm and standalone-binary invocation forms.
 */
export function buildStartChildArgs(opts: StartOptions): string[] {
  const args: string[] = ["start"];
  if (opts.port !== undefined) args.push("--port", String(opts.port));
  if (opts.hosts?.length) {
    for (const h of opts.hosts) args.push("--host", h);
  }
  if (opts.debug) args.push("--debug");
  if (opts.local) args.push("--local");
  if (opts.allowRemoteManagement) args.push("--allow-remote-management");
  if (opts.remoteUrl) args.push("--remote", opts.remoteUrl);
  return args;
}

/**
 * Whether we are running as a packaged single-executable (SEA) binary, in
 * which case `process.execPath` IS the lore program and no script path is
 * needed. In dev/npm mode `process.execPath` is node/bun and we must pass the
 * script (`process.argv[1]`) as the first arg.
 */
function isSeaBinary(): boolean {
  try {
    const sea = require("node:sea") as { isSea?: () => boolean };
    return typeof sea.isSea === "function" ? sea.isSea() : false;
  } catch {
    return false;
  }
}

/** Build the `{ command, args }` used to re-spawn lore detached. */
export function daemonSpawnSpec(opts: StartOptions): {
  command: string;
  args: string[];
} {
  const childArgs = buildStartChildArgs(opts);
  if (isSeaBinary()) {
    return { command: process.execPath, args: childArgs };
  }
  // Dev/npm: prepend the script path (node/bun <script> start …).
  return { command: process.execPath, args: [process.argv[1], ...childArgs] };
}

/**
 * The host the daemon parent should probe. The detached child binds to
 * `opts.hosts` (default 127.0.0.1), so a hardcoded 127.0.0.1 probe would time
 * out when the user started with a non-loopback `--host` (e.g. a Tailscale or
 * LAN address). Use the first configured host, falling back to loopback.
 */
export function daemonProbeHost(opts: StartOptions): string {
  const host = opts.hosts?.find((h) => h && h.length > 0);
  return host ?? "127.0.0.1";
}

/** Injectable IO for the daemon orchestration, so `runDaemon` is testable. */
export interface DaemonIO {
  readProcess: () => GatewayProcessRecord | null;
  authenticate: (record: GatewayProcessRecord) => Promise<string | null>;
  probeHealth: (url: string) => Promise<boolean>;
  /** Spawn the detached child gateway; returns its pid (or undefined). */
  spawnDaemon: () => number | undefined;
  inspectProcess: (pid: number) => ProcessInspection;
  terminate: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  removeProcess: (record: GatewayProcessRecord) => void;
  removePort: (port: number, token: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  logInfo: (msg: string) => void;
  logError: (msg: string) => void;
  /** Health-poll budget in ms (default 10s). */
  timeoutMs?: number;
  /** Poll interval in ms (default 250). */
  intervalMs?: number;
  /** Per-signal child-exit wait budget in ms. */
  cleanupTimeoutMs?: number;
}

async function waitForDaemonExit(
  pid: number,
  expectedProcessIdentity: string,
  io: DaemonIO,
  intervalMs: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = io.now() + timeoutMs;
  while (
    !daemonGenerationExited(pid, expectedProcessIdentity, io) &&
    io.now() < deadline
  ) {
    await io.sleep(intervalMs);
  }
  return daemonGenerationExited(pid, expectedProcessIdentity, io);
}

function inspectDaemonProcess(pid: number, io: DaemonIO): ProcessInspection {
  try {
    return io.inspectProcess(pid);
  } catch {
    return { state: "unknown" };
  }
}

function verifiedProcessIdentity(inspection: ProcessInspection): string | null {
  return inspection.state === "alive" &&
    inspection.identity !== null &&
    !inspection.identity.startsWith("unverified:")
    ? inspection.identity
    : null;
}

function daemonGenerationExited(
  pid: number,
  expectedProcessIdentity: string,
  io: DaemonIO,
): boolean {
  const inspection = inspectDaemonProcess(pid, io);
  return (
    inspection.state === "dead" ||
    (inspection.state === "alive" &&
      inspection.identity !== null &&
      inspection.identity !== expectedProcessIdentity)
  );
}

async function signalDaemonGeneration(
  pid: number,
  expectedProcessIdentity: string,
  signal: "SIGTERM" | "SIGKILL",
  io: DaemonIO,
): Promise<"signalled" | "exited" | "uncertain"> {
  try {
    return await withLifecycleLock("gateway-shutdown", (lock) => {
      lock.assertOwned();
      const inspection = inspectDaemonProcess(pid, io);
      if (
        inspection.state === "dead" ||
        (inspection.state === "alive" &&
          inspection.identity !== null &&
          inspection.identity !== expectedProcessIdentity)
      ) {
        return "exited";
      }
      if (
        inspection.state !== "alive" ||
        inspection.identity === null ||
        inspection.identity !== expectedProcessIdentity
      ) {
        return "uncertain";
      }
      lock.assertOwned();
      try {
        io.terminate(pid, signal);
      } catch (error) {
        const afterSignalFailure = inspectDaemonProcess(pid, io);
        if (
          afterSignalFailure.state === "dead" ||
          (afterSignalFailure.state === "alive" &&
            afterSignalFailure.identity !== null &&
            afterSignalFailure.identity !== expectedProcessIdentity)
        ) {
          return "exited";
        }
        throw error;
      }
      return "signalled";
    });
  } catch {
    // Lock loss, failed inspection, and signal errors are all ambiguous. Never
    // guess that the numeric PID still names the detached child.
    return "uncertain";
  }
}

async function terminateTimedOutDaemon(
  pid: number,
  expectedProcessIdentity: string | null,
  io: DaemonIO,
  intervalMs: number,
  expectedRecord: GatewayProcessRecord | null,
): Promise<{ stopped: boolean; signalled: boolean }> {
  if (expectedProcessIdentity === null) {
    // A live child without a verifiable start identity cannot be signalled.
    // A definitively dead PID is safe to classify as stopped, but a live or
    // unknown PID remains ambiguous even if its number matches the spawn result.
    return {
      stopped: inspectDaemonProcess(pid, io).state === "dead",
      signalled: false,
    };
  }

  const cleanupTimeout = io.cleanupTimeoutMs ?? SHUTDOWN_DEADLINE_MS;
  let signalled = false;
  const termResult = await signalDaemonGeneration(
    pid,
    expectedProcessIdentity,
    "SIGTERM",
    io,
  );
  if (termResult === "uncertain") {
    return { stopped: false, signalled };
  }
  signalled = termResult === "signalled";

  let exited =
    termResult === "exited" ||
    (await waitForDaemonExit(
      pid,
      expectedProcessIdentity,
      io,
      intervalMs,
      cleanupTimeout,
    ));
  if (!exited) {
    const killResult = await signalDaemonGeneration(
      pid,
      expectedProcessIdentity,
      "SIGKILL",
      io,
    );
    if (killResult === "uncertain") {
      return { stopped: false, signalled };
    }
    signalled ||= killResult === "signalled";
    exited =
      killResult === "exited" ||
      (await waitForDaemonExit(
        pid,
        expectedProcessIdentity,
        io,
        intervalMs,
        cleanupTimeout,
      ));
  }

  if (exited) {
    await withLifecycleLock("gateway-start", async (lifecycleLock) => {
      lifecycleLock.assertOwned();
      const record = io.readProcess();
      lifecycleLock.assertOwned();
      if (
        expectedRecord &&
        record?.pid === expectedRecord.pid &&
        record.token === expectedRecord.token &&
        record.processIdentity === expectedRecord.processIdentity
      ) {
        io.removeProcess(expectedRecord);
        lifecycleLock.assertOwned();
        io.removePort(expectedRecord.port, expectedRecord.token);
      }
    });
  }
  return { stopped: exited, signalled };
}

/**
 * Daemon orchestration: reuse an authenticated gateway, else spawn a detached
 * child and poll until its process record authenticates.
 */
export async function runDaemon(
  opts: StartOptions,
  io: DaemonIO,
): Promise<number> {
  // Public health proves availability, not ownership. Reuse only a process
  // record whose owner-only challenge authenticates against the recorded PID.
  const existingRecord = io.readProcess();
  if (existingRecord) {
    const reusedHost = await io.authenticate(existingRecord);
    if (reusedHost) {
      const url = probeUrlFor(reusedHost, existingRecord.port);
      io.logInfo(`Gateway already running on ${url}`);
      io.logInfo(`Dashboard: ${url}/ui`);
      io.logInfo(`Stop it with: lore stop`);
      return 0;
    }
  }

  // Generic health classifies a preferred-port occupant, but never authorizes
  // reuse. An explicit occupied port is an error; default ports may fall back.
  const configuredHosts = (
    opts.hosts?.length ? opts.hosts : ["127.0.0.1"]
  ).filter((host) => host.length > 0);
  const preferredPorts = opts.port === undefined ? DEFAULT_PORTS : [opts.port];
  for (const preferredPort of preferredPorts) {
    const foreignHost = await firstReachableHost(
      configuredHosts,
      preferredPort,
      io.probeHealth,
    );
    if (!foreignHost) continue;
    if (opts.port !== undefined) {
      io.logError(
        `Port ${opts.port} is already in use by another process (not an authenticated lore gateway).`,
      );
      return 1;
    }
    io.logInfo(
      `Preferred port ${preferredPort} is occupied by a foreign service; the background gateway will use its fallback chain.`,
    );
    break;
  }

  const spawned = await withLifecycleLock("gateway-start", (lifecycleLock) => {
    lifecycleLock.assertOwned();
    const pid = io.spawnDaemon();
    if (pid === undefined) return undefined;
    // Capture the process-start identity immediately while spawn ownership is
    // serialized. The numeric PID alone is never sufficient for later cleanup.
    const inspection = inspectDaemonProcess(pid, io);
    return {
      pid,
      processIdentity: verifiedProcessIdentity(inspection),
    };
  });
  if (spawned === undefined) {
    io.logError("Failed to spawn the background gateway.");
    return 1;
  }
  const { pid, processIdentity: spawnedProcessIdentity } = spawned;
  const timeout = io.timeoutMs ?? 10_000;
  const interval = io.intervalMs ?? 250;
  const deadline = io.now() + timeout;
  let spawnedRecord: GatewayProcessRecord | null = null;
  while (io.now() < deadline) {
    await io.sleep(interval);
    const record = io.readProcess();
    const isSpawnedGeneration =
      spawnedProcessIdentity !== null &&
      record?.version === 2 &&
      record.pid === pid &&
      record.processIdentity === spawnedProcessIdentity;
    if (isSpawnedGeneration) spawnedRecord = record;
    const authenticatedHost = record ? await io.authenticate(record) : null;
    if (record && authenticatedHost) {
      const url = probeUrlFor(authenticatedHost, record.port);
      io.logInfo(
        isSpawnedGeneration
          ? `Gateway started in the background (pid ${pid})`
          : `Gateway already running in the background (pid ${record.pid})`,
      );
      io.logInfo(`Listening on ${url}`);
      io.logInfo(`Dashboard: ${url}/ui`);
      io.logInfo(`Logs: ${daemonLogPath()}`);
      io.logInfo(`Stop it with: lore stop`);
      return 0;
    }
  }

  const cleanup = await terminateTimedOutDaemon(
    pid,
    spawnedProcessIdentity,
    io,
    interval,
    spawnedRecord,
  );
  if (cleanup.stopped && cleanup.signalled) {
    io.logError(
      `Gateway did not establish authenticated ownership within ${timeout}ms; terminated background pid ${pid}. Check the log: ${daemonLogPath()}`,
    );
  } else if (cleanup.stopped) {
    io.logError(
      `Gateway did not establish authenticated ownership within ${timeout}ms; background pid ${pid}'s spawned process generation is no longer running. Check the log: ${daemonLogPath()}`,
    );
  } else {
    io.logError(
      `Gateway startup failed with unknown child state: background pid ${pid} did not establish authenticated ownership and could not be confirmed stopped. Check the log and process before retrying: ${daemonLogPath()}`,
    );
  }
  return 1;
}

/** Spawn the detached child gateway with stdio redirected to the log file. */
function spawnDetachedGateway(opts: StartOptions): number | undefined {
  const logFd = openDaemonLogFile();
  const { command, args } = daemonSpawnSpec(opts);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(command, args, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    });
  } finally {
    closeSync(logFd);
  }
  child.unref();
  return child.pid;
}

/** Build the real (production) IO for {@link runDaemon}. */
export function realDaemonIO(opts: StartOptions): DaemonIO {
  return {
    readProcess: readGatewayProcessFile,
    authenticate: probeGatewayProcessHost,
    probeHealth: probeGateway,
    spawnDaemon: () => spawnDetachedGateway(opts),
    inspectProcess: inspectProcessGeneration,
    terminate: (pid, signal) => process.kill(pid, signal),
    removeProcess: removeGatewayProcessFile,
    removePort: removePortFile,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: Date.now,
    logInfo: (msg) => console.log(`[lore] ${msg}`),
    logError: (msg) => console.error(`[lore] ${msg}`),
  };
}

/**
 * Daemonize: re-spawn `lore start` detached with stdio redirected to a log
 * file, poll until the gateway is healthy, print where it's listening, and
 * exit. Thin shell around `runDaemon` that supplies real IO and calls
 * `safeExit`.
 */
async function startDaemon(opts: StartOptions): Promise<never> {
  safeExit(await runDaemon(opts, realDaemonIO(opts)));
}

/**
 * Start the gateway server, returning the actual port and a shutdown function.
 *
 * Merges CLI options on top of env-var config (CLI takes precedence).
 *
 * When the port is not explicitly set (no `--port` / `LORE_LISTEN_PORT`),
 * the server tries a fallback chain: 3207 → 5673 → OS-assigned random port.
 * At each step, if the port is occupied by an existing lore gateway
 * (verified via its process record and owner-only control token), returns a
 * handle with `owned: false`
 * so the caller can reuse the existing instance.
 */
export async function startGateway(
  opts: StartOptions = {},
  ioOverrides: Partial<StartGatewayIO> = {},
): Promise<GatewayHandle> {
  return withLifecycleLock("gateway-start", (lifecycleLock) =>
    startGatewayLocked(opts, ioOverrides, lifecycleLock),
  );
}

async function startGatewayLocked(
  opts: StartOptions,
  ioOverrides: Partial<StartGatewayIO>,
  lifecycleLock: LifecycleLock,
): Promise<GatewayHandle> {
  const io: StartGatewayIO = { ...realStartGatewayIO, ...ioOverrides };
  const config = loadConfig();

  // In-process callers (OpenCode plugin, Pi extension) pass `quiet: true`.
  // They run inside the host agent's full-screen TUI, where ANY stdout/stderr
  // write corrupts the rendered screen. Route the gateway's own startup/
  // shutdown notices through the core `log` module (file-based, terminal-
  // suppressed) when quiet; otherwise keep the visible `console.error` notices
  // for the `lore start` CLI.
  const quiet = opts.quiet === true;
  const notify = (msg: string): void => {
    if (quiet) log.warn(msg);
    else console.error(`[lore] ${msg}`);
  };

  // CLI overrides
  if (opts.port !== undefined) {
    config.port = opts.port;
    config.portExplicit = true;
  }
  if (opts.hosts?.length) config.hosts = opts.hosts;
  if (opts.debug !== undefined) config.debug = opts.debug;
  if (opts.allowRemoteManagement !== undefined) {
    config.allowRemoteManagement = opts.allowRemoteManagement;
  }

  // Hosted mode: `--local` CLI flag takes precedence, then env var,
  // then the caller-provided default. `lore start` leaves `opts.local`
  // undefined (→ hosted mode ON by default), while `lore run`,
  // `lore import`, and in-process callers (OpenCode plugin, Pi extension)
  // set `opts.local = true` (→ hosted mode OFF).
  //
  // IMPORTANT: In-process callers MUST pass `local: true` — hosted mode
  // is a process-wide flag that disables filesystem operations in
  // @loreai/core. When the gateway runs in the same process as the
  // plugin/extension, enabling hosted mode breaks the plugin's own
  // getGitRemote(), .lore.md import, config loading, and file watching.
  if (opts.local !== undefined) {
    config.hostedMode = !opts.local;
  } else if (!process.env.LORE_HOSTED_MODE) {
    // No explicit env var and no CLI flag — apply caller default.
    // `lore start` (opts.local === undefined) defaults to hosted mode.
    config.hostedMode = true;
  }
  // else: LORE_HOSTED_MODE env var was set — loadConfig() already handled it.

  // Remote-gateway mode follows the same layering as hosted mode:
  // `--local` opts out, explicit env vars win, and `lore start` (the
  // long-running-gateway command) defaults to `remoteGateway = true`
  // because running a long-lived gateway is a strong signal that other
  // machines are going to talk to it. `loadConfig()` already applied
  // explicit env vars and bind-address auto-detection; here we only
  // upgrade the default for `lore start` when nothing else set it.
  if (opts.local === true) {
    // --local flag always disables remote mode, mirroring hosted mode.
    config.remoteGateway = false;
    config.remoteGatewayAutoDetected = false;
  } else if (
    opts.local === undefined &&
    !("LORE_REMOTE_GATEWAY" in process.env) &&
    !("LORE_HOSTED_MODE" in process.env)
  ) {
    // No --local, no explicit env vars. loadConfig() may have set
    // remoteGateway via bind-address auto-detection — preserve that.
    // Otherwise, this is `lore start` — default to remote mode.
    if (!config.remoteGateway) {
      config.remoteGateway = true;
      config.remoteGatewayCommandDefault = true;
    }
  }

  // Validate after CLI/env/default mode precedence is fully applied. In
  // particular, `--local` must be able to opt out before this invariant runs.
  assertGatewayAccessConfigured(config);

  // Build the list of ports to try.
  // Explicit port: single attempt, fail hard on conflict.
  // Default: 3207 → 5673 → 0 (OS-assigned random).
  const portsToTry: number[] = config.portExplicit
    ? [config.port]
    : [...DEFAULT_PORTS, 0];
  const controlToken = randomBytes(32).toString("base64url");
  // Windows has no race-free creation-time query in Node. Publish an explicit
  // unverified identity so discovery works, while destructive stop fails closed.
  const processIdentity =
    currentProcessIdentity() ?? `unverified:${controlToken}`;

  // With no explicit port, reuse an authenticated gateway wherever it actually
  // bound (including a fallback/random port). The process record is the source
  // of identity; public health and the port file are not.
  if (!config.portExplicit) {
    const record = io.readProcess();
    if (record) {
      const authenticatedHost = await io.authenticate(record);
      if (authenticatedHost) {
        config.port = record.port;
        config.hosts = [authenticatedHost];
        return {
          config,
          port: record.port,
          owned: false,
          managementToken: record.token,
          shutdown: async () => {},
        };
      }
    }
  }

  for (const candidatePort of portsToTry) {
    config.port = candidatePort;

    // Pre-bind identity/occupancy probe (issue #908). Only an authenticated
    // owner record establishes Lore identity; public /health merely classifies
    // an unauthenticated occupant as foreign.
    //
    // Skip port 0 (OS-assigned random): nothing can already be listening there,
    // and port 0 is not a probeable address. Default config.hosts is
    // ["127.0.0.1"], so the common cold-start cost here is a single fast,
    // connection-refused loopback probe.
    if (candidatePort !== 0) {
      const record = io.readProcess();
      const authenticatedHost =
        record?.port === candidatePort ? await io.authenticate(record) : null;
      if (record && authenticatedHost) {
        config.hosts = [authenticatedHost];
        return {
          config,
          port: candidatePort,
          owned: false,
          managementToken: record.token,
          shutdown: async () => {},
        };
      }

      const probeHosts = [
        ...new Set([
          "127.0.0.1",
          ...config.hosts,
          ...(record?.port === candidatePort ? record.hosts : []),
        ]),
      ];
      const foreignHost = await firstReachableHost(probeHosts, candidatePort);
      if (foreignHost) {
        if (config.portExplicit) {
          throw new Error(
            `Port ${candidatePort} is already in use by another process (not an authenticated lore gateway). ` +
              `Use --port / LORE_LISTEN_PORT to pick a different port.`,
          );
        }
        const nextIdx = portsToTry.indexOf(candidatePort) + 1;
        const nextPort = portsToTry[nextIdx];
        const nextLabel = nextPort === 0 ? "random port" : String(nextPort);
        notify(
          `Port ${candidatePort} in use (not an authenticated lore gateway), trying ${nextLabel}…`,
        );
        continue;
      }
    }

    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    let remoteShutdown: (() => void) | undefined;
    try {
      // startServer() binds each host and awaits the OS bind internally, so an
      // EADDRINUSE rejection surfaces from THIS await (not from `server.ready`).
      // It MUST be inside the try so the catch below can probe for and reuse an
      // existing lore gateway instead of crashing.
      lifecycleLock.assertOwned();
      server = await withoutLifecycleLock(() =>
        io.startServer(config, {
          controlToken,
          onShutdown: () => {
            if (!remoteShutdown) {
              notify(
                "Remote shutdown was requested before gateway publication; refusing.",
              );
              process.exitCode = 1;
              return;
            }
            remoteShutdown();
          },
        }),
      );
      await server.ready; // already resolved by startServer; kept for clarity
      const actualPort = server.port;
      // startServer() may drop hosts that aren't currently bindable (e.g. a
      // stale Tailscale IP → EADDRNOTAVAIL). Reflect the hosts we actually
      // bound so the "listening on …" log and /health probes don't advertise
      // an interface that's down.
      if (server.hosts.length) config.hosts = server.hosts;

      try {
        // Publish a shared generation token in both discovery records. The PID
        // record additionally binds the token to this process-start identity.
        lifecycleLock.assertOwned();
        io.writePort(actualPort, controlToken);
        lifecycleLock.assertOwned();
        const processRecord: GatewayProcessRecord = {
          version: 2,
          pid: process.pid,
          port: actualPort,
          hosts: server.hosts,
          token: controlToken,
          processIdentity,
        };
        io.writeProcess(processRecord);
      } catch (publicationError) {
        let closeError: unknown;
        try {
          await server.stop();
        } catch (error) {
          closeError = error;
        }
        if (closeError === undefined) {
          // Remove discovery only after listener closure is confirmed. If close
          // fails, retain evidence for the possibly-live listener.
          const published = io.readProcess();
          try {
            lifecycleLock.assertOwned();
            io.removePort(actualPort, controlToken);
          } finally {
            if (
              published?.pid === process.pid &&
              published.token === controlToken &&
              published.processIdentity === processIdentity
            ) {
              lifecycleLock.assertOwned();
              io.removeProcess(process.pid, published);
            }
          }
        } else {
          server = undefined;
          throw new AggregateError(
            [publicationError, closeError],
            "Gateway publication failed and the live listener could not be closed; discovery evidence was retained.",
          );
        }
        throw publicationError;
      }

      const boundServer = server;
      let shutdownPromise: Promise<void> | undefined;
      const shutdown = (): Promise<void> => {
        shutdownPromise ??= withLifecycleLock(
          "gateway-shutdown",
          async (shutdownLock) => {
            notify("Shutting down…");
            let shutdownError: unknown;
            let listenerClose: Promise<void> | undefined;
            let listenerCloseError: unknown;
            try {
              shutdownLock.assertOwned();
              // server.close() synchronously stops accepting new work, but its
              // promise waits for active streams. Start closure first, then
              // cancel/reset pipeline work so those streams can settle.
              listenerClose = boundServer.stop().catch((error: unknown) => {
                listenerCloseError = error;
              });
            } catch (error) {
              listenerCloseError = error;
            }
            try {
              shutdownLock.assertOwned();
              await io.resetPipelineState({ fast: true });
            } catch (error) {
              shutdownError ??= error;
            }
            if (listenerClose) {
              await listenerClose;
            }
            shutdownError ??= listenerCloseError;
            // Preserve current-main embed/vector/DB ordering while the
            // lifecycle lock excludes a successor start.
            try {
              shutdownLock.assertOwned();
              await embedding.settleDocumentEmbeds(EMBED_DRAIN_DEADLINE_MS);
            } catch (error) {
              shutdownError ??= error;
            }
            try {
              shutdownLock.assertOwned();
              await embedding.resetProvider();
            } catch (error) {
              shutdownError ??= error;
            }
            try {
              shutdownLock.assertOwned();
              await shutdownVectorPoolAsync(VECTOR_POOL_SHUTDOWN_DEADLINE_MS);
            } catch (error) {
              shutdownError ??= error;
            }
            try {
              shutdownLock.assertOwned();
              closeDb();
            } catch (error) {
              // SQLite recovery handles a failed best-effort checkpoint. Keep
              // the established current-main behavior: warn but do not wedge
              // shutdown or retain an otherwise-stale process record for it.
              notify(
                `Database close warning: ${error instanceof Error ? error.message : String(error)}`,
              );
            }

            if (shutdownError) throw shutdownError;

            // Discovery is removed only after listener and worker teardown.
            shutdownLock.assertOwned();
            io.removePort(actualPort, controlToken);
            const current = io.readProcess();
            if (
              current?.pid === process.pid &&
              current.token === controlToken &&
              current.processIdentity === processIdentity
            ) {
              shutdownLock.assertOwned();
              io.removeProcess(current.pid, current);
            }
          },
          {
            timeoutMs: Math.max(1, Math.floor(SHUTDOWN_DEADLINE_MS / 2)),
          },
        );
        return shutdownPromise;
      };
      const processShutdown = opts.processBoundary
        ? io.createProcessShutdownController(shutdown)
        : undefined;
      remoteShutdown = () => {
        if (processShutdown) {
          void processShutdown(0);
          return;
        }
        void shutdown().catch((error: unknown) => {
          notify(
            `Remote shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          process.exitCode = 1;
        });
      };

      if (candidatePort === 0) {
        notify(
          `Preferred ports (${DEFAULT_PORTS.join(", ")}) were unavailable; using port ${actualPort}`,
        );
      }

      return {
        config,
        port: actualPort,
        owned: true,
        managementToken: controlToken,
        shutdown,
        processShutdown,
      };
    } catch (e) {
      // Clean up any successfully-bound servers before retrying.
      // In multi-host configs, some hosts may have bound before another
      // failed with EADDRINUSE — stop them to avoid leaking FDs.
      // `server` is undefined when startServer() itself rejected (the common
      // EADDRINUSE case), in which case there is nothing to stop here.
      if (server) await server.stop();

      const msg = e instanceof Error ? e.message : String(e);
      if (!(/port\b.*\bin use/i.test(msg) || /EADDRINUSE/i.test(msg))) {
        throw e; // Not a port conflict — don't retry
      }

      // Port is occupied — re-read and authenticate the exact persisted owner.
      // Public health never establishes identity.
      if (candidatePort !== 0) {
        const record = io.readProcess();
        const authenticatedHost =
          record?.port === candidatePort ? await io.authenticate(record) : null;
        if (record && authenticatedHost) {
          config.hosts = [authenticatedHost];
          return {
            config,
            port: candidatePort,
            owned: false,
            managementToken: record.token,
            shutdown: async () => {},
          };
        }
      }

      // Port is taken by something else — try next candidate if available.
      if (config.portExplicit) {
        throw new Error(
          `Port ${candidatePort} is already in use by another process (not an authenticated lore gateway). ` +
            `Use --port / LORE_LISTEN_PORT to pick a different port.`,
        );
      }

      // Log the fallback (not for port 0 since that always succeeds).
      const nextIdx = portsToTry.indexOf(candidatePort) + 1;
      if (nextIdx < portsToTry.length) {
        const nextPort = portsToTry[nextIdx];
        const nextLabel = nextPort === 0 ? "random port" : String(nextPort);
        notify(
          `Port ${candidatePort} in use (not an authenticated lore gateway), trying ${nextLabel}…`,
        );
      }
    }
  }

  // Unreachable — port 0 always succeeds or throws a non-EADDRINUSE error.
  throw new Error("Failed to bind to any port.");
}

/**
 * Run the `lore start` command — start gateway server and block until
 * SIGINT/SIGTERM.
 */
export async function commandStart(opts: StartOptions): Promise<never> {
  // Background mode: re-spawn detached, report status, and exit.
  if (opts.bg) {
    return startDaemon(opts);
  }

  const { config, port, owned, shutdown, processShutdown } = await startGateway(
    {
      ...opts,
      processBoundary: true,
    },
  );

  const addrs = config.hosts.map((host) => probeUrlFor(host, port));

  if (!owned) {
    // Another lore gateway is already running — nothing to do.
    console.log(`[lore] Gateway already running on ${addrs.join(", ")}`);
    console.log(`[lore] Dashboard: ${addrs[0]}/ui`);
    if (!opts.quiet) {
      console.log(
        "[lore] Use that instance, or stop it first to start a new one.",
      );
      console.log(
        "[lore] Note: hosted mode setting reflects the running instance, not this invocation.",
      );
    }
    safeExit(0);
  }

  console.log(`[lore] Gateway listening on ${addrs.join(", ")}`);
  console.log(`[lore] Dashboard: ${addrs[0]}/ui`);

  if (!opts.quiet) {
    const localAddr = addrs[0];
    // Surface remote-gateway mode status with a clear, actionable log.
    // Helps the user verify that the lore-config bucketing fix is active
    // (so unrelated sessions won't merge onto this gateway's cwd).
    if (config.remoteGateway) {
      const reason = process.env.LORE_REMOTE_GATEWAY
        ? "LORE_REMOTE_GATEWAY=1"
        : process.env.LORE_HOSTED_MODE
          ? "LORE_HOSTED_MODE=1"
          : config.remoteGatewayAutoDetected
            ? `non-loopback bind (${config.hosts.join(",")})`
            : config.remoteGatewayCommandDefault
              ? "`lore start` default (long-running gateway)"
              : "explicit";
      console.log(
        `[lore] remote gateway mode ACTIVE (${reason}) — path-less sessions route to /__lore_unattributed__/<sessionID> instead of cwd`,
      );
      if (config.remoteGatewayCommandDefault) {
        console.log(
          `[lore]   pass \`--local\` or set LORE_REMOTE_GATEWAY=0 to disable for local dev`,
        );
      }
    } else {
      console.log(
        `[lore] remote gateway mode OFF (cwd fallback active) — set LORE_REMOTE_GATEWAY=1 for long-running/remote setups`,
      );
    }
    console.log("");
    console.log(
      `[lore] Model routing: claude-* → Anthropic, nvidia/* → Nvidia NIM, gpt-* → OpenAI, …`,
    );
    console.log("");
    console.log("[lore] Point your AI agent at the gateway:");
    console.log(`  export ANTHROPIC_BASE_URL=${localAddr}`);
    console.log(`  export OPENAI_BASE_URL=${localAddr}/v1`);
    console.log("");
    console.log("[lore] IMPORTANT: When using Claude Code, also set:");
    console.log("  export DISABLE_AUTO_COMPACT=1");
    console.log("");
    console.log("[lore] Configuration (environment variables):");
    console.log(
      `  LORE_LISTEN_PORT        Port to listen on (current: ${port})`,
    );
    console.log(
      `  LORE_LISTEN_HOST        Hosts to bind to, comma-separated (current: ${config.hosts.join(",")})`,
    );
    console.log(
      `  LORE_UPSTREAM_ANTHROPIC Anthropic API URL (current: ${config.upstreamAnthropic})`,
    );
    console.log(
      `  LORE_UPSTREAM_OPENAI    OpenAI API URL (current: ${config.upstreamOpenAI})`,
    );
    console.log(
      `  LORE_IDLE_TIMEOUT       Idle timeout in seconds (current: ${config.idleTimeoutSeconds})`,
    );
    console.log(
      `  LORE_DEBUG              Enable debug logging (current: ${config.debug})`,
    );
    console.log(
      `  LORE_BATCH_DISABLED     Disable batch background work (current: ${process.env.LORE_BATCH_DISABLED === "1"})`,
    );
    console.log(
      `  LORE_REMOTE_URL         Remote gateway URL for \`lore run\` (delegates instead of starting local)`,
    );
    console.log(
      `  LORE_GATEWAY_AUTH_TOKEN Access token required by remote/hosted data-plane routes (value is never printed)`,
    );
    console.log(
      `  LORE_HOSTED_MODE        Hosted mode — disable FS ops on client-controlled paths (current: ${config.hostedMode}, default for \`lore start\`: true)`,
    );
    console.log(
      `  LORE_REMOTE_GATEWAY     Remote-gateway mode — bucket path-less sessions per-session (current: ${config.remoteGateway}, default for \`lore start\`: true, pass --local to disable)`,
    );
  }
  // Block until signal — bounded shutdown + force-exit on a second interrupt.
  installSignalShutdown(shutdown, processShutdown);

  // Keep the process alive (the HTTP server already does this, but be explicit)
  return new Promise(() => {});
}
