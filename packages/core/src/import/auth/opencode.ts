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
 *
 * When multiple providers have credentials on disk (e.g. a stale `anthropic`
 * key from a previous config + a current `openrouter` key), we read the
 * user's active `model`/`small_model` from `~/.config/opencode/opencode.json`
 * (and the project `opencode.json`) and pin that provider's credential first.
 * Without this, the importer blindly picks the first routable entry — which on
 * a JSON object is insertion order, almost always the user's OLDEST provider
 * rather than the one they actually use today.
 */
import { join } from "node:path";
import { cwd } from "node:process";
import type { AgentAuthProvider, AgentResolvedAuth } from "../types";
import { registerAuthProvider } from "./index";
import { readJsonFile, xdgDataHome, xdgConfigHome } from "./util";

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

/**
 * Read the user's `model` / `small_model` field from OpenCode's config. These
 * are `"<provider>/<model-id>"` strings; we want the provider prefix.
 *
 * OpenCode's resolution order is (1) remote `.well-known/opencode`,
 * (2) `~/.config/opencode/opencode.json`, (3) `OPENCODE_CONFIG`,
 * (4) project `opencode.json`. We honor only the two on-disk sources — remote
 * and env-overridable paths don't apply to a standalone `lore import` run,
 * and the project config overrides global for project-local setups.
 *
 * `model` wins over `small_model` (it represents the primary workhorse; we
 * only consult `small_model` when `model` is unset). Returns null when no
 * usable config is found — callers preserve the original iteration order in
 * that case.
 */
export function getOpenCodeActiveProvider(): string | null {
  const candidates = [
    join(xdgConfigHome(), "opencode", "opencode.json"),
    join(cwd(), "opencode.json"),
  ];
  for (const cfgPath of candidates) {
    const cfg = readJsonFile<{
      model?: unknown;
      small_model?: unknown;
    }>(cfgPath);
    if (!cfg) continue;
    for (const field of ["model", "small_model"] as const) {
      const raw = cfg[field];
      if (typeof raw !== "string" || raw.length === 0) continue;
      // OpenCode's config supports `{env:NAME}` substitution in this field —
      // resolve it transparently so we still see the provider even when the
      // user opted into env-driven model selection.
      const resolved = raw.startsWith("{env:")
        ? (process.env[raw.slice(5, raw.indexOf("}"))] ?? raw)
        : raw;
      // Provider id is the substring before the FIRST "/". "openrouter/anthropic/claude-..."
      // is "openrouter"; "claude-sonnet-4-5" alone (no "/") is unusable.
      const slash = resolved.indexOf("/");
      if (slash > 0) return normalizeProvider(resolved.slice(0, slash));
    }
  }
  return null;
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

    // When several providers' credentials are on disk, pin the user's
    // CURRENTLY-CONFIGURED provider (per opencode.json's `model`/`small_model`)
    // first. Otherwise the importer picks whatever happens to be first in
    // JSON-object iteration order — typically the user's oldest entry, which
    // is almost never the one they're trying to import with today.
    const active = getOpenCodeActiveProvider();
    if (active) {
      const idx = out.findIndex((c) => c.providerID === active);
      if (idx > 0) {
        const [picked] = out.splice(idx, 1);
        out.unshift(picked);
      }
    }

    return out;
  },
};

registerAuthProvider(opencodeAuth);

export { opencodeAuth };
