/**
 * `lore start` — typed Stricli command (Phase 3B.2).
 *
 * Starts the gateway server (foreground or detached via `--bg`).
 * Calls the existing `commandStart` lifecycle handler from `../start`.
 * The lifecycle handler takes:
 *
 *   opts.port       — port to bind (number, optional)
 *   opts.hosts      — hostnames to bind (string[], optional)
 *   opts.debug      — verbose banner (boolean, optional)
 *   opts.remoteUrl  — remote gateway URL (string, optional)
 *   opts.local      — disable hosted mode (boolean, optional)
 *   opts.bg         — daemonize and exit (boolean, optional; aliased to
 *                     `--daemon`)
 *
 * The handler returns `Promise<void>` and never resolves in the
 * foreground path — Stricli awaits the return value, so the gateway
 * runs until SIGINT/SIGTERM. The typed wrapper does NOT itself call
 * `process.exit`; the `startDaemon` (background) path returns after
 * the child is launched.
 */
import { buildCommand } from "../lib/command";
import { commandStart, type StartOptions } from "../start";

type StartFlags = {
  port?: number;
  host?: string[];
  debug?: boolean;
  remote?: string;
  local?: boolean;
  bg?: boolean;
  daemon?: boolean;
};

export const startCommand = buildCommand<StartFlags, []>({
  brief: "Start the lore gateway (foreground or background)",
  fullDescription:
    "Start the lore gateway server. Without `--bg` the gateway blocks " +
    "in the foreground until SIGINT/SIGTERM. With `--bg` (or `--daemon`) " +
    "the process detaches, prints the gateway address + PID + log path, " +
    "and exits 0. Flags: --port/-p, --host (repeatable), --debug/-d, " +
    "--remote/-r, --local/-l, --bg/--daemon.",
  parameters: {
    // -H is reserved by Stricli for help, so --host has no short alias.
    // The remaining legacy aliases are retained.
    aliases: { p: "port", d: "debug", r: "remote", l: "local" },
    flags: {
      port: {
        kind: "parsed",
        parse: Number,
        brief: "Port to bind (default: from LORE_LISTEN_PORT or 3207)",
        optional: true,
      },
      host: {
        kind: "parsed",
        parse: String,
        variadic: true,
        brief: "Host to bind (repeat for multiple, default: 127.0.0.1)",
        optional: true,
      },
      debug: {
        kind: "boolean",
        brief: "Verbose startup banner",
        optional: true,
      },
      remote: {
        kind: "parsed",
        parse: String,
        brief: "Remote gateway URL (overrides LORE_REMOTE_URL)",
        optional: true,
      },
      local: {
        kind: "boolean",
        brief: "Disable hosted mode even for lore start (alias: -l)",
        optional: true,
      },
      bg: {
        kind: "boolean",
        brief: "Detach and run as a background daemon",
        optional: true,
      },
      daemon: {
        kind: "boolean",
        brief: "Alias for --bg",
        optional: true,
      },
    },
  },
  async handler(flags) {
    const opts: StartOptions = {
      port: flags.port,
      hosts: flags.host?.flatMap((host) =>
        host
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      ),
      debug: flags.debug,
      remoteUrl: flags.remote,
      local: flags.local,
      bg: flags.bg || flags.daemon || undefined,
    };
    // Foreground path returns Promise<never>; Stricli waits for handler
    // completion before exiting, while start.ts owns signal handling.
    await commandStart(opts);
  },
});
