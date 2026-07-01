/**
 * Gateway LLM adapter: implements LLMClient via direct API calls.
 * Used by Lore's background workers (distillation, curation, query expansion)
 * running inside the gateway process.
 *
 * Supports both Anthropic Messages API and OpenAI Chat Completions API.
 * The wire protocol is determined by explicit protocol from the session's
 * UpstreamSnapshot (threaded via opts.protocol), with fallback to the
 * provider route registry (PROVIDER_ROUTES) and a safe default of
 * "anthropic" for unknown/aggregator providers:
 *   - Anthropic protocol → POST /v1/messages
 *   - OpenAI protocol    → POST /v1/chat/completions
 *
 * Protocol is decoupled from provider identity — proxy/aggregator
 * providers (e.g. OpenCode Zen) that have protocol=null in the route
 * table receive their protocol from the session snapshot instead.
 *
 * Retry logic, Sentry instrumentation, worker call tracking, and error
 * handling are shared across both protocols.
 */

import type { LLMClient } from "@loreai/core";
import { log } from "@loreai/core";
import * as Sentry from "@sentry/bun";
import type { AuthCredential } from "./auth";
import { authHeaders, markAuthStale, markGlobalAuthStale } from "./auth";
import { tripCircuitBreaker } from "./background-limiter";
import { resolveProviderRoute } from "./config";
import {
  buildBillingBlock,
  buildCodexWorkerHeaders,
  buildOAuthWorkerHeaders,
  workerUserAgent,
  signBody,
} from "./cch";
import {
  setGenAiUsageAttributes,
  emitCostMetric,
  type AnthropicUsage,
} from "./sentry";
import { recordWorkerCost } from "./cost-tracker";
import { upstreamFetch } from "./fetch";
import { extractJSONFromSSE } from "./translate/types";
import { buildOpenAIChatCompletionsUrl } from "./translate/openai";
import { isBedrockMantleHost, toMantleModelId } from "./translate/bedrock";
import {
  toVertexBody,
  toVertexModelId,
  vertexRawPredictUrl,
  vertexRegionFromUrl,
} from "./translate/vertex";
import { getVertexAccessToken, resolveVertexProject } from "./vertex-auth";
import {
  recordWorkerFailure,
  markWorkerPaused,
  isWorkerIncapable,
  recordEmptyWorkerResponse,
  clearEmptyWorkerStreak,
} from "./worker-health";
import { getModelEntrySync } from "./worker-model";

// ---------------------------------------------------------------------------
// Worker call tracking
// ---------------------------------------------------------------------------

/** Tracks worker session IDs so temporal capture can skip them. */
export const activeWorkerCalls = new Set<string>();

// ---------------------------------------------------------------------------
// Retry helpers (exported for testing)
// ---------------------------------------------------------------------------

/** HTTP status codes that are transient and worth retrying. 504 (Gateway
 *  Timeout) is included: upstream gateways (esp. OpenRouter fronting slow free
 *  models) return it on transient upstream timeouts — a retry usually clears. */
const TRANSIENT_CODES = new Set([429, 500, 502, 503, 504, 529]);

/** HTTP status codes indicating permanent auth failure. */
export const AUTH_ERROR_CODES = new Set([401, 403]);

/**
 * Provider "payment required / out of credit" codes (e.g. OpenRouter 402
 * "requires more credits"). An expected account state, NOT an infrastructure
 * outage: suppress Sentry escalation, do not count toward the worker-health
 * failure ladder, and soft-pause the session so we stop retrying every turn.
 */
const INSUFFICIENT_CREDIT_CODES = new Set([402]);

/**
 * Matches the long-context (1M) beta token family, e.g.
 * `context-1m-2025-08-07`. The date suffix changes over time, so match the
 * `context-1m` stem (optionally followed by `-<suffix>`), anchored on a
 * trimmed token so it can't match a substring inside another beta name.
 */
const LONG_CONTEXT_BETA_RE = /^context-1m(?:-.*)?$/;

/** Minimum model context window (tokens) required to keep a `context-1m` beta. */
const LONG_CONTEXT_MIN_WINDOW = 1_000_000;

/**
 * Does this header set carry an `anthropic-beta` whose value contains a
 * long-context (`context-1m`) token? Only the long-context beta is a plausible
 * cause of the "beta not available for this subscription" 400 on worker calls,
 * so the retry fallback is gated on its presence — we never strip betas (and
 * lose the OAuth gate) for an unrelated 400.
 */
function hasLongContextBeta(headers: Record<string, string>): boolean {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "anthropic-beta" && /context-1m/i.test(v)) {
      return true;
    }
  }
  return false;
}

/**
 * Return a copy of the headers with ONLY the long-context (`context-1m`) beta
 * token removed from `anthropic-beta`, preserving every other beta — crucially
 * `oauth-2025-04-20`, which OAuth/bearer worker calls require to authenticate.
 * Stripping the whole header would turn a recoverable beta-400 into a 401 on
 * OAuth sessions. If removing the long-context token leaves no betas, the
 * header is dropped entirely. Used as a runtime fallback on a beta-related 400.
 */
function stripBetaHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "anthropic-beta") {
      const kept = v
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0 && !LONG_CONTEXT_BETA_RE.test(t));
      if (kept.length > 0) out[k] = kept.join(",");
      continue;
    }
    out[k] = v;
  }
  return out;
}

/**
 * Heuristic: does a 400 body indicate the request used a beta feature the
 * model/subscription doesn't support? Matches Anthropic's long-context and
 * generic beta-availability errors (e.g. "The long context beta is not yet
 * available for this subscription", "... beta is not available", "unsupported
 * beta"). Conservative — only triggers the one-shot beta-stripped retry.
 */
function isBetaRelated400(body: string): boolean {
  return (
    /\bbeta\b/i.test(body) &&
    /\b(not\s+(yet\s+)?available|unsupported|not\s+enabled|invalid)\b/i.test(
      body,
    )
  );
}

/**
 * Worker call sites set `temperature: 0` for reproducible distillation/curation.
 * Newer models (e.g. Anthropic `claude-sonnet-5`) have DEPRECATED the sampling
 * `temperature` param and reject any request that includes it with a 400
 * ("`temperature` is deprecated for this model."), which breaks every worker on
 * that model. We learn this fact at runtime — on the first such 400 — so
 * subsequent worker calls omit `temperature` upfront instead of burning a
 * wasted round-trip per call. The set is intentionally NOT seeded from a
 * hardcoded model list: hardcoding drifts as models ship and risks both false
 * positives (stripping from a model that supports it) and misses (a new model
 * we forgot). Runtime learning is always correct and self-healing. Keyed by
 * `providerID/modelID`; in-memory, so it re-learns at most once per model per
 * gateway lifetime after a restart.
 */
const temperatureUnsupportedModels = new Set<string>();

/** Stable key for the temperature-capability set. */
function workerModelKey(model: {
  providerID: string;
  modelID: string;
}): string {
  return `${model.providerID}/${model.modelID}`;
}

/** Record that a model rejects the `temperature` param (learned from a 400). */
export function markTemperatureUnsupported(model: {
  providerID: string;
  modelID: string;
}): void {
  temperatureUnsupportedModels.add(workerModelKey(model));
}

/** Has this model been observed to reject the `temperature` param? */
export function isTemperatureUnsupportedModel(model: {
  providerID: string;
  modelID: string;
}): boolean {
  return temperatureUnsupportedModels.has(workerModelKey(model));
}

/** Test-only: clear the learned temperature-capability set. */
export function _resetTemperatureUnsupportedModels(): void {
  temperatureUnsupportedModels.clear();
}

/**
 * Heuristic: does a 400 body indicate the request's `temperature` param is not
 * accepted by this model? Matches Anthropic's "`temperature` is deprecated for
 * this model." and OpenAI-style "Unsupported parameter: temperature" / "...
 * not supported ..." shapes. Requires the word `temperature` AND a rejection
 * verb so an unrelated 400 that merely mentions temperature can't trigger the
 * one-shot temperature-stripped retry.
 */
function isTemperatureUnsupported400(body: string): boolean {
  return (
    /temperature/i.test(body) &&
    /\b(deprecated|unsupported|no\s+longer\s+supported|not\s+(?:a\s+)?support(?:ed)?|removed|not\s+allowed|cannot\s+be\s+(?:set|used|specified))\b/i.test(
      body,
    )
  );
}

/**
 * Unified retry policy (modeled on Claude Code's `getRetryDelay`).
 *
 * A single policy governs every worker call — urgent or background, 429 or
 * 5xx, Anthropic or any OpenAI-compatible provider. We deliberately do NOT
 * bifurcate retry timing by urgency: the early retries are fast (sub-second),
 * so a transient blip clears quickly without the old 60s background first-wait
 * that made urgent calls (compaction) "hang", while the cap + jitter keep a
 * sustained 429 storm from hammering the API. Aggregate pressure is managed
 * centrally by the circuit breaker (see `background-limiter.ts`), which now
 * trips on any 429 — so per-call wide spacing is no longer needed.
 *
 * Server `Retry-After` is always honored (capped at MAX_DELAY_MS so a
 * pathological header can't wait unbounded). Without a header we use
 * exponential backoff with jitter: 0.5s, 1s, 2s, 4s, 8s, 16s, 32s, 32s…
 */
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 32_000;

