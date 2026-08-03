/**
 * `lore sync` / `lore team` / `lore admin` / `lore import` — typed Stricli
 * commands (Phase 3D.3).
 *
 * Each wraps its legacy counterpart via the shared `runLegacyAndCollect`
 * bridge. The legacy handlers take `(positionals, values)` and read from
 * `process.argv`; the typed wrappers map the Stricli input into that
 * shape.
 *
 * Output shape:
 *   - human: rendered legacy text
 *   - JSON:  { output: <captured stdout> }
 *
 * Exit codes: legacy semantics preserved.
 *
 * Phase 3D.3 ships the bridge wrappers. Phase 3D.3b will migrate flag
 * parsing where it diverges from the Stricli defaults.
 */
import { buildOutputCommand } from "../lib/command";
import { runLegacyAndCollect } from "../lib/legacy-bridge";
import { commandSync } from "../sync-cmd";
import { commandTeam } from "../team-cmd";
import { commandAdmin } from "../admin-cmd";
import { commandImport } from "../import";

type Flags = Record<string, never>;

function wrapSync(
  fn: (positionals: string[], values: Record<string, unknown>) => Promise<void>,
) {
  return async (
    positionals: readonly unknown[],
  ): Promise<{ exitCode: number; captured: string }> => {
    const { exitCode, captured } = await runLegacyAndCollect(() =>
      fn(positionals as string[], {}),
    );
    if (exitCode !== 0) process.exitCode = exitCode;
    return { exitCode, captured };
  };
}

export const syncCommand = buildOutputCommand<string, Flags, []>({
  brief: "Sync data between the local lore DB and Supabase",
  fullDescription:
    "Bidirectional sync between the local lore DB and Supabase. " +
    "Subcommands: status, push, pull, sync.",
  parameters: { flags: {} },
  config: {
    renderHuman: (data) => data,
    toJson: (data) => ({ output: data }),
  },
  async handler() {
    const { captured } = await wrapSync(commandSync)([]);
    return { kind: "value" as const, data: captured };
  },
});

export const teamCommand = buildOutputCommand<string, Flags, []>({
  brief: "Manage team membership and roles",
  fullDescription:
    "Team configuration: invite members, assign roles, remove " + "members.",
  parameters: { flags: {} },
  config: {
    renderHuman: (data) => data,
    toJson: (data) => ({ output: data }),
  },
  async handler() {
    const { captured } = await wrapSync(commandTeam)([]);
    return { kind: "value" as const, data: captured };
  },
});

export const adminCommand = buildOutputCommand<string, Flags, []>({
  brief: "Admin operations (admin-only)",
  fullDescription:
    "Admin-only operations: re-sync data, manage workers, " +
    "control backfill. Requires admin role on the project.",
  parameters: { flags: {} },
  config: {
    renderHuman: (data) => data,
    toJson: (data) => ({ output: data }),
  },
  async handler() {
    const { captured } = await wrapSync(commandAdmin)([]);
    return { kind: "value" as const, data: captured };
  },
});

export const importCommand = buildOutputCommand<string, Flags, []>({
  brief: "Import knowledge from .lore.md / AGENTS.md files",
  fullDescription:
    "Bulk-import knowledge entries from .lore.md or AGENTS.md files " +
    "into the local lore DB.",
  parameters: { flags: {} },
  config: {
    renderHuman: (data) => data,
    toJson: (data) => ({ output: data }),
  },
  async handler() {
    const { captured } = await wrapSync(commandImport)([]);
    return { kind: "value" as const, data: captured };
  },
});
