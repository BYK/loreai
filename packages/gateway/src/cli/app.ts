/**
 * Canonical Stricli application for Lore.
 *
 * Phase 1 owns ONLY:
 *   - `lore help` and `lore --help` (human text rendered from `printHelp()`)
 *   - `lore version` and `lore --version` (prints `VERSION`)
 *   - `lore help --json` (stub returns a structured payload noting the
 *     richer version is planned for Phase 4)
 *
 * Every other command keeps going through the legacy `_cli()` dispatcher in
 * `main.ts` until the corresponding phase migrates it. The route tree in
 * this module intentionally grows one route per phase.
 */
import { buildApplication } from "@stricli/core";
import { VERSION } from "./version";
import { printHelp } from "./help";
import { buildCommand as buildLoreCommand } from "./lib/command";
import { buildRouteMap } from "./lib/route-map";
import type { LoreCommandContext } from "./context";
import { whoamiCommand } from "./commands/whoami";
import { logsCommand } from "./commands/logs";
import { stopCommand } from "./commands/stop";
import { logCommand, diffCommand } from "./commands/log";
import { doctorCommand } from "./commands/doctor";
import { lintCommand } from "./commands/lint";
import { loginCommand, logoutCommand } from "./commands/auth";
import { syncCommand } from "./commands/sync";
import { teamCommand } from "./commands/team";
import { adminCommand } from "./commands/admin";
import { importCommand } from "./commands/import";

/**
 * Routes that are still served by the legacy dispatcher.
 *
 * This list is the migration queue. Each entry gets a typed command in its
 * own phase slice, then leaves this set. Until then the legacy `_cli()`
 * handles them through the orchestrator in `cli.ts`.
 */
export const LEGACY_ROUTES: ReadonlySet<string> = new Set([
  "start",
  "run",
  "setup",
  "data",
  "recall",
  "entity",
  "upgrade",
]);

type HelpFlags = {
  json: boolean;
};

const helpCommand = buildLoreCommand<HelpFlags, [string?]>({
  brief: "Show help text for lore or a subcommand",
  parameters: {
    flags: {
      json: {
        kind: "boolean",
        brief: "Emit a stable structured JSON introspection of the route tree",
        default: false,
      },
    },
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "Optional dotted command path, e.g. `data list`",
          parse: String,
          optional: true,
        },
      ],
    },
  },
  handler(flags, path) {
    if (flags.json) {
      const payload = {
        schemaVersion: 1,
        name: "lore",
        version: VERSION,
        note: "Structured JSON help is planned for Phase 4. Run `lore help` for human output.",
        path: path ?? null,
      };
      this.process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return;
    }
    printHelp();
  },
});

const versionCommand = buildLoreCommand({
  brief: "Print the lore CLI version and exit",
  handler() {
    this.process.stdout.write(`${VERSION}\n`);
  },
});

/**
 * Build the root route map.
 *
 * Only `help` and `version` are real routes in Phase 1. The legacy commands
 * live behind the dispatcher's own argv parsing — the Stricli tree does not
 * see them, so we do not register them here. This keeps the Stricli surface
 * honest: a route that exists in this tree behaves through Stricli.
 */
export const routes = buildRouteMap({
  brief: "context management proxy for AI coding agents",
  fullDescription:
    "lore is a command-line interface for the Lore AI memory gateway. " +
    "It provides commands for authentication, viewing and managing stored data, " +
    "importing prior conversations, and launching supported AI agents through the gateway.",
  routes: {
    help: helpCommand,
    version: versionCommand,
    whoami: whoamiCommand,
    logs: logsCommand,
    stop: stopCommand,
    log: logCommand,
    diff: diffCommand,
    doctor: doctorCommand,
    lint: lintCommand,
    login: loginCommand,
    logout: logoutCommand,
    sync: syncCommand,
    team: teamCommand,
    admin: adminCommand,
    import: importCommand,
  },
});

/**
 * The Stricli application.
 */
export const app = buildApplication(routes, {
  name: "lore",
  versionInfo: { currentVersion: VERSION },
  scanner: {
    caseStyle: "allow-kebab-for-camel",
    allowArgumentEscapeSequence: true,
  },
});

// Re-export for downstream code that imports `LoreCommandContext` via app.
export type { LoreCommandContext };
