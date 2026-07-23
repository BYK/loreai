/**
 * OpenCode on-disk credential reader.
 *
 * OpenCode stores per-provider credentials in `auth.json` under its data dir
 * (`$XDG_DATA_HOME/opencode/auth.json`, default `~/.local/share/opencode`).
 * Each entry is keyed by the models.dev provider ID and is one of:
 *   - `{ type: "api", key }`                       → api-key credential
 *   - `{ type: "oauth", access, refresh, expires }` → bearer credential (access token)
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
      } else if (
        entry.type === "oauth" &&
        typeof entry.access === "string" &&
        entry.access
      ) {
        out.push({
          scheme: "bearer",
          value: entry.access,
          providerID,
          expiresAt:
            typeof entry.expires === "number" ? entry.expires : undefined,
        });
      }
    }
    return out;
  },
};

registerAuthProvider(opencodeAuth);

export { opencodeAuth };
