/**
 * `lore import` — detect and import knowledge from external AI agent conversations.
 *
 * Scans for conversation history from Claude Code, OpenCode, and Aider,
 * then extracts knowledge entries via the curator LLM.
 *
 * When `LORE_REMOTE_URL` is set, detection and chunk reading happen locally
 * (they require filesystem access), but extraction is delegated to the remote
 * gateway via the REST API. No local gateway startup is needed.
 */
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import {
  conversationImport,
  config as loreConfig,
  ensureProject,
  setLastImportAt,
  load,
} from "@loreai/core";
type DetectionResult =
  import("@loreai/core").conversationImport.DetectionResult;
import { createGatewayLLMClient, getLastWorkerError } from "../llm-adapter";
import {
  resolveAuth,
  workerKeyScheme,
  getLastSeenAuthProvider,
  type AuthCredential,
} from "../auth";
import {
  defaultModelForProvider,
  defaultSelectableModelForProvider,
  fetchModelData,
  parseWorkerModelEnv,
} from "../worker-model";
import { resolveProviderRoute, providerForUpstreamOrigin } from "../config";
import { hasRecentAuthRejectedFailure } from "../worker-health";
import {
  AGENTS,
  captureUserEnvCredential,
  InvalidEnvCredentialUpstreamError,
} from "./agents";
import { exportLoreFile } from "@loreai/core";
import { startGateway, type StartOptions } from "./start";
import {
  getRemoteUrl,
  projectQueryParams,
  remoteGet,
  remotePost,
} from "./remote";

const {
  detectAll,
  extractKnowledge,
  getProvider,
  isImported,
  recordImport,
  computeHash,
  getStructuredSource,
  getStructuredSources,
  detectStructuredSources,
  importStructuredEntries,
  safeParseImportDoc,
  readUsableAuth,
  getOpenCodeActiveProvider,
} = conversationImport;
type StructuredSourceName = conversationImport.StructuredSourceName;
type AgentResolvedAuth =
  import("@loreai/core").conversationImport.AgentResolvedAuth;

function reportInvalidEnvCredentialUpstream(
  error: unknown,
  agentDisplayName: string,
): boolean {
  if (!(error instanceof InvalidEnvCredentialUpstreamError)) return false;
  console.error(
    `[lore] Can't import ${agentDisplayName}: ${error.envVarName} contains an unsafe or invalid upstream URL.\n` +
      `[lore] Fix or unset ${error.envVarName}, then retry.`,
  );
  process.exitCode = 1;
  return true;
}

/**
 * OpenAI-compatible aggregator providers that proxy model requests to any
 * underlying vendor. When the user has a credential on one of these, the
 * session model (e.g. `anthropic/claude-sonnet-5` or `openai/gpt-5.6-luna`)
 * can be sent as-is — the aggregator resolves the model id and forwards to
 * the right upstream. This is what makes an OpenRouter/Anthropic-billed key
 * route correctly even when `cfg.model` targets anthropic directly.
 *
 * The set is intentionally tight: only true aggregators that proxy to ANY
 * model catalog their providers expose. Adding a regular OpenAI-compatible
 * provider here (e.g. deepseek) would route arbitrary model ids through it
 * and 400. See adm's 2nd-attempt failure (Slack 2026-07-30) for the
 * original symptom.
 */
const OPENAI_COMPATIBLE_AGGREGATORS = new Set<string>([
  "openrouter",
  "groq",
  "cerebras",
  "huggingface",
]);

/**
 * Resolve the extraction credential + model for a given detected agent, in
 * priority order:
 *   1. `LORE_WORKER_API_KEY` explicit override (provider from `cfgModel`, which
 *      the caller resolves as `workerModel ?? model`).
 *   2. The harness's OWN on-disk auth (routable + unexpired) — the automatic
 *      "use my existing credentials" path.
 *   3. The harness's env-based credential: its base-URL + auth-token env vars
 *      (e.g. Claude Code with ANTHROPIC_BASE_URL=openrouter.ai +
 *      ANTHROPIC_AUTH_TOKEN=<key>). This is the common OpenRouter / proxy setup
 *      where nothing is stored on disk but the credential is fully usable.
 *   4. A live session / last-seen credential captured in THIS process (e.g.
 *      `lore import` invoked after a session, or a warmed global fallback).
 *   5. `cfgModel` explicit override (falls to `resolveAuth`, may be null).
 * Returns null when nothing usable is found for this agent.
 */