// Why we retry rather than bail fast on rate limits (kept as a line comment so
// the env-docs generator scrapes only the concise JSDoc below, not this prose):
// Worker calls share the session's credential and (usually) model, so a 429 the
// worker hits is the same 429 the client's own request would hit — bailing
// early doesn't let the client "continue", it just discards Lore's enriched
// output and hands the identical wait to the client. So we ride out transient
// 429s here (honoring Retry-After). The fall-back path is the last-resort
// safety net for *non-shared* failures (a Lore-specific worker error, or a
// worker-model-only 429/529) and for surfacing a sustained outage rather than
// holding the client's connection open indefinitely. Raw conversation data is
// never lost on fall-back: turns are already in temporal storage,
// distillation/curation retry on the next idle pass, and compaction forwards
// the client's native compaction. The total hold is bounded (~MAX_DELAY_MS ×
// retries) to stay under typical client read-timeouts; SSE keep-alive
// heartbeats (a follow-up) would let us wait out longer windows.
/**
 * Number of times a worker upstream call retries a transient failure before
 * falling back to the caller's own handling (default: 8). Override with the
 * LORE_MAX_RETRIES env var.
 */
const DEFAULT_MAX_RETRIES = 8;

/**
 * Default output budget for a worker call when the caller does not specify one.
 *
 * Reasoning models (DeepSeek, Qwen-thinking, Nemotron, MiniMax — common on free
 * aggregator tiers) count hidden reasoning tokens against `max_completion_tokens`
 * / `max_tokens`. With too small a budget the model can spend the entire
 * allowance on reasoning and emit an EMPTY `content`/`text` block
 * (`finish_reason:"length"`), which previously surfaced as an opaque
 * `no-response`. We give workers reasoning headroom so a distillation/curation
 * call has room for both the reasoning pass and the visible answer. This is a
 * cap, not a charge: non-reasoning models still only emit (and bill for) the
 * tokens they actually produce.
 */
const DEFAULT_WORKER_MAX_TOKENS = 16384;

/**
 * Resolve the retry budget. `LORE_MAX_RETRIES` overrides the default; values
 * that are non-numeric, negative, or zero fall back to the default (we never
 * silently disable retries — that would contradict the "ride it out" policy).
 */
function resolveMaxRetries(): number {
  const env = process.env.LORE_MAX_RETRIES;
  if (env) {
    const n = Number.parseInt(env, 10);
    if (Number.isFinite(n) && n >= 1) return n;
  }
  return DEFAULT_MAX_RETRIES;
}

/**
 * Max retries for a worker call. A single budget regardless of status code or
 * urgency (the `_status` parameter is retained for call-site readability and
 * potential future tuning).
 */
export function maxRetriesFor(_status: number | null = null): number {
  return resolveMaxRetries();
}

