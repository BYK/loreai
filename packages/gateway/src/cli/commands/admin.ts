/**
 * `lore admin` — typed Stricli command (Phase 3D.3d).
 *
 * Wraps the legacy `commandAdmin` from `../admin-cmd` via the shared
 * `runLegacyAndCollect` bridge. The legacy handler takes 3 positionals:
 *
 *   - positionals[0]: subcommand (must be "grant")
 *   - positionals[1]: target (UUID for org or user)
 *   - positionals[2]: tier (free | team | pro)
 *
 * No flags. The typed adapter declares only the positional schema.
 *
 * Output shape:
 *   - human: rendered legacy text
 *   - JSON:  { output: <captured stdout> }
 *
 * Exit codes: legacy semantics preserved (0 success, 1 usage/invalid
 * tier/no service-role client).
 */
import { buildOutputCommand } from "../lib/command";
import { runLegacyAndCollect } from "../lib/legacy-bridge";
import { commandAdmin } from "../admin-cmd";

type AdminFlags = Record<string, never>;

export const adminCommand = buildOutputCommand<
  string,
  AdminFlags,
  readonly [string?, string?, string?]
>({
  brief: "Admin operations (admin-only)",
  fullDescription:
    "Admin-only operations: grant a tier (free | team | pro) to an " +
    "org or user by UUID. The three positionals are: subcommand " +
    "(grant), target UUID, tier. No flags. Requires " +
    "SUPABASE_SERVICE_ROLE_KEY (staff-only).",
  parameters: {
    flags: {},
    positional: {
      kind: "tuple",
      parameters: [
        { parse: String, brief: "Subcommand (grant)", optional: true },
        { parse: String, brief: "Target UUID (org or user)", optional: true },
        { parse: String, brief: "Tier (free | team | pro)", optional: true },
      ],
    },
  },
  config: {
    renderHuman: (data) => data,
    toJson: (data) => ({ output: data }),
  },
  async handler(_flags, sub, target, tier) {
    // Stricli spreads ARGS = [string?, string?, string?] into individual
    // args. Collect back into the legacy string[].
    const positionals: string[] = [];
    if (typeof sub === "string") positionals.push(sub);
    if (typeof target === "string") positionals.push(target);
    if (typeof tier === "string") positionals.push(tier);
    const { exitCode, captured } = await runLegacyAndCollect(() =>
      commandAdmin(positionals, {}),
    );
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
    return { kind: "value" as const, data: captured };
  },
});