export function resolveAgentImportAuth(
  agentName: string,
  workerApiKey: string | undefined,
  cfgModel: { providerID: string; modelID: string } | undefined,
):
  | {
      getAuth: (
        sessionID?: string,
        providerID?: string,
      ) => AuthCredential | null;
      model: { providerID: string; modelID: string };
      /** Upstream URL to route extraction to, when captured from the agent's env. */
      upstream?: string;
    }
  | {
      /**
       * A credential WAS found in the agent's env, but its provider has no
       * default worker model and the user set no model — so extraction would
       * send an empty model id and 400. The caller must tell the user to set an
       * explicit worker model (env override / `.lore.json` model) rather than
       * silently fail.
       */
      needsModel: string;
    }
  | null {
  // 1. Explicit dedicated worker key wins. Provider comes from cfg.model when
  //    set, else anthropic (historical default for the raw-key path).
  if (workerApiKey) {
    const providerID = cfgModel?.providerID ?? "anthropic";
    const model = cfgModel ?? defaultModelForProvider(providerID);
    return {
      getAuth: (_sessionID, reqProvider) => ({
        scheme: workerKeyScheme(reqProvider ?? providerID),
        value: workerApiKey,
      }),
      model,
    };
  }

  // 2. Harness on-disk auth — pick the first credential whose provider Lore
  //    can DIRECTLY authenticate for extraction. A provider is usable only if
  //    it has a concrete upstream URL (some routes carry url:null — local
  //    runtimes like ollama/vllm/lmstudio, not reachable for extraction).
  //    github-copilot IS usable: OpenCode stores the GitHub OAuth token that
  //    api.githubcopilot.com accepts directly as a Bearer (no runtime token
  //    exchange needed), and its route carries a concrete url. Anything
  //    filtered here falls through to the accurate "no usable credential"
  //    guidance rather than a confusing downstream "no response from the model".
  //
  //    OpenCode-specific override: a shell-env credential for the user's
  //    CURRENTLY-CONFIGURED provider (`~/.config/opencode/opencode.json`'s
  //    `model`/`small_model`) wins over the on-disk credential for that same
  //    provider — matches OpenCode's own env-first precedence in its @ai-sdk
  //    clients. Without this, a user with `ANTHROPIC_API_KEY` set + a stale
  //    `anthropic: { key }` in auth.json gets a 401-storm from the import
  //    worker even though `lore run opencode` works (because OpenCode's
  //    Anthropic SDK reads the env var, not auth.json).
  const envOverride = pickOpenCodeActiveEnvCredential(agentName);
  const creds: AgentResolvedAuth[] = readUsableAuth(agentName);
  const usable = creds.find((c) =>
    // Prefer the active-provider credential that the env path selected —
    // ensures the env credential wins when both exist for the same
    // provider. Falls back to the first routable entry otherwise.
    envOverride
      ? c.providerID === envOverride.providerID
      : resolveProviderRoute(c.providerID)?.url != null,
  );
  if (usable) {
    // Honor an explicit user model (LORE_WORKER_MODEL / .lore.json) when it
    // targets this credential's provider — the credential authenticates the
    // provider, the user picks the model. This matters for GitHub Copilot,
    // whose per-subscription model access varies: the built-in default
    // (gpt-5-mini) may be unavailable on a Copilot plan that only serves
    // claude-*, so a user who set LORE_WORKER_MODEL=github-copilot/claude-sonnet-5
    // must get their model, not the default. Fall back to the credential's own
    // model hint, then the provider default.
    //
    // Also honor `cfgModel` when the credential's provider is an OpenAI-compatible
    // aggregator (openrouter, groq, cerebras, huggingface) or shares the same
    // upstream protocol as the cfgModel's provider — these aggregators can
    // proxy the session model id (e.g. `openai/gpt-5.6-luna` → openrouter).
    const credRoute = resolveProviderRoute(usable.providerID);
    const isOpenAIAggregator =
      credRoute?.protocol === "openai" &&
      OPENAI_COMPATIBLE_AGGREGATORS.has(usable.providerID);
    const model =
      cfgModel && cfgModel.providerID === usable.providerID
        ? cfgModel
        : cfgModel && isOpenAIAggregator
          ? { providerID: usable.providerID, modelID: cfgModel.modelID }
          : usable.modelID
            ? { providerID: usable.providerID, modelID: usable.modelID }
            : defaultModelForProvider(usable.providerID);
    // A routable-but-defaultless provider (openrouter, deepseek, groq, …) has
    // no WORKER_DEFAULTS entry, so defaultModelForProvider returns an empty
    // modelID — and an on-disk credential often carries no modelID hint either
    // (e.g. OpenCode's auth.json stores only the key). Sending model="" would
    // 400 at the upstream, so signal needsModel instead of returning an
    // unusable credential (same guard as tier 3). We DO have their key.
    if (!model.modelID) {
      return { needsModel: usable.providerID };
    }
    // The OpenCode env-preference: when an env-var credential was found for
    // the active provider, use its value (and scheme) instead of the
    // on-disk one. The on-disk `usable` only tells us WHICH provider to
    // authenticate — the env path supplies the actual token. Falls back to
    // the on-disk value when there's no env override (or for non-opencode
    // agents).
    const pickedScheme = envOverride?.scheme ?? usable.scheme;
    const pickedValue = envOverride?.value ?? usable.value;
    return {
      getAuth: () => ({ scheme: pickedScheme, value: pickedValue }),
      model,
    };
  }

  // 3. Harness ENV credential: the user pointed the agent at a provider purely
  //    through shell env (base-URL + auth-token env vars), with nothing on disk.
  //    Very common for OpenRouter / corporate-proxy setups. Resolve the provider
  //    from the captured base URL (a known host → provider via the reverse map;
  //    unknown host still works — we route extraction straight at that upstream
  //    and default the model). Route extraction to the captured upstream.
  //
  //    For OpenCode, this branch also catches the case where the user has a
  //    shell-env credential but NO on-disk credential at all (e.g. fresh
  //    machine, never ran `opencode auth login` — the env var IS the
  //    credential). The active-provider lookup in step 2 would return null
  //    for env because we don't have the on-disk entry to match against.
  const agentDef = AGENTS.find((a) => a.name === agentName);
  if (agentDef) {
    const envCred = captureUserEnvCredential(agentDef);
    if (envCred) {
      // OpenCode's `authTokenEnvVars` covers multiple provider families
      // (ANTHROPIC_API_KEY → anthropic, OPENAI_API_KEY → openai, …). Without
      // a hint, the legacy code fell back to `wireProtocol ?? "anthropic"` —
      // wrong for OpenCode (no wireProtocol). Use the active provider from
      // opencode.json when it matches the captured env var, else route by
      // the env var's NAME (env-var → provider mapping maintained here).
      // Falls back to wireProtocol/legacy defaults for non-opencode agents.
      const envDrivenProviderID =
        agentName === "opencode"
          ? (pickEnvVarProvider(envCred.envVarName) ??
            getOpenCodeActiveProvider())
          : null;
      const providerID = envCred.upstreamUrl
        ? (providerForUpstreamOrigin(envCred.upstreamUrl) ??
          envDrivenProviderID ??
          agentDef.wireProtocol ??
          "anthropic")
        : (envDrivenProviderID ?? agentDef.wireProtocol ?? "anthropic");
      // Honor an explicit user model ONLY when it targets this credential's
      // provider (same guard as tier 2) — the env credential authenticates
      // `providerID`, so a cfgModel for a DIFFERENT provider would route this
      // key to the wrong upstream/model. Otherwise fall back to the provider
      // default.
      const model =
        cfgModel && cfgModel.providerID === providerID
          ? cfgModel
          : defaultModelForProvider(providerID);
      // An aggregator/proxy provider (openrouter, deepseek, groq, …) has no
      // WORKER_DEFAULTS entry, so defaultModelForProvider returns an empty
      // modelID. Sending model="" would 400 at the upstream — so instead of
      // silently returning an unusable credential, signal that the user must
      // pick a model (LORE_WORKER_MODEL / .lore.json). We DO have their key.
      if (!model.modelID) {
        return { needsModel: providerID };
      }
      return {
        getAuth: () => ({ scheme: envCred.scheme, value: envCred.token }),
        model,
        upstream: envCred.upstreamUrl ?? undefined,
      };
    }
  }

  // 4. Live session / last-seen credential captured in-process. Match the model
  //    to that credential's provider (or cfg.model when explicitly set) so the
  //    extraction routes to the provider we actually hold a credential for.
  const lastSeenProvider = getLastSeenAuthProvider() ?? undefined;
  const sessionCred = resolveAuth(
    undefined,
    cfgModel?.providerID ?? lastSeenProvider,
  );
  if (sessionCred) {
    const model =
      cfgModel ?? defaultModelForProvider(lastSeenProvider ?? undefined);
    // A routable-but-defaultless provider (openrouter, deepseek, groq, …) has
    // no WORKER_DEFAULTS entry, so defaultModelForProvider returns an empty
    // modelID — sending model="" would 400 at the upstream. Match tiers 2 and
    // 3's needsModel signal so the user gets an actionable "set a worker model"
    // message rather than a misleading upstream 400. Seer finding 15586978/1.
    if (!model.modelID) {
      return { needsModel: model.providerID };
    }
    return { getAuth: resolveAuth, model };
  }

  // 5. cfg.model override with no resolvable credential → nothing usable.
  return null;
}

/**
 * Pick the per-protocol upstreams map for an extraction call. When the
 * credential was captured from the agent's own env (tier 3, `agentUpstream`
 * set), route BOTH protocol slots at that captured upstream (e.g.
 * openrouter.ai) — unless the user configured an explicit dedicated
 * `LORE_WORKER_UPSTREAM` (`configWorkerUpstream`), which always takes
 * precedence. Otherwise fall back to the default per-protocol upstreams.
 */
export function resolveExtractionUpstreams(
  agentUpstream: string | undefined,
  configWorkerUpstream: string | undefined,
  defaults: { anthropic: string; openai: string },
): { anthropic: string; openai: string } {
  if (agentUpstream && !configWorkerUpstream) {
    return { anthropic: agentUpstream, openai: agentUpstream };
  }
  return defaults;
}

/**
 * Map a single auth-token env var name to the provider family it
 * authenticates. Used by opencode's tier-2/tier-3 routing to figure out
 * which provider an env-var credential belongs to — the env var carries a
 * bare token, not a provider ID, and opencode has multiple providers'
 * env vars in its `authTokenEnvVars` (ANTHROPIC_API_KEY → anthropic,
 * OPENAI_API_KEY → openai, OPENROUTER_API_KEY → openrouter, etc.).
 *
 * Returns null for env vars we don't recognize — the caller falls back
 * to the active provider (opencode.json's `model`) or to the legacy
 * wireProtocol default.
 */
function pickEnvVarProvider(envVarName: string): string | null {
  switch (envVarName) {
    case "ANTHROPIC_API_KEY":
    case "ANTHROPIC_AUTH_TOKEN":
      return "anthropic";
    case "OPENAI_API_KEY":
      return "openai";
    case "OPENROUTER_API_KEY":
      return "openrouter";
    case "GEMINI_API_KEY":
    case "GOOGLE_API_KEY":
      return "google";
    default:
      return null;
  }
}

/**
 * Look up a shell-env credential that authenticates the user's CURRENTLY
 * CONFIGURED opencode provider. Used to prefer a fresh env-var key over a
 * stale on-disk one in tier 2 — matches OpenCode's own env-first precedence
 * (the @ai-sdk Anthropic/OpenAI clients read the env var, not auth.json,
 * so `lore run opencode` succeeds against the env credential even when
 * auth.json has a rotated key).
 *
 * Returns null for non-opencode agents, when no active provider is
 * detected (no `model`/`small_model` in opencode.json), or when no env
 * var is set for that provider. Callers MUST fall through to the on-disk
 * tier-2 path in those cases — the env path can never fully replace
 * auth.json because the user might still have a usable on-disk credential
 * from a previous config.
 */
function pickOpenCodeActiveEnvCredential(agentName: string): {
  providerID: string;
  scheme: "bearer" | "api-key";
  value: string;
} | null {
  if (agentName !== "opencode") return null;
  const active = getOpenCodeActiveProvider();
  if (!active) return null;
  // Walk the opencode agent's authTokenEnvVars (kept in agents.ts for one
  // place to update); the first match whose var authenticates `active` AND
  // has a non-empty value wins. We honor the var list's declared precedence
  // (bearer over api-key for anthropic — matches Claude Code's parity rule).
  const def = AGENTS.find((a) => a.name === "opencode");
  if (!def?.authTokenEnvVars) return null;
  for (const { var: key, scheme } of def.authTokenEnvVars) {
    if (pickEnvVarProvider(key) !== active) continue;
    const raw = process.env[key];
    if (!raw) continue;
    // Sanitize the same way captureUserEnvCredential does — control chars
    // would otherwise smuggle headers into the captured credential.
    // oxlint-disable-next-line no-control-regex -- intentional control-character sanitization
    const token = raw.replace(/[\x00-\x1f\x7f]/g, "").trim();
    if (!token) continue;
    return { providerID: active, scheme, value: token };
  }
  return null;
}