/** Parse the Retry-After header into milliseconds, or null if absent/invalid. */
export function parseRetryAfter(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

/**
 * Compute delay for a retry attempt (0-based) using the unified policy.
 * - Honor Retry-After when present, capped at MAX_DELAY_MS.
 * - Otherwise exponential backoff with 0-25% jitter:
 *   min(BASE_DELAY_MS * 2^attempt, MAX_DELAY_MS) + jitter.
 */
export function backoffMs(
  attempt: number,
  retryAfterMs: number | null,
): number {
  if (retryAfterMs != null) return Math.min(retryAfterMs, MAX_DELAY_MS);
  const base = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  return base + Math.random() * 0.25 * base;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// OpenAI response types & usage normalization (exported for testing)
// ---------------------------------------------------------------------------

/** OpenAI Chat Completions response shape (subset we need). */
type OpenAIChatResponse = {
  choices?: Array<{
    message?: {
      content?: string;
      // Reasoning models (DeepSeek, Qwen-thinking, Nemotron, MiniMax, etc.)
      // commonly served on aggregators like OpenCode Zen put their answer in a
      // reasoning field and leave `content` empty/null. We read these as a
      // fallback so worker calls to such models are not misclassified as
      // empty/no-response. `reasoning_content` is the DeepSeek/Qwen field;
      // `reasoning` is the OpenRouter/others field.
      reasoning_content?: string;
      reasoning?: string;
    };
    finish_reason?: string;
  }>;
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
};

/**
 * Normalize OpenAI usage to the AnthropicUsage shape for unified cost tracking.
 *
 * Maps:
 *   prompt_tokens                          → input_tokens
 *   completion_tokens                      → output_tokens
 *   prompt_tokens_details.cached_tokens    → cache_read_input_tokens
 *   (not reported by OpenAI)               → cache_creation_input_tokens = 0
 */
export function normalizeOpenAIUsage(
  usage: OpenAIChatResponse["usage"],
): AnthropicUsage {
  return {
    input_tokens: usage?.prompt_tokens ?? 0,
    output_tokens: usage?.completion_tokens ?? 0,
    cache_read_input_tokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
    cache_creation_input_tokens: 0, // OpenAI doesn't report this separately
  };
}

// ---------------------------------------------------------------------------
// Provider-specific request builders
// ---------------------------------------------------------------------------

/**
 * Wire protocol for worker requests.
 *
 * `openai-responses` is collapsed to `"openai"` (Chat Completions) for normal
 * OpenAI providers — workers do simple prompt→response and the Chat Completions
 * endpoint is simpler/cheaper. The one exception is `openai-codex`: ChatGPT's
 * `/backend-api` serves ONLY the Responses API (`/codex/responses`), so it gets
 * a dedicated `"openai-codex-responses"` worker protocol that speaks Responses.
 */
type WorkerProtocol =
  | "anthropic"
  | "openai"
  | "openai-codex-responses"
  | "vertex";

/** Upstream URL, wire protocol, and provider label for a resolved target. */
type ProviderTarget = {
  url: string;
  protocol: WorkerProtocol;
  /** Provider label for Sentry spans and logging. */
  providerName: string;
};

/**
 * Resolve the wire protocol for a worker request.
 *
 * Priority:
 *  1. Explicit protocol from caller (threaded from UpstreamSnapshot)
 *  2. Route table lookup via PROVIDER_ROUTES
 *  3. Default: "anthropic" (safest — most aggregators speak Anthropic)
 *
 * `openai-responses` is collapsed to `"openai"` because workers only use
 * simple prompt→response via Chat Completions, not the Responses API — EXCEPT
 * for `openai-codex`, whose ChatGPT backend serves only the Responses API and
 * therefore maps to `"openai-codex-responses"`.
 */
export function resolveWorkerProtocol(
  providerID: string,
  explicit?: "anthropic" | "openai" | "openai-responses" | "vertex",
): WorkerProtocol {
  // openai-codex MUST use the Responses API — its backend has no Chat
  // Completions endpoint. This takes precedence over the explicit hint
  // (which would otherwise collapse openai-responses → openai).
  if (providerID === "openai-codex") {
    return "openai-codex-responses";
  }
  // 1. Explicit protocol from caller (threaded from UpstreamSnapshot)
  if (explicit) {
    // Vertex is a DISTINCT worker protocol: it speaks the Anthropic Messages
    // body but to a :rawPredict URL (model in the path) authenticated with a
    // GCP OAuth2 token — buildVertexWorkerRequest handles all three. It must
    // NOT collapse to "anthropic" (that would POST to /v1/messages with an
    // x-api-key). NOTE: AWS Bedrock is NOT a distinct worker protocol — it is
    // reached via the bedrock-mantle endpoint, whose snapshot protocol is
    // already "anthropic" (route carries `bedrockMantle: true`), so Bedrock
    // worker calls route to the mantle upstream over the normal Anthropic path.
    if (explicit === "vertex") return "vertex";
    return explicit === "anthropic" ? "anthropic" : "openai";
  }
  // 2. Route table lookup
  const route = resolveProviderRoute(providerID);
  if (route?.protocol) {
    if (route.protocol === "vertex") return "vertex";
    return route.protocol === "anthropic" ? "anthropic" : "openai";
  }
  // 3. Default: anthropic (safest for unknown/aggregator providers)
  return "anthropic";
}

/**
 * Resolve upstream target URL and protocol for a worker model.
 *
 * CROSS-PROVIDER SAFETY: the `upstreamOverride` (the session's endpoint) is
 * ONLY honored when the worker model's provider matches the session/override
 * provider. A session endpoint belongs to provider A; sending provider B's
 * model there with provider A's credential is the exact misconfig that caused
 * the production 401 loop (minimax model → api.anthropic.com). When the worker
 * model's provider differs, we route by the model's OWN provider route table
 * (`resolveProviderRoute`) and ignore the session override. If the model's
 * provider has no route URL, `routeUrl` is null and the caller must fail closed
 * rather than fall back to a foreign endpoint.
 *
 * @param modelProviderID  The worker model's provider (authoritative for routing)
 * @param overrideProviderID  The session/override provider, if known
 */
function resolveTarget(
  upstreams: { anthropic: string; openai: string },
  protocol: WorkerProtocol,
  upstreamOverride: string | undefined,
  modelProviderID: string,
  overrideProviderID?: string,
): ProviderTarget & { routeUnavailable?: boolean } {
  // Honor the session override ONLY when we have positive evidence it belongs
  // to this worker model's provider:
  //  - overrideProviderID matches the model's provider (the normal case), OR
  //  - overrideProviderID is unknown AND the model provider does NOT have its
  //    own distinct provider route (so there's no safer endpoint to prefer —
  //    e.g. the model provider IS the override's, or it's an aggregator).
  // When overrideProviderID is unknown but the model HAS its own route (e.g.
  // minimax → api.minimax.io), we do NOT trust the foreign override — we route
  // by the model's own provider below. This fails safe: a future caller that
  // sets `upstreamUrl` without `upstreamProviderID` cannot silently re-open the
  // cross-provider collusion (the production minimax→Anthropic 401 loop).
  const overrideMatchesModel = overrideProviderID
    ? overrideProviderID === modelProviderID
    : resolveProviderRoute(modelProviderID)?.url == null;
  if (upstreamOverride && overrideMatchesModel) {
    return {
      url: upstreamOverride.replace(/\/$/, ""),
      protocol,
      // Use the friendly provider label for codex; otherwise the protocol is a
      // reasonable span label for an override target.
      providerName:
        protocol === "openai-codex-responses" ? "openai-codex" : protocol,
    };
  }

  // Cross-provider (or no override): route by the worker model's OWN provider.
  // This is what sends a minimax worker to api.minimax.io instead of colluding
  // with the session's Anthropic endpoint.
  // No usable session override for this model — route by the worker model's
  // OWN provider. This covers both (a) a cross-provider override that doesn't
  // match the model, and (b) no override at all. The default anthropic/openai
  // endpoints (below) are ONLY for the two providers they actually belong to;
  // a foreign provider (minimax, xai, ...) must use its route or fail closed,
  // never silently land on api.anthropic.com.
  const isCrossProviderOverride = !!upstreamOverride && !overrideMatchesModel;
  const isDefaultProvider =
    modelProviderID === "anthropic" || modelProviderID === "openai";
  if (isCrossProviderOverride || !isDefaultProvider) {
    if (protocol === "openai-codex-responses") {
      // Codex has no static default upstream — fall back to its provider route.
      const route = resolveProviderRoute("openai-codex");
      if (route?.url) {
        return {
          url: route.url.replace(/\/$/, ""),
          protocol,
          providerName: "openai-codex",
        };
      }
    } else {
      const route = resolveProviderRoute(modelProviderID);
      if (route?.url) {
        return {
          url: route.url.replace(/\/$/, ""),
          protocol,
          providerName: modelProviderID,
        };
      }
    }
    // No route URL for this provider (unknown, or a local provider needing an
    // explicit LORE_UPSTREAM_<PROVIDER>). Signal the caller to fail closed —
    // we must NOT fall back to a foreign default endpoint.
    return {
      url: "",
      protocol,
      providerName: modelProviderID,
      routeUnavailable: true,
    };
  }
  if (protocol === "openai") {
    return {
      url: upstreams.openai.replace(/\/$/, ""),
      protocol,
      providerName: "openai",
    };
  }
  return {
    url: upstreams.anthropic.replace(/\/$/, ""),
    protocol,
    providerName: "anthropic",
  };
}

/**
 * Build Anthropic Messages API request.
 * Returns the full URL, headers, and serialized body.
 */
function buildAnthropicWorkerRequest(
  target: ProviderTarget,
  cred: AuthCredential,
  model: { providerID: string; modelID: string },
  system: string,
  user: string,
  maxTokens: number,
  sessionID?: string,
  temperature?: number,
): { url: string; headers: Record<string, string>; body: string } {
  // For bearer tokens (Claude Code OAuth), inject the billing header
  // as the first system block with a cch=00000 placeholder that gets
  // signed after JSON serialization.
  const billingBlock =
    cred.scheme === "bearer" ? buildBillingBlock(sessionID, user) : null;

  // System prompt caching for workers: send as block array with 1h TTL.
  // Worker calls come in bursts (distillation, curation) separated by
  // minutes of user thinking — 5m TTL expires between bursts, but 1h
  // survives. The system prompt (DISTILLATION_SYSTEM, etc.) is static
  // across all calls → near-100% cache hit rate after the first write.
  const systemBlocks = system
    ? [
        {
          type: "text" as const,
          text: system,
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ]
    : [];

  const systemPayload =
    billingBlock || systemBlocks.length > 0
      ? [...(billingBlock ? [billingBlock] : []), ...systemBlocks]
      : undefined;

  // AWS Bedrock via bedrock-mantle: the worker hits the session's mantle
  // upstream over this Anthropic path, so the body model must be the mantle
  // catalog id (`anthropic.<model>`). Detected from the target host so it
  // applies whether the session was routed via X-Lore-Provider: bedrock or a
  // mantle LORE_UPSTREAM_ANTHROPIC. Auth is the client's Bedrock API key
  // (x-api-key via authHeaders) — no SigV4, no billing block (api-key scheme).
  const upstreamModelID = isBedrockMantleHost(target.url)
    ? toMantleModelId(model.modelID)
    : model.modelID;

  let body = JSON.stringify({
    model: upstreamModelID,
    max_tokens: maxTokens,
    ...(temperature != null && { temperature }),
    system: systemPayload,
    messages: [{ role: "user", content: user }],
  });

  // Sign the body: compute xxHash64 and replace cch=00000 with real hash
  if (billingBlock) {
    body = signBody(body);
  }

  // For OAuth sessions, include Claude Code headers (anthropic-beta,
  // user-agent, etc.) sniffed from conversation turns. Without these,
  // Anthropic may reject worker calls with 401 even when the token is valid.
  const oauthHeaders = buildOAuthWorkerHeaders(sessionID);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    // Replay a user-agent on every worker request. Anthropic-compat providers
    // (MiniMax) reject UA-less requests with a generic auth failure even when
    // the key/host are correct — the conversation path works only because it
    // forwards the client UA. oauthHeaders (billing sessions) may override this.
    "user-agent": workerUserAgent(sessionID),
    ...authHeaders(cred),
    ...oauthHeaders,
  };

  // Capability-aware beta filtering (primary defense against the long-context
  // 400 loop). The client's `anthropic-beta` is replayed verbatim onto worker
  // calls, but a sniffed `context-1m` long-context beta is meaningless — and
  // rejected with a 400 — for a worker model that doesn't support a 1M context
  // window (e.g. claude-haiku-4-5, whose limit is 200K and will likely never
  // support 1M). Requesting 1M on such a model is a logical error, so we drop
  // the long-context beta unless the SELECTED worker model actually supports
  // a 1M+ context window. (A runtime 400-retry-without-beta fallback in the
  // retry loop covers any beta we couldn't validate here.)
  applyModelBetaCapabilityFilter(headers, model.modelID);

  return {
    url: `${target.url}/v1/messages`,
    headers,
    body,
  };
}

/**
 * Drop beta tokens that the selected worker model cannot honor. Currently
 * removes the long-context (`context-1m`) beta when the model's context window
 * is below 1M — requesting 1M context on, e.g., haiku is a logical error that
 * Anthropic rejects with a 400. Mutates `headers` in place. Other betas are
 * preserved. If stripping leaves no betas, the header is removed entirely.
 */
function applyModelBetaCapabilityFilter(
  headers: Record<string, string>,
  modelID: string,
): void {
  const betaKey = Object.keys(headers).find(
    (k) => k.toLowerCase() === "anthropic-beta",
  );
  if (!betaKey) return;
  const betaValue = headers[betaKey];
  if (!betaValue || !/context-1m/i.test(betaValue)) return;

  // Look up the model's real context window (models.dev-backed, with a
  // conservative fallback table). Unknown models default to 200K.
  const contextWindow = getModelEntrySync(modelID).limit?.context ?? 200_000;
  if (contextWindow >= LONG_CONTEXT_MIN_WINDOW) return; // model supports 1M

  const kept = betaValue
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !LONG_CONTEXT_BETA_RE.test(t));
  if (kept.length > 0) {
    headers[betaKey] = kept.join(",");
  } else {
    delete headers[betaKey];
  }
}

/**
 * Build OpenAI Chat Completions API request.
 * Returns the full URL, headers, and serialized body.
 */
function buildOpenAIWorkerRequest(
  target: ProviderTarget,
  cred: AuthCredential,
  model: { providerID: string; modelID: string },
  system: string,
  user: string,
  maxTokens: number,
  temperature?: number,
): { url: string; headers: Record<string, string>; body: string } {
  const messages: Array<{ role: string; content: string }> = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: user });

  return {
    // Background workers have no original request to forward verbatim, so the
    // URL is reconstructed host-aware (GitHub Copilot omits `/v1`, issue #1052;
    // Google Gemini serves `/v1beta/openai/...`, issue #1070).
    url: buildOpenAIChatCompletionsUrl(target.url),
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(cred),
    },
    body: JSON.stringify({
      model: model.modelID,
      max_completion_tokens: maxTokens,
      stream: false,
      ...(temperature != null && { temperature }),
      messages,
    }),
  };
}

