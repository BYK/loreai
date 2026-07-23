/**
 * OpenCode on-disk credential reader.
 *
 * OpenCode stores per-provider credentials in `auth.json` under its data dir
 * (`$XDG_DATA_HOME/opencode/auth.json`, default `~/.local/share/opencode`).
 * Each entry is keyed by the models.dev provider ID and is one of:
 *   - `{ type: "api", key }`                       → api-key credential
 *   - `{ type: "oauth", access, refresh, expires }` → bearer credential
 *
 * For most oauth providers the short-lived `access` token is the bearer. For
 * `github-copilot`, OpenCode uses the long-lived GitHub OAuth `refresh` token
 * (`gho_...`) directly as the bearer against api.githubcopilot.com (no
 * `copilot_internal/v2/token` exchange), and stores `expires: 0` as a
 * "no known expiry" sentinel — handled below.
 *
 * We map each entry to an AgentResolvedAuth. OpenCode uses models.dev provider
 * IDs, which line up with Lore's canonical provider IDs for the common cases;
 * a small normalization table covers known coding-plan aliases.
 */
import { join } from "node:path";
import type { AgentAuthProvider, AgentResolvedAuth } from "../types";
import { registerAuthProvider } from "./index";
import { readJsonFile, xdgDataHome } from "./util";

type OpenCodeApiEntry = { type: "api"; key: string };
type OpenCodeOAuthEntry = {
  type: "oauth";
  access?: string;
  refresh?: string;
  expires?: number;
};
type OpenCodeAuthEntry = OpenCodeApiEntry | OpenCodeOAuthEntry;

function authPath(): string {
  return join(xdgDataHome(), "opencode", "auth.json");
}

/**
 * Normalize an OpenCode provider key to a Lore canonical provider ID. Most
 * models.dev IDs match directly; map known coding-plan aliases to their base
 * provider so the gateway can route them.
 */
function normalizeProvider(key: string): string {
  if (key === "minimax-coding-plan") return "minimax";
  return key;
}

const opencodeAuth: AgentAuthProvider = {
  name: "opencode",

  readAuth(): AgentResolvedAuth[] {
    const store = readJsonFile<Record<string, OpenCodeAuthEntry>>(authPath());
    if (!store || typeof store !== "object") return [];

    const out: AgentResolvedAuth[] = [];
    for (const [key, entry] of Object.entries(store)) {
      if (!entry || typeof entry !== "object") continue;
      const providerID = normalizeProvider(key);

      if (entry.type === "api" && typeof entry.key === "string" && entry.key) {
        out.push({ scheme: "api-key", value: entry.key, providerID });
      } else if (entry.type === "oauth") {
        // OpenCode's github-copilot integration uses the `refresh` field (the
        // long-lived GitHub OAuth `gho_` token) directly as an
        // `Authorization: Bearer` against api.githubcopilot.com — it does NOT
        // perform the `copilot_internal/v2/token` exchange. For other oauth
        // providers the short-lived `access` token is the bearer. Prefer the
        // provider-correct field: refresh for copilot, access otherwise.
        const token =
          providerID === "github-copilot"
            ? (entry.refresh ?? entry.access)
            : entry.access;
        if (typeof token === "string" && token) {
          // github-copilot stores the long-lived GitHub OAuth token with
          // `expires: 0` (a sentinel meaning "no known expiry", NOT "expired at
          // epoch 0"). Treat a non-positive expiry as unset so the routability
          // filter's `isUnexpired` check doesn't discard a perfectly valid
          // token. Real short-lived oauth access tokens carry a positive epoch.
          const expiresAt =
            typeof entry.expires === "number" && entry.expires > 0
              ? entry.expires
              : undefined;
          out.push({
            scheme: "bearer",
            value: token,
            providerID,
            expiresAt,
          });
        }
      }
    }
    return out;
  },
};

registerAuthProvider(opencodeAuth);

export { opencodeAuth };