/**
 * Build the "found your credential but no worker model" guidance shown when one
 * or more agents resolved a credential for a provider with no default worker
 * model (and the user set none). Returns null when there's nothing to say.
 *
 * Independent of whether OTHER agents authenticated: the per-agent skip lines
 * promise "(see below)", so this guidance must appear whenever ANY agent hit
 * the needsModel condition. `anyAuthResolved` only tweaks the wording ("some
 * agents") — the caller decides whether to also stop the run.
 */
export function buildNeedsModelGuidance(
  providers: string[],
  anyAuthResolved: boolean,
): string | null {
  if (providers.length === 0) return null;
  const providerList = providers.join(", ");
  const exportLines = providers
    .map(
      (p) =>
        `[lore]   export LORE_WORKER_MODEL=${p}/<model>   # e.g. ${p}/gpt-5-mini`,
    )
    .join("\n");
  return (
    `\n[lore] Can't import${anyAuthResolved ? " some agents" : ""}: found your ${providerList} credential(s), but\n` +
    `[lore] no built-in default worker model exists for ${providers.length > 1 ? "those providers" : providerList}, so Lore\n` +
    `[lore] doesn't know which model to run extraction on. Pick one and retry:\n` +
    `[lore]\n` +
    `${exportLines}\n` +
    `[lore]   lore import\n` +
    `[lore]\n` +
    `[lore] (or set \`model\` / \`workerModel\` in .lore.json).`
  );
}

// ---------------------------------------------------------------------------
// Provider-fallback chain (auto-retry on 401)
// ---------------------------------------------------------------------------

/**
 * A single extraction credential candidate. The import loop tries each
 * candidate in order; on upstream 401/403, it records the failure and moves
 * to the next one. The first candidate that produces at least one
 * non-`abortedByAuth` chunk wins the whole batch.
 */
type AuthCandidate = {
  /** Display label for the user (e.g. "opencode.json active provider: openrouter"). */
  label: string;
  /** Where the credential came from — drives the user-facing note. */
  source: "opencode-active" | "opencode-on-disk" | "env" | "session";
  /** Resolves a credential per chunk (called by the LLM client). */
  getAuth: (sessionID?: string, providerID?: string) => AuthCredential | null;
  /** Model + provider used for extraction. */
  model: { providerID: string; modelID: string };
  /** Optional upstream override (env-credential tier routes here). */
  upstream?: string;
};

/**
 * Build the ordered list of extraction-credential candidates for one agent.
 *
 * Order:
 *  1. The user's CURRENTLY-CONFIGURED provider from opencode.json
 *     (`model` / `small_model`) — matches what their `lore run` actually
 *     started with. Best-first because if it's working in `lore run`, it'll
 *     work here too.
 *  2. Remaining routable entries from auth.json (the OpenCode reorder in
 *     `readUsableAuth` already places the active provider first; this is
 *     the rest of the JSON iteration order — the user's older credentials,
 *     which may or may not still be valid).
 *  3. Env credential (tier 3) — common OpenRouter / proxy setups where the
 *     agent never wrote anything to auth.json but the user has
 *     ANTHROPIC_API_KEY et al in their shell.
 *  4. Last-seen session credential (tier 4) — the gateway's global fallback
 *     for `providerID` matching a prior live request.
 *
 * The `LORE_WORKER_API_KEY` explicit override (tier 1) is intentionally
 * excluded from the chain — it's a deliberate user choice, and silently
 * retrying past it would surprise users who set the env var to debug
 * routing. Tier 1 stays single-shot in `resolveAgentImportAuth`.
 *
 * Candidates whose provider lacks a default worker model AND the user set
 * no override are skipped (they'd 400 at the upstream with an empty model
 * id — the same `needsModel` guard the tier 2 path already enforces).
 *
 * Returns an empty array when NOTHING is usable — the caller skips the
 * agent with the standard "no usable credential" line.
 */
