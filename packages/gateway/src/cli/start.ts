/**
 * `lore start` — start the gateway server without auto-launching an agent.
 *
 * Extracted from the old top-level index.ts boot logic.
 */
import { spawn } from "node:child_process";
import { openSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, DEFAULT_PORTS, type GatewayConfig } from "../config";
import { startServer } from "../server";
import { resetPipelineState } from "../pipeline";
import { writePortFile, removePortFile, readPortFile } from "../portfile";
import { writePidFile, removePidFile } from "../pidfile";
import { dataDir, embedding } from "@loreai/core";
import { safeExit } from "./exit";
import { installSignalShutdown } from "./shutdown";

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
  /**
   * When true, `lore start` daemonizes: it re-spawns itself detached, polls
   * the gateway until healthy, prints the address + PID + log path, and exits 0.
   * CLI: `--bg` / `--daemon`.
   */
  bg?: boolean;
}

export interface GatewayHandle {
  config: GatewayConfig;
  port: number;
  /** Whether this process owns the server (started it). False when reusing an existing instance. */
  owned: boolean;
  /** Shut down the gateway. No-op when `owned` is false. */
  shutdown: () => Promise<void>;
}

/**
 * Probe a running gateway at the given URL via its `/health` endpoint.
 * Returns `true` if the response is 2xx, `false` on any error or timeout.
 */
export async function probeGateway(
  baseURL: string,
  timeoutMs = 1500,
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${baseURL}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Build the base URL for probing `host:port`, bracketing IPv6 literals so the
 * resulting URL is valid (e.g. `http://[::1]:3207`, not `http://::1:3207`).
 * A bare `:` in the host marks it as an IPv6 address (hostnames/IPv4 never
 * contain one); an already-bracketed value is left untouched.
 */
function probeUrlFor(host: string, port: number): string {
  const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${h}:${port}`;
}

/**
 * Probe several interfaces concurrently for a live lore gateway on `port`.
 * Resolves `true` as soon as ANY host answers `/health`, `false` only once
 * every probe has failed. Concurrent so one hanging interface can't serialize
 * the per-probe timeout onto the rest.
 */
async function anyGatewayAlive(
  hosts: string[],
  port: number,
): Promise<boolean> {
  const results = await Promise.all(
    hosts.map((host) => probeGateway(probeUrlFor(host, port))),
  );
  return results.some((alive) => alive);
}

/** Path to the daemon's combined stdout/stderr log. */
export function daemonLogPath(): string {
  return join(dataDir(), "gateway.log");
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
  readPort: () => number | null;
  probe: (url: string) => Promise<boolean>;
  /** Spawn the detached child gateway; returns its pid (or undefined). */
  spawnDaemon: () => number | undefined;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  logInfo: (msg: string) => void;
  logError: (msg: string) => void;
  /** Health-poll budget in ms (default 10s). */
  timeoutMs?: number;
  /** Poll interval in ms (default 250). */
  intervalMs?: number;
}

/**
 * Daemon orchestration: reuse an already-running gateway, else spawn the
 * detached child and poll until it's serving. Returns the process exit code
 * (0 = healthy/reused, 1 = timed out). Pure of `process.exit` so it is
 * unit-testable; `startDaemon` is the thin shell that wires real IO + exit.
 */
export async function runDaemon(
  opts: StartOptions,
  io: DaemonIO,
): Promise<number> {
  const host = daemonProbeHost(opts);

  // If a gateway is already up on the preferred port, don't start a second one.
  const existingPort = io.readPort();
  if (existingPort) {
    const url = `http://${host}:${existingPort}`;
    if (await io.probe(url)) {
      io.logInfo(`Gateway already running on ${url}`);
      io.logInfo(`Dashboard: ${url}/ui`);
      io.logInfo(`Stop it with: lore stop`);
      return 0;
    }
  }

  const pid = io.spawnDaemon();
  const timeout = io.timeoutMs ?? 10_000;
  const interval = io.intervalMs ?? 250;
  const deadline = io.now() + timeout;
  while (io.now() < deadline) {
    await io.sleep(interval);
    const port = io.readPort();
    if (port && (await io.probe(`http://${host}:${port}`))) {
      const url = `http://${host}:${port}`;
      io.logInfo(`Gateway started in the background (pid ${pid})`);
      io.logInfo(`Listening on ${url}`);
      io.logInfo(`Dashboard: ${url}/ui`);
      io.logInfo(`Logs: ${daemonLogPath()}`);
      io.logInfo(`Stop it with: lore stop`);
      return 0;
    }
  }

  io.logError(
    `Gateway did not become healthy within ${timeout}ms. Check the log: ${daemonLogPath()}`,
  );
  return 1;
}

