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
import { recordWorkerFailure, markWorkerPaused } from "./worker-health";

// ---------------------------------------------------------------------------
// Worker call tracking
// ---------------------------------------------------------------------------

/** Tracks worker session IDs so temporal capture can skip them. */
export const activeWorkerCalls = new Set<string>();

// ---------------------------------------------------------------------------
// Retry helpers (exported for testing)
// ---------------------------------------------------------------------------

/** HTTP status codes that are transient and worth retrying. */
const TRANSIENT_CODES = new Set([429, 500, 502, 503, 529]);

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
  choices?: Array<{ message?: { content?: string } }>;
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
type WorkerProtocol = "anthropic" | "openai" | "openai-codex-responses";

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
  explicit?: "anthropic" | "openai" | "openai-responses",
): WorkerProtocol {
  // openai-codex MUST use the Responses API — its backend has no Chat
  // Completions endpoint. This takes precedence over the explicit hint
  // (which would otherwise collapse openai-responses → openai).
  if (providerID === "openai-codex") {
    return "openai-codex-responses";
  }
  // 1. Explicit protocol from caller (threaded from UpstreamSnapshot)
  if (explicit) {
    return explicit === "anthropic" ? "anthropic" : "openai";
  }
  // 2. Route table lookup
  const route = resolveProviderRoute(providerID);
  if (route?.protocol) {
    return route.protocol === "anthropic" ? "anthropic" : "openai";
  }
  // 3. Default: anthropic (safest for unknown/aggregator providers)
  return "anthropic";
}

/** Resolve upstream target URL and protocol.
 *  When `upstreamOverride` is set, the request routes to that URL instead
 *  of the default — used for same-provider routing where the session's
 *  credentials only work against the session's endpoint. */
function resolveTarget(
  upstreams: { anthropic: string; openai: string },
  protocol: WorkerProtocol,
  upstreamOverride?: string,
): ProviderTarget {
  if (upstreamOverride) {
    return {
      url: upstreamOverride.replace(/\/$/, ""),
      protocol,
      // Use the friendly provider label for codex; otherwise the protocol is a
      // reasonable span label for an override target.
      providerName:
        protocol === "openai-codex-responses" ? "openai-codex" : protocol,
    };
  }
  if (protocol === "openai-codex-responses") {
    // Codex has no static default upstream — it always arrives via the
    // session's upstream override (chatgpt.com/backend-api). Fall back to the
    // provider route URL if present.
    const route = resolveProviderRoute("openai-codex");
    return {
      url: (route?.url ?? upstreams.openai).replace(/\/$/, ""),
      protocol,
      providerName: "openai-codex",
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

  let body = JSON.stringify({
    model: model.modelID,
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

  return {
    url: `${target.url}/v1/messages`,
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...authHeaders(cred),
      ...oauthHeaders,
    },
    body,
  };
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
    url: `${target.url}/v1/chat/completions`,
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
  maxTokens: number,
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
    body: JSON.stringify({
      model: model.modelID,
      // Codex REQUIRES store:false (rejects store:true).
      store: false,
      stream: false,
      max_output_tokens: maxTokens,
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
function parseAnthropicResponse(data: {
  content?: Array<{ type: string; text?: string }>;
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
  return {
    text: textBlock?.text ?? null,
    usage: data.usage ?? null,
    model: data.model ?? null,
  };
}

/** Extract text response from an OpenAI Chat Completions response. */
function parseOpenAIResponse(data: OpenAIChatResponse): {
  text: string | null;
  usage: AnthropicUsage | null;
  model: string | null;
} {
  return {
    text: data.choices?.[0]?.message?.content ?? null,
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
 * Dispatch to the correct worker request builder for a resolved target.
 * Single source of truth so adding a protocol touches exactly one place.
 */
function buildWorkerRequest(
  target: ProviderTarget,
  cred: AuthCredential,
  model: { providerID: string; modelID: string },
  system: string,
  user: string,
  maxTokens: number,
  sessionID?: string,
  temperature?: number,
): { url: string; headers: Record<string, string>; body: string } {
  switch (target.protocol) {
    case "openai-codex-responses":
      return buildCodexWorkerRequest(
        target,
        cred,
        model,
        system,
        user,
        maxTokens,
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
  opts?: { dedicatedWorkerKey?: boolean },
): LLMClient {
  const hasDedicatedKey = opts?.dedicatedWorkerKey === true;
  return {
    async prompt(system, user, opts) {
      const model = opts?.model ?? defaultModel;
      const cred = getAuth(opts?.sessionID, model.providerID);
      if (!cred) {
        log.warn("no auth credentials available for worker call");
        recordWorkerFailure(
          opts?.sessionID ?? "_unknown",
          opts?.workerID ?? "unknown",
          "no-auth",
        );
        return null;
      }
      const upstreamOverride = opts?.upstreamUrl;
      const protocol = resolveWorkerProtocol(model.providerID, opts?.protocol);
      const target = resolveTarget(upstreams, protocol, upstreamOverride);
      const maxTokens = opts?.maxTokens ?? 8192;

      // Defense-in-depth: detect API key / provider mismatch before making
      // a doomed request. Anthropic keys start with "sk-ant-"; OpenAI keys
      // start with "sk-" (without "ant"). Bearer tokens (OAuth) can't be
      // distinguished by prefix, so only API keys are checked.
      // Skip when LORE_WORKER_API_KEY is set — the user deliberately chose
      // a cross-provider credential/model combination.
      // Also skip when an upstream override points to a known
      // proxy/aggregator (e.g. OpenCode Zen, OpenRouter) that accepts the
      // session's credentials regardless of the provider prefix.
      // DO NOT skip for direct provider URLs (api.anthropic.com,
      // api.openai.com) — the mismatch check is still needed there.
      let shouldCheckProtocolMismatch = true;
      if (upstreamOverride) {
        try {
          const hostname = new URL(upstreamOverride).hostname;
          // Only skip the check for proxy/aggregator hosts — direct
          // provider URLs still need the mismatch guard.
          // Only Anthropic and OpenAI are checked because they're the
          // only providers whose API key prefixes are distinguishable
          // (sk-ant- vs sk-). Other providers use bearer tokens or
          // non-standard key formats this prefix check can't validate.
          const isDirectProvider =
            hostname === "api.anthropic.com" || hostname === "api.openai.com";
          if (!isDirectProvider) {
            shouldCheckProtocolMismatch = false;
          }
        } catch {
          // Malformed URL — run the check to be safe.
        }
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

      // Build protocol-specific request
      let req = buildWorkerRequest(
        target,
        cred,
        model,
        system,
        user,
        maxTokens,
        opts?.sessionID,
        opts?.temperature,
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
                // Guard: some providers return SSE even when stream: false
                // was sent. Extract JSON from the data: lines instead.
                const ct = response.headers.get("content-type") ?? "";
                const rawData = ct.includes("text/event-stream")
                  ? await extractJSONFromSSE(response)
                  : await response.json();

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
                if (parsed.text) return parsed.text;

                // Transport succeeded but the model returned no usable text.
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
                  // Credential changed — rebuild request and retry once
                  log.info(
                    `worker auth error ${response.status}, credential refreshed — retrying: ${text.slice(0, 200)}`,
                  );
                  req = buildWorkerRequest(
                    target,
                    freshCred,
                    model,
                    system,
                    user,
                    maxTokens,
                    opts?.sessionID,
                    opts?.temperature,
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