/**
 * Build an OpenAI **Responses API** worker request for `openai-codex`.
 *
 * ChatGPT's `/backend-api` serves only the Responses API, so worker calls use
 * the same wire format as the foreground turn: `instructions` + `input` items,
 * `store: false` (required), and the sniffed Codex fingerprint headers.
 */
function buildCodexWorkerRequest(
  target: ProviderTarget,
  cred: AuthCredential,
  model: { providerID: string; modelID: string },
  system: string,
  user: string,
  sessionID?: string,
  temperature?: number,
): { url: string; headers: Record<string, string>; body: string } {
  const codexHeaders = buildCodexWorkerHeaders(sessionID) ?? {};

  return {
    // target.url is the ChatGPT backend base (e.g. https://chatgpt.com/backend-api);
    // Codex serves the Responses API at `/codex/responses`.
    url: `${target.url}/codex/responses`,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(cred),
      ...codexHeaders,
    },
    // No `max_output_tokens`: ChatGPT Codex rejects it ("Unsupported parameter:
    // max_output_tokens") and enforces its own server-side output limits. Same
    // omission as the foreground Codex delta.
    body: JSON.stringify({
      model: model.modelID,
      // Codex REQUIRES store:false (rejects store:true).
      store: false,
      stream: false,
      ...(temperature != null && { temperature }),
      instructions: system,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: user }],
        },
      ],
    }),
  };
}

/** Extract text response from an Anthropic Messages API response. */
export function parseAnthropicResponse(data: {
  content?: Array<{ type: string; text?: string; thinking?: string }>;
  model?: string;
  usage?: AnthropicUsage;
}): {
  text: string | null;
  usage: AnthropicUsage | null;
  model: string | null;
} {
  const textBlock = data.content?.find(
    (b) => b.type === "text" && typeof b.text === "string",
  );
  // reasoning models put the answer in reasoning fields — never treat a present
  // reasoning body as no-response. When an aggregator proxies a reasoning model
  // through the Anthropic shape and emits only a `thinking` block (no `text`
  // block), fall back to the thinking text rather than returning null.
  let text = textBlock?.text ?? null;
  if (text === null) {
    const thinkingBlock = data.content?.find(
      (b) => b.type === "thinking" && typeof b.thinking === "string",
    );
    text = thinkingBlock?.thinking ?? null;
  }
  return {
    text,
    usage: data.usage ?? null,
    model: data.model ?? null,
  };
}

/** Extract text response from an OpenAI Chat Completions response. */
export function parseOpenAIResponse(data: OpenAIChatResponse): {
  text: string | null;
  usage: AnthropicUsage | null;
  model: string | null;
} {
  const message = data.choices?.[0]?.message;
  // reasoning models put the answer in reasoning fields — never treat a present
  // reasoning body as no-response. Prefer real `content`; fall back to
  // `reasoning_content` (DeepSeek/Qwen) then `reasoning` (OpenRouter/others)
  // only when `content` is empty/missing.
  // Guard the type: OpenAI `content` can be null or (multimodal) an array at
  // runtime — only a non-empty string counts as real content; otherwise fall
  // back to the reasoning fields (which must also be strings).
  const content = message?.content;
  const reasoning =
    typeof message?.reasoning_content === "string"
      ? message.reasoning_content
      : typeof message?.reasoning === "string"
        ? message.reasoning
        : null;
  const text =
    typeof content === "string" && content.length > 0 ? content : reasoning;
  return {
    text: text ?? null,
    usage: data.usage ? normalizeOpenAIUsage(data.usage) : null,
    model: data.model ?? null,
  };
}

/**
 * Extract text from an OpenAI **Responses API** non-streaming response (used by
 * the `openai-codex` worker path). Text lives in `output[].content[].text` for
 * `output_text` parts; usage uses `input_tokens`/`output_tokens`.
 */
function parseResponsesWorkerResponse(data: {
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  output_text?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  model?: string;
}): {
  text: string | null;
  usage: AnthropicUsage | null;
  model: string | null;
} {
  // Prefer the convenience `output_text` aggregate when present; otherwise
  // concatenate text parts from message output items.
  let text: string | null =
    typeof data.output_text === "string" ? data.output_text : null;
  if (text === null && Array.isArray(data.output)) {
    const parts: string[] = [];
    for (const item of data.output) {
      if (!Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (part?.type === "output_text" && typeof part.text === "string") {
          parts.push(part.text);
        }
      }
    }
    if (parts.length > 0) text = parts.join("");
  }

  const usage: AnthropicUsage | null = data.usage
    ? {
        input_tokens: data.usage.input_tokens ?? 0,
        output_tokens: data.usage.output_tokens ?? 0,
      }
    : null;

  return { text, usage, model: data.model ?? null };
}

/**
 * Build a Google Vertex AI (Claude) worker request: an Anthropic Messages body
 * POSTed to the `:rawPredict` URL (model in the path, non-streaming) and
 * authenticated with a GCP OAuth2 bearer token (ADC). Async because minting the
 * token and resolving the project are async.
 *
 * The region is read from the session's vertex base URL (`target.url`, the
 * authoritative endpoint); the project prefers the threaded config value, else
 * derives from ADC. No client credential reaches the wire — Vertex auth is the
 * GCP token, so `cred` is intentionally ignored. No billing block (Vertex is
 * not a Claude Code billing endpoint).
 */
async function buildVertexWorkerRequest(
  target: ProviderTarget,
  model: { providerID: string; modelID: string },
  system: string,
  user: string,
  maxTokens: number,
  vertexProject?: string,
  temperature?: number,
): Promise<{ url: string; headers: Record<string, string>; body: string }> {
  const region = vertexRegionFromUrl(target.url) ?? "global";
  const project = await resolveVertexProject(vertexProject ?? "");
  if (!project) {
    throw new Error(
      "Vertex worker: no GCP project. Set GOOGLE_CLOUD_PROJECT (or " +
        "LORE_VERTEX_PROJECT), or ensure Application Default Credentials " +
        "provide a project.",
    );
  }
  const vertexModel = toVertexModelId(model.modelID);
  const token = await getVertexAccessToken();
  // Worker system prompt is static across bursts → cache it. Use bare ephemeral
  // (5m) rather than the 1h extended-ttl beta of uncertain Vertex support.
  const systemBlocks = system
    ? [
        {
          type: "text" as const,
          text: system,
          cache_control: { type: "ephemeral" as const },
        },
      ]
    : undefined;
  const body = JSON.stringify(
    toVertexBody({
      max_tokens: maxTokens,
      ...(temperature != null && { temperature }),
      system: systemBlocks,
      messages: [{ role: "user", content: user }],
    }),
  );
  return {
    url: vertexRawPredictUrl(region, project, vertexModel, false),
    // The documented Vertex rawPredict header set is exactly these two (see
    // https://docs.claude.com/en/api/claude-on-vertex-ai). NEVER add
    // `anthropic-beta` here: it's an api.anthropic.com-only header. Worker
    // prompt caching is driven by the cache_control block on `systemBlocks`
    // above (a GA Vertex feature), NOT a beta header — so its absence does not
    // disable caching, while forwarding it would risk a Vertex 400.
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body,
  };
}

/**
 * Dispatch to the correct worker request builder for a resolved target.
 * Single source of truth so adding a protocol touches exactly one place.
 * Async: the Vertex builder mints a GCP OAuth2 token; the other builders are
 * synchronous and resolve immediately.
 */
async function buildWorkerRequest(
  target: ProviderTarget,
  cred: AuthCredential,
  model: { providerID: string; modelID: string },
  system: string,
  user: string,
  maxTokens: number,
  sessionID?: string,
  temperature?: number,
  vertexProject?: string,
): Promise<{ url: string; headers: Record<string, string>; body: string }> {
  switch (target.protocol) {
    case "openai-codex-responses":
      // Codex omits max_output_tokens (rejected by ChatGPT) — no maxTokens arg.
      return buildCodexWorkerRequest(
        target,
        cred,
        model,
        system,
        user,
        sessionID,
        temperature,
      );
    case "openai":
      return buildOpenAIWorkerRequest(
        target,
        cred,
        model,
        system,
        user,
        maxTokens,
        temperature,
      );
    case "vertex":
      return buildVertexWorkerRequest(
        target,
        model,
        system,
        user,
        maxTokens,
        vertexProject,
        temperature,
      );
    default:
      return buildAnthropicWorkerRequest(
        target,
        cred,
        model,
        system,
        user,
        maxTokens,
        sessionID,
        temperature,
      );
  }
}