export function buildAuthFallbackChain(
  agentName: string,
  cfgModel: { providerID: string; modelID: string } | undefined,
): AuthCandidate[] {
  const candidates: AuthCandidate[] = [];
  const seen = new Set<string>();

  function push(c: AuthCandidate | null): void {
    if (!c) return;
    // De-dup by (providerID, value) — env and on-disk may resolve to the
    // same provider with the same key (OpenCode's tier-2 env-preference),
    // and we want the env path to win over the on-disk path (not silently
    // retried as a separate candidate).
    const value = (() => {
      try {
        return c.getAuth(undefined, c.model.providerID)?.value ?? "";
      } catch {
        return "";
      }
    })();
    const dedupeKey = `${c.model.providerID}::${value}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    candidates.push(c);
  }

  // Read every usable auth.json credential. The OpenCode reader already
  // reorders so the active provider sits first; we honor that ordering and
  // add a separate "opencode-active" label to the first one so the user
  // knows where it came from.
  const active = agentName === "opencode" ? getOpenCodeActiveProvider() : null;
  const onDiskCreds = readUsableAuth(agentName);

  for (const cred of onDiskCreds) {
    // Routability check — same as the existing tier-2 path. A provider
    // without a concrete upstream URL (local runtimes like ollama/vllm)
    // can't be used for extraction; skip it instead of attempting a doomed
    // call.
    const isRoutable = resolveProviderRoute(cred.providerID)?.url != null;
    if (!isRoutable) continue;

    const isActive = active === cred.providerID;
    const source: AuthCandidate["source"] = isActive
      ? "opencode-active"
      : "opencode-on-disk";
    const label = isActive
      ? `opencode.json active provider: ${cred.providerID}`
      : `on-disk auth.json: ${cred.providerID}`;

    // Per-credential model resolution: when cfgModel targets a DIFFERENT
    // provider than this credential, the question is whether the session
    // model still applies on this provider's route. The user's session model
    // is what they last picked in OpenCode (e.g. `openai/gpt-5.6-luna`); if
    // this credential's provider speaks the same upstream protocol
    // (OpenAI-compatible), then sending the session model through this
    // credential is almost certainly what the user wants — OpenRouter
    // proxies `openai/gpt-5.6-luna` correctly, Groq proxies it, opencode/zen
    // proxies it, etc. Picking a random "cheapest model on this provider"
    // from models.dev would route the request to a model the user never
    // subscribed to (e.g. adm's openrouter key might be Anthropic-billed,
    // not OpenAI-billed — sending `openai/gpt-5.6-luna` would 400).
    //
    // Two cases for cross-provider routing:
    //   a. Same protocol — cfgModel.providerID and cred.providerID both
    //      speak, e.g., OpenAI Chat Completions. The model id transfers
    //      directly.
    //   b. Cred provider is an OpenAI-compatible aggregator (openrouter,
    //      groq, cerebras, huggingface, github-copilot, opencode/zen). These
    //      proxy requests to the underlying provider of the model id — so
    //      sending `anthropic/claude-sonnet-5` to openrouter routes to
    //      Anthropic via OpenRouter's OpenAI endpoint. Same for any model
    //      that openrouter has cataloged.
    //
    // So the resolution order is:
    //   1. cfgModel with matching providerID — use as-is.
    //   2. cfgModel with a credential provider that speaks the SAME protocol
    //      OR is an OpenAI-compatible aggregator — swap providerID, keep
    //      modelID. This handles both the openai→openrouter case AND the
    //      anthropic→openrouter case (adm's openrouter key may be
    //      Anthropic-billed, not OpenAI-billed).
    //   3. cred.modelID — explicit per-credential override.
    //   4. per-credential default from models.dev — last-resort fallback.
    const credRoute = resolveProviderRoute(cred.providerID);
    const isOpenAIAggregator =
      credRoute?.protocol === "openai" &&
      OPENAI_COMPATIBLE_AGGREGATORS.has(cred.providerID);
    const model =
      cfgModel && cfgModel.providerID === cred.providerID
        ? cfgModel
        : cfgModel && isOpenAIAggregator
          ? { providerID: cred.providerID, modelID: cfgModel.modelID }
          : cred.modelID
            ? { providerID: cred.providerID, modelID: cred.modelID }
            : defaultSelectableModelForProvider(cred.providerID);

    // Skip candidates that lack a model — same guard as tier 2/3.
    if (!model.modelID) continue;

    push({
      label,
      source,
      getAuth: () => ({ scheme: cred.scheme, value: cred.value }),
      model,
    });
  }

  // Env credential (tier 3) — last; if it had a valid token it would have
  // already won at the env-overrides-on-disk stage for the active provider
  // (and been de-duped above). This catches the "no on-disk at all" path:
  // a fresh machine with only shell env credentials.
  const agentDef = AGENTS.find((a) => a.name === agentName);
  if (agentDef) {
    const envCred = captureUserEnvCredential(agentDef);
    if (envCred) {
      const envDrivenProviderID =
        agentName === "opencode"
          ? (pickEnvVarProvider(envCred.envVarName) ??
            getOpenCodeActiveProvider())
          : null;
      const providerID = envCred.upstreamUrl
        ? (providerForUpstreamOrigin(envCred.upstreamUrl) ??
          envDrivenProviderID ??
          agentDef.wireProtocol ??
          "anthropic")
        : (envDrivenProviderID ?? agentDef.wireProtocol ?? "anthropic");
      const model =
        cfgModel && cfgModel.providerID === providerID
          ? cfgModel
          : defaultModelForProvider(providerID);
      if (model.modelID) {
        push({
          label: `shell env credential: ${envCred.envVarName}`,
          source: "env",
          getAuth: () => ({ scheme: envCred.scheme, value: envCred.token }),
          model,
          upstream: envCred.upstreamUrl ?? undefined,
        });
      }
    }
  }

  // Last-seen session credential (tier 4). Only include when the chain so
  // far is empty — otherwise we'd try a session credential that might be
  // for a DIFFERENT provider than the active one (cross-provider leak,
  // #829). When the chain already has candidates from auth.json, those are
  // a strictly better signal than whatever the gateway captured from a
  // prior unrelated request.
  if (candidates.length === 0) {
    const lastSeenProvider = getLastSeenAuthProvider() ?? undefined;
    const sessionCred = resolveAuth(
      undefined,
      cfgModel?.providerID ?? lastSeenProvider,
    );
    if (sessionCred) {
      const model =
        cfgModel ?? defaultModelForProvider(lastSeenProvider ?? undefined);
      if (model.modelID) {
        candidates.push({
          label: `last session credential: ${model.providerID}`,
          source: "session",
          getAuth: resolveAuth,
          model,
        });
      }
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Truncate a string for inline log display. Used by the chain's diagnostic
 * to inline per-candidate errors (e.g. "openrouter did not answer (HTTP 400:
 * model not found) — falling through..."). Keeps log lines single-line and
 * within a reasonable width even when the underlying error message is huge.
 */
function truncateForLog(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "…";
}

function formatDate(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 16);
}

async function confirm(message: string, defaultYes = true): Promise<boolean> {
  if (!process.stdin.isTTY) return defaultYes;

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  return new Promise<boolean>((resolve) => {
    rl.question(`${message} ${suffix}: `, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === "") resolve(defaultYes);
      else resolve(trimmed === "y" || trimmed === "yes");
    });
  });
}

/**
 * Read a single line from the given prompt. Returns "" for non-TTY input so
 * callers can apply their own default. Injectable reader for testing.
 */
type LineReader = (prompt: string) => Promise<string>;

const readLine: LineReader = (prompt: string) =>
  new Promise<string>((resolve) => {
    if (!process.stdin.isTTY) {
      resolve("");
      return;
    }
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });

/**
 * Parse a comma/space-separated list of 1-based indices into 0-based indices.
 *
 * Accepts:
 *   - "" / "a" / "all"  → all indices [0..count)
 *   - "1,3" / "1 3"     → [0, 2]
 * Invalid/out-of-range tokens cause a return of `null` (caller re-prompts).
 * Duplicates are collapsed; result is sorted ascending.
 */
export function parseIndexSelection(
  input: string,
  count: number,
): number[] | null {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "" || trimmed === "a" || trimmed === "all") {
    return Array.from({ length: count }, (_, i) => i);
  }

  const tokens = trimmed.split(/[\s,]+/).filter(Boolean);
  const picked = new Set<number>();
  for (const tok of tokens) {
    if (!/^\d+$/.test(tok)) return null;
    const n = Number.parseInt(tok, 10);
    if (n < 1 || n > count) return null;
    picked.add(n - 1);
  }
  if (picked.size === 0) return null;
  return [...picked].sort((a, b) => a - b);
}

/**
 * Prompt the user to pick a subset of items by number. Returns the selected
 * 0-based indices. Non-TTY (and no injected reader) → all. After `maxTries`
 * invalid attempts → all.
 */
export async function selectIndices(
  count: number,
  opts: { reader?: LineReader; maxTries?: number } = {},
): Promise<number[]> {
  const reader = opts.reader ?? readLine;
  const maxTries = opts.maxTries ?? 3;
  const all = () => Array.from({ length: count }, (_, i) => i);
  // Without an injected reader, only prompt on a real TTY; otherwise import all.
  if (!opts.reader && !process.stdin.isTTY) return all();

  for (let attempt = 0; attempt < maxTries; attempt++) {
    const answer = await reader(
      "[lore] Which histories to import? (comma-separated numbers, or 'a' for all): ",
    );
    const parsed = parseIndexSelection(answer, count);
    if (parsed) return parsed;
    console.error(
      "[lore] Invalid selection — enter e.g. '1,3' or 'a' for all.",
    );
  }
  // Fall back to importing everything after repeated invalid input.
  console.error("[lore] Defaulting to all agents.");
  return all();
}

/** A detected session already recorded on the remote gateway. */
type RemoteImportRecord = {
  agent_name: string;
  source_id: string;
  source_hash: string;
};

/**
 * Restrict detection results to a single agent by internal name.
 *
 * Returns the filtered results (possibly empty). Pure — no I/O.
 */
export function applyAgentFilter(
  results: DetectionResult[],
  agentFilter: string | null,
): DetectionResult[] {
  if (!agentFilter) return results;
  return results.filter((r) => r.agentName === agentFilter);
}

/**
 * Drop sessions that have already been imported, recompute per-agent totals,
 * and remove agents left with no new sessions.
 *
 * Dedup source depends on mode:
 *   - remote: match against the remote gateway's import-history rows
 *   - local:  consult the local import DB via `isImportedLocal`
 *
 * Both the hash function and the local-check are injected so this is a pure,
 * testable transform with no direct filesystem/DB dependency.
 */
export function filterAlreadyImported(
  results: DetectionResult[],
  opts: {
    projectPath: string;
    hashOf: (sess: { messageCount: number; lastActivityAt: number }) => string;
    remoteImports?: RemoteImportRecord[];
    isImportedLocal: (
      projectPath: string,
      agentName: string,
      sourceId: string,
      hash: string,
    ) => unknown;
    hasProvider?: (agentName: string) => boolean;
  },
): DetectionResult[] {
  const { projectPath, hashOf, remoteImports, isImportedLocal } = opts;
  const hasProvider = opts.hasProvider ?? (() => true);

  for (const result of results) {
    if (!hasProvider(result.agentName)) continue;

    result.sessions = result.sessions.filter((sess) => {
      const hash = hashOf({
        messageCount: sess.messageCount,
        lastActivityAt: sess.lastActivityAt,
      });
      if (remoteImports) {
        // Check against remote import history
        return !remoteImports.some(
          (r) =>
            r.agent_name === result.agentName &&
            r.source_id === sess.id &&
            r.source_hash === hash,
        );
      }
      // Local mode: check local DB (truthy record → already imported)
      return !isImportedLocal(projectPath, result.agentName, sess.id, hash);
    });

    result.totalMessages = result.sessions.reduce(
      (s, sess) => s + sess.messageCount,
      0,
    );
    result.totalTokens = result.sessions.reduce(
      (s, sess) => s + sess.estimatedTokens,
      0,
    );
  }

  // Remove agents with no new sessions
  return results.filter((r) => r.sessions.length > 0);
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Structured-memory import (Engram / mem0)
// ---------------------------------------------------------------------------

const STRUCTURED_SOURCE_NAMES: readonly StructuredSourceName[] = [
  "engram",
  "mem0",
];

function isStructuredName(name: string): name is StructuredSourceName {
  return (STRUCTURED_SOURCE_NAMES as readonly string[]).includes(name);
}

/**
 * Decide whether this `lore import` invocation targets a structured-memory
 * source, and which one. Precedence:
 *   1. explicit `--source <name>`,
 *   2. `--agent <name>` naming a structured source,
 *   3. `--file` with no source, when exactly one structured source is detected.
 *
 * A bare `lore import` (no flags) does NOT auto-route to a structured source
 * even if one is installed — it stays on the conversation-import lane so a user
 * who merely has the `engram` binary on PATH isn't surprised. Structured import
 * requires an explicit signal (`--source`, `--agent <structured>`, or `--file`).
 *
 * Returns null to fall through to the conversation-import lane.
 */
export function resolveStructuredSourceName(opts: {
  sourceFlag: string | null;
  agentFilter: string | null;
  fileFlag: string | null;
}): StructuredSourceName | null {
  const { sourceFlag, agentFilter, fileFlag } = opts;
  if (sourceFlag && isStructuredName(sourceFlag)) return sourceFlag;
  if (agentFilter && isStructuredName(agentFilter)) return agentFilter;
  // A --file with no source: auto-route to a detected structured source when
  // exactly one is present (a file is an explicit migration intent).
  if (fileFlag && !sourceFlag && !agentFilter) {
    const detected = detectStructuredSources();
    if (detected.length === 1) return detected[0].name;
  }
  return null;
}

async function importStructured(opts: {
  remote: string | undefined;
  projectPath: string;
  sourceName: StructuredSourceName;
  filePath: string | null;
  dryRun: boolean;
  yes: boolean;
  global: boolean;
  mem0?: {
    qdrantUrl?: string;
    collection?: string;
    serverUrl?: string;
    token?: string;
    path?: string;
    user?: string;
  };
}): Promise<void> {
  const { projectPath, sourceName, filePath, dryRun, global } = opts;

  const source = getStructuredSource(sourceName);
  if (!source) {
    const supported = getStructuredSources()
      .map((s) => s.name)
      .join(", ");
    console.error(
      `[lore] Import source "${sourceName}" is not available yet. Supported: ${supported}.`,
    );
    return;
  }

  console.log(
    `[lore] Importing structured memory from ${source.displayName}...`,
  );

  // Produce the normalized document (runs the source's export CLI, reads
  // --file, or probes a running server). This always happens client-side — the
  // remote gateway has no shared filesystem with the client. May be async.
  let doc: conversationImport.LoreImportDoc;
  try {
    doc = await source.produceDoc({
      filePath: filePath ?? undefined,
      project: projectPath,
      mem0QdrantUrl: opts.mem0?.qdrantUrl,
      mem0Collection: opts.mem0?.collection,
      mem0ServerUrl: opts.mem0?.serverUrl,
      mem0Token: opts.mem0?.token,
      mem0Path: opts.mem0?.path,
      mem0User: opts.mem0?.user,
    });
  } catch (err) {
    console.error(
      `[lore] Could not read ${source.displayName} memory: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  if (doc.entries.length === 0) {
    console.log(`[lore] No entries found in ${source.displayName} memory.`);
    return;
  }

  console.log(`[lore] Found ${doc.entries.length} entries.`);

  if (dryRun) {
    const preview = importStructuredEntries(doc, {
      defaultProjectPath: projectPath,
      global,
      dryRun: true,
    });
    console.log(
      `[lore] Dry run — would create ${preview.created}, update ${preview.updated}, skip ${preview.skipped}.`,
    );
    return;
  }

  if (!opts.yes) {
    const ok = await confirm(
      `[lore] Import ${doc.entries.length} entries from ${source.displayName}?`,
    );
    if (!ok) {
      console.log("[lore] Import cancelled.");
      return;
    }
  }

  // Remote mode: send the validated doc to the gateway for the actual write.
  if (opts.remote) {
    await importStructuredRemote(opts.remote, projectPath, doc, global);
    return;
  }

  // Local mode: write directly.
  const result = importStructuredEntries(doc, {
    defaultProjectPath: projectPath,
    global,
  });

  setLastImportAt(projectPath, Date.now());
  try {
    // Ensure imported entries become searchable even in a short-lived CLI.
    const { embedding } = await import("@loreai/core");
    await embedding.backfillEmbeddings();
  } catch {
    // Non-fatal — embeddings backfill on next gateway boot.
  }
  try {
    exportLoreFile(projectPath);
  } catch {
    // Non-fatal
  }

  console.log(
    `[lore] Import complete: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped.`,
  );
  console.log("[lore] Run `lore data list knowledge` to review.");
}

async function importStructuredRemote(
  remote: string,
  projectPath: string,
  doc: conversationImport.LoreImportDoc,
  global: boolean,
): Promise<void> {
  const { getGitRemote, normalizeRemoteUrl } = await import("@loreai/core");
  const raw = getGitRemote(projectPath);
  const normalized = raw ? normalizeRemoteUrl(raw) : undefined;

  console.log(`\n[lore] Using remote gateway at ${remote}`);

  // Re-validate before sending (defensive; the server re-validates too).
  const check = safeParseImportDoc(doc);
  if (!check.success) {
    console.error(
      "[lore] Internal error: produced an invalid import document.",
    );
    return;
  }

  let result: { created: number; updated: number; skipped: number };
  try {
    result = await remotePost(
      remote,
      "/api/v1/import/structured",
      {
        git_remote: normalized,
        path: projectPath,
        global,
        doc,
      },
      { compress: true },
    );
  } catch (err) {
    console.error(
      `[lore] Structured import failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  setLastImportAt(projectPath, Date.now());
  try {
    exportLoreFile(projectPath);
  } catch {
    // Non-fatal
  }

  console.log(
    `[lore] Import complete: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped.`,
  );
  console.log("[lore] Run `lore data list knowledge` to review.");
}

export async function commandImport(
  _args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  // Parse flags
  const dryRun = flags["dry-run"] === true || flags.dryRun === true;
  const yes = flags.yes === true || flags.y === true;
  const agentFilter = (flags.agent as string) ?? null;
  const sourceFlag = (flags.source as string) ?? null;
  const fileFlag = (flags.file as string) ?? null;
  const global = flags.global === true;
  const mem0Opts = {
    qdrantUrl: (flags["mem0-qdrant"] as string) ?? undefined,
    collection: (flags["mem0-collection"] as string) ?? undefined,
    serverUrl: (flags["mem0-server"] as string) ?? undefined,
    token: (flags["mem0-token"] as string) ?? undefined,
    path: (flags["mem0-path"] as string) ?? undefined,
    user: (flags["mem0-user"] as string) ?? undefined,
  };
  const noWorktrees =
    flags["no-worktrees"] === true || flags.noWorktrees === true;
  const projectFlag = flags.project as string | undefined;
  const projectPath = projectFlag ? resolve(projectFlag) : process.cwd();

  const remote = getRemoteUrl();

  // Initialize core (loads config, opens DB, runs migrations).
  // In remote mode we still need load() for detectAll / readChunks which use
  // core's provider registry. A local project record may be created later by
  // the belt-and-suspenders recordImport() call — that's intentional so the
  // local DB has dedup history if the user later runs without LORE_REMOTE_URL.
  await load(projectPath);
  if (!remote) {
    ensureProject(projectPath);
  }

  // Structured-memory import lane (Engram / mem0). Routed by --source/--file
  // (or --agent naming a structured source). This reads ALREADY structured
  // memory and writes it directly to the knowledge store (no curator LLM).
  // Conversation-history import (below) is the other lane.
  if (sourceFlag && !getStructuredSource(sourceFlag)) {
    const supported = getStructuredSources()
      .map((s) => s.name)
      .join(", ");
    console.error(
      `[lore] Import source "${sourceFlag}" is not available. Supported: ${supported}.`,
    );
    return;
  }
  const structuredName = resolveStructuredSourceName({
    sourceFlag,
    agentFilter,
    fileFlag,
  });
  if (structuredName) {
    await importStructured({
      remote,
      projectPath,
      sourceName: structuredName,
      filePath: fileFlag,
      dryRun,
      yes,
      global,
      mem0: mem0Opts,
    });
    return;
  }

  // Detect conversation history (local filesystem scan — always local)
  console.log("[lore] Scanning for conversation history...\n");

  let results = detectAll(projectPath, { worktrees: !noWorktrees });

  if (agentFilter) {
    results = applyAgentFilter(results, agentFilter);
    if (results.length === 0) {
      console.log(
        `[lore] No conversation history found from "${agentFilter}" for this project.`,
      );
      return;
    }
  }

  if (results.length === 0) {
    console.log(
      "[lore] No prior AI conversation history found for this project.",
    );
    return;
  }

  // Filter out already-imported sessions.
  // In remote mode, fetch import history from the remote gateway.
  let remoteImports: RemoteImportRecord[] | undefined;
  if (remote) {
    try {
      const pq = projectQueryParams(projectPath);
      remoteImports = await remoteGet<typeof remoteImports>(
        remote,
        `/api/v1/import/history?${pq}`,
      );
    } catch (err: unknown) {
      // 400/404 = project doesn't exist on remote yet (first import) — proceed without dedup
      const status =
        err instanceof Error && "status" in err
          ? (err as { status: number }).status
          : 0;
      if (status === 400 || status === 404) {
        console.error(
          "[lore] Note: project not yet known to remote gateway — all sessions will be imported.",
        );
      } else {
        // Server errors, auth failures, network issues — re-throw (don't silently double-import)
        throw err;
      }
    }
  }

  results = filterAlreadyImported(results, {
    projectPath,
    hashOf: (sess) =>
      computeHash({
        messageCount: sess.messageCount,
        lastTimestamp: sess.lastActivityAt,
      }),
    remoteImports,
    isImportedLocal: isImported,
    hasProvider: (name) => getProvider(name) != null,
  });

  if (results.length === 0) {
    console.log(
      "[lore] All detected conversations have already been imported.",
    );
    return;
  }

  // Show detection summary. When more than one agent was detected and we can
  // prompt interactively (TTY, no --agent filter, not --yes/--dry-run), offer a
  // numbered multi-select so the user can import a subset.
  const canSelect =
    results.length > 1 &&
    !agentFilter &&
    !yes &&
    !dryRun &&
    process.stdin.isTTY;

  console.log("Found prior conversations for this project:\n");
  results.forEach((result, i) => {
    const prefix = canSelect ? `  ${i + 1}. ` : "  ";
    console.log(`${prefix}${result.agentDisplayName}`);
    console.log(
      `    ${result.sessions.length} sessions, ~${result.totalMessages} messages`,
    );
    if (result.sessions.length > 0) {
      const latest = result.sessions[0];
      console.log(`    Most recent: ${formatDate(latest.lastActivityAt)}`);
    }
    console.log();
  });

  // Interactive agent selection (subset). Non-TTY / --yes / --agent → all.
  if (canSelect) {
    const chosen = await selectIndices(results.length);
    results = chosen.map((i) => results[i]);
    if (results.length === 0) {
      console.log("[lore] No agents selected — import cancelled.");
      return;
    }
  }

  // Recompute totals over the (possibly narrowed) selection.
  const totalMessages = results.reduce((s, r) => s + r.totalMessages, 0);
  const totalSessions = results.reduce((s, r) => s + r.sessions.length, 0);

  // Estimate LLM calls (one per ~12K token chunk)
  const totalTokens = results.reduce((s, r) => s + r.totalTokens, 0);
  const estimatedChunks = Math.ceil(totalTokens / 12288);
  console.log(
    `  Total: ${totalSessions} sessions, ~${totalMessages} messages (~${estimatedChunks} LLM calls)\n`,
  );

  if (dryRun) {
    console.log("[lore] Dry run — no imports performed.");
    return;
  }

  // Confirm unless --yes
  if (!yes) {
    const ok = await confirm(
      "[lore] Import knowledge from these conversations?",
    );
    if (!ok) {
      console.log("[lore] Import cancelled.");
      return;
    }
  }

  // Remote mode: delegate extraction to the remote gateway
  if (remote) {
    await importRemote(remote, projectPath, results);
    return;
  }

  // NOTE: The auth-rejected probe snapshot (`attemptStartedAt`) is now captured
  // PER CANDIDATE inside the fallback loop, not once per run. Per-candidate
  // scoping prevents candidate 1's auth-rejected failure from incorrectly
  // tripping the probe for candidate 2 when candidate 2 returns null for a
  // non-auth reason (network timeout, model bug). Seer finding 15586850.

  // Start gateway for LLM access
  console.log("\n[lore] Starting gateway for LLM access...");

  // Import always runs locally — reading local agent history files.
  const startOpts: StartOptions = { quiet: true, local: true };
  const { config, owned, shutdown } = await startGateway(startOpts);
  const cfg = loreConfig();
  // Worker-model resolution, highest priority first: the LORE_WORKER_MODEL env
  // override (same parse the live worker path uses), then `.lore.json`
  // `workerModel`, then the session `model`. Env parity matters here — a user
  // who set LORE_WORKER_API_KEY + LORE_WORKER_UPSTREAM naturally also sets
  // LORE_WORKER_MODEL, and silently ignoring it routes their key to the wrong
  // provider's default model (e.g. anthropic/claude-* → 404 on api.openai.com).
  const cfgModel =
    parseWorkerModelEnv(process.env.LORE_WORKER_MODEL) ??
    cfg.workerModel ??
    cfg.model;
  const workerApiKey = config.workerApiKey;

  // When a dedicated worker key is used, honor LORE_WORKER_UPSTREAM (both
  // protocol slots point at it) and skip the in-adapter protocol-mismatch
  // pre-flight (the user deliberately chose this key/upstream). Falls back to
  // the default per-protocol upstreams otherwise. (Carried from #1454.)
  const workerUpstreams = config.workerUpstream
    ? { anthropic: config.workerUpstream, openai: config.workerUpstream }
    : { anthropic: config.upstreamAnthropic, openai: config.upstreamOpenAI };

  // Pre-flight guard (carried from #1454): with `dedicatedWorkerKey` disabling
  // the in-adapter mismatch check, a non-`sk-ant-` LORE_WORKER_API_KEY with no
  // LORE_WORKER_UPSTREAM would default to the anthropic upstream and fire one
  // doomed request + one Sentry capture PER CHUNK PER AGENT. Catch it once here.
  if (
    workerApiKey &&
    !config.workerUpstream &&
    (cfgModel?.providerID ?? "anthropic") === "anthropic" &&
    !workerApiKey.startsWith("sk-ant-")
  ) {
    console.error(
      `\n[lore] Can't import: LORE_WORKER_API_KEY is set but doesn't look like an\n` +
        `[lore] Anthropic key (no \`sk-ant-\` prefix), and no target was configured,\n` +
        `[lore] so it would be sent to Anthropic and rejected. Point it at the right\n` +
        `[lore] provider, e.g.:\n` +
        `[lore]\n` +
        `[lore]   export LORE_WORKER_API_KEY=<a raw key for a provider Lore proxies>\n` +
        `[lore]   export LORE_WORKER_UPSTREAM=https://api.openai.com/v1   # match your key\n` +
        `[lore]   lore import\n` +
        `[lore]\n` +
        `[lore] Note: a GitHub Copilot / ChatGPT subscription token is NOT a usable\n` +
        `[lore] raw key. If that's all you have, run \`lore run\` and send one message —\n` +
        `[lore] Lore captures the live credential and imports automatically.`,
    );
    if (owned) await shutdown();
    return;
  }

  try {
    let totalCreated = 0;
    let totalUpdated = 0;
    let totalDeleted = 0;
    let _totalChunks = 0;
    let totalFailed = 0;
    // Track whether ANY agent had a usable credential, so we can print
    // accurate guidance if the whole run authenticated nothing.
    let anyAuthResolved = false;
    // Providers for which we found an agent's env credential but no default
    // model (and the user set none) — collected across ALL agents so the final
    // guidance names every affected provider, not just the last one seen.
    const needsModelProviders = new Set<string>();

    for (const result of results) {
      const provider = getProvider(result.agentName);
      if (!provider) continue;

      // Tier-1 (explicit LORE_WORKER_API_KEY) is a deliberate user override —
      // single-shot, no fallback. Every other path goes through the
      // auto-fallback chain below.
      let tier1: ReturnType<typeof resolveAgentImportAuth>;
      try {
        tier1 = resolveAgentImportAuth(
          result.agentName,
          workerApiKey,
          cfgModel,
        );
      } catch (error) {
        if (!reportInvalidEnvCredentialUpstream(error, result.agentDisplayName))
          throw error;
        continue;
      }
      if (tier1 === null) {
        console.log(
          `[lore] Skipping ${result.agentDisplayName}: no usable credential found ` +
            `in its on-disk auth (none stored, expired, or provider not proxied).`,
        );
        continue;
      }
      if ("needsModel" in tier1) {
        // We HAVE the user's key but not a model to use it with.
        needsModelProviders.add(tier1.needsModel);
        console.log(
          `[lore] Skipping ${result.agentDisplayName}: found your ${tier1.needsModel} ` +
            `credential, but no worker model is set for that provider. ` +
            `Set one and retry (see below).`,
        );
        continue;
      }

      // Build the candidate list. Tier-1 is a single-entry list (no
      // auto-fallback past a deliberate user override). Tier-2/3/4 builds
      // the chain: opencode active provider first, then other auth.json
      // entries, then env credential, then last-seen session.
      type Candidate = {
        auth: typeof tier1;
        label: string;
      };
      // Force-load the models.dev snapshot so per-credential default
      // resolution (defaultSelectableModelForProvider) can pick a
      // concrete model id for defaultless providers like openrouter,
      // deepseek, groq, opencode. Without this warmup the chain runs
      // against an empty cache and filters those credentials at the
      // `if (!model.modelID) continue` guard. Adm (2026-07-30) hit this
      // on a fresh `lore import` process — the cache was never warmed.
      try {
        await fetchModelData();
      } catch {
        // fetchModelData handles its own errors. Failing to load
        // models.dev shouldn't block the import — fall back to the
        // empty-cache path (which still tries WORKER_DEFAULTS
        // providers correctly).
      }
      let chain: AuthCandidate[];
      try {
        chain = workerApiKey
          ? []
          : buildAuthFallbackChain(result.agentName, cfgModel);
      } catch (error) {
        if (!reportInvalidEnvCredentialUpstream(error, result.agentDisplayName))
          throw error;
        continue;
      }
      const candidates: Candidate[] = workerApiKey
        ? [{ auth: tier1, label: "LORE_WORKER_API_KEY" }]
        : chain.map((c) => ({
            auth: {
              getAuth: c.getAuth,
              model: c.model,
              upstream: c.upstream,
            },
            label: c.label,
          }));

      if (candidates.length === 0) {
        // Don't set anyAuthResolved — buildAuthFallbackChain filtered out
        // candidates that lacked a default worker model (an aggregator
        // provider without `LORE_WORKER_MODEL`). Leaving the flag false
        // lets the end-of-run "no usable credential" guidance fire so the
        // user knows what to fix, instead of a silent zero-row import.
        console.log(
          `[lore] Skipping ${result.agentDisplayName}: no usable credential found ` +
            `(auth.json had no routable entries, no shell env credential, no live session).`,
        );
        continue;
      }
      anyAuthResolved = true;

      const sessionIds = result.sessions.map((s) => s.id);
      console.log(`[lore] Reading ${result.agentDisplayName} conversations...`);

      const chunks = provider.readChunks(projectPath, sessionIds);
      if (chunks.length === 0) {
        console.log(
          `[lore] No extractable content from ${result.agentDisplayName}.`,
        );
        continue;
      }

      console.log(
        `[lore] Extracting knowledge from ${chunks.length} chunks (${result.agentDisplayName})...`,
      );

      // Iterate the candidate list. Each candidate attempts the full chunk
      // batch; on upstream 401/403 (abortedByAuth), we move to the next
      // candidate. The first candidate that produces at least one non-auth
      // answer wins. Cost: at most one chunk per failed provider (the
      // worker-health probe inside extract.ts aborts on the first 401).
      let extractResult: Awaited<ReturnType<typeof extractKnowledge>> | null =
        null;
      const triedProviders: Array<{
        label: string;
        providerID: string;
        reason: "auth-rejected" | "no-response";
        /** First per-chunk error from the loop or the LLM client, when
         * no-response. undefined when auth-rejected. Source: the
         * per-chunk try/catch (throw case) OR the LLM adapter's
         * getLastWorkerError() (return-null case — most common). */
        lastError?: string;
      }> = [];

      for (let i = 0; i < candidates.length; i++) {
        const { auth, label } = candidates[i];
        const isFirstAttempt = i === 0;

        // Show the user which credential we're attempting (transparency:
        // not a warning, just an FYI line). On fallback attempts, prefix
        // with "Trying" so the user can see the failover in action.
        console.log(
          isFirstAttempt
            ? `[lore]   Using ${label}`
            : `[lore]   Trying ${label}`,
        );

        // When the credential was captured from the agent's own env (tier 3),
        // route extraction to that captured upstream (e.g. openrouter.ai), not
        // the default anthropic/openai host. A dedicated worker key
        // (config.workerUpstream) still takes precedence.
        const agentUpstreams = resolveExtractionUpstreams(
          auth.upstream,
          config.workerUpstream,
          workerUpstreams,
        );

        const llm = createGatewayLLMClient(
          agentUpstreams,
          auth.getAuth,
          auth.model,
          { dedicatedWorkerKey: !!workerApiKey || auth.upstream != null },
        );

        // Snapshot the auth-rejected timestamp at the START of this attempt.
        // Without this, a failure recorded by an EARLIER candidate would
        // incorrectly trip the probe for THIS candidate if it returns null
        // for a non-auth reason (network timeout, model bug) — wrongly
        // attributing the transient failure to auth and skipping a valid
        // credential. Per-candidate `attemptStartedAt` scopes the probe
        // strictly to failures recorded during THIS attempt's chunks.
        const attemptStartedAt = Date.now();

        const attemptResult = await extractKnowledge({
          llm,
          projectPath,
          chunks,
          model: auth.model,
          onProgress: (progress) => {
            process.stderr.write(
              `\r[lore]   Chunk ${progress.current}/${progress.total} — ${progress.created} created, ${progress.updated} updated`,
            );
          },
          // The standalone import path is session-less (no sessionID is passed
          // to llm.prompt — see extract.ts: workerID is fixed to "lore-import").
          // Inject the worker-health peek so the loop aborts on the FIRST chunk
          // whose LLM call returned null AND an upstream `auth-rejected` was
          // recorded, instead of letting the same broken credential burn the
          // remaining 70 chunks.
          wasRecentChunkAuthRejected: () =>
            hasRecentAuthRejectedFailure(
              "_unknown",
              "lore-import",
              60_000,
              attemptStartedAt,
            ),
        });

        // Clear the progress line
        process.stderr.write("\n");

        // Success path: at least one chunk was answered AND we weren't aborted
        // by auth. Take this candidate's result and stop iterating.
        if (!attemptResult.abortedByAuth && attemptResult.chunksAnswered > 0) {
          extractResult = attemptResult;
          break;
        }

        // Failed attempt — record this candidate as tried and move to the next.
        // The wording distinguishes auth-rejected from a generic failure
        // (network timeout, malformed response, model bug) so the user can
        // diagnose the right thing. Only the auth-rejected case is
        // actionable for credential rotation; other failures might be
        // transient and resolve on the next attempt.
        // For no-response, prefer the LLM adapter's getLastWorkerError() —
        // it captures the actual error from every return-null path
        // (4xx non-2xx, data-policy block, credit, retry exhausted, etc.)
        // that the per-chunk try/catch in extract.ts doesn't see. Fall
        // back to attemptResult.lastError for the throw case (PR #1541).
        const noResponseErr = !attemptResult.abortedByAuth
          ? (getLastWorkerError() ?? attemptResult.lastError)
          : undefined;
        triedProviders.push({
          label,
          providerID: auth.model.providerID,
          reason: attemptResult.abortedByAuth ? "auth-rejected" : "no-response",
          // Preserve the underlying error so the final diagnostic can
          // surface it (adm's openrouter silent-fail case, Slack 2026-07-30).
          // Undefined when abortedByAuth (the upstream already told us why).
          // Source: the per-chunk try/catch (PR #1541, throw case) OR
          // the LLM adapter's getLastWorkerError() (return-null case).
          lastError: noResponseErr,
        });

        if (i < candidates.length - 1) {
          const reasonText = attemptResult.abortedByAuth
            ? `rejected the credential`
            : `did not answer`;
          // Surface the underlying error when known so adm (and similar users)
          // can diagnose without needing to enable debug logging. The "no-response"
          // diagnostic alone is opaque — could be auth, network, model-not-found,
          // rate-limit, or a malformed response. Source: per-chunk catch
          // (PR #1541) OR the LLM adapter's getLastWorkerError() (this PR).
          const detail = noResponseErr
            ? ` (${truncateForLog(noResponseErr, 200)})`
            : "";
          console.log(
            `[lore]   ${auth.model.providerID} ${reasonText}${detail} — ` +
              `falling through to next provider.`,
          );
        }
      }

      // No candidate worked — surface a single combined diagnostic.
      // When ANY tried provider was auth-rejected (vs a generic no-response),
      // we still print the credential-fix advice because at least one path
      // needs a fresh key. When ALL tried providers failed for a non-auth
      // reason, the credential advice is misleading and we surface a generic
      // "models didn't answer" message instead.
      if (extractResult === null) {
        const authRejectedCount = triedProviders.filter(
          (t) => t.reason === "auth-rejected",
        ).length;
        const allNonAuth = authRejectedCount === 0;
        const triedList = triedProviders
          .map((t) => `${t.providerID} (${t.label})`)
          .join(", ");
        const multiLine =
          triedProviders.length > 1 && !allNonAuth
            ? "\n[lore] No provider auto-fallback could authenticate."
            : "";

        if (allNonAuth) {
          // Show the underlying error from the first no-response attempt so
          // the user can diagnose without enabling --debug. The error is
          // truncated because HTTP bodies can be huge (openrouter 4xx often
          // returns a JSON blob with full request details).
          const noResponseEntry = triedProviders.find(
            (t) => t.reason === "no-response",
          );
          const lastError = noResponseEntry?.lastError?.trim() || undefined;
          const errorDetail = lastError
            ? `\n[lore] First error: ${truncateForLog(lastError, 300)}`
            : "";
          console.error(
            `\n[lore] Can't import ${result.agentDisplayName}: tried ${triedList || "all available"} ` +
              `and none answered (no HTTP 401 — likely transient network/timeout/model issue).${errorDetail}\n` +
              `[lore]\n` +
              `[lore] Re-run \`lore import\` after a moment. If this keeps happening, file an ` +
              `issue with the full output of \`lore import --debug\`.\n`,
          );
          // Count one chunk per attempted candidate (the worker-health
          // probe aborts on the first chunk, so only chunks.length/total
          // attempts were actually made — not all chunks). The full
          // failure summary at the end still surfaces the actual count
          // for transparency.
          totalFailed += triedProviders.length || 1;
          continue;
        }

        console.error(
          `\n[lore] Can't import ${result.agentDisplayName}: tried ${triedList || "all available"} ` +
            `and all rejected the credential (HTTP 401).${multiLine}\n` +
            `[lore]\n` +
            `[lore] The credential likely came from one of these places. ` +
            `Pick the one that matches your setup:\n` +
            `[lore]\n` +
            `[lore]   1. ${result.agentDisplayName} on-disk auth. Update ` +
            `or re-authenticate in that agent (e.g. \`opencode auth login\`).\n` +
            `[lore]      Then re-run \`lore import\`.\n` +
            `[lore]\n` +
            `[lore]   2. Shell env vars (e.g. ANTHROPIC_AUTH_TOKEN / ` +
            `ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY). ` +
            `Confirm the key in your shell, then re-run \`lore import\` ` +
            `from the same shell.\n` +
            `[lore]\n` +
            `[lore]   3. Override the import credential entirely with a ` +
            `dedicated worker key:\n` +
            `[lore]        export LORE_WORKER_API_KEY=<a fresh raw API key>\n` +
            `[lore]        lore import\n` +
            `[lore]\n` +
            `[lore] Tip: a ChatGPT / GitHub Copilot subscription token is NOT ` +
            `a usable raw key for the API. If that's all you have, run \`lore ` +
            `run\` and send one message — Lore captures the live credential ` +
            `and re-offers imports automatically.`,
        );
        // Count one chunk per auth-rejected candidate (the worker-health
        // probe aborts on the first chunk of each candidate, so the
        // actual number of attempted chunks equals the number of tried
        // providers — not chunks.length).
        totalFailed += triedProviders.length || 1;
        continue;
      }

      // Record imports for each session. (The pre-PR guard for
      // `chunksAnswered === 0` was deleted — the fallback loop already
      // surfaces the no-response case via the combined-tried diagnostic when
      // every candidate fails. A non-aborted candidate with 0 answered is no
      // longer reachable because the loop's success predicate requires
      // `chunksAnswered > 0` to break.)
      for (const sess of result.sessions) {
        const hash = computeHash({
          messageCount: sess.messageCount,
          lastTimestamp: sess.lastActivityAt,
        });
        recordImport(projectPath, result.agentName, sess.id, hash, {
          created: extractResult.created,
          updated: extractResult.updated,
        });
      }

      totalCreated += extractResult.created;
      totalUpdated += extractResult.updated;
      totalDeleted += extractResult.deleted;
      _totalChunks += extractResult.chunksProcessed;
      totalFailed += extractResult.chunksFailed;
    }

    // We found the user's credential but no model to drive it (an aggregator /
    // proxy provider with no built-in default, and no model configured). Tell
    // them exactly how to fix it — we're one env var away from working. Name
    // EVERY affected provider (a multi-agent run can hit more than one). Shown
    // whenever ANY agent hit this, even if OTHERS authenticated successfully —
    // the per-agent skip lines promised "(see below)", so the guidance must
    // always appear when a needsModel failure occurred.
    const needsModelMsg = buildNeedsModelGuidance(
      [...needsModelProviders],
      anyAuthResolved,
    );
    if (needsModelMsg) {
      console.error(needsModelMsg);
      // Nothing else authenticated → stop here (don't fall through to the
      // generic "no credential" block or the success summary). If OTHER agents
      // succeeded, keep going so their import still records + summarizes.
      if (!anyAuthResolved) return;
    }

    // No agent had a usable credential — explain how to fix it, then stop
    // before claiming a successful (empty) import. Only name a specific
    // provider in the key hint when the user EXPLICITLY configured a model;
    // otherwise stay neutral (a Copilot/OpenRouter user has no "anthropic key"
    // to export). Lead with the universal `lore run` path.
    if (!anyAuthResolved) {
      const keyHint = cfgModel
        ? `<your ${cfgModel.providerID} key>`
        : "<key for your provider>";
      console.error(
        "\n[lore] Can't import: no usable credential found for background extraction.\n" +
          "[lore] `lore import` authenticates using each agent's OWN credentials —\n" +
          "[lore] its on-disk auth file OR its base-URL + auth-token env vars (e.g.\n" +
          "[lore] ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN) — but none were usable\n" +
          "[lore] (none found, expired, or the provider needs a runtime token exchange\n" +
          "[lore] Lore can't do standalone, e.g. GitHub Copilot).\n" +
          "[lore] Ways forward:\n" +
          "[lore]\n" +
          "[lore]   1. If you launch your agent with base-URL + token env vars set\n" +
          "[lore]      (OpenRouter / proxy setups), export them in THIS shell and retry:\n" +
          "[lore]        export ANTHROPIC_BASE_URL=... ANTHROPIC_AUTH_TOKEN=...\n" +
          "[lore]        lore import\n" +
          "[lore]\n" +
          "[lore]   2. Or run `lore run`, send one message, and the import happens\n" +
          "[lore]      automatically once your credential is captured.\n" +
          "[lore]\n" +
          "[lore]   3. Or give `lore import` a dedicated worker key and retry:\n" +
          `[lore]        export LORE_WORKER_API_KEY=${keyHint}\n` +
          "[lore]        lore import",
      );
      return;
    }

    // Record import timestamp (supplementary — auto-import gates on per-agent
    // import_history rows via hasAgentImportRecord, not this timestamp)
    setLastImportAt(projectPath, Date.now());

    // Export .lore.md
    try {
      exportLoreFile(projectPath);
    } catch {
      // Non-fatal
    }

    // Summary
    console.log(
      `\n[lore] Import complete: ${totalCreated} entries created, ${totalUpdated} updated` +
        (totalDeleted ? `, ${totalDeleted} deleted` : "") +
        (totalFailed ? ` (${totalFailed} chunks failed)` : "") +
        ".",
    );
    console.log("[lore] Run `lore data list knowledge` to review.");
  } finally {
    if (owned) await shutdown();
  }
}

// ---------------------------------------------------------------------------
// Remote import — detection + chunk reading local, extraction via gateway API
// ---------------------------------------------------------------------------

async function importRemote(
  remote: string,
  projectPath: string,
  results: ReturnType<typeof detectAll>,
): Promise<void> {
  const { getGitRemote, normalizeRemoteUrl } = await import("@loreai/core");
  const raw = getGitRemote(projectPath);
  const normalized = raw ? normalizeRemoteUrl(raw) : undefined;

  console.log(`\n[lore] Using remote gateway at ${remote}`);

  let totalCreated = 0;
  let totalUpdated = 0;
  let totalDeleted = 0;
  let _totalChunks = 0;
  let totalFailed = 0;

  for (const result of results) {
    const provider = getProvider(result.agentName);
    if (!provider) continue;

    const sessionIds = result.sessions.map((s) => s.id);
    console.log(`[lore] Reading ${result.agentDisplayName} conversations...`);

    const chunks = provider.readChunks(projectPath, sessionIds);
    if (chunks.length === 0) {
      console.log(
        `[lore] No extractable content from ${result.agentDisplayName}.`,
      );
      continue;
    }

    console.log(
      `[lore] Extracting knowledge from ${chunks.length} chunks via remote gateway (${result.agentDisplayName})...`,
    );

    // Send chunks to remote gateway for extraction (zstd-compressed)
    let extractResult: {
      created: number;
      updated: number;
      deleted: number;
      chunksProcessed: number;
      chunksFailed: number;
    };
    try {
      extractResult = await remotePost(
        remote,
        "/api/v1/import/extract",
        {
          git_remote: normalized,
          path: projectPath,
          chunks: chunks.map((c) => ({
            label: c.label,
            text: c.text,
            estimatedTokens: c.estimatedTokens,
            timestamp: c.timestamp,
          })),
        },
        { compress: true },
      );
    } catch (err) {
      console.error(
        `[lore] Extraction failed for ${result.agentDisplayName}: ${err instanceof Error ? err.message : String(err)}`,
      );
      totalFailed += chunks.length;
      continue;
    }

    // Record imports on remote gateway + locally (belt-and-suspenders:
    // remote is source of truth, local prevents re-detection if user
    // later runs without LORE_REMOTE_URL)
    for (const sess of result.sessions) {
      const hash = computeHash({
        messageCount: sess.messageCount,
        lastTimestamp: sess.lastActivityAt,
      });
      try {
        await remotePost(remote, "/api/v1/import/record", {
          git_remote: normalized,
          path: projectPath,
          agent_name: result.agentName,
          source_id: sess.id,
          source_hash: hash,
          stats: {
            created: extractResult.created,
            updated: extractResult.updated,
          },
        });
      } catch (err) {
        console.error(
          `[lore] Warning: failed to record import on remote: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // Also record locally (belt-and-suspenders)
      try {
        recordImport(projectPath, result.agentName, sess.id, hash, {
          created: extractResult.created,
          updated: extractResult.updated,
        });
      } catch {
        // Non-fatal — remote record is the source of truth
      }
    }

    totalCreated += extractResult.created;
    totalUpdated += extractResult.updated;
    totalDeleted += extractResult.deleted;
    _totalChunks += extractResult.chunksProcessed;
    totalFailed += extractResult.chunksFailed;
  }

  // Record import timestamp locally (supplementary — auto-import gates on per-agent
  // import_history rows via hasAgentImportRecord, not this timestamp)
  setLastImportAt(projectPath, Date.now());

  // Export .lore.md locally so knowledge appears in the local file
  try {
    exportLoreFile(projectPath);
  } catch {
    // Non-fatal
  }

  // Summary
  console.log(
    `\n[lore] Import complete: ${totalCreated} entries created, ${totalUpdated} updated` +
      (totalDeleted ? `, ${totalDeleted} deleted` : "") +
      (totalFailed ? ` (${totalFailed} chunks failed)` : "") +
      ".",
  );
  console.log("[lore] Run `lore data list knowledge` to review.");
}
