/**
 * `lore login` / `lore logout` — typed Stricli commands (Phase 3D.2).
 *
 * Both commands wrap their legacy counterparts from `../login` via the
 * shared `runLegacyAndCollect` bridge. The legacy handlers read from
 * `process.argv` and accept positionals + values; the typed wrappers
 * map the typed Stricli flags into the legacy `Record<string, unknown>`
 * shape.
 *
 * Output shape:
 *   - human: rendered legacy text (browser flow / device flow / logout)
 *   - JSON:  { output: <captured stdout> }
 *
 * Exit codes: legacy semantics preserved (0 normal, 1 invalid args).
 */
import { buildOutputCommand } from "../lib/command";
import { runLegacyAndCollect } from "../lib/legacy-bridge";
import { commandLogin, commandLogout } from "../login";

type LoginFlags = {
  email?: string;
  "no-browser"?: boolean;
};

type LogoutFlags = Record<string, never>;

export const loginCommand = buildOutputCommand<
  string,
  LoginFlags,
  readonly unknown[]
>({
  brief: "Sign in to lore (browser or device flow)",
  fullDescription:
    "Sign in to lore with a Supabase email or via the headless " +
    "GitHub device flow. With no flags, opens a local browser; falls " +
    "back to device sign-in (paste-the-code + QR) when no browser " +
    "can reach our loopback (SSH, headless, CI).",
  parameters: {
    flags: {
      email: {
        kind: "parsed",
        parse: String,
        brief: "Email address (alternative to GitHub device flow)",
        optional: true,
      },
      "no-browser": {
        kind: "boolean",
        brief: "Force the device flow even if a local browser is available",
        optional: true,
      },
    },
    // No positionals declared — the legacy handler accepts none, and
    // declaring them here would let Stricli accept but silently drop
    // unknown args (review finding F-1). Drop until the legacy handler
    // is replaced.
  },
  config: {
    renderHuman: (data) => data,
    toJson: (data) => ({ output: data }),
  },
  async handler(flags) {
    const values: Record<string, unknown> = {};
    if (flags.email) values.email = flags.email;
    if (flags["no-browser"]) values["no-browser"] = true;
    const { exitCode, captured } = await runLegacyAndCollect(() =>
      commandLogin([], values),
    );
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
    return { kind: "value" as const, data: captured };
  },
});

export const logoutCommand = buildOutputCommand<
  string,
  LogoutFlags,
  readonly unknown[]
>({
  brief: "Sign out (clear local session)",
  fullDescription:
    "Best-effort server-side sign-out, then clear the local " +
    "session. Network errors are ignored — local logout is what " +
    "matters.",
  parameters: {
    flags: {},
    // No positionals declared — see F-1 above.
  },
  config: {
    renderHuman: (data) => data,
    toJson: (data) => ({ output: data }),
  },
  async handler() {
    const { exitCode, captured } = await runLegacyAndCollect(() =>
      commandLogout(),
    );
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
    return { kind: "value" as const, data: captured };
  },
});
