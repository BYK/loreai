/**
 * `lore whoami` — show the signed-in account.
 *
 * Phase 3A: typed Stricli command returning a `CommandOutput<WhoamiResult>`.
 * Talks directly to `@loreai/core`'s supabase helpers so the typed output
 * path doesn't depend on stdout capture.
 */
import { buildOutputCommand } from "../lib/command";
import { AuthError, NetworkError } from "../lib/errors";
import {
  getCurrentUser,
  isLoggedIn,
  SessionUnavailableError,
} from "../../supabase";

type WhoamiFlags = {
  verify: boolean;
};

interface WhoamiResult {
  identity: string;
  user_id: string;
  email: string | null;
  github_login: string | null;
  display_name: string | null;
  verified: boolean;
}

function renderHuman(data: WhoamiResult): string {
  return data.identity;
}

function toJson(data: WhoamiResult): unknown {
  return {
    user_id: data.user_id,
    email: data.email,
    github_login: data.github_login,
    display_name: data.display_name,
    verified: data.verified,
  };
}

function formatIdentity(user: {
  user_id: string;
  email?: string | null;
  github_login?: string | null;
  display_name?: string | null;
}): string {
  if (user.github_login) return `@${user.github_login}`;
  if (user.email) return user.email;
  if (user.display_name) return user.display_name;
  return user.user_id || "unknown";
}

export const whoamiCommand = buildOutputCommand<WhoamiResult, WhoamiFlags, []>({
  brief: "Show the signed-in account",
  fullDescription:
    "Print the Folk Lore account currently signed in to this machine. " +
    "Use --verify to round-trip to the server and confirm the session is still valid. " +
    "JSON output includes the underlying account identifiers.",
  parameters: {
    flags: {
      verify: {
        kind: "boolean",
        brief: "Round-trip to the server to verify the session is still valid",
        default: false,
      },
    },
  },
  config: { renderHuman, toJson },
  async handler(flags) {
    // The session helper owns guarded cleanup on an explicit rejection.
    // Network failures retain the login and report a retryable network error.
    const hadSession = isLoggedIn();
    let user;
    try {
      user = await getCurrentUser({ verify: flags.verify });
    } catch (error) {
      if (error instanceof SessionUnavailableError)
        throw new NetworkError({
          message: error.message,
          tryCommand: "lore whoami --verify",
        });
      throw error;
    }
    if (!user) {
      throw new AuthError({
        message: hadSession
          ? "Session expired. Run `lore login` to sign in again."
          : "Not logged in. Run `lore login` to sign in.",
        tryCommand: "lore login",
      });
    }
    return {
      kind: "value" as const,
      data: {
        identity: formatIdentity(user),
        user_id: user.user_id,
        email: user.email ?? null,
        github_login: user.github_login ?? null,
        display_name: user.display_name ?? null,
        verified: flags.verify,
      },
      hint: "Run `lore logout` to sign out, or `lore login` to switch accounts.",
    };
  },
});