/** Dispatch to the correct worker response parser for a resolved target. */
function parseWorkerResponse(
  protocol: WorkerProtocol,
  rawData: unknown,
): { text: string | null; usage: AnthropicUsage | null; model: string | null } {
  switch (protocol) {
    case "openai-codex-responses":
      return parseResponsesWorkerResponse(
        rawData as Parameters<typeof parseResponsesWorkerResponse>[0],
      );
    case "openai":
      return parseOpenAIResponse(rawData as OpenAIChatResponse);
    default:
      return parseAnthropicResponse(
        rawData as Parameters<typeof parseAnthropicResponse>[0],
      );
  }
}

/**
 * Summarize an upstream worker response body for diagnostics when the parser
 * found no usable text. Reports which fields were present (content vs the
 * reasoning/thinking fallbacks), the finish_reason, and a truncated body
 * sample — without dumping the full (potentially large) payload. This lets us
 * classify an empty `no-response` as a genuinely empty completion, a
 * reasoning-field shape we don't read, or a truncation (`finish_reason:
 * "length"`), instead of an opaque failure.
 */
/**
 * Best-effort extraction of the upstream finish/stop reason from a worker
 * response body (OpenAI `choices[0].finish_reason` or Anthropic `stop_reason`).
 * Used to distinguish a *complete* empty response (model capability issue) from
 * a *truncated* one (`length` — a budget problem, not a capability one).
 */