/** Spawn the detached child gateway with stdio redirected to the log file. */
function spawnDetachedGateway(opts: StartOptions): number | undefined {
  const logPath = daemonLogPath();
  mkdirSync(dataDir(), { recursive: true });
  const logFd = openSync(logPath, "a");
  const { command, args } = daemonSpawnSpec(opts);
  const child = spawn(command, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  child.unref();
  return child.pid;
}

/** Build the real (production) IO for {@link runDaemon}. */
export function realDaemonIO(opts: StartOptions): DaemonIO {
  return {
    readPort: readPortFile,
    probe: probeGateway,
    spawnDaemon: () => spawnDetachedGateway(opts),
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
 * (verified via `/health` probe), returns a handle with `owned: false`
 * so the caller can reuse the existing instance.
 */
export async function startGateway(
  opts: StartOptions = {},
): Promise<GatewayHandle> {
  const config = loadConfig();

  // CLI overrides
  if (opts.port !== undefined) {
    config.port = opts.port;
    config.portExplicit = true;
  }
  if (opts.hosts?.length) config.hosts = opts.hosts;
  if (opts.debug !== undefined) config.debug = opts.debug;

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

  // Build the list of ports to try.
  // Explicit port: single attempt, fail hard on conflict.
  // Default: 3207 → 5673 → 0 (OS-assigned random).
  const portsToTry: number[] = config.portExplicit
    ? [config.port]
    : [...DEFAULT_PORTS, 0];

  for (const candidatePort of portsToTry) {
    config.port = candidatePort;
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      // startServer() binds each host and awaits the OS bind internally, so an
      // EADDRINUSE rejection surfaces from THIS await (not from `server.ready`).
      // It MUST be inside the try so the catch below can probe for and reuse an
      // existing lore gateway instead of crashing.
      server = await startServer(config);
      await server.ready; // already resolved by startServer; kept for clarity
      const actualPort = server.port;
      // startServer() may drop hosts that aren't currently bindable (e.g. a
      // stale Tailscale IP → EADDRNOTAVAIL). Reflect the hosts we actually
      // bound so the "listening on …" log and /health probes don't advertise
      // an interface that's down.
      if (server.hosts.length) config.hosts = server.hosts;

      // Write port file so plugins can discover us (even on random port).
      writePortFile(actualPort);
      // Write pid file so `lore stop` can find and signal this process.
      writePidFile();

      const boundServer = server;
      let shutdownStarted = false;
      const shutdown = async () => {
        if (shutdownStarted) return;
        shutdownStarted = true;
        console.error("[lore] Shutting down…");
        boundServer.stop();
        removePortFile(actualPort);
        removePidFile();
        // `fast`: skip the synchronous batch-queue LLM drain on process exit —
        // replaying queued background prompts through retries is what made
        // Ctrl+C hang for minutes. They resume next session.
        await resetPipelineState({ fast: true });
        // Shut down the embedding worker thread gracefully. Done after
        // resetPipelineState (which clears sessions/timers) but before
        // safeExit — gives the worker time to exit cleanly via its
        // "shutdown" message handler rather than being killed by _exit().
        await embedding.resetProvider();
      };

      if (candidatePort === 0) {
        console.error(
          `[lore] Preferred ports (${DEFAULT_PORTS.join(", ")}) were unavailable; using port ${actualPort}`,
        );
      }

      return { config, port: actualPort, owned: true, shutdown };
    } catch (e) {
      // Clean up any successfully-bound servers before retrying.
      // In multi-host configs, some hosts may have bound before another
      // failed with EADDRINUSE — stop them to avoid leaking FDs.
      // `server` is undefined when startServer() itself rejected (the common
      // EADDRINUSE case), in which case there is nothing to stop here.
      server?.stop();

      const msg = e instanceof Error ? e.message : String(e);
      if (!(/port\b.*\bin use/i.test(msg) || /EADDRINUSE/i.test(msg))) {
        throw e; // Not a port conflict — don't retry
      }

      // Port is occupied — check if it's a lore gateway we can reuse.
      // (Skip probe for port 0 — it can't EADDRINUSE.)
      //
      // The running gateway may be bound to an interface other than
      // config.hosts[0] (e.g. it's on 127.0.0.1 while we're configured for a
      // LAN/Tailscale IP, or vice versa). Probe 127.0.0.1 (always reachable for
      // a local gateway) plus every configured host before declaring the port
      // foreign-owned — otherwise a healthy lore gateway gets misreported as
      // "port in use".
      //
      // Probe in parallel and adopt the first interface that answers: probes
      // are independent, and a hanging/unreachable host (e.g. a stale Tailscale
      // address) must not serialize 1.5s timeouts onto the others.
      if (candidatePort !== 0) {
        const probeHosts = [...new Set(["127.0.0.1", ...config.hosts])];
        const alive = await anyGatewayAlive(probeHosts, candidatePort);
        if (alive) {
          return {
            config,
            port: candidatePort,
            owned: false,
            shutdown: async () => {},
          };
        }
      }

      // Port is taken by something else — try next candidate if available.
      if (config.portExplicit) {
        throw new Error(
          `Port ${candidatePort} is already in use by another process (not a lore gateway). ` +
            `Use --port / LORE_LISTEN_PORT to pick a different port.`,
        );
      }

      // Log the fallback (not for port 0 since that always succeeds).
      const nextIdx = portsToTry.indexOf(candidatePort) + 1;
      if (nextIdx < portsToTry.length) {
        const nextPort = portsToTry[nextIdx];
        const nextLabel = nextPort === 0 ? "random port" : String(nextPort);
        console.error(
          `[lore] Port ${candidatePort} in use (not a lore gateway), trying ${nextLabel}…`,
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

  const { config, port, owned, shutdown } = await startGateway(opts);

  const addrs = config.hosts.map((h) => `http://${h}:${port}`);

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
      `  LORE_HOSTED_MODE        Hosted mode — disable FS ops on client-controlled paths (current: ${config.hostedMode}, default for \`lore start\`: true)`,
    );
    console.log(
      `  LORE_REMOTE_GATEWAY     Remote-gateway mode — bucket path-less sessions per-session (current: ${config.remoteGateway}, default for \`lore start\`: true, pass --local to disable)`,
    );
  }
  // Block until signal — bounded shutdown + force-exit on a second interrupt.
  installSignalShutdown(shutdown);

  // Keep the process alive (the HTTP server already does this, but be explicit)
  return new Promise(() => {});
}
