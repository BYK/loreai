/**
 * `lore start` — start the gateway server without auto-launching an agent.
 *
 * Extracted from the old top-level index.ts boot logic.
 */
import { loadConfig, DEFAULT_PORTS, type GatewayConfig } from "../config";
import { startServer } from "../server";
import { resetPipelineState } from "../pipeline";
import { writePortFile, removePortFile } from "../portfile";
import { embedding } from "@loreai/core";
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

      // Write port file so plugins can discover us (even on random port).
      writePortFile(actualPort);

      const boundServer = server;
      let shutdownStarted = false;
      const shutdown = async () => {
        if (shutdownStarted) return;
        shutdownStarted = true;
        console.error("[lore] Shutting down…");
        boundServer.stop();
        removePortFile(actualPort);
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
      if (candidatePort !== 0) {
        const probeUrl = `http://${config.hosts[0]}:${candidatePort}`;
        const alive = await probeGateway(probeUrl);
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