function extractFinishReason(rawData: unknown): string | undefined {
  try {
    const d = rawData as {
      choices?: Array<{ finish_reason?: string }>;
      stop_reason?: string;
    };
    return d.choices?.[0]?.finish_reason ?? d.stop_reason ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Detect a provider error envelope embedded in an otherwise-2xx body and return
 * its numeric status code, if any. Gateways such as OpenRouter surface an
 * UPSTREAM failure as an HTTP 200 whose body is `{"error":{"code":504,...}}`
 * instead of propagating the status line — so the status-keyed transient retry
 * never sees it and the body parses as a "successful but empty" completion.
 * Returns the embedded code (number) when present, else null. Only the shape
 * `{ error: { code: <number|numeric-string> } }` is recognized; a normal
 * completion has no top-level `error` object, so false positives are unlikely.
 * See #899.
 */
function extractBodyErrorCode(rawData: unknown): number | null {
  if (!rawData || typeof rawData !== "object") return null;
  const err = (rawData as { error?: unknown }).error;
  if (!err || typeof err !== "object") return null;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "number" && Number.isFinite(code)) return code;
  if (typeof code === "string" && /^\d+$/.test(code)) return Number(code);
  return null;
}

function describeEmptyWorkerResponse(rawData: unknown): string {
  const fields: string[] = [];
  let finishReason: string | undefined;
  try {
    const d = rawData as {
      choices?: Array<{
        message?: {
          content?: unknown;
          reasoning_content?: unknown;
          reasoning?: unknown;
        };
        finish_reason?: string;
      }>;
      content?: Array<{ type?: string }>;
    };
    const msg = d.choices?.[0]?.message;
    if (msg) {
      if (typeof msg.content === "string" && msg.content.length > 0)
        fields.push("content");
      if (typeof msg.reasoning_content === "string")
        fields.push("reasoning_content");
      if (typeof msg.reasoning === "string") fields.push("reasoning");
      finishReason = d.choices?.[0]?.finish_reason;
    }
    if (Array.isArray(d.content)) {
      for (const b of d.content) if (b.type) fields.push(`block:${b.type}`);
    }
  } catch {
    // ignore — best-effort introspection
  }
  let sample = "";
  try {
    sample = JSON.stringify(rawData).slice(0, 300);
  } catch {
    sample = "(unserializable)";
  }
  return (
    `fields=[${fields.join(",") || "none"}]` +
    ` finish_reason=${finishReason ?? "n/a"}` +
    ` body=${sample}`
  );
}

// ---------------------------------------------------------------------------
// LLMClient factory
// ---------------------------------------------------------------------------

/**
 * Create an LLMClient that sends single-turn prompts to the appropriate provider.
 *
 * Routes to Anthropic Messages API or OpenAI Chat Completions API based on
 * the resolved wire protocol (explicit `opts.protocol` from the session's
 * UpstreamSnapshot, then provider route table, then default "anthropic").
 * Retry logic, Sentry instrumentation, and error handling are shared across
 * both protocols.
 *
 * @param upstreams     Base URLs for each provider
 * @param getAuth       Callback to resolve auth credentials (per-session → global fallback)
 * @param defaultModel  Default model to use when no override is specified
 */
export function createGatewayLLMClient(
  upstreams: { anthropic: string; openai: string },
  getAuth: (sessionID?: string, providerID?: string) => AuthCredential | null,
  defaultModel: { providerID: string; modelID: string },
  opts?: { dedicatedWorkerKey?: boolean; vertexProject?: string },
): LLMClient {
  const hasDedicatedKey = opts?.dedicatedWorkerKey === true;
  // Configured GCP project for Vertex workers (else derived from ADC at call
  // time). Threaded so an explicit LORE_VERTEX_PROJECT (without GOOGLE_CLOUD_*)
  // is honored — the session base URL carries the region but never the project.
  const factoryVertexProject = opts?.vertexProject;
  return {
    async prompt(system, user, opts) {
      const model = opts?.model ?? defaultModel;

      // Skip models already known to produce no usable worker output. This is
      // a capability verdict (not an outage): the call would just waste a round
      // trip and re-fail. Distillation/curation defer; data stays recallable.
      if (isWorkerIncapable(model.providerID, model.modelID)) {
        return null;
      }

      const upstreamOverride = opts?.upstreamUrl;
      // The explicit protocol hint comes from the SESSION's upstream. Only
      // honor it when the worker model belongs to the same provider as the
      // session — otherwise it's the wrong wire protocol for this model (e.g.
      // an "anthropic" hint applied to an openai worker model). For a
      // cross-provider worker, derive the protocol from the model's OWN
      // provider route instead. This keeps protocol, URL, and credential all
      // consistent with the worker model's provider.
      const sameProviderAsSession =
        !opts?.upstreamProviderID ||
        opts.upstreamProviderID === model.providerID;
      const protocol = resolveWorkerProtocol(
        model.providerID,
        sameProviderAsSession ? opts?.protocol : undefined,
      );

      // Vertex authenticates with lore's own GCP OAuth2 bearer token (minted
      // inside buildVertexWorkerRequest); the client credential is IGNORED on
      // the wire. A Vertex client legitimately sends NO key — the
      // gateway-holds-credentials model, identical to the conversation and
      // warmer paths — so we must NOT fail-closed on a missing client
      // credential for the vertex worker path (doing so silently disabled ALL
      // background distillation/curation for such sessions). Synthesize a
      // placeholder so the shared worker pipeline proceeds; it is never sent
      // upstream (the vertex builder constructs its own headers and ignores it).
      const cred =
        getAuth(opts?.sessionID, model.providerID) ??
        (protocol === "vertex"
          ? ({ scheme: "bearer", value: "" } as AuthCredential)
          : null);
      if (!cred) {
        log.warn("no auth credentials available for worker call");
        recordWorkerFailure(
          opts?.sessionID ?? "_unknown",
          opts?.workerID ?? "unknown",
          "no-auth",
        );
        return null;
      }
      const target = resolveTarget(
        upstreams,
        protocol,
        upstreamOverride,
        model.providerID,
        opts?.upstreamProviderID,
      );
      const maxTokens = opts?.maxTokens ?? DEFAULT_WORKER_MAX_TOKENS;

      // Cross-provider fail-closed: the worker model's provider has no route
      // URL (unknown provider, or a local provider missing its explicit
      // upstream). We must NOT fall back to the session's foreign endpoint —
      // that's the exact collusion that caused the minimax→Anthropic 401 loop.
      // Skip the call, record it, and soft-pause so it doesn't re-fire.
      if (target.routeUnavailable || !target.url) {
        log.warn(
          `worker cross-provider: no route for model provider="${model.providerID}" ` +
            `(model=${model.modelID}, worker=${opts?.workerID ?? "unknown"}, ` +
            `session=${opts?.sessionID?.slice(0, 16) ?? "none"}) — skipping`,
        );
        recordWorkerFailure(
          opts?.sessionID ?? "_unknown",
          opts?.workerID ?? "unknown",
          "cross-provider",
        );
        if (opts?.sessionID) markWorkerPaused(opts.sessionID);
        return null;
      }

      // Defense-in-depth: detect API key / provider mismatch before making
      // a doomed request. Anthropic keys start with "sk-ant-"; OpenAI keys
      // start with "sk-" (without "ant"). Bearer tokens (OAuth) can't be
      // distinguished by prefix, so only API keys are checked.
      // Skip when LORE_WORKER_API_KEY is set — the user deliberately chose
      // a cross-provider credential/model combination.
      // The check is keyed off the RESOLVED TARGET host (not the raw
      // override): after cross-provider routing the target may be the model's
      // own endpoint (e.g. api.minimax.io) where an `sk-`-prefixed key is
      // perfectly valid and must NOT be rejected as an "Anthropic mismatch".
      // Only the two direct providers whose key prefixes are distinguishable
      // (api.anthropic.com / api.openai.com) get the prefix check; everything
      // else (aggregators, minimax, bearer tokens) is exempt.
      let shouldCheckProtocolMismatch = false;
      try {
        const targetHost = new URL(target.url).hostname;
        shouldCheckProtocolMismatch =
          targetHost === "api.anthropic.com" || targetHost === "api.openai.com";
      } catch {
        // Malformed target URL — leave the check off (the route resolution
        // above already failed closed for unroutable providers).
      }
      if (
        cred.scheme === "api-key" &&
        !hasDedicatedKey &&
        shouldCheckProtocolMismatch
      ) {
        const isAnthropicKey = cred.value.startsWith("sk-ant-");
        if (target.protocol === "anthropic" && !isAnthropicKey) {
          log.warn(
            `worker protocol mismatch: ${target.protocol} target with non-Anthropic API key — skipping (model=${model.modelID}, worker=${opts?.workerID ?? "unknown"})`,
          );
          recordWorkerFailure(
            opts?.sessionID ?? "_unknown",
            opts?.workerID ?? "unknown",
            "protocol-mismatch",
          );
          return null;
        }
        if (target.protocol === "openai" && isAnthropicKey) {
          log.warn(
            `worker protocol mismatch: ${target.protocol} target with Anthropic API key — skipping (model=${model.modelID}, worker=${opts?.workerID ?? "unknown"})`,
          );
          recordWorkerFailure(
            opts?.sessionID ?? "_unknown",
            opts?.workerID ?? "unknown",
            "protocol-mismatch",
          );
          return null;
        }
      }

      // Resolve the effective sampling temperature. Models we've already
      // observed to reject `temperature` (see markTemperatureUnsupported) get
      // it omitted upfront so we don't burn a wasted 400 round-trip per call.
      // A runtime-learned 400 below flips this to undefined for the retry.
      let effectiveTemperature = isTemperatureUnsupportedModel(model)
        ? undefined
        : opts?.temperature;

      // The credential in effect for the CURRENT attempt. Starts as `cred`; an
      // auth-error refresh reassigns it so every later rebuild in the retry loop
      // (e.g. the temperature-strip rebuild) signs with the fresh key rather
      // than the stale one that just 401'd. Typed non-null (assigned only from
      // non-null values) so the closure keeps the `if (!cred)` guard's narrowing.
      let activeCred: AuthCredential = cred;

      // Build protocol-specific request
      let req = await buildWorkerRequest(
        target,
        activeCred,
        model,
        system,
        user,
        maxTokens,
        opts?.sessionID,
        effectiveTemperature,
        factoryVertexProject,
      );

      // Track this call so temporal capture can skip it
      const callID = `gw-worker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      activeWorkerCalls.add(callID);

      const urgent = opts?.urgent === true;

      try {
        // Wrap the entire retry loop in a gen_ai.chat span so it captures
        // real wall-clock duration including retries and backoff delays.
        return await Sentry.startSpan(
          {
            op: "gen_ai.chat",
            name: `chat ${model.modelID}`,
            attributes: {
              "gen_ai.operation.name": "chat",
              "gen_ai.request.model": model.modelID,
              "gen_ai.provider.name": target.providerName,
              "lore.worker_id": opts?.workerID ?? "unknown",
              "lore.call_type": "direct",
              "lore.urgent": urgent,
            },
          },
          async (span) => {
            // Track retry metrics for span enrichment
            let retryCount = 0;
            let totalDelayMs = 0;
            let lastRetryAfterMs: number | null = null;
            let finalStatus = 0;
            // Trip the circuit breaker at most once per call so a multi-retry
            // 429 loop doesn't runaway-escalate the breaker's backoff schedule.
            let breakerTripped = false;
            // Strip beta headers at most once per call (runtime fallback for a
            // beta-related 400 — see the non-transient block below).
            let betaStripped = false;
            // Strip the temperature param at most once per call (runtime
            // fallback for a "temperature is deprecated" 400 — see below).
            let temperatureStripped = false;
            // Resolve the retry budget once per call (not per attempt) — the
            // value can't change mid-loop and re-reading the env each iteration
            // is wasteful.
            const maxRetries = maxRetriesFor();

            // Retry loop for transient errors (429, 5xx)
            for (let attempt = 0; ; attempt++) {
              let response: Response;
              try {
                response = await upstreamFetch(req.url, {
                  method: "POST",
                  headers: req.headers,
                  // opts.thinking is intentionally not forwarded — this bare API
                  // call never includes the `thinking` parameter so models
                  // won't produce thinking tokens regardless.
                  body: req.body,
                });
              } catch (e) {
                // Network/fetch error — retry if attempts remain
                if (attempt < maxRetries) {
                  const delay = backoffMs(attempt, null);
                  retryCount++;
                  totalDelayMs += delay;
                  log.warn(
                    `worker request network error (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms`,
                  );
                  await sleep(delay);
                  continue;
                }
                // Enrich span before rethrowing
                if (retryCount > 0) {
                  span.setAttribute("lore.retry.count", retryCount);
                  span.setAttribute("lore.retry.total_delay_ms", totalDelayMs);
                }
                throw e; // exhausted retries — rethrow to outer catch
              }

              finalStatus = response.status;

              if (response.ok) {
                // If a prior attempt stripped `temperature` and the request now
                // succeeds (2xx), temperature really was the culprit — learn it
                // so future calls to this model omit it upfront. Deferred to
                // success (rather than marking on the 400 heuristic match) so a
                // regex false-positive on an unrelated 400 can never permanently
                // mislabel a model that actually supports temperature.
                if (temperatureStripped) markTemperatureUnsupported(model);

                // Guard: some providers return SSE even when stream: false
                // was sent. Extract JSON from the data: lines instead.
                const ct = response.headers.get("content-type") ?? "";
                const rawData = ct.includes("text/event-stream")
                  ? await extractJSONFromSSE(response)
                  : await response.json();

                // A 2xx whose body is a provider error envelope (e.g. OpenRouter
                // surfacing an upstream timeout as HTTP 200 + {error:{code:504}})
                // is NOT a usable completion. The status-keyed transient handling
                // below never sees it, and parseWorkerResponse would yield no text
                // → it would be miscounted as an empty/incapable response. Route a
                // transient embedded code into the SAME retry/backoff ladder as a
                // real HTTP-level transient. Non-transient embedded codes fall
                // through to the normal empty-response handling (no regression). #899
                const bodyErrCode = extractBodyErrorCode(rawData);
                if (bodyErrCode != null && TRANSIENT_CODES.has(bodyErrCode)) {
                  // Trip the breaker once on an embedded 429, matching the
                  // HTTP-level 429 path (background work to this provider pauses
                  // while this call rides out the limit; other providers drain).
                  if (bodyErrCode === 429 && !breakerTripped) {
                    breakerTripped = true;
                    const cbRetryAfter = parseRetryAfter(response);
                    tripCircuitBreaker(
                      cbRetryAfter ? Math.ceil(cbRetryAfter / 1000) : undefined,
                      model.providerID,
                    );
                  }
                  if (attempt < maxRetries) {
                    const retryAfter = parseRetryAfter(response);
                    const delay = backoffMs(attempt, retryAfter);
                    retryCount++;
                    totalDelayMs += delay;
                    if (retryAfter != null) lastRetryAfterMs = retryAfter;
                    log.warn(
                      `worker upstream returned HTTP 200 with an embedded ${bodyErrCode} ` +
                        `error (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms ` +
                        `— model=${model.providerID}/${model.modelID} worker=${opts?.workerID ?? "unknown"}`,
                    );
                    await sleep(delay);
                    continue;
                  }
                  // Exhausted. Mirror the HTTP-level exhaustion path for full
                  // observability parity (Seer): log, capture to Sentry for
                  // alerting, enrich the span with retry metadata, and mark the
                  // span errored. This path retries up to maxRetries times, so
                  // those attempts must not be invisible in tracing. Worker-health
                  // reason matches the HTTP transient path (rate-limit/upstream-
                  // error) — NEVER worker-incapable: the upstream responded with a
                  // transient error, which must not mark a capable model incapable.
                  log.warn(
                    `worker upstream embedded ${bodyErrCode} error persisted after ` +
                      `${maxRetries + 1} attempts — model=${model.providerID}/${model.modelID} ` +
                      `worker=${opts?.workerID ?? "unknown"} ` +
                      `session=${opts?.sessionID?.slice(0, 16) ?? "none"}`,
                  );
                  Sentry.captureException(
                    new Error(
                      `Worker upstream exhausted ${maxRetries + 1} retries: HTTP 200 embedded ${bodyErrCode}`,
                    ),
                    {
                      fingerprint: [
                        "LOREAI-GATEWAY",
                        "worker-retry-exhausted",
                        String(bodyErrCode),
                      ],
                      extra: {
                        // Wire status was a misleading 200; the embedded code is
                        // the real failure signal.
                        status: 200,
                        bodyErrorCode: bodyErrCode,
                        attempts: maxRetries + 1,
                        totalDelayMs,
                        lastRetryAfterMs,
                        model: model.modelID,
                        workerID: opts?.workerID ?? "unknown",
                      },
                    },
                  );
                  span.setAttribute("lore.retry.count", retryCount);
                  span.setAttribute("lore.retry.total_delay_ms", totalDelayMs);
                  if (lastRetryAfterMs != null) {
                    span.setAttribute(
                      "lore.retry.last_retry_after_ms",
                      lastRetryAfterMs,
                    );
                  }
                  span.setAttribute("lore.retry.final_status", finalStatus);
                  span.setAttribute("lore.retry.body_error_code", bodyErrCode);
                  span.setStatus({
                    code: 2,
                    message: "embedded error exhausted retries",
                  });
                  recordWorkerFailure(
                    opts?.sessionID ?? "_unknown",
                    opts?.workerID ?? "unknown",
                    bodyErrCode === 429 ? "rate-limit" : "upstream-error",
                  );
                  return null;
                }

                // Parse response based on protocol
                const parsed = parseWorkerResponse(target.protocol, rawData);

                // Set usage attributes on the span
                if (parsed.usage) {
                  setGenAiUsageAttributes(
                    span,
                    parsed.usage,
                    parsed.model ?? undefined,
                  );
                  emitCostMetric(model.modelID, parsed.usage, "direct");
                  recordWorkerCost(
                    opts?.sessionID,
                    model.modelID,
                    parsed.usage,
                    "direct",
                    opts?.workerID,
                  );
                }

                // Enrich span with retry metadata on eventual success
                if (retryCount > 0) {
                  span.setAttribute("lore.retry.count", retryCount);
                  span.setAttribute("lore.retry.total_delay_ms", totalDelayMs);
                  if (lastRetryAfterMs != null) {
                    span.setAttribute(
                      "lore.retry.last_retry_after_ms",
                      lastRetryAfterMs,
                    );
                  }
                  span.setAttribute("lore.retry.final_status", finalStatus);
                }

                // NOTE: We intentionally do NOT call recordWorkerSuccess() here.
                // The LLM adapter only knows the transport succeeded; the core
                // distillation/curator pipeline knows whether the response was
                // actually parseable and usable. Recording success at the
                // transport layer would clear failure state before the parse
                // step can record "parse-error", making sustained parse
                // failures invisible to the health ladder.
                if (parsed.text) {
                  // A usable response resets the consecutive-empty streak so a
                  // model that recovers isn't pushed toward an incapable verdict
                  // by old, non-consecutive empties.
                  clearEmptyWorkerStreak(model.providerID, model.modelID);
                  return parsed.text;
                }

                // Transport succeeded but the model returned no usable text.
                // Log WHAT came back so an empty no-response can be classified
                // (genuinely empty vs an unread field shape vs a length
                // truncation) instead of being opaque. The raw body is
                // otherwise discarded here.
                const finishReason = extractFinishReason(rawData);
                log.warn(
                  `worker empty response (HTTP ${response.status}, ct=${ct || "?"}) ` +
                    `— model=${model.providerID}/${model.modelID} ` +
                    `worker=${opts?.workerID ?? "unknown"} ` +
                    `session=${opts?.sessionID?.slice(0, 16) ?? "none"} ` +
                    `— ${describeEmptyWorkerResponse(rawData)}`,
                );

                // Classify: a COMPLETE response (finish/stop reason indicates
                // the model finished producing — not a truncation, content
                // filter, or tool-call) that still has no usable text, even
                // after the reasoning-field fallback, is a model CAPABILITY
                // signal. Budget truncations ("length"/"max_tokens"), content
                // filtering, and tool-call stops are NOT capability facts and
                // stay retryable no-response. We require several CONSECUTIVE
                // such empties before marking the model incapable, so a single
                // transient/prompt-specific empty doesn't permanently skip a
                // capable model. recordEmptyWorkerResponse encapsulates this.
                if (
                  recordEmptyWorkerResponse(
                    model.providerID,
                    model.modelID,
                    finishReason,
                  )
                ) {
                  recordWorkerFailure(
                    opts?.sessionID ?? "_unknown",
                    opts?.workerID ?? "unknown",
                    "worker-incapable",
                  );
                  return null;
                }

                // Record as no-response here so the adapter is the single
                // owner of transport-failure attribution — core workers no
                // longer record on a null return (which double-counted, e.g.
                // a no-auth failure was logged by both the adapter AND the
                // distiller). Sustained empty completions still escalate.
                recordWorkerFailure(
                  opts?.sessionID ?? "_unknown",
                  opts?.workerID ?? "unknown",
                  "no-response",
                );
                return null;
              }

              // --- Auth error: 401/403 — mark stale, re-resolve, retry once ---
              if (AUTH_ERROR_CODES.has(response.status)) {
                const text = await response.text().catch(() => "(no body)");

                // Always record the auth failure so the worker-health ladder
                // sees it even for session-less paths (the adapter is the
                // single owner of transport-failure attribution).
                recordWorkerFailure(
                  opts?.sessionID ?? "_unknown",
                  opts?.workerID ?? "unknown",
                  "auth-rejected",
                );
                // Mark this provider's credential stale so resolveAuth()
                // falls through to global — but only for THIS provider,
                // not other providers on the same session. Requires a real
                // session ID (staleness is per-session state).
                if (opts?.sessionID) {
                  markAuthStale(opts.sessionID, model.providerID);
                } else {
                  // Session-less worker (e.g. entity-rebuild) — mark the
                  // global fallback as stale so resolveAuth(undefined)
                  // returns null instead of the same rejected token.
                  // Without this, session-less workers hammer indefinitely
                  // because markAuthStale requires a sessionID.
                  markGlobalAuthStale();
                }

                // Re-resolve: credential may have been refreshed by a concurrent client request
                const freshCred = getAuth(opts?.sessionID, model.providerID);
                const credentialChanged =
                  !!freshCred && freshCred.value !== cred.value;
                if (credentialChanged && attempt === 0) {
                  // Credential changed — adopt it as the current credential so
                  // any subsequent rebuild (e.g. the temperature-strip retry)
                  // uses the fresh key, then rebuild request and retry once.
                  activeCred = freshCred;
                  log.info(
                    `worker auth error ${response.status}, credential refreshed — retrying: ${text.slice(0, 200)}`,
                  );
                  req = await buildWorkerRequest(
                    target,
                    activeCred,
                    model,
                    system,
                    user,
                    maxTokens,
                    opts?.sessionID,
                    effectiveTemperature,
                    factoryVertexProject,
                  );
                  retryCount++;
                  continue;
                }

                // No fresh credential or retry also failed — alert and bail
                log.error(
                  `worker upstream auth error: ${response.status} ${response.statusText}` +
                    ` — url=${target.url} model=${model.providerID}/${model.modelID}` +
                    ` cred=${cred.scheme} worker=${opts?.workerID ?? "unknown"}` +
                    ` session=${opts?.sessionID?.slice(0, 16) ?? "none"}` +
                    ` — ${text}`,
                );
                Sentry.captureException(
                  new Error(
                    `Worker upstream auth error: ${response.status} ${response.statusText}`,
                  ),
                  {
                    fingerprint: [
                      "LOREAI-GATEWAY",
                      "worker-auth-error",
                      String(response.status),
                    ],
                    extra: {
                      status: response.status,
                      model: model.modelID,
                      workerID: opts?.workerID ?? "unknown",
                      sessionID: opts?.sessionID?.slice(0, 16),
                      credentialChanged,
                      freshCredAvailable: !!freshCred,
                    },
                  },
                );
                span.setStatus({
                  code: 2,
                  message: `HTTP ${response.status} auth`,
                });
                // Soft-pause so a persistent auth failure doesn't re-fire on
                // every idle tick + turn. The per-provider staleness above
                // does NOT stop the loop for a cross-provider 401 (the key is
                // valid for its real provider, so it's never marked stale) —
                // the pause is the robust backstop. isWorkerCreditPaused()
                // still lets one probe through per 5 min so a refreshed
                // credential recovers automatically. Urgent calls are exempt.
                if (opts?.sessionID) markWorkerPaused(opts.sessionID);
                return null;
              }

              // --- Insufficient credit: 402 — expected account state ---
              // (e.g. OpenRouter "requires more credits"). NOT an outage:
              //  • log.warn (no Error object) so it does NOT auto-forward to
              //    Sentry;
              //  • intentionally NO recordWorkerFailure — that ladder is what
              //    escalates to Sentry after 3 hits, and 402 must not;
              //  • markWorkerPaused soft-pauses this session's background work
              //    so the distiller/curator stop retrying every turn (a probe
              //    is allowed once per circuit interval to detect a top-up).
              if (INSUFFICIENT_CREDIT_CODES.has(response.status)) {
                const text = await response.text().catch(() => "(no body)");
                log.warn(
                  `worker upstream insufficient credit: ${response.status} ${response.statusText}` +
                    ` — model=${model.providerID}/${model.modelID}` +
                    ` worker=${opts?.workerID ?? "unknown"}` +
                    ` session=${opts?.sessionID?.slice(0, 16) ?? "none"}` +
                    ` — ${text.slice(0, 200)}`,
                );
                if (opts?.sessionID) {
                  markWorkerPaused(opts.sessionID);
                } else {
                  // Session-less workers (e.g. entity-rebuild) can't be paused
                  // per-session — log so it's visible but don't escalate.
                  log.warn(
                    `worker upstream insufficient credit (session-less, no pause): ${response.status}`,
                  );
                }
                span.setStatus({
                  code: 2,
                  message: `HTTP ${response.status} credit`,
                });
                return null;
              }

              // Non-transient error — fail immediately, no retry
              if (!TRANSIENT_CODES.has(response.status)) {
                const text = await response.text().catch(() => "(no body)");

                // 400 + a beta-related complaint → the request carries a beta
                // header the model/subscription doesn't support (e.g. a
                // `context-1m` long-context beta sniffed from the client turn
                // and replayed onto a worker call to a non-1M model like
                // haiku). The upfront capability check (buildWorkerRequest)
                // should already strip incompatible betas, but this is the
                // runtime safety net: retry ONCE with the long-context beta
                // removed (preserving oauth-2025-04-20 et al. so OAuth calls
                // still authenticate) before giving up. Bounded to one retry.
                if (
                  response.status === 400 &&
                  !betaStripped &&
                  hasLongContextBeta(req.headers) &&
                  isBetaRelated400(text)
                ) {
                  betaStripped = true;
                  req = { ...req, headers: stripBetaHeaders(req.headers) };
                  log.warn(
                    `worker 400 looks long-context-beta-related — retrying once without the context-1m beta ` +
                      `(model=${model.providerID}/${model.modelID}, worker=${opts?.workerID ?? "unknown"}): ${text.slice(0, 160)}`,
                  );
                  retryCount++;
                  continue;
                }

                // 400 + a "temperature is deprecated/unsupported" complaint →
                // the request carries a `temperature` the model rejects (newer
                // models like claude-sonnet-5 dropped the sampling param). Learn
                // it so future calls omit temperature upfront, then rebuild THIS
                // request without temperature and retry once. We rebuild via
                // buildWorkerRequest rather than string-editing req.body so the
                // OAuth billing signature is recomputed over the new body
                // (mutating the serialized body would invalidate the cch hash).
                // Bounded to one retry per call.
                if (
                  response.status === 400 &&
                  !temperatureStripped &&
                  effectiveTemperature != null &&
                  isTemperatureUnsupported400(text)
                ) {
                  temperatureStripped = true;
                  effectiveTemperature = undefined;
                  req = await buildWorkerRequest(
                    target,
                    activeCred,
                    model,
                    system,
                    user,
                    maxTokens,
                    opts?.sessionID,
                    effectiveTemperature,
                    factoryVertexProject,
                  );
                  // Rebuilding restores the freshly-built header set, which
                  // resurrects a beta we may have already stripped at runtime
                  // (the upfront capability filter KEEPS context-1m for a
                  // 1M-capable model like sonnet-5, so a subscription-not-
                  // entitled beta 400 is only cured by the runtime strip). If a
                  // model needed BOTH fixes, re-apply the beta strip so the
                  // temperature rebuild doesn't regress it into a beta-400 loop.
                  if (betaStripped) {
                    req = { ...req, headers: stripBetaHeaders(req.headers) };
                  }
                  log.warn(
                    `worker 400 reports temperature is unsupported — retrying once without the temperature param ` +
                      `(model=${model.providerID}/${model.modelID}, worker=${opts?.workerID ?? "unknown"}): ${text.slice(0, 160)}`,
                  );
                  retryCount++;
                  continue;
                }

                log.error(
                  `worker upstream request failed: ${response.status} ${response.statusText}` +
                    ` — url=${target.url} model=${model.providerID}/${model.modelID}` +
                    ` cred=${cred.scheme} worker=${opts?.workerID ?? "unknown"}` +
                    ` session=${opts?.sessionID?.slice(0, 16) ?? "none"}` +
                    ` — ${text}`,
                );
                span.setStatus({ code: 2, message: `HTTP ${response.status}` });
                recordWorkerFailure(
                  opts?.sessionID ?? "_unknown",
                  opts?.workerID ?? "unknown",
                  "upstream-error",
                );
                // Soft-pause: a non-transient 4xx for a worker re-sending the
                // same content is permanent. Stops the re-fire-every-turn loop;
                // isWorkerCreditPaused() still probes once per 5 min so a fixed
                // request recovers. Urgent calls are pause-exempt.
                if (opts?.sessionID) markWorkerPaused(opts.sessionID);
                return null;
              }

              // Transient error — retry if attempts remain.
              // Trip the circuit breaker for THIS provider on ANY 429 (urgent
              // included) so background work targeting the same provider pauses
              // instead of piling on more requests while this call rides out
              // the rate limit. Work routed to other providers keeps draining.
              // The urgent call itself is not gated by the breaker, so it keeps
              // retrying. Trip at most once per call to avoid runaway
              // escalation of the backoff schedule across a multi-retry loop.
              if (response.status === 429 && !breakerTripped) {
                breakerTripped = true;
                const cbRetryAfter = parseRetryAfter(response);
                const pauseSec = cbRetryAfter
                  ? Math.ceil(cbRetryAfter / 1000)
                  : undefined;
                tripCircuitBreaker(pauseSec, model.providerID);
              }

              if (attempt < maxRetries) {
                const retryAfter = parseRetryAfter(response);
                const delay = backoffMs(attempt, retryAfter);
                retryCount++;
                totalDelayMs += delay;
                if (retryAfter != null) lastRetryAfterMs = retryAfter;
                log.warn(
                  `worker upstream ${response.status} (attempt ${attempt + 1}/${maxRetries + 1}), ` +
                    `retrying in ${delay}ms` +
                    (retryAfter != null
                      ? ` (retry-after: ${Math.round(retryAfter / 1000)}s)`
                      : ""),
                );
                await sleep(delay);
                continue;
              }

              // Exhausted retries — fall back, log, capture Sentry, enrich span.
              // Urgent calls (compaction, query expansion) hand control back to
              // a caller that degrades gracefully without losing data — e.g.
              // handleCompaction forwards the client's own compaction upstream.
              // On a shared-quota 429 that fallback will hit the same limit and
              // the client handles it, so our exhaustion here is not itself a
              // failure to surface loudly. Log it at `warn` (hidden unless
              // LORE_DEBUG) to avoid alarming red `[lore]` noise; non-urgent
              // background exhaustion stays at `error` since it can indicate a
              // sustained problem worth investigating.
              const text = await response.text().catch(() => "(no body)");
              const exhaustionMsg =
                `worker upstream request failed after ${maxRetries + 1} attempts: ${response.status} ${response.statusText}` +
                ` — url=${target.url} model=${model.providerID}/${model.modelID}` +
                ` cred=${cred.scheme} worker=${opts?.workerID ?? "unknown"}` +
                ` session=${opts?.sessionID?.slice(0, 16) ?? "none"}` +
                ` — ${text}`;
              if (urgent) {
                log.warn(exhaustionMsg);
              } else {
                log.error(exhaustionMsg);
              }

              // Capture as Sentry error for alerting
              Sentry.captureException(
                new Error(
                  `Worker upstream exhausted ${maxRetries + 1} retries: ${response.status} ${response.statusText}`,
                ),
                {
                  fingerprint: [
                    "LOREAI-GATEWAY",
                    "worker-retry-exhausted",
                    String(response.status),
                  ],
                  extra: {
                    status: response.status,
                    attempts: maxRetries + 1,
                    totalDelayMs,
                    lastRetryAfterMs,
                    model: model.modelID,
                    workerID: opts?.workerID ?? "unknown",
                  },
                },
              );

              // Enrich span with retry metadata
              span.setAttribute("lore.retry.count", retryCount);
              span.setAttribute("lore.retry.total_delay_ms", totalDelayMs);
              if (lastRetryAfterMs != null) {
                span.setAttribute(
                  "lore.retry.last_retry_after_ms",
                  lastRetryAfterMs,
                );
              }
              span.setAttribute("lore.retry.final_status", finalStatus);
              span.setStatus({ code: 2, message: `HTTP exhausted retries` });
              recordWorkerFailure(
                opts?.sessionID ?? "_unknown",
                opts?.workerID ?? "unknown",
                response.status === 429 ? "rate-limit" : "upstream-error",
              );
              return null;
            }
          },
        );
      } catch (e) {
        // Client disconnect / abort is benign — downgrade from error to info
        // to avoid Sentry noise from normal connection lifecycle events.
        const isAbort = e instanceof DOMException && e.name === "AbortError";
        if (isAbort) {
          log.info("worker prompt aborted (client disconnect or shutdown)");
        } else {
          log.error("worker prompt failed:", e);
        }
        // Network/timeout error — no response was received. Record here so the
        // adapter remains the single owner of transport-failure attribution
        // (core workers no longer record on a null return).
        recordWorkerFailure(
          opts?.sessionID ?? "_unknown",
          opts?.workerID ?? "unknown",
          "no-response",
        );
        return null;
      } finally {
        activeWorkerCalls.delete(callID);
      }
    },
  };
}
