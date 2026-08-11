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

import { AsyncLocalStorage } from "node:async_hooks";
import type { LLMClient } from "@loreai/core";
import { log } from "@loreai/core";
import { anthropicThinkingBudget, openAIReasoningEffort } from "@loreai/core";
import { invariantCheck } from "@loreai/core";
import type { ReasoningEffort } from "@loreai/core";
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
import { responseAgainstAbort } from "./abort-race";
import {
  looksLikeSSE,
  type GatewayContentBlock,
  type GatewayResponse,
} from "./translate/types";
import {
  buildOpenAIChatCompletionsUrl,
  buildOpenAIResponsesUrl,
  copilotHeaders,
} from "./translate/openai";
import { accumulateOpenAISSEStream } from "./stream/openai";
import { accumulateResponsesSSEStream } from "./stream/openai-responses";
import { accumulateGeminiSSEStream } from "./stream/gemini";
import {
  geminiUsageFromMetadata,
  validateGeminiFunctionCallIdentity,
} from "./translate/gemini";
import {
  accumulateSSEResponse,
  cancelAndReleaseReader,
  readStreamChunk,
  SSEStreamLimitError,
  SSEStreamTransportError,
} from "./stream/anthropic";
import { isBedrockMantleHost, toMantleModelId } from "./translate/bedrock";
import {
  ANTHROPIC_CONTENT_BLOCK_TYPES,
  ANTHROPIC_STOP_REASONS,
  normalizeAnthropicStopReason,
} from "./anthropic-protocol";
import {
  isRecord,
  validateAnthropicUsage,
  validateGeminiUsageMetadata,
  validateOpenAIUsage,
  validateResponsesUsage,
} from "./usage-validation";
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
  markWorkerIncapable,
  markFreeModelsDataBlocked,
  recordEmptyWorkerResponse,
  clearEmptyWorkerStreak,
} from "./worker-health";
import { getModelEntrySync, workerModelCandidates } from "./worker-model";

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
const LONG_CONTEXT_BETA_RE = /^context-1m(?:-.*)?$/i;

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

// Exported for unit testing in `long-context-beta.test.ts`. The runtime
// safety net in the worker retry loop is dead code for `context-1m`
// specifically after the upfront strip (#1571), but the helpers remain as
// the explicit fallback for any future beta the upstream rejects. Tests pin
// the helper behavior so a future refactor doesn't accidentally drop the
// OAuth gate or accept unrelated betas.
export const __testing = {
  hasLongContextBeta,
  stripBetaHeaders,
  isBetaRelated400,
};

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
const reasoningNoneUnsupportedTargets = new Set<string>();

function reasoningNoneCapabilityKey(
  target: ProviderTarget,
  model: { providerID: string; modelID: string },
): string {
  let origin = target.url;
  try {
    origin = new URL(target.url).origin;
  } catch {
    // Keep the unresolved URL string; route validation reports malformed URLs.
  }
  return `${origin}\x1f${model.providerID}\x1f${model.modelID}\x1f${target.protocol}`;
}

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
export function isTemperatureUnsupported400(body: string): boolean {
  return (
    /temperature/i.test(body) &&
    /\b(deprecated|unsupported|no\s+longer\s+supported|not\s+(?:a\s+)?support(?:ed)?|removed|not\s+allowed|cannot\s+be\s+(?:set|used|specified))\b/i.test(
      body,
    )
  );
}

function isReasoningNoneUnsupported400(body: string): boolean {
  return (
    /reasoning/i.test(body) &&
    /(?:effort|none)/i.test(body) &&
    /\b(?:unsupported|invalid|not\s+supported|not\s+allowed)\b/i.test(body)
  );
}

/**
 * True when an upstream response indicates the worker MODEL is unavailable
 * because it is gated by the account's data policy — specifically OpenRouter's
 *   404 "No endpoints available matching your guardrail restrictions and data
 *   policy. Configure: https://openrouter.ai/settings/privacy"
 * returned for `:free` models when the account has not opted into prompt
 * logging/training.
 *
 * This is a per-account availability fact about THIS model, not a transient
 * outage: retrying is futile and the fix is to blocklist the model and
 * re-resolve worker selection to a usable same-family sibling. Kept strict
 * (status 404 AND a "no endpoints" phrase AND a data-policy/guardrail/privacy
 * marker) so an ordinary 404 (wrong URL, unknown model) cannot trigger it.
 */
export function isDataPolicyBlocked404(status: number, body: string): boolean {
  if (status !== 404) return false;
  if (!/no\s+endpoints/i.test(body)) return false;
  return (
    /data\s+policy/i.test(body) ||
    /guardrail/i.test(body) ||
    /settings\/privacy/i.test(body)
  );
}

/**
 * True when a 400 body says the requested MODEL is unavailable on this
 * account/plan (as opposed to a bad request about params). Copilot returns
 * `code:"model_not_supported"` / `"unsupported_api_for_model"`; other providers
 * phrase it as "model not found/supported/does not exist". Kept to model-scoped
 * markers so a generic 400 (bad param, quota, etc.) does NOT trigger a model
 * swap. Used by the worker retry loop to fall back to a same-provider backup
 * model (see {@link workerModelCandidates}).
 */
export function isModelUnsupported400(status: number, body: string): boolean {
  if (status !== 400) return false;
  return (
    /model_not_supported/i.test(body) ||
    /model_not_found/i.test(body) ||
    /\bmodel\b[^"]{0,40}?(?:is\s+)?not\s+(?:supported|found|available)\b/i.test(
      body,
    ) ||
    /\bmodel\b[^"]{0,40}?does\s+not\s+exist\b/i.test(body)
  );
}

/** A model exists, but not on the API protocol used for this request. */
export function isUnsupportedApi400(status: number, body: string): boolean {
  return status === 400 && /unsupported_api_for_model/i.test(body);
}

/**
 * True when a worker model is a genuine Anthropic Claude model (not an
 * anthropic-compat third party like MiniMax / vLLM served over the Anthropic
 * wire protocol). Every real Claude model id contains "claude" — direct
 * (`claude-sonnet-5`), Bedrock mantle (`anthropic.claude-…`), and Vertex
 * (`claude-…`). Compat providers use their own model ids (e.g. `MiniMax-M1`),
 * so they are naturally excluded.
 */
export function isAnthropicClaudeModel(modelID: string): boolean {
  return /claude/i.test(modelID);
}

/**
 * Decide whether a worker request to this model should carry
 * `thinking:{type:"disabled"}`.
 *
 * PRIMARY (data-driven): models.dev `reasoning_options`. A `toggle` entry marks
 * a model whose adaptive thinking is ON BY DEFAULT (claude-sonnet-5) and must be
 * turned off explicitly. `effort`-only (claude-opus-4-8, gpt-5) and
 * `budget_tokens` (claude-sonnet-4-5) models run WITHOUT thinking unless it is
 * requested, so they need no opt-out — returning false avoids an unnecessary
 * param. This generalizes across providers/generations with no hardcoded list.
 *
 * FALLBACK (offline-safe): when models.dev has NO reasoning data for the model
 * (API outage, or an id newer than the models.dev snapshot), fall back to the
 * Claude-id heuristic so an on-by-default Claude model is still covered when the
 * data is unavailable — a models.dev outage must never silently re-break workers.
 * Sending the param is a harmless no-op for off-by-default Claude models, and the
 * runtime learning net strips it for any model that rejects it.
 */
export function workerThinkingOnByDefault(model: { modelID: string }): boolean {
  const opts = getModelEntrySync(model.modelID).reasoning_options;
  if (Array.isArray(opts) && opts.length > 0) {
    return opts.some((o) => o?.type === "toggle");
  }
  return isAnthropicClaudeModel(model.modelID);
}

/**
 * Decide whether a worker model MAY spend hidden reasoning tokens against its
 * output budget on a plain (no-effort) call — the signal that gates the
 * reasoning-headroom floor (`workerReasoningHeadroomFloor`).
 *
 * This is DELIBERATELY BROADER than `workerThinkingOnByDefault`. That predicate
 * answers "must we send `thinking:{type:"disabled"}`?" and is intentionally
 * narrow (only `toggle`-typed reasoning is on-by-default on the Anthropic wire).
 * But budget headroom is about whether the model reasons AT ALL by default when
 * reached over a protocol with no suppression lever (OpenAI/Gemini) — which is
 * true for `effort`-typed and `budget_tokens`-typed reasoning models too.
 *
 * Real regression this fixes: models.dev lists OpenRouter's
 * `anthropic/claude-sonnet-5` with `reasoning_options:[{type:"effort",…}]` (NO
 * `toggle`). `workerThinkingOnByDefault` returns false for it (no toggle), so the
 * floor never applied — and the curator's tiny 2048 budget was burned on hidden
 * reasoning, returning empty `finish_reason:"length"` (observed in production
 * after the #1418 deploy). ANY non-empty `reasoning_options` → the model can
 * reason → floor applies. Empty/absent `reasoning_options` falls back to the
 * Claude-id heuristic (offline-safe, same as `workerThinkingOnByDefault`).
 *
 * A floor, never a charge: a non-reasoning model still bills only what it emits,
 * so an over-broad true here costs nothing; a false NEGATIVE re-breaks workers.
 */
export function workerModelReasons(model: { modelID: string }): boolean {
  const opts = getModelEntrySync(model.modelID).reasoning_options;
  if (Array.isArray(opts) && opts.length > 0) return true;
  return isAnthropicClaudeModel(model.modelID);
}

/**
 * models.dev-driven check: does this model reject a non-default sampling
 * `temperature`? True for the deprecated-sampling generation (claude-sonnet-5,
 * claude-opus-4-7/4-8, gpt-5, o3, …) where `temperature` is `false`. Used to
 * strip `temperature` PROACTIVELY (before the first 400); the runtime
 * learning net (`isTemperatureUnsupportedModel`) remains the fallback for
 * models absent from models.dev or during an outage.
 */
export function modelRejectsTemperatureByData(modelID: string): boolean {
  return getModelEntrySync(modelID).temperature === false;
}

/**
 * Companion to the temperature-capability learning above, for the `thinking`
 * param. Workers send `thinking:{type:"disabled"}` to genuine Anthropic Claude
 * models to suppress adaptive thinking (see `buildAnthropicWorkerRequest`).
 * Every current Claude model accepts it, but a model that predates the thinking
 * API (older claude-3.x, still reachable on some accounts) can reject an unknown
 * `thinking` field with a 400. We learn that at runtime — on the first such 400
 * — so subsequent calls omit the param, exactly mirroring the temperature
 * mechanism. In-memory; re-learns at most once per model per gateway lifetime.
 */
const thinkingUnsupportedModels = new Set<string>();

/** Record that a model rejects the `thinking` param (learned from a 400). */
export function markThinkingUnsupported(model: {
  providerID: string;
  modelID: string;
}): void {
  thinkingUnsupportedModels.add(workerModelKey(model));
}

/** Has this model been observed to reject the `thinking` param? */
export function isThinkingUnsupportedModel(model: {
  providerID: string;
  modelID: string;
}): boolean {
  return thinkingUnsupportedModels.has(workerModelKey(model));
}

/** Test-only: clear the learned thinking-capability set. */
export function _resetThinkingUnsupportedModels(): void {
  thinkingUnsupportedModels.clear();
}

/**
 * Heuristic: does a 400 body indicate the request's `thinking` param is not
 * accepted by this model? Matches Anthropic param-rejection shapes for an
 * unknown/unsupported field (e.g. "thinking: Extra inputs are not permitted",
 * "thinking.type ... not supported"). Requires the word `thinking` AND a
 * rejection verb so an unrelated 400 that merely mentions thinking can't trigger
 * the one-shot thinking-stripped retry.
 */
function isThinkingUnsupported400(body: string): boolean {
  return (
    /thinking/i.test(body) &&
    /\b(deprecated|unsupported|no\s+longer\s+supported|not\s+supported|not\s+permitted|not\s+allowed|unexpected|unrecognized|unknown|extra\s+inputs|removed|invalid)\b/i.test(
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

const WORKER_ERROR_BODY_MAX_BYTES = 64 * 1024;
const WORKER_RESPONSE_SNIFF_BYTES = 64 * 1024;
// Counts all wire bytes exposed to JSON/SSE decoding and accumulator retention,
// including replay of the sniff prefix. The Bun HTTP bridge also pauses at a
// 64 KiB byte queue; buffering below that transport boundary (and one already-
// delivered source chunk) is outside adapter control. Decoded and accumulated
// content can only derive from bytes admitted under this cap.
const MAX_WORKER_RESPONSE_BYTES = 4 * 1024 * 1024;
// Worker prompts are normally bounded to tens of KiB (distillation segments
// are capped at 16K tokens). This generous wire cap prevents an accidental or
// adversarial caller from materializing an unbounded serialized request while
// preserving substantial headroom for JSON escaping and worker system prompts.
const MAX_WORKER_REQUEST_BYTES = 4 * 1024 * 1024;
// JSON can expand one input byte (an ASCII control character) to a six-byte
// `\u00xx` escape. Cap raw prompt bytes at the derived worst-case ratio so the
// serializer itself cannot transiently allocate far beyond the wire cap.
const MAX_WORKER_PROMPT_SOURCE_BYTES = Math.floor(MAX_WORKER_REQUEST_BYTES / 6);
const WORKER_RESPONSE_INACTIVITY_MS = 120_000;
const WORKER_REQUEST_TIMEOUT_MS = 300_000;

/** Return only URL origin metadata; userinfo, path, query, and fragment vanish. */
function sanitizedWorkerOrigin(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "invalid-origin";
    }
    return url.origin;
  } catch {
    return "invalid-origin";
  }
}

/** Prevent control characters in non-body metadata from forging log lines. */
function diagnosticToken(
  value: string | undefined,
  fallback = "unknown",
): string {
  if (!value) return fallback;
  let safe = "";
  for (const char of value.slice(0, 160)) {
    const code = char.charCodeAt(0);
    safe += code < 32 || code === 127 ? "?" : char;
  }
  return safe;
}

function diagnosticContentKind(contentType: string): string {
  if (!contentType) return "missing";
  if (looksLikeSSE(contentType, "")) return "sse";
  return /(?:^|[/+])json(?:$|;)/i.test(contentType) ? "json" : "other";
}

function diagnosticFinishReason(reason: string | undefined): string {
  if (!reason) return "n/a";
  return new Set([
    "stop",
    "end_turn",
    "length",
    "max_tokens",
    "max_output_tokens",
    "content_filter",
    "tool_calls",
    "tool_use",
  ]).has(reason)
    ? reason
    : "unknown";
}

/** Extract a bounded structural transport code without exposing its message. */
function transportErrorCode(error: unknown): string | undefined {
  const code = isRecord(error) ? error.code : undefined;
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)
    ? code
    : undefined;
}

function transportErrorKind(error: unknown): string {
  if (error instanceof WorkerTransportFailureError) return error.kind;
  if (error instanceof SSEStreamTransportError) return error.kind;
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return "deadline";
  }
  return "transport";
}

/**
 * Error detail safe for logs/lastWorkerError. Provider body values and arbitrary
 * stream error messages are deliberately excluded.
 */
function safeWorkerBodyErrorDetail(error: unknown): string {
  if (error instanceof WorkerResponseTooLargeError) return error.message;
  if (error instanceof SyntaxError) return "malformed JSON body";
  const message = error instanceof Error ? error.message : "";
  const safePatterns = [
    /^SSE stream exceeded \d+ frame limit$/,
    /^SSE event exceeded \d+ byte limit$/,
    /^worker response exceeded \d+ byte limit$/,
    /^unterminated SSE event at EOF$/,
    /^missing (?:Anthropic message_stop|OpenAI finish_reason|Gemini finishReason) terminal$/,
    /^missing terminal response status$/,
    /^missing Responses compatibility terminal status$/,
    /^malformed (?:Anthropic|OpenAI|Responses|Gemini) (?:stream event|response body|usage|terminal event)$/,
    /^worker JSON response root must be an object$/,
    /^non-success Responses response status$/,
    /^response\.failed terminal$/,
    /^Responses terminal reported failure$/,
    /^Responses terminal event\/status mismatch$/,
    /^incomplete Responses output lifecycle$/,
    /^Anthropic stream error event$/,
    /^(?:Response|Upstream response|Anthropic response) has no body$/,
  ];
  return safePatterns.some((pattern) => pattern.test(message))
    ? message
    : "invalid response body";
}

/** Initiate response-body cleanup before a retry without trusting cancel to settle. */
function cancelWorkerResponseForRetry(
  response: Response,
  reason: unknown,
): void {
  if (!response.body || response.body.locked) return;
  void response.body.cancel(reason).catch(() => {});
}

// Visible-output headroom added on top of an extended-thinking budget so the
// model has room for the actual answer after reasoning (Anthropic counts thinking
// against max_tokens). Mirrors pipeline.ts's THINKING_OUTPUT_HEADROOM.
const THINKING_OUTPUT_HEADROOM = 8192;

// When a worker truncates on the output budget (`finish_reason:"length"` /
// `stop_reason:"max_tokens"`) and emits NO visible text, the model spent the
// entire allowance on hidden reasoning. Common when the worker model is a
// reasoning model reached over a protocol that does not expose an explicit
// thinking budget (e.g. Claude routed through OpenRouter's OpenAI-compatible
// endpoint). We retry ONCE with the budget multiplied, clamped to the model's
// own output limit. Bounded to a single retry per call.
const WORKER_LENGTH_RETRY_MULTIPLIER = 4;
// Absolute ceiling for the retried budget when the model's output limit is
// unknown (fallback entry). Bounds cost/latency.
const WORKER_LENGTH_RETRY_CAP = 64_000;

// Default hidden-reasoning budget assumed for a reasoning-on-by-default worker
// model when the caller set NO explicit reasoning effort. Distillation/curation
// workers pass `thinking:false` / no effort, but OpenRouter (and other
// aggregators) route reasoning models like `anthropic/claude-sonnet-5` that
// reason REGARDLESS — burning hidden tokens against the output budget before any
// visible text. Equal to `anthropicThinkingBudget("high")` (16384): a heavy
// curator/distillation reasoning pass on claude-sonnet-5 was observed burning
// past the previous 8192 default and truncating on the FIRST attempt, forcing a
// wasted call + retry-to-64000 (production logs 2026-07-21, session
// 1eMRchBV7Ajs0dds: `retrying once with max_tokens 16384 → 64000`). 16384 lands
// the common case in one round-trip; the length-retry remains the backstop for
// the rare pass that still exceeds it. A floor, never a charge — a higher
// ceiling costs nothing for models that emit fewer tokens.
const DEFAULT_REASONING_MODEL_BUDGET = 16_384;

/**
 * The minimum output budget a worker call needs so the model can complete its
 * VISIBLE answer after any hidden reasoning pass, or 0 when no floor applies.
 *
 * - Explicit reasoning effort set → `anthropicThinkingBudget(effort) +
 *   THINKING_OUTPUT_HEADROOM` (the caller asked the model to reason; make room).
 * - No effort, but the model reasons by default (`workerModelReasons` — ANY
 *   non-empty models.dev `reasoning_options`, i.e. toggle/effort/budget_tokens,
 *   or the Claude-id fallback) → `DEFAULT_REASONING_MODEL_BUDGET +
 *   THINKING_OUTPUT_HEADROOM`. This is the case the length-retry alone could not
 *   solve: the workers pass tiny budgets (~1–8K) and a reasoning model burns
 *   most of it on reasoning, so the FIRST attempt must already carry headroom.
 * - Otherwise → 0 (non-reasoning model with no effort keeps its caller budget).
 *
 * A floor, never a charge: a model that doesn't reason still bills only the
 * tokens it actually emits.
 */
function workerReasoningHeadroomFloor(
  model: { modelID: string },
  reasoningEffort: ReasoningEffort | undefined,
): number {
  const explicitBudget = anthropicThinkingBudget(reasoningEffort);
  if (explicitBudget != null) return explicitBudget + THINKING_OUTPUT_HEADROOM;
  if (workerModelReasons(model)) {
    return DEFAULT_REASONING_MODEL_BUDGET + THINKING_OUTPUT_HEADROOM;
  }
  return 0;
}

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
  if (!Number.isNaN(seconds)) {
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    const milliseconds = seconds * 1000;
    if (!Number.isFinite(milliseconds) || !Number.isSafeInteger(milliseconds)) {
      return null;
    }
    return Math.min(milliseconds, MAX_DELAY_MS);
  }
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    const milliseconds = Math.max(0, date - Date.now());
    return Number.isSafeInteger(milliseconds)
      ? Math.min(milliseconds, MAX_DELAY_MS)
      : null;
  }
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
  if (retryAfterMs != null && Number.isFinite(retryAfterMs)) {
    return Math.min(Math.max(0, retryAfterMs), MAX_DELAY_MS);
  }
  const base = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  return base + Math.random() * 0.25 * base;
}

export function abortableSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function readWorkerResponseText(
  response: Response,
  signal?: AbortSignal,
  maxBytes = WORKER_ERROR_BODY_MAX_BYTES,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (bytes < maxBytes) {
      const { done, value } = await readStreamChunk(reader, {
        signal,
        inactivityMs: WORKER_RESPONSE_INACTIVITY_MS,
      });
      if (done) break;
      if (!value) continue;
      const chunk = value.subarray(0, maxBytes - bytes);
      chunks.push(chunk);
      bytes += chunk.byteLength;
    }
  } catch (_err) {
    if (signal?.aborted) throw signal.reason;
    return "(no body)";
  } finally {
    cancelAndReleaseReader(reader);
  }
  // This is bounded diagnostic text, not semantic response JSON. Replacement
  // decoding preserves useful error classification when malformed bytes or a
  // multibyte code point land at the truncation boundary.
  return new TextDecoder().decode(Buffer.concat(chunks));
}

class WorkerResponseTooLargeError extends SSEStreamLimitError {
  constructor() {
    super(`worker response exceeded ${MAX_WORKER_RESPONSE_BYTES} byte limit`);
    this.name = "WorkerResponseTooLargeError";
  }
}

class IncompleteWorkerResponseError extends Error {
  constructor(readonly reason?: string) {
    super(`worker response incomplete${reason ? ` (${reason})` : ""}`);
    this.name = "IncompleteWorkerResponseError";
  }
}

class WorkerRequestTooLargeError extends Error {
  readonly bytes: number;

  constructor(bytes: number) {
    super(`worker request exceeded ${MAX_WORKER_REQUEST_BYTES} byte limit`);
    this.name = "WorkerRequestTooLargeError";
    this.bytes = bytes;
  }
}

class WorkerTransportFailureError extends Error {
  readonly kind: string;
  readonly code?: string;

  constructor(error: unknown) {
    const kind = transportErrorKind(error);
    const code = transportErrorCode(error);
    super(
      `Worker transport failure: kind=${kind}${code ? ` code=${code}` : ""}`,
    );
    this.name = "WorkerTransportFailureError";
    this.kind = kind;
    this.code = code;
  }
}

function enforceWorkerRequestLimit<T extends { body: string }>(request: T): T {
  const bytes = Buffer.byteLength(request.body);
  if (bytes > MAX_WORKER_REQUEST_BYTES) {
    throw new WorkerRequestTooLargeError(bytes);
  }
  return request;
}

type WorkerSuccessBody =
  | { isSSE: true; response: Response }
  | { isSSE: false; text: string };

function replayWorkerStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  prefix: Uint8Array[],
  signal?: AbortSignal,
): Response {
  let prefixIndex = 0;
  let bytes = 0;
  let finished = false;
  let overflow = false;

  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (finished) return;
        try {
          if (overflow) throw new WorkerResponseTooLargeError();
          const result =
            prefixIndex < prefix.length
              ? { done: false as const, value: prefix[prefixIndex++] }
              : await readStreamChunk(reader, {
                  signal,
                  inactivityMs: WORKER_RESPONSE_INACTIVITY_MS,
                });
          signal?.throwIfAborted();
          if (result.done) {
            finished = true;
            reader.releaseLock();
            controller.close();
            return;
          }
          const remaining = MAX_WORKER_RESPONSE_BYTES - bytes;
          if (result.value.byteLength > remaining) {
            if (remaining === 0) throw new WorkerResponseTooLargeError();
            overflow = true;
            bytes += remaining;
            controller.enqueue(result.value.subarray(0, remaining));
            return;
          }
          bytes += result.value.byteLength;
          controller.enqueue(result.value);
        } catch (error) {
          finished = true;
          void reader.cancel(error).catch(() => {});
          try {
            reader.releaseLock();
          } catch {
            // Cancellation remains non-blocking if a runtime keeps read pending.
          }
          controller.error(error);
        }
      },
      cancel(reason) {
        finished = true;
        void reader.cancel(reason).catch(() => {});
        try {
          reader.releaseLock();
        } catch {
          // Never await an uncooperative source cancellation.
        }
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

async function readCompleteWorkerBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  prefix: Uint8Array[],
  signal?: AbortSignal,
  onBodyBytes?: () => void,
): Promise<string> {
  const chunks = [...prefix];
  let bytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  try {
    if (bytes > MAX_WORKER_RESPONSE_BYTES) {
      throw new WorkerResponseTooLargeError();
    }
    for (;;) {
      const { done, value } = await readStreamChunk(reader, {
        signal,
        inactivityMs: WORKER_RESPONSE_INACTIVITY_MS,
      });
      if (done) break;
      if (!value) continue;
      if (value.byteLength > 0) onBodyBytes?.();
      bytes += value.byteLength;
      if (bytes > MAX_WORKER_RESPONSE_BYTES) {
        throw new WorkerResponseTooLargeError();
      }
      chunks.push(value);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks),
      );
    } catch {
      throw new Error("malformed worker response UTF-8");
    }
  } finally {
    void reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      // See readWorkerResponseText: never wait on provider cancellation.
    }
  }
}

async function inspectWorkerSuccessBody(
  response: Response,
  signal?: AbortSignal,
  onNonSSEBodyBytes?: () => void,
): Promise<WorkerSuccessBody> {
  const reader = response.body?.getReader();
  if (!reader) return { isSSE: false, text: "" };
  const contentType = response.headers.get("content-type") ?? "";
  const prefix: Uint8Array[] = [];
  let prefixBytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let sniffToken = "";
  let skippingLeadingWhitespace = true;

  const sniffSSEPrefix = (chunk: Uint8Array): boolean | null => {
    const text = decoder.decode(chunk, { stream: true });
    for (const char of text) {
      if (skippingLeadingWhitespace) {
        if (char === "\uFEFF" || /\s/.test(char)) continue;
        if (char === ":") return true;
        skippingLeadingWhitespace = false;
      }
      sniffToken += char;
      const sseFields = ["data:", "event:", "id:", "retry:"];
      if (sseFields.some((field) => field.startsWith(sniffToken))) {
        if (sseFields.includes(sniffToken)) return true;
        continue;
      }
      return false;
    }
    return null;
  };

  if (looksLikeSSE(contentType, "")) {
    return {
      isSSE: true,
      response: replayWorkerStream(reader, prefix, signal),
    };
  }

  try {
    while (prefixBytes < WORKER_RESPONSE_SNIFF_BYTES) {
      const { done, value } = await readStreamChunk(reader, {
        signal,
        inactivityMs: WORKER_RESPONSE_INACTIVITY_MS,
      });
      if (done) {
        if (prefixBytes > MAX_WORKER_RESPONSE_BYTES) {
          throw new WorkerResponseTooLargeError();
        }
        reader.releaseLock();
        if (prefix.some((chunk) => chunk.byteLength > 0)) {
          onNonSSEBodyBytes?.();
        }
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(prefix),
          );
        } catch {
          throw new Error("malformed worker response UTF-8");
        }
        return {
          isSSE: false,
          text,
        };
      }
      if (!value) continue;
      prefix.push(value);
      const sniffBytes = Math.min(
        value.byteLength,
        WORKER_RESPONSE_SNIFF_BYTES - prefixBytes,
      );
      prefixBytes += sniffBytes;
      let ssePrefix: boolean | null;
      try {
        ssePrefix = sniffSSEPrefix(value.subarray(0, sniffBytes));
      } catch {
        onNonSSEBodyBytes?.();
        throw new Error("malformed worker response UTF-8");
      }
      if (ssePrefix) {
        return {
          isSSE: true,
          response: replayWorkerStream(reader, prefix, signal),
        };
      }
      if (ssePrefix === false) break;
    }

    if (prefix.some((chunk) => chunk.byteLength > 0)) onNonSSEBodyBytes?.();
    return {
      isSSE: false,
      text: await readCompleteWorkerBody(
        reader,
        prefix,
        signal,
        onNonSSEBodyBytes,
      ),
    };
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      // Never await an uncooperative response-body cancellation.
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// OpenAI response types & usage normalization (exported for testing)
// ---------------------------------------------------------------------------

/** OpenAI Chat Completions response shape (subset we need). */
type OpenAIChatResponse = {
  choices?: Array<{
    index?: number;
    message?: {
      content?: string | null | Array<Record<string, unknown>>;
      // Reasoning models (DeepSeek, Qwen-thinking, Nemotron, MiniMax, etc.)
      // commonly served on aggregators like OpenCode Zen put their answer in a
      // reasoning field and leave `content` empty/null. We read these as a
      // fallback so worker calls to such models are not misclassified as
      // empty/no-response. `reasoning_content` is the DeepSeek/Qwen field;
      // `reasoning` is the OpenRouter/others field.
      reasoning_content?: string;
      reasoning?: string;
      refusal?: string | null;
      tool_calls?: Array<{ id?: string; function?: unknown }>;
    };
    finish_reason?: string | null;
    native_finish_reason?: string | null;
  }>;
  model?: string | null;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
      cache_write_tokens?: number;
    } | null;
    completion_tokens_details?: {
      reasoning_tokens?: number;
      audio_tokens?: number;
      accepted_prediction_tokens?: number;
      rejected_prediction_tokens?: number;
    } | null;
  };
};

/**
 * OpenAI-protocol usage reports cache reads (`cached_tokens`) and writes
 * (`cache_write_tokens`) as a SUBSET of `prompt_tokens` (inclusive accounting —
 * confirmed by the OpenAI prompt-caching docs: `prompt_tokens: 2006` includes
 * `cached_tokens: 1920`). The gateway's cost model and cache analytics treat
 * input / cache-read / cache-write as DISJOINT buckets (the Anthropic-native
 * convention, where `input_tokens` already EXCLUDES cache tokens). Feeding the
 * raw inclusive `prompt_tokens` straight through double-bills the cached and
 * written tokens (once at input rate, again at cache-read/write rate) and
 * inflates the analytics denominator.
 *
 * Convert to the disjoint convention by subtracting the cache buckets from the
 * reported input. Clamped at 0 so a provider that (incorrectly) reports cache
 * tokens exceeding `prompt_tokens` can never yield a negative input count.
 */
export function disjointOpenAIInputTokens(
  rawInputTokens: number | undefined,
  cachedTokens: number | undefined,
  cacheWriteTokens: number | undefined,
): number {
  return Math.max(
    0,
    (rawInputTokens ?? 0) - (cachedTokens ?? 0) - (cacheWriteTokens ?? 0),
  );
}

/**
 * Normalize OpenAI usage to the AnthropicUsage shape for unified cost tracking.
 *
 * Maps:
 *   prompt_tokens − cached − written           → input_tokens (disjoint)
 *   completion_tokens                          → output_tokens
 *   prompt_tokens_details.cached_tokens        → cache_read_input_tokens
 *   prompt_tokens_details.cache_write_tokens   → cache_creation_input_tokens
 *
 * OpenAI proper doesn't report cache writes (field absent → 0); OpenRouter does
 * report them for Anthropic explicit caching. See `disjointOpenAIInputTokens`
 * for why the cache buckets are subtracted from `prompt_tokens`.
 */
export function normalizeOpenAIUsage(
  usage: OpenAIChatResponse["usage"],
): AnthropicUsage {
  validateOpenAIUsage(usage, "malformed OpenAI usage");
  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheWriteTokens =
    usage?.prompt_tokens_details?.cache_write_tokens ?? 0;
  return {
    input_tokens: disjointOpenAIInputTokens(
      usage?.prompt_tokens,
      cachedTokens,
      cacheWriteTokens,
    ),
    output_tokens: usage?.completion_tokens ?? 0,
    cache_read_input_tokens: cachedTokens,
    cache_creation_input_tokens: cacheWriteTokens,
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
export type WorkerProtocol =
  | "anthropic"
  | "openai"
  | "openai-responses"
  | "openai-codex-responses"
  | "vertex"
  | "gemini";

/** Upstream URL, wire protocol, and provider label for a resolved target. */
export type ProviderTarget = {
  url: string;
  protocol: WorkerProtocol;
  /** Provider label for Sentry spans and logging. */
  providerName: string;
};

/** Return the other OpenAI protocol for origins known to serve both APIs. */
function alternateProtocolForUnsupportedApi(
  target: ProviderTarget,
): "openai" | "openai-responses" | null {
  if (target.protocol !== "openai" && target.protocol !== "openai-responses") {
    return null;
  }
  try {
    const hostname = new URL(target.url).hostname;
    if (
      hostname !== "api.openai.com" &&
      hostname !== "githubcopilot.com" &&
      !hostname.endsWith(".githubcopilot.com")
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return target.protocol === "openai" ? "openai-responses" : "openai";
}

type WorkerProtocolFamily = "anthropic" | "openai" | "vertex" | "gemini";

/** URL supplies lowercase/IDNA semantics; remove one optional DNS root dot. */
export function normalizedWorkerHostname(url: string): string | null {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  } catch {
    return null;
  }
}

const WORKER_PROVIDER_ALIAS_FAMILIES: readonly ReadonlySet<string>[] = [
  new Set(["vertex", "google-vertex", "google-vertex-anthropic"]),
  new Set(["bedrock", "amazon-bedrock"]),
];

const WORKER_PROVIDER_PROTOCOL_CAPABILITIES: Readonly<
  Record<string, ReadonlySet<WorkerProtocolFamily>>
> = {
  bedrock: new Set(["anthropic"]),
  "amazon-bedrock": new Set(["anthropic"]),
  vertex: new Set(["vertex"]),
  // The generic Vertex provider can serve native Gemini as well as the
  // configured Claude rawPredict route. The Anthropic-specific identity may not.
  "google-vertex": new Set(["vertex", "gemini"]),
  "google-vertex-anthropic": new Set(["vertex"]),
};

/** Canonical ID for explicitly supported provider aliases; unrelated IDs stay distinct. */
export function canonicalWorkerProviderID(providerID: string): string {
  for (const family of WORKER_PROVIDER_ALIAS_FAMILIES) {
    if (family.has(providerID)) return [...family][0];
  }
  return providerID;
}

function workerProviderAliasIDs(providerID: string): readonly string[] {
  for (const family of WORKER_PROVIDER_ALIAS_FAMILIES) {
    if (family.has(providerID)) {
      return [providerID, ...[...family].filter((id) => id !== providerID)];
    }
  }
  return [providerID];
}

function workerProvidersEquivalent(left: string, right: string): boolean {
  return canonicalWorkerProviderID(left) === canonicalWorkerProviderID(right);
}

function workerProviderSupportsProtocol(
  providerID: string,
  protocol: WorkerProtocol,
): boolean {
  const capabilities = WORKER_PROVIDER_PROTOCOL_CAPABILITIES[providerID];
  return capabilities?.has(workerProtocolFamily(protocol)) ?? true;
}

function workerProtocolFamily(value: WorkerProtocol): WorkerProtocolFamily {
  if (value === "vertex") return "vertex";
  if (value === "gemini") return "gemini";
  if (
    value === "openai" ||
    value === "openai-responses" ||
    value === "openai-codex-responses"
  ) {
    return "openai";
  }
  return "anthropic";
}

/** Trusted canonical origin capabilities. Unknown hosts require provenance. */
export function workerOriginProtocolFamilies(
  url: string,
): ReadonlySet<WorkerProtocolFamily> | null {
  try {
    const parsed = new URL(url);
    const host = normalizedWorkerHostname(url);
    if (host === null) return new Set();
    const knownHost =
      host === "api.anthropic.com" ||
      host === "api.openai.com" ||
      host === "chatgpt.com" ||
      host === "generativelanguage.googleapis.com" ||
      vertexRegionFromUrl(host) !== null;
    if (
      knownHost &&
      (parsed.protocol !== "https:" ||
        (parsed.port !== "" && parsed.port !== "443"))
    ) {
      return new Set();
    }
    if (host === "api.anthropic.com") return new Set(["anthropic"]);
    if (host === "api.openai.com") return new Set(["openai"]);
    if (host === "chatgpt.com") {
      return /(?:^|\/)backend-api(?:\/|$)/.test(parsed.pathname)
        ? new Set(["openai"])
        : new Set();
    }
    // Google's Developer API serves native Gemini and an OpenAI-compatible
    // facade on the same canonical origin.
    if (host === "generativelanguage.googleapis.com") {
      return new Set(["gemini", "openai"]);
    }
    // Vertex hosts serve Claude rawPredict (`vertex`) and native Gemini
    // generateContent under project/location paths.
    if (vertexRegionFromUrl(host) !== null) {
      return new Set(["vertex", "gemini"]);
    }
    return null;
  } catch {
    return new Set();
  }
}

function workerOriginProviderIDs(url: string): ReadonlySet<string> | null {
  try {
    const parsed = new URL(url);
    const host = normalizedWorkerHostname(url);
    if (host === null) return new Set();
    const knownHost =
      host === "api.anthropic.com" ||
      host === "api.openai.com" ||
      host === "chatgpt.com" ||
      host === "generativelanguage.googleapis.com" ||
      vertexRegionFromUrl(host) !== null;
    if (
      knownHost &&
      (parsed.protocol !== "https:" ||
        (parsed.port !== "" && parsed.port !== "443"))
    ) {
      return new Set();
    }
    if (host === "api.anthropic.com") return new Set(["anthropic"]);
    if (host === "api.openai.com") return new Set(["openai"]);
    if (host === "chatgpt.com") {
      return /(?:^|\/)backend-api(?:\/|$)/.test(parsed.pathname)
        ? new Set(["openai", "openai-codex"])
        : new Set();
    }
    if (host === "generativelanguage.googleapis.com") {
      return new Set(["google"]);
    }
    if (vertexRegionFromUrl(host) !== null) {
      return new Set(["vertex", "google-vertex", "google-vertex-anthropic"]);
    }
    return null;
  } catch {
    return new Set();
  }
}

/**
 * Resolve the wire protocol for a worker request.
 *
 * Priority:
 *  1. Explicit protocol from caller (threaded from UpstreamSnapshot)
 *  2. Per-model protocol override (only one case today: github-copilot +
 *     `gpt-5.6-*` family → Responses API; those models return
 *     `unsupported_api_for_model` on `/chat/completions` and are only
 *     reachable via `/responses`, per `earendil-works/pi#6475`)
 *  3. Route table lookup via PROVIDER_ROUTES
 *  4. Default: "anthropic" (safest — most aggregators speak Anthropic)
 *
 * Pass an optional `modelID` to enable per-model routing for hosts that serve
 * the same provider on BOTH chat-completions and responses (e.g. github-copilot
 * serves gpt-5-mini via /chat/completions but gpt-5.6-luna only via
 * /responses). Without `modelID`, behavior matches the prior collapse — all
 * openai-shape providers keep the default chat-completions path.
 *
 * `openai-responses` is preserved (NOT collapsed to `"openai"`) when step 2
 * selects it for a model that needs the Responses wire shape. The Codex path
 * (`openai-codex-responses`) is a separate distinct string because ChatGPT
 * Codex's `/codex/responses` server-side requirements differ (no
 * `max_output_tokens`, mandatory `store:false`, ChatGPT fingerprint headers)
 * from generic openai-responses and deserves its own builder.
 */
export function resolveWorkerProtocol(
  providerID: string,
  explicit?: "anthropic" | "openai" | "openai-responses" | "vertex" | "gemini",
  modelID?: string,
  targetUrl?: string | URL,
): WorkerProtocol {
  // openai-codex MUST use the Responses API — its backend has no Chat
  // Completions endpoint. This takes precedence over the explicit hint.
  if (providerID === "openai-codex") {
    return "openai-codex-responses";
  }
  // A `providerID="openai"` worker targeting the ChatGPT subscription
  // backend (chatgpt.com/backend-api) MUST also use the Responses API —
  // that backend serves ONLY `/backend-api/codex/responses` and 404s on
  // `/chat/completions`. Without this guard the worker storm keeps
  // retrying against a dead URL and trips `workerHealthSummary`'s
  // 5min-degradation threshold (session-level "background workers
  // unhealthy"). This collapses the two openai-codex-style providers
  // (the explicit codex providerID and the openai+ChatGPT-backend case)
  // into the same wire path so `buildCodexWorkerRequest` builds the
  // correct `${target.url}/codex/responses` URL.
  if (providerID === "openai" && isChatGPTBackend(targetUrl)) {
    return "openai-codex-responses";
  }
  // 1. Explicit protocol from caller (threaded from UpstreamSnapshot) — only
  //    honored when the route does not have a per-model override. A caller
  //    thread that explicitly pins "openai" for a github-copilot+gpt-5.6
  //    worker is a misconfig (the model is unreachable on that path) and we
  //    still honor the per-model override for safety; an explicit
  //    "openai-responses" hint must be preserved through (do NOT collapse).
  if (explicit) {
    // Per-model override beats an explicit openai hint (caller likely did
    // not know about the gpt-5.6 routing); but an explicit openai-responses
    // hint is authoritative — IF the provider actually supports the
    // Responses API. The pre-PR-#1582 behavior collapsed
    // `openai-responses` → `openai` UNCONDITIONALLY (defensive guard
    // against misconfigured snapshots where upstreamProviderID and
    // protocol disagree); PR #1582 loosened that to preserve the hint
    // UNCONDITIONALLY, which would silently misroute a misconfigured
    // anthropic/vertex/gemini snapshot to `/v1/responses` on api.anthropic.com
    // (404). Restore the guard: only preserve `openai-responses` when the
    // route table says the provider supports it (real OpenAI: api.openai.com
    // — config.ts:573-578) OR the per-model override (github-copilot +
    // gpt-5.6-*) triggers. Other providers' openai-responses hints fall
    // through to chat-completions (`"openai"`), matching the prior collapse.
    if (explicit === "openai-responses") {
      if (
        resolveProviderRoute(providerID)?.protocol === "openai-responses" ||
        (providerID === "github-copilot" &&
          modelID &&
          isResponsesOnlyModel(modelID))
      ) {
        return "openai-responses";
      }
      return "openai";
    }
    if (
      providerID === "github-copilot" &&
      modelID &&
      isResponsesOnlyModel(modelID)
    ) {
      return "openai-responses";
    }
    // Vertex is a DISTINCT worker protocol: it speaks the Anthropic Messages
    // body but to a :rawPredict URL (model in the path) authenticated with a
    // GCP OAuth2 token — buildVertexWorkerRequest handles all three. It must
    // NOT collapse to "anthropic" (that would POST to /v1/messages with an
    // x-api-key). NOTE: AWS Bedrock is NOT a distinct worker protocol — it is
    // reached via the bedrock-mantle endpoint, whose snapshot protocol is
    // already "anthropic" (route carries `bedrockMantle: true`), so Bedrock
    // worker calls route to the mantle upstream over the normal Anthropic path.
    if (explicit === "vertex") return "vertex";
    // Gemini is a DISTINCT worker protocol: native generateContent (model in the
    // URL path, x-goog-api-key auth) — it must NOT collapse to "openai".
    if (explicit === "gemini") return "gemini";
    return explicit === "anthropic" ? "anthropic" : "openai";
  }
  // 2. Per-model override (no explicit hint from caller) — github-copilot +
  //    gpt-5.6-* is the only case today; adding a new family here means
  //    adding the family string to the constant.
  if (
    providerID === "github-copilot" &&
    modelID &&
    isResponsesOnlyModel(modelID)
  ) {
    return "openai-responses";
  }
  // 3. Route table lookup
  const route = resolveProviderRoute(providerID);
  if (route?.protocol) {
    if (route.protocol === "vertex") return "vertex";
    if (route.protocol === "gemini") return "gemini";
    return route.protocol === "anthropic" ? "anthropic" : "openai";
  }
  // 4. Default: anthropic (safest for unknown/aggregator providers)
  return "anthropic";
}

/**
 * Model ids that are reachable ONLY on the OpenAI **Responses** API endpoint
 * (NOT on `/chat/completions`) on GitHub Copilot. Probed by direct API call
 * (returns `{"code":"unsupported_api_for_model"}` on /chat/completions) and
 * confirmed available on /responses. Added in Copilot's
 * 2026-07-09 rollout (Sol/Terra/Luna). When models.dev grows the family on
 * github-copilot (per `anomalyco/models.dev#3178`), extend the prefix check
 * — the current set is the three-member gpt-5.6 generation. Mirror of the
 * `alreadyCheap` checks in `WORKER_DEFAULTS` for the same family.
 */
function isResponsesOnlyModel(modelID: string): boolean {
  return modelID.startsWith("gpt-5.6-") || modelID === "gpt-5.6";
}

/**
 * True when the upstream URL is the ChatGPT subscription backend
 * (https://chatgpt.com/backend-api). That backend serves ONLY the Responses
 * API at `/backend-api/codex/responses` — it has NO Chat Completions
 * endpoint, so any `providerID="openai"` worker request routed via
 * `buildOpenAIChatCompletionsUrl` will 404. Detecting this at protocol-
 * resolution time lets `resolveWorkerProtocol` route the worker to
 * `openai-codex-responses`, which builds the correct URL (`${url}/codex/responses`).
 */
function isChatGPTBackend(url: string | URL | undefined): boolean {
  if (!url) return false;
  try {
    const target = typeof url === "string" ? new URL(url) : url;
    return /(?:^|\/)backend-api(?:\/|$)/.test(target.pathname);
  } catch {
    return false;
  }
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
export function resolveTarget(
  upstreams: { anthropic: string; openai: string },
  protocol: WorkerProtocol,
  upstreamOverride: string | undefined,
  modelProviderID: string,
  overrideProviderID?: string,
): ProviderTarget & { routeUnavailable?: boolean } {
  const unavailable = (): ProviderTarget & { routeUnavailable: true } => ({
    url: "",
    protocol,
    providerName: modelProviderID,
    routeUnavailable: true,
  });
  const normalizedTargetUrl = (url: string): string => {
    const families = workerOriginProtocolFamilies(url);
    if (families !== null && families.size > 0) {
      const parsed = new URL(url);
      const hostname = normalizedWorkerHostname(url);
      if (hostname) parsed.hostname = hostname;
      return parsed.toString().replace(/\/$/, "");
    }
    return url.replace(/\/$/, "");
  };
  const canonicalOriginIsCompatible = (url: string): boolean => {
    const families = workerOriginProtocolFamilies(url);
    const providerIDs = workerOriginProviderIDs(url);
    return (
      (families === null || families.has(workerProtocolFamily(protocol))) &&
      (providerIDs === null ||
        [...providerIDs].some((providerID) =>
          workerProvidersEquivalent(providerID, modelProviderID),
        ))
    );
  };
  if (!workerProviderSupportsProtocol(modelProviderID, protocol)) {
    return unavailable();
  }
  if (
    (modelProviderID === "openai" &&
      workerProtocolFamily(protocol) !== "openai") ||
    (modelProviderID === "anthropic" &&
      workerProtocolFamily(protocol) !== "anthropic")
  ) {
    return unavailable();
  }
  // Honor the session override ONLY when we have positive evidence it belongs
  // to this worker model's provider:
  //  - overrideProviderID matches the model's provider (the normal case).
  // An absent provider label is not evidence of ownership: trusting an
  // unlabelled URL would let an arbitrary endpoint receive the model provider's
  // credential, especially for route-less/custom providers. Without explicit
  // provenance, ignore the override and use a trusted static route or fail
  // closed below.
  const overrideMatchesModel =
    overrideProviderID !== undefined &&
    workerProvidersEquivalent(overrideProviderID, modelProviderID);
  if (upstreamOverride && overrideMatchesModel) {
    if (!workerProviderSupportsProtocol(overrideProviderID, protocol)) {
      return unavailable();
    }
    // Unknown/custom aliases are accepted only with this exact provider
    // provenance. Canonical origins remain authoritative and cannot be
    // relabelled into another protocol family.
    if (!canonicalOriginIsCompatible(upstreamOverride)) return unavailable();
    return {
      url: normalizedTargetUrl(upstreamOverride),
      protocol,
      // Prefer the actual provider label over the protocol. `overrideMatchesModel`
      // guarantees the override and worker model share a provider, so either the
      // explicit `overrideProviderID` or the worker `modelProviderID` is the true
      // provider (e.g. "openrouter"). Using the protocol here (e.g. "openai")
      // silently mislabels the span AND breaks providerName-gated behavior such as
      // the OpenRouter `:floor` worker preference in buildOpenAIWorkerRequest.
      // Codex keeps its friendly label.
      providerName:
        protocol === "openai-codex-responses"
          ? "openai-codex"
          : (overrideProviderID ?? modelProviderID),
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
        if (!canonicalOriginIsCompatible(route.url)) return unavailable();
        return {
          url: normalizedTargetUrl(route.url),
          protocol,
          providerName: "openai-codex",
        };
      }
    } else {
      const route = resolveProviderRoute(modelProviderID);
      if (route?.url) {
        const routeFamily = route.protocol
          ? workerProtocolFamily(
              route.protocol === "openai-responses"
                ? "openai-responses"
                : route.protocol,
            )
          : undefined;
        const canonicalFamilies = workerOriginProtocolFamilies(route.url);
        if (
          (canonicalFamilies !== null &&
            !canonicalFamilies.has(workerProtocolFamily(protocol))) ||
          (canonicalFamilies === null &&
            routeFamily !== undefined &&
            routeFamily !== workerProtocolFamily(protocol))
        ) {
          return unavailable();
        }
        return {
          url: normalizedTargetUrl(route.url),
          protocol,
          providerName: modelProviderID,
        };
      }
    }
    // No route URL for this provider (unknown, or a local provider needing an
    // explicit LORE_UPSTREAM_<PROVIDER>). Signal the caller to fail closed —
    // we must NOT fall back to a foreign default endpoint.
    return unavailable();
  }
  if (modelProviderID === "openai") {
    if (workerProtocolFamily(protocol) !== "openai" || !upstreams.openai) {
      return unavailable();
    }
    if (!canonicalOriginIsCompatible(upstreams.openai)) return unavailable();
    return {
      url: normalizedTargetUrl(upstreams.openai),
      protocol,
      providerName: "openai",
    };
  }
  if (
    modelProviderID !== "anthropic" ||
    workerProtocolFamily(protocol) !== "anthropic" ||
    !upstreams.anthropic ||
    !canonicalOriginIsCompatible(upstreams.anthropic)
  ) {
    return unavailable();
  }
  return {
    url: normalizedTargetUrl(upstreams.anthropic),
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
  disableThinking = false,
  reasoningEffort?: ReasoningEffort,
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

  // `disableThinking` (decided by the caller — see the retry loop) sends
  // `thinking:{type:"disabled"}` for genuine Anthropic Claude workers. Workers
  // do deterministic single-shot summarization (distillation / curation) and
  // never benefit from thinking. Newer models (claude-sonnet-5+) use ADAPTIVE
  // thinking that is silently activated by the replayed Claude Code OAuth
  // fingerprint (`oauth-2025-04-20` beta on api.anthropic.com); when active the
  // model can spend its budget on a thinking block and return an EMPTY thinking
  // block with no visible text — the worker then sees a "no usable text" empty
  // response and the whole distill/curate loop degrades. `{type:"disabled"}` is
  // accepted (and a no-op) by all current Claude models; a rare model that
  // rejects the param (older claude-3.x) is learned via a one-shot 400 retry in
  // the loop, which then passes `disableThinking=false` here.
  // Extended thinking, opt-in via reasoning effort. When a budget is set the
  // caller wants the model to reason — this OVERRIDES the default worker
  // disable-thinking suppression. Anthropic constraints when thinking is on:
  //   1. max_tokens MUST exceed budget_tokens — the judge's tiny 256-token cap
  //      would otherwise 400, so we raise max_tokens to budget + headroom.
  //   2. temperature must be unset (only the default is allowed) — so we drop it.
  // Caveat: budget+headroom for `xhigh` is ~41K; a model whose output ceiling is
  // below that would 400. Not guarded here (we lack the per-model ceiling on the
  // worker path), but the effort budgets stay well under the common 64K ceiling
  // and the invariant-check judge — the only effort caller — degrades a judge 400
  // to a safe "no finding" (advisory: never fails the build).
  const thinkingBudget = anthropicThinkingBudget(reasoningEffort);
  const thinkingEnabled = thinkingBudget != null;
  const effectiveMaxTokens = thinkingEnabled
    ? Math.max(maxTokens, thinkingBudget + THINKING_OUTPUT_HEADROOM)
    : maxTokens;

  let body = JSON.stringify({
    model: upstreamModelID,
    max_tokens: effectiveMaxTokens,
    // temperature is incompatible with extended thinking — omit when enabled.
    ...(temperature != null && !thinkingEnabled && { temperature }),
    ...(thinkingEnabled
      ? { thinking: { type: "enabled", budget_tokens: thinkingBudget } }
      : disableThinking && { thinking: { type: "disabled" } }),
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

  // Worker calls never need the 1M context window — workers operate on bounded
  // message segments (a distillation segment is capped at 16K tokens; the whole
  // session is typically well under 200K). The user's `anthropic-beta` is
  // replayed verbatim onto worker calls, so a sniffed `context-1m` long-context
  // beta rides along UNLESS we strip it here. On a subscription auth account
  // without purchased usage credits, Anthropic rejects any call carrying the
  // `context-1m` beta with a 429 ("Usage credits are required for long context
  // requests.") regardless of payload size, and that 429 is permanent — workers
  // exhaust their retry budget, the circuit breaker trips, and distillation /
  // curation / cache-warming stop forever (issue #1571). The earlier
  // capability-conditional filter was wrong: it asked "can this worker model
  // handle 1M", but the right question is "does this call need 1M", and the
  // answer is always no for a background worker. Strip it unconditionally.
  // (A runtime 400-retry-without-beta fallback in the retry loop covers any
  // other beta we couldn't validate here.)
  stripLongContextBetaForWorker(headers);

  return {
    url: `${target.url}/v1/messages`,
    headers,
    body,
  };
}

/**
 * Drop the long-context (`context-1m`) beta token from worker calls.
 *
 * Workers operate on bounded message segments (distillation, curation, cache
 * warming, query expansion) — never on the full 1M window the user opted into
 * for their conversation turn. Carrying the `context-1m` beta on a worker call
 * is never useful, and on a subscription auth account without purchased usage
 * credits it is actively harmful: Anthropic rejects any call carrying the beta
 * with a 429 ("Usage credits are required for long context requests."),
 * regardless of how small the worker payload is, and that 429 is permanent.
 * The call exhausts its retry budget, the circuit breaker trips, and the
 * session's background work stops forever (issue #1571).
 *
 * The previous capability-conditional filter only stripped the beta when the
 * worker model's catalog context window was below 1M — which never fired for
 * the default worker model (claude-sonnet-4-6, 1M-capable) and so produced the
 * exact failure described above. Strip unconditionally for workers and let
 * capability be a runtime concern (the 400-retry-without-beta fallback in the
 * retry loop remains as a safety net for any future beta we couldn't validate).
 *
 * Other betas (oauth-2025-04-20, fine-grained-tool-streaming, extended-cache-ttl,
 * prompt-caching-scope, etc.) are preserved. If stripping leaves no betas,
 * the header is removed entirely. Mutates `headers` in place.
 */
function stripLongContextBetaForWorker(headers: Record<string, string>): void {
  const betaKey = Object.keys(headers).find(
    (k) => k.toLowerCase() === "anthropic-beta",
  );
  if (!betaKey) return;
  const betaValue = headers[betaKey];
  if (!betaValue || !/context-1m/i.test(betaValue)) return;

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
  reasoningEffort?: ReasoningEffort,
): { url: string; headers: Record<string, string>; body: string } {
  const messages: Array<{ role: string; content: string }> = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: user });

  // OpenRouter-only cost lever: route background worker calls to the cheapest
  // provider for the chosen model (equivalent to the `:floor` slug suffix, i.e.
  // `provider.sort: "price"`). This is safe here because `buildOpenAIWorkerRequest`
  // only ever builds BACKGROUND worker calls (distillation, curation, query
  // expansion) — never the live conversation, which goes through the proxy path
  // and needs OpenRouter's default load-balancing for reliability. Worker calls
  // are latency-tolerant with no user waiting, so trading load-balancing for the
  // lowest price is pure upside. The field is OpenRouter-specific; other OpenAI-
  // protocol providers ignore an unknown `provider` key. NOTE: `:floor` can land
  // on a quantized endpoint — if distillation/curation quality degrades, a user
  // can pin precision via their own worker model config (see docs). Other OpenAI-
  // protocol upstreams never see this block (gated on providerName).
  const providerPrefs =
    target.providerName === "openrouter"
      ? { provider: { sort: "price" } }
      : undefined;

  // Reasoning models honor `reasoning_effort`; non-reasoning models (gpt-4o-mini,
  // the CI default) silently ignore it. `off`/undefined → omit. `xhigh` clamps to
  // `high` (not a standard OpenAI value) inside openAIReasoningEffort.
  const effort = openAIReasoningEffort(reasoningEffort);

  return {
    // Background workers have no original request to forward verbatim, so the
    // URL is reconstructed host-aware (GitHub Copilot omits `/v1`, issue #1052;
    // Google Gemini serves `/v1beta/openai/...`, issue #1070).
    url: buildOpenAIChatCompletionsUrl(target.url),
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(cred),
      // GitHub Copilot wants Copilot-Integration-Id + X-GitHub-Api-Version;
      // no-op for others.
      ...copilotHeaders(target.url),
    },
    body: JSON.stringify({
      model: model.modelID,
      max_completion_tokens: maxTokens,
      stream: false,
      ...(temperature != null && { temperature }),
      ...(effort != null && { reasoning_effort: effort }),
      messages,
      ...providerPrefs,
    }),
  };
}

/**
 * Build a native Gemini `generateContent` worker request. Gemini authenticates
 * with an API key via `x-goog-api-key` (NOT Bearer), carries the model in the
 * URL path, and uses `systemInstruction` + `contents` + `generationConfig`.
 */
function buildGeminiWorkerRequest(
  target: ProviderTarget,
  cred: AuthCredential,
  model: { providerID: string; modelID: string },
  system: string,
  user: string,
  maxTokens: number,
  temperature?: number,
): { url: string; headers: Record<string, string>; body: string } {
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: maxTokens,
  };
  if (temperature != null) generationConfig.temperature = temperature;
  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig,
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  // Gemini API-key auth uses `x-goog-api-key`; OAuth/Code-Assist sessions use a
  // Bearer token. Be scheme-aware so a bearer credential is never shoved into
  // the api-key header (which would silently misauth).
  const authHeader: Record<string, string> =
    cred.scheme === "bearer"
      ? { Authorization: `Bearer ${cred.value}` }
      : { "x-goog-api-key": cred.value };
  return {
    url: `${target.url}/v1beta/models/${encodeURIComponent(model.modelID)}:generateContent`,
    headers: {
      "Content-Type": "application/json",
      ...authHeader,
    },
    body: JSON.stringify(body),
  };
}

/** Parse a native Gemini `generateContent` worker response into `{text,usage,model}`. */
export function parseGeminiWorkerResponse(data: {
  candidates?: unknown;
  usageMetadata?: unknown;
  modelVersion?: unknown;
}): {
  text: string | null;
  usage: AnthropicUsage | null;
  model: string | null;
} {
  const malformed = (): never => {
    throw new Error("malformed Gemini response body");
  };
  if (data.candidates !== undefined && !Array.isArray(data.candidates)) {
    malformed();
  }
  const candidates = (data.candidates ?? []) as unknown[];
  for (const candidate of candidates) {
    const toolIdentities = new Set<string>();
    if (!isRecord(candidate)) malformed();
    const typedCandidate = candidate as Record<string, unknown>;
    if (
      typedCandidate.index !== undefined &&
      (!Number.isSafeInteger(typedCandidate.index) ||
        (typedCandidate.index as number) < 0)
    ) {
      malformed();
    }
    if (
      typedCandidate.finishReason !== undefined &&
      typedCandidate.finishReason !== null &&
      typeof typedCandidate.finishReason !== "string"
    ) {
      malformed();
    }
    if (
      typedCandidate.tokenCount !== undefined &&
      (!Number.isSafeInteger(typedCandidate.tokenCount) ||
        (typedCandidate.tokenCount as number) < 0)
    ) {
      malformed();
    }
    if (typedCandidate.content === undefined) continue;
    if (!isRecord(typedCandidate.content)) malformed();
    const typedContent = typedCandidate.content as Record<string, unknown>;
    if (
      typedContent.role !== undefined &&
      typeof typedContent.role !== "string"
    ) {
      malformed();
    }
    const parts = typedContent.parts;
    if (parts === undefined) continue;
    if (!Array.isArray(parts)) malformed();
    for (const part of parts as unknown[]) {
      if (!isRecord(part)) malformed();
      const typedPart = part as Record<string, unknown>;
      if (
        typedPart.text !== undefined &&
        typedPart.functionCall !== undefined
      ) {
        malformed();
      }
      if (typedPart.text !== undefined && typeof typedPart.text !== "string") {
        malformed();
      }
      if (
        typedPart.thought !== undefined &&
        typeof typedPart.thought !== "boolean"
      ) {
        malformed();
      }
      if (typedPart.functionCall !== undefined) {
        if (!isRecord(typedPart.functionCall)) malformed();
        validateGeminiFunctionCallIdentity(
          typedPart.functionCall,
          toolIdentities,
          "malformed Gemini response body",
        );
      }
    }
  }

  const usageMetadata = validateGeminiUsageMetadata(
    data.usageMetadata,
    "malformed Gemini response body",
  );
  if (
    data.modelVersion !== undefined &&
    data.modelVersion !== null &&
    typeof data.modelVersion !== "string"
  ) {
    malformed();
  }

  const first = candidates[0] as Record<string, unknown> | undefined;
  const content = first?.content as Record<string, unknown> | undefined;
  const parts = (content?.parts ?? []) as Array<Record<string, unknown>>;
  const text =
    parts
      .filter((p) => typeof p.text === "string")
      .map((p) => p.text)
      .join("") || null;
  const normalizedUsage = usageMetadata
    ? geminiUsageFromMetadata(usageMetadata)
    : null;
  const usage: AnthropicUsage | null = normalizedUsage
    ? {
        input_tokens: normalizedUsage.inputTokens,
        output_tokens: normalizedUsage.outputTokens,
        cache_read_input_tokens: normalizedUsage.cacheReadInputTokens ?? 0,
        cache_creation_input_tokens: 0,
      }
    : null;
  return {
    text,
    usage,
    model: typeof data.modelVersion === "string" ? data.modelVersion : null,
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
      // ChatGPT's Codex backend rejects non-streaming requests.
      stream: true,
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

/**
 * Build an OpenAI **Responses API** worker request for a generic openai-responses
 * target (NOT Codex). Used for `github-copilot` workers on the `gpt-5.6-*`
 * family — those models return `unsupported_api_for_model` on `/chat/completions`
 * and are ONLY reachable on `/responses`, per `earendil-works/pi#6475`. Other
 * GitHub-Copilot models (gpt-5-mini, claude-sonnet-4.5, etc.) continue to use
 * the chat-completions path (see `buildOpenAIWorkerRequest`).
 *
 * Wire-format differences vs Chat Completions:
 *   - `input: [{ role, content }]` items array (NOT `messages`)
 *   - top-level `instructions: "..."` (NOT a `{role:"system",...}` first message)
 *   - `max_output_tokens` (NOT `max_completion_tokens`)
 *   - `reasoning: { effort: ... }` (NOT `reasoning_effort: "..."`)
 *   - `store: false` — required by Copilot's `/responses` endpoint (observed)
 *   - URL: host-aware via `buildOpenAIResponsesUrl` (github-copilot omits /v1,
 *     issue #1052; mirrors the chat-completions URL builder)
 *
 * Unlike Codex, this path allows `max_output_tokens` (Copilot's `/responses`
 * honors it just like the Responses API spec) and threads `reasoningEffort`
 * through to nested `reasoning.{effort}`. Same `openAIReasoningEffort` returns
 * null on `off`/undefined so we omit both forms when the caller did not set it.
 */
function buildOpenAIResponsesWorkerRequest(
  target: ProviderTarget,
  cred: AuthCredential,
  model: { providerID: string; modelID: string },
  system: string,
  user: string,
  maxTokens: number,
  temperature?: number,
  reasoningEffort?: ReasoningEffort,
): { url: string; headers: Record<string, string>; body: string } {
  // Copilot's Responses endpoint defaults an omitted effort to medium. `off`
  // therefore has to be explicit; omission does not disable reasoning.
  const effort =
    reasoningEffort === "off" ? "none" : openAIReasoningEffort(reasoningEffort);

  return {
    // Host-aware URL construction: github-copilot omits /v1 (issue #1052),
    // mirrors buildOpenAIChatCompletionsUrl. Other openai-responses hosts
    // (currently none in our route table) get the default `/v1/responses`.
    url: buildOpenAIResponsesUrl(target.url),
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(cred),
      // GitHub Copilot wants Copilot-Integration-Id + X-GitHub-Api-Version;
      // no-op for other hosts (matches the chat-completions path).
      ...copilotHeaders(target.url),
    },
    body: JSON.stringify({
      model: model.modelID,
      store: false,
      stream: false,
      max_output_tokens: maxTokens,
      ...(temperature != null && { temperature }),
      ...(effort != null && { reasoning: { effort } }),
      instructions: system,
      input: [
        {
          role: "user",
          content: user,
        },
      ],
    }),
  };
}

function validateAnthropicContentBlock(block: unknown): void {
  const malformed = (): never => {
    throw new Error("malformed Anthropic response body");
  };
  if (
    !isRecord(block) ||
    typeof block.type !== "string" ||
    !ANTHROPIC_CONTENT_BLOCK_TYPES.has(block.type)
  ) {
    malformed();
  }
  const typedBlock = block as Record<string, unknown>;
  switch (typedBlock.type) {
    case "text":
      if (typeof typedBlock.text !== "string") malformed();
      break;
    case "thinking":
      if (
        typeof typedBlock.thinking !== "string" ||
        (typedBlock.signature !== undefined &&
          typeof typedBlock.signature !== "string")
      ) {
        malformed();
      }
      break;
    case "redacted_thinking":
      if (typeof typedBlock.data !== "string") malformed();
      break;
    case "tool_use":
    case "server_tool_use":
      if (
        typeof typedBlock.id !== "string" ||
        typeof typedBlock.name !== "string" ||
        (typedBlock.type === "tool_use"
          ? !isRecord(typedBlock.input)
          : typedBlock.input === undefined)
      ) {
        malformed();
      }
      break;
    case "container_upload":
      if (typeof typedBlock.file_id !== "string") malformed();
      break;
    case "web_search_tool_result":
    case "web_fetch_tool_result":
    case "code_execution_tool_result":
    case "bash_code_execution_tool_result":
    case "text_editor_code_execution_tool_result":
    case "tool_search_tool_result":
      if (
        typeof typedBlock.tool_use_id !== "string" ||
        typedBlock.content == null
      ) {
        malformed();
      }
      break;
    case "fallback":
      // A fallback block is a provider boundary marker and has no worker text.
      break;
  }
}

/** Extract text response from an Anthropic Messages API response. */
export function parseAnthropicResponse(data: {
  content?: Array<
    Record<string, unknown> & {
      type: string;
      text?: string;
      thinking?: string;
    }
  >;
  model?: string | null;
  usage?: AnthropicUsage;
  stop_reason?: unknown;
}): {
  text: string | null;
  usage: AnthropicUsage | null;
  model: string | null;
} {
  if (data.content !== undefined && !Array.isArray(data.content)) {
    throw new Error("malformed Anthropic response body");
  }
  const toolIdentities = new Set<string>();
  for (const block of data.content ?? []) {
    validateAnthropicContentBlock(block);
    if (block.type === "tool_use" || block.type === "server_tool_use") {
      const id = (block as { id?: unknown }).id;
      if (typeof id !== "string" || !id || toolIdentities.has(id)) {
        throw new Error("malformed Anthropic response body");
      }
      toolIdentities.add(id);
    }
  }
  if (
    data.model !== undefined &&
    data.model !== null &&
    typeof data.model !== "string"
  ) {
    throw new Error("malformed Anthropic response body");
  }
  if (
    data.stop_reason !== undefined &&
    (typeof data.stop_reason !== "string" ||
      !ANTHROPIC_STOP_REASONS.has(data.stop_reason))
  ) {
    throw new Error("malformed Anthropic response body");
  }
  validateAnthropicUsage(data.usage, {
    message: "malformed Anthropic response body",
    requireInput: true,
    requireOutput: true,
  });
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
    model: typeof data.model === "string" ? data.model : null,
  };
}

/** Extract text response from an OpenAI Chat Completions response. */
export function parseOpenAIResponse(data: OpenAIChatResponse): {
  text: string | null;
  usage: AnthropicUsage | null;
  model: string | null;
} {
  if (data.choices !== undefined && !Array.isArray(data.choices)) {
    throw new Error("malformed OpenAI response body");
  }
  const logicalChoiceIndices = new Set<number>();
  for (let position = 0; position < (data.choices?.length ?? 0); position++) {
    const choice = data.choices?.[position];
    if (!isRecord(choice)) throw new Error("malformed OpenAI response body");
    const logicalIndex = choice.index === undefined ? position : choice.index;
    if (
      !Number.isSafeInteger(logicalIndex) ||
      logicalIndex < 0 ||
      logicalChoiceIndices.has(logicalIndex)
    ) {
      throw new Error("malformed OpenAI response body");
    }
    logicalChoiceIndices.add(logicalIndex);
  }
  for (const choice of data.choices ?? []) {
    const toolIdentities = new Set<string>();
    if (!isRecord(choice)) throw new Error("malformed OpenAI response body");
    if (
      choice.index !== undefined &&
      (!Number.isSafeInteger(choice.index) || choice.index < 0)
    ) {
      throw new Error("malformed OpenAI response body");
    }
    if (
      (choice.finish_reason !== undefined &&
        choice.finish_reason !== null &&
        typeof choice.finish_reason !== "string") ||
      (choice.native_finish_reason !== undefined &&
        choice.native_finish_reason !== null &&
        typeof choice.native_finish_reason !== "string")
    ) {
      throw new Error("malformed OpenAI response body");
    }
    if (choice.message === undefined) continue;
    if (!isRecord(choice.message)) {
      throw new Error("malformed OpenAI response body");
    }
    const message = choice.message;
    if (
      message.content !== undefined &&
      message.content !== null &&
      typeof message.content !== "string" &&
      !Array.isArray(message.content)
    ) {
      throw new Error("malformed OpenAI response body");
    }
    if (
      Array.isArray(message.content) &&
      message.content.some((part) => !isRecord(part))
    ) {
      throw new Error("malformed OpenAI response body");
    }
    for (const field of [
      "reasoning_content",
      "reasoning",
      "refusal",
    ] as const) {
      if (
        message[field] !== undefined &&
        message[field] !== null &&
        typeof message[field] !== "string"
      ) {
        throw new Error("malformed OpenAI response body");
      }
    }
    const toolCalls = message.tool_calls;
    if (toolCalls !== undefined && !Array.isArray(toolCalls)) {
      throw new Error("malformed OpenAI response body");
    }
    for (const call of toolCalls ?? []) {
      if (!isRecord(call) || typeof call.id !== "string" || !call.id) {
        throw new Error("malformed OpenAI response body");
      }
      if (toolIdentities.has(call.id)) {
        throw new Error("malformed OpenAI response body");
      }
      toolIdentities.add(call.id);
    }
  }
  const message = data.choices?.[0]?.message;
  if (
    data.model !== undefined &&
    data.model !== null &&
    typeof data.model !== "string"
  ) {
    throw new Error("malformed OpenAI response body");
  }
  validateOpenAIUsage(data.usage, "malformed OpenAI response body");
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
    typeof content === "string" && content.length > 0
      ? content
      : reasoning ||
        (typeof message?.refusal === "string" ? message.refusal : null);
  return {
    text: text ?? null,
    usage: data.usage ? normalizeOpenAIUsage(data.usage) : null,
    model: typeof data.model === "string" ? data.model : null,
  };
}

/**
 * Extract text from an OpenAI **Responses API** non-streaming response (used by
 * the `openai-codex` worker path). Text lives in `output[].content[].text` for
 * `output_text` parts; usage uses `input_tokens`/`output_tokens`.
 */
export function parseResponsesWorkerResponse(data: {
  output?: Array<{
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    content?: Array<{
      type?: string;
      text?: string;
      refusal?: string;
    }>;
  }>;
  output_text?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    // Responses API reports cache details under `input_tokens_details`;
    // OpenAI-compatible providers may use `prompt_tokens_details` instead.
    input_tokens_details?: {
      cached_tokens?: number;
      cache_write_tokens?: number;
    };
    prompt_tokens_details?: {
      cached_tokens?: number;
      cache_write_tokens?: number;
    };
    output_tokens_details?: {
      reasoning_tokens?: number;
      audio_tokens?: number;
      accepted_prediction_tokens?: number;
      rejected_prediction_tokens?: number;
    };
  };
  model?: string | null;
  status?: string;
  incomplete_details?: { reason?: string } | null;
}): {
  text: string | null;
  usage: AnthropicUsage | null;
  model: string | null;
  incompleteDetails?: { reason: string } | null;
} {
  if (
    data.status !== undefined &&
    data.status !== "completed" &&
    data.status !== "incomplete"
  ) {
    throw new Error("non-success Responses response status");
  }
  const incompleteDetails = data.incomplete_details;
  if (
    incompleteDetails !== undefined &&
    incompleteDetails !== null &&
    (!isRecord(incompleteDetails) ||
      typeof incompleteDetails.reason !== "string" ||
      incompleteDetails.reason.length === 0)
  ) {
    throw new Error("malformed Responses response body");
  }
  if (incompleteDetails != null && data.status !== "incomplete") {
    throw new Error("malformed Responses response body");
  }
  if (data.output !== undefined && !Array.isArray(data.output)) {
    throw new Error("malformed Responses response body");
  }
  const toolIdentities = new Set<string>();
  const outputItemIds = new Set<string>();
  for (const item of data.output ?? []) {
    if (!isRecord(item)) throw new Error("malformed Responses response body");
    if (item.type !== undefined && typeof item.type !== "string") {
      throw new Error("malformed Responses response body");
    }
    if (
      typeof item.id !== "string" ||
      item.id.length === 0 ||
      outputItemIds.has(item.id)
    ) {
      throw new Error("malformed Responses response body");
    }
    outputItemIds.add(item.id);
    if (item.type === "function_call") {
      const identity = item.call_id;
      if (
        typeof identity !== "string" ||
        identity.length === 0 ||
        toolIdentities.has(identity) ||
        typeof item.name !== "string" ||
        typeof item.arguments !== "string"
      ) {
        throw new Error("malformed Responses response body");
      }
      toolIdentities.add(identity);
    }
    if (item.content !== undefined && !Array.isArray(item.content)) {
      throw new Error("malformed Responses response body");
    }
    for (const part of item.content ?? []) {
      if (!isRecord(part)) {
        throw new Error("malformed Responses response body");
      }
      if (part.type !== undefined && typeof part.type !== "string") {
        throw new Error("malformed Responses response body");
      }
      if (part.type === "output_text" && typeof part.text !== "string") {
        throw new Error("malformed Responses response body");
      }
      if (part.type === "refusal" && typeof part.refusal !== "string") {
        throw new Error("malformed Responses response body");
      }
    }
  }
  if (
    data.output_text !== undefined &&
    data.output_text !== null &&
    typeof data.output_text !== "string"
  ) {
    throw new Error("malformed Responses response body");
  }
  if (
    data.model !== undefined &&
    data.model !== null &&
    typeof data.model !== "string"
  ) {
    throw new Error("malformed Responses response body");
  }
  const validatedUsage = validateResponsesUsage(
    data.usage,
    "malformed Responses response body",
  );

  // Prefer the convenience `output_text` aggregate when present; otherwise
  // concatenate text parts from message output items.
  let text: string | null =
    typeof data.output_text === "string" && data.output_text.length > 0
      ? data.output_text
      : null;
  if (text === null && Array.isArray(data.output)) {
    const parts: string[] = [];
    for (const item of data.output) {
      if (!Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (part?.type === "output_text" && typeof part.text === "string") {
          parts.push(part.text);
        } else if (
          part?.type === "refusal" &&
          typeof part.refusal === "string"
        ) {
          parts.push(part.refusal);
        }
      }
    }
    if (parts.length > 0) text = parts.join("");
  }

  let usage: AnthropicUsage | null = null;
  if (validatedUsage) {
    const rawDetails =
      validatedUsage.input_tokens_details ??
      validatedUsage.prompt_tokens_details;
    const details = isRecord(rawDetails) ? rawDetails : undefined;
    const cachedTokens =
      typeof details?.cached_tokens === "number"
        ? details.cached_tokens
        : undefined;
    const cacheWriteTokens =
      typeof details?.cache_write_tokens === "number"
        ? details.cache_write_tokens
        : undefined;
    usage = {
      // input_tokens is inclusive of cache reads/writes; convert to the
      // gateway's disjoint convention so cache tokens aren't double-counted.
      input_tokens: disjointOpenAIInputTokens(
        typeof validatedUsage.input_tokens === "number"
          ? validatedUsage.input_tokens
          : undefined,
        cachedTokens,
        cacheWriteTokens,
      ),
      output_tokens:
        typeof validatedUsage.output_tokens === "number"
          ? validatedUsage.output_tokens
          : 0,
      cache_read_input_tokens: cachedTokens ?? 0,
      cache_creation_input_tokens: cacheWriteTokens ?? 0,
    };
  }

  return {
    text,
    usage,
    model: typeof data.model === "string" ? data.model : null,
    ...(incompleteDetails === undefined
      ? {}
      : {
          incompleteDetails:
            incompleteDetails === null
              ? null
              : { reason: incompleteDetails.reason as string },
        }),
  };
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
  disableThinking = false,
  reasoningEffort?: ReasoningEffort,
  signal?: AbortSignal,
): Promise<{ url: string; headers: Record<string, string>; body: string }> {
  const region = vertexRegionFromUrl(target.url) ?? "global";
  const project = await resolveVertexProject(vertexProject ?? "", signal);
  if (!project) {
    throw new Error(
      "Vertex worker: no GCP project. Set GOOGLE_CLOUD_PROJECT (or " +
        "LORE_VERTEX_PROJECT), or ensure Application Default Credentials " +
        "provide a project.",
    );
  }
  const vertexModel = toVertexModelId(model.modelID);
  const token = await getVertexAccessToken(signal);
  const vertexThinkingBudget = anthropicThinkingBudget(reasoningEffort) ?? 0;
  const vertexThinkingEnabled = vertexThinkingBudget > 0;
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
      max_tokens: vertexThinkingEnabled
        ? Math.max(maxTokens, vertexThinkingBudget + THINKING_OUTPUT_HEADROOM)
        : maxTokens,
      // temperature is incompatible with extended thinking — omit when enabled.
      ...(temperature != null && !vertexThinkingEnabled && { temperature }),
      // Vertex serves Claude over the Anthropic Messages body shape, so the same
      // adaptive-thinking-on-by-default applies (sonnet-5). A reasoning-effort
      // budget enables thinking (overriding the default disable); otherwise
      // `thinking:{type:"disabled"}` turns it off. See buildAnthropicWorkerRequest.
      ...(vertexThinkingEnabled
        ? { thinking: { type: "enabled", budget_tokens: vertexThinkingBudget } }
        : disableThinking && { thinking: { type: "disabled" } }),
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
  disableThinking = false,
  reasoningEffort?: ReasoningEffort,
  signal?: AbortSignal,
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
    case "openai-responses":
      return buildOpenAIResponsesWorkerRequest(
        target,
        cred,
        model,
        system,
        user,
        maxTokens,
        temperature,
        reasoningEffort,
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
        reasoningEffort,
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
        disableThinking,
        reasoningEffort,
        signal,
      );
    case "gemini":
      return buildGeminiWorkerRequest(
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
        disableThinking,
        reasoningEffort,
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
    case "openai-responses":
      // Same wire shape as the Codex path — reuse the existing Responses-API
      // worker parser; openai-responses and openai-codex-responses both
      // produce `{ output: [...], usage: { input_tokens, output_tokens, ... } }`.
      return parseResponsesWorkerResponse(
        rawData as Parameters<typeof parseResponsesWorkerResponse>[0],
      );
    case "openai":
      return parseOpenAIResponse(rawData as OpenAIChatResponse);
    case "gemini":
      return parseGeminiWorkerResponse(
        rawData as Parameters<typeof parseGeminiWorkerResponse>[0],
      );
    default:
      return parseAnthropicResponse(
        rawData as Parameters<typeof parseAnthropicResponse>[0],
      );
  }
}

/**
 * Accumulate an SSE upstream worker response into a GatewayResponse using the
 * protocol's stream accumulator. The ChatGPT/Copilot/Codex backend and some
 * OpenAI-compatible providers stream even for a non-streaming worker request;
 * merging every chunk here (rather than reading a single JSON body) makes the
 * worker read multi-chunk safe and immune to a mislabeled/absent
 * text/event-stream content-type (LOREAI-GATEWAY-38 / -1P).
 */
function accumulateWorkerSSE(
  protocol: WorkerProtocol,
  response: Response,
  signal?: AbortSignal,
  onSemanticContent?: () => void,
): Promise<GatewayResponse> {
  switch (protocol) {
    case "openai-codex-responses":
      return accumulateResponsesSSEStream(response, {
        validation: "codex",
        stopAtTerminal: true,
        signal,
        inactivityMs: WORKER_RESPONSE_INACTIVITY_MS,
        onSemanticContent,
      });
    case "openai-responses":
      // OpenAI Responses API uses the same wire-shape SSE stream as the
      // Codex-Responses path (`event: response.*` deltas). Reuse the existing
      // accumulator.
      return accumulateResponsesSSEStream(response, {
        validation: "public",
        stopAtTerminal: true,
        signal,
        inactivityMs: WORKER_RESPONSE_INACTIVITY_MS,
        onSemanticContent,
      });
    case "gemini":
      return accumulateGeminiSSEStream(response, {
        signal,
        stopAtTerminal: true,
        strict: true,
        inactivityMs: WORKER_RESPONSE_INACTIVITY_MS,
        onSemanticContent,
      });
    case "openai":
      return accumulateOpenAISSEStream(response, {
        signal,
        stopAtTerminal: true,
        strict: true,
        inactivityMs: WORKER_RESPONSE_INACTIVITY_MS,
        onSemanticContent,
        consumeUntilDone: true,
      });
    default:
      // Anthropic wire (incl. Vertex/Bedrock-mantle) SSE.
      return accumulateSSEResponse(response, {
        signal,
        stopAtTerminal: true,
        strict: true,
        inactivityMs: WORKER_RESPONSE_INACTIVITY_MS,
        onSemanticContent,
      });
  }
}

/** Parse buffered SSE framing without changing its LF/CRLF semantics. */
function workerSSEFrames(body: string): Array<{ event: string; data: string }> {
  const frames: Array<{ event: string; data: string }> = [];
  for (const frame of body.split(/\r?\n\r?\n/)) {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length > 0) {
      frames.push({ event, data: dataLines.join("\n") });
    }
  }
  return frames;
}

function parseWorkerSSEData(
  event: string,
  data: string,
): Record<string, unknown> | Error {
  try {
    const parsed: unknown = JSON.parse(data);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return new Error(`malformed ${event || "unnamed"} event`);
    }
    return parsed as Record<string, unknown>;
  } catch {
    return new Error(`malformed ${event || "unnamed"} event`);
  }
}

function validateResponsesWorkerSSE(body: string): Error | null {
  let terminalStatus: string | null = null;
  let terminalEvent: string | null = null;
  let incompleteReason: string | undefined;

  for (const { event, data } of workerSSEFrames(body)) {
    if (!data || data === "[DONE]") continue;
    const parsed = parseWorkerSSEData(event, data);
    if (parsed instanceof Error) return parsed;

    if (event === "response.failed") {
      return new Error("response.failed terminal");
    }
    if (
      event === "response.completed" ||
      event === "response.done" ||
      event === "response.incomplete"
    ) {
      terminalEvent = event;
      const response = parsed.response as Record<string, unknown> | undefined;
      terminalStatus =
        typeof response?.status === "string" ? response.status : null;
      const details = response?.incomplete_details as
        | Record<string, unknown>
        | undefined;
      incompleteReason =
        typeof details?.reason === "string" ? details.reason : undefined;
    }
  }

  if (!terminalStatus) return new Error("missing terminal response status");
  if (
    terminalStatus === "incomplete" ||
    terminalEvent === "response.incomplete"
  ) {
    return new IncompleteWorkerResponseError(incompleteReason ?? "max_tokens");
  }
  if (terminalStatus === "failed" || terminalStatus === "cancelled") {
    return new Error(`terminal response status=${terminalStatus}`);
  }
  return terminalStatus === "completed"
    ? null
    : new Error(`invalid terminal response status=${terminalStatus}`);
}

/**
 * Require the protocol's actual terminal evidence before trusting accumulated
 * worker text. The shared stream accumulators are intentionally permissive for
 * foreground translation, but a worker stream ending at an arbitrary byte
 * boundary must never turn a partial semantic verdict into a clean success.
 */
function validateWorkerSSE(
  protocol: WorkerProtocol,
  body: string,
): Error | null {
  if (
    protocol === "openai-codex-responses" ||
    protocol === "openai-responses"
  ) {
    return validateResponsesWorkerSSE(body);
  }

  if (protocol === "openai") {
    let finishSeenBeforeDone = false;
    let doneSeen = false;
    for (const { event, data } of workerSSEFrames(body)) {
      if (data === "[DONE]") {
        doneSeen = true;
        break;
      }
      if (!data) continue;
      const parsed = parseWorkerSSEData(event, data);
      if (parsed instanceof Error) return parsed;
      const choices = parsed.choices;
      const firstChoice = Array.isArray(choices) ? choices[0] : undefined;
      if (
        !!firstChoice &&
        typeof firstChoice === "object" &&
        typeof (firstChoice as Record<string, unknown>).finish_reason ===
          "string" &&
        ((firstChoice as Record<string, unknown>).finish_reason as string)
          .length > 0
      ) {
        finishSeenBeforeDone = true;
      }
    }
    if (!finishSeenBeforeDone) {
      return new Error("missing terminal chat finish_reason");
    }
    return doneSeen ? null : new Error("missing terminal [DONE] sentinel");
  }

  if (protocol === "gemini") {
    let finishReasonSeen = false;
    for (const { event, data } of workerSSEFrames(body)) {
      if (!data || data === "[DONE]") continue;
      const parsed = parseWorkerSSEData(event, data);
      if (parsed instanceof Error) return parsed;
      const candidates = parsed.candidates;
      const firstCandidate = Array.isArray(candidates)
        ? candidates[0]
        : undefined;
      if (
        !!firstCandidate &&
        typeof firstCandidate === "object" &&
        typeof (firstCandidate as Record<string, unknown>).finishReason ===
          "string" &&
        ((firstCandidate as Record<string, unknown>).finishReason as string)
          .length > 0
      ) {
        finishReasonSeen = true;
      }
    }
    return finishReasonSeen
      ? null
      : new Error("missing terminal Gemini finishReason");
  }

  // Anthropic Messages wire, including Vertex and Bedrock-mantle streams.
  let stopReasonSeen = false;
  let messageStopSeen = false;
  for (const { event, data } of workerSSEFrames(body)) {
    if (!data || data === "[DONE]") continue;
    const parsed = parseWorkerSSEData(event, data);
    if (parsed instanceof Error) return parsed;
    if (event === "message_delta") {
      const delta = parsed.delta as Record<string, unknown> | undefined;
      if (
        typeof delta?.stop_reason === "string" &&
        delta.stop_reason.length > 0
      ) {
        stopReasonSeen = true;
      }
    } else if (event === "message_stop" && stopReasonSeen) {
      messageStopSeen = true;
    }
  }
  if (!stopReasonSeen) return new Error("missing terminal message stop_reason");
  return messageStopSeen
    ? null
    : new Error("missing terminal message_stop event");
}

/**
 * Project an accumulated GatewayResponse down to the worker result shape
 * ({ text, usage, model }). Only the visible text blocks form the worker's
 * text — a response that is purely tool_use (no text) is treated as empty,
 * matching parseWorkerResponse (workers consume text, not tool calls).
 */
export function gatewayResponseToWorkerResult(resp: GatewayResponse): {
  text: string | null;
  usage: AnthropicUsage | null;
  model: string | null;
} {
  const text = resp.content
    .filter(
      (b): b is Extract<GatewayContentBlock, { type: "text" }> =>
        b.type === "text",
    )
    .map((b) => b.text)
    .join("");
  // Reasoning models (e.g. MiniMax-M3 via OpenRouter) can emit their entire answer
  // as reasoning/thinking with an empty text block. Never treat a present thinking
  // body as no-response — fall back to it when there is no visible text, mirroring
  // parseOpenAIResponse (content→reasoning) and parseAnthropicResponse (text→thinking). (#1334)
  const workerText =
    text ||
    resp.content
      .filter(
        (b): b is Extract<GatewayContentBlock, { type: "thinking" }> =>
          b.type === "thinking",
      )
      .map((b) => b.thinking)
      .join("") ||
    resp.content
      .flatMap((block) => {
        if (block.type !== "opaque") return [];
        const content = block.raw.content;
        if (!Array.isArray(content)) return [];
        return content
          .filter(
            (part): part is Record<string, unknown> =>
              !!part && typeof part === "object" && !Array.isArray(part),
          )
          .map((part) =>
            part.type === "refusal" && typeof part.refusal === "string"
              ? part.refusal
              : "",
          );
      })
      .join("");
  const usage: AnthropicUsage | null = resp.usage
    ? {
        input_tokens: resp.usage.inputTokens,
        output_tokens: resp.usage.outputTokens,
        cache_read_input_tokens: resp.usage.cacheReadInputTokens,
        cache_creation_input_tokens: resp.usage.cacheCreationInputTokens,
      }
    : null;
  return { text: workerText || null, usage, model: resp.model || null };
}

/**
 * Summarize an upstream worker response body for diagnostics when the parser
 * found no usable text. Reports which fields were present (content vs the
 * reasoning/thinking fallbacks), the finish_reason, and a truncated body
 * shape summary without dumping response values. This lets us
 * classify an empty `no-response` as a genuinely empty completion, a
 * reasoning-field shape we don't read, or a truncation (`finish_reason:
 * "length"`), instead of an opaque failure.
 */
/**
 * Best-effort extraction of the upstream finish/stop reason from a worker
 * response body. Reads, in order: OpenAI `choices[0].finish_reason`, the
 * aggregator-specific `choices[0].native_finish_reason` (OpenRouter surfaces the
 * true upstream reason here — e.g. `MAX_TOKENS` — while sometimes leaving
 * `finish_reason` normalized or absent), then Anthropic top-level `stop_reason`.
 * Used to distinguish a *complete* empty response (model capability issue) from
 * a *truncated* one (`length`/`max_tokens` — a budget problem, not a capability
 * one). `isLengthTruncation` lower-cases the result so provider casing
 * (`MAX_TOKENS`) still matches.
 */
function extractFinishReason(rawData: unknown): string | undefined {
  try {
    const d = rawData as {
      choices?: Array<{
        finish_reason?: string;
        native_finish_reason?: string;
      }>;
      stop_reason?: string;
      status?: string;
      incomplete_details?: { reason?: string } | null;
    };
    const reason =
      d.choices?.[0]?.finish_reason ??
      d.choices?.[0]?.native_finish_reason ??
      d.stop_reason ??
      (d.status === "incomplete" &&
      d.incomplete_details?.reason === "max_output_tokens"
        ? "length"
        : d.status === "incomplete"
          ? d.incomplete_details?.reason
          : undefined) ??
      undefined;
    return reason === "refusal" ? normalizeAnthropicStopReason(reason) : reason;
  } catch {
    return undefined;
  }
}

/**
 * True when a finish/stop reason indicates the model hit its OUTPUT BUDGET
 * (rather than finishing, being content-filtered, or making a tool call).
 * Matches the OpenAI (`length`), Anthropic (`max_tokens`), and Gemini-style
 * (`max_output_tokens` / `MAX_TOKENS`) spellings surfaced by
 * `extractFinishReason` (which reads `finish_reason`, then the aggregator
 * `native_finish_reason`, then `stop_reason`). Case-insensitive so a provider's
 * upstream casing still matches. A budget truncation is retryable with a larger
 * budget; a genuine `stop`/`end_turn` empty is a capability signal.
 */
function isLengthTruncation(finishReason: string | undefined): boolean {
  if (!finishReason) return false;
  const r = finishReason.toLowerCase();
  return r === "length" || r === "max_tokens" || r === "max_output_tokens";
}

/**
 * The largest output budget a `finish_reason:"length"` retry may request for a
 * given model: the model's own `limit.output` when known, else a conservative
 * absolute cap. Bounds cost/latency and guarantees the retry never exceeds what
 * the model can actually emit (which would just truncate again).
 */
function workerLengthRetryCeiling(modelID: string): number {
  const out = getModelEntrySync(modelID).limit?.output;
  return out && out > 0
    ? Math.min(out, WORKER_LENGTH_RETRY_CAP)
    : WORKER_LENGTH_RETRY_CAP;
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

export function describeEmptyWorkerResponse(rawData: unknown): string {
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
      fields.push(`blocks:${d.content.length}`);
    }
  } catch {
    // ignore — best-effort introspection
  }
  const knownFinishReasons = new Set([
    "stop",
    "end_turn",
    "length",
    "max_tokens",
    "max_output_tokens",
    "content_filter",
    "tool_calls",
    "tool_use",
  ]);
  return (
    `fields=[${fields.join(",") || "none"}]` +
    ` finish_reason=${finishReason && knownFinishReasons.has(finishReason) ? finishReason : finishReason ? "unknown" : "n/a"}`
  );
}

// ---------------------------------------------------------------------------
// LLMClient factory
// ---------------------------------------------------------------------------

/**
 * Last error from a prompt() call that returned null. The LLMClient interface
 * is `prompt(): string | null` — the null is opaque to callers. To preserve
 * the interface while still surfacing the underlying error in the chain's
 * diagnostic, we record the LAST non-empty error here and expose it via
 * `getLastWorkerError()`. Reset at the START of every prompt() call.
 *
 * Single-threaded CLI assumption: the import command is sequential, so the
 * "last" writer is also the "only" writer per chain run.
 *
 * The chain's diagnostic reads this AFTER the loop (after every prompt call
 * has returned). If the loop produces 0 created/0 updated (every call returned
 * null) and lastError is set, the user sees a concrete reason instead of
 * the opaque "did not answer".
 */
let lastWorkerError: string | undefined;

export type PromptFailureCode =
  | "no-auth"
  | "auth-rejected"
  | "route-unavailable"
  | "protocol-mismatch"
  | "model-unsupported"
  | "api-unsupported"
  | "rate-limited"
  | "timeout"
  | "network-error"
  | "invalid-response"
  | "response-too-large"
  | "incomplete-response"
  | "empty-response"
  | "insufficient-credit"
  | "data-policy"
  | "worker-incapable"
  | "aborted"
  | "upstream-error";

export type PromptOutcome =
  | {
      kind: "success";
      text: string;
      model: string;
      protocol: WorkerProtocol;
      attempts: number;
    }
  | {
      kind: "failure";
      code: PromptFailureCode;
      message: string;
      retryable: boolean;
      model: string;
      protocol?: WorkerProtocol;
      httpStatus?: number;
      finishReason?: string;
      attempts: number;
    };

type PromptOptions = NonNullable<Parameters<LLMClient["prompt"]>[2]>;

export interface GatewayLLMClient extends LLMClient {
  promptDetailed(
    system: string,
    user: string,
    opts?: PromptOptions,
  ): Promise<PromptOutcome>;
}

type PromptDiagnosticContext = {
  attempts: number;
  model: { providerID: string; modelID: string };
  protocol?: WorkerProtocol;
  failure?: Extract<PromptOutcome, { kind: "failure" }>;
};

const promptDiagnosticStorage =
  new AsyncLocalStorage<PromptDiagnosticContext>();

function recordPromptDispatch(
  model: { providerID: string; modelID: string },
  protocol: WorkerProtocol,
): void {
  const context = promptDiagnosticStorage.getStore();
  if (!context) return;
  context.attempts++;
  context.model = model;
  context.protocol = protocol;
}

function recordPromptFailure(
  code: PromptFailureCode,
  message: string,
  options: {
    retryable?: boolean;
    model?: { providerID: string; modelID: string };
    protocol?: WorkerProtocol;
    httpStatus?: number;
    finishReason?: string;
    preserveExisting?: boolean;
  } = {},
): void {
  if (!options.preserveExisting || !lastWorkerError) lastWorkerError = message;
  const context = promptDiagnosticStorage.getStore();
  if (!context || (options.preserveExisting && context.failure)) return;
  const model = options.model ?? context.model;
  const protocol = options.protocol ?? context.protocol;
  context.failure = {
    kind: "failure",
    code,
    message: message.slice(0, 400),
    retryable: options.retryable ?? false,
    model: `${model.providerID}/${model.modelID}`,
    ...(protocol ? { protocol } : {}),
    ...(options.httpStatus != null ? { httpStatus: options.httpStatus } : {}),
    ...(options.finishReason ? { finishReason: options.finishReason } : {}),
    attempts: context.attempts,
  };
}

/** Read the last recorded error from a prompt() call that returned null. */
export function getLastWorkerError(): string | undefined {
  return lastWorkerError;
}

/** Test/utility hook — reset state between explicit runs. */
export function _clearLastWorkerError(): void {
  lastWorkerError = undefined;
}

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
): GatewayLLMClient {
  const hasDedicatedKey = opts?.dedicatedWorkerKey === true;
  // Configured GCP project for Vertex workers (else derived from ADC at call
  // time). Threaded so an explicit LORE_VERTEX_PROJECT (without GOOGLE_CLOUD_*)
  // is honored — the session base URL carries the region but never the project.
  const factoryVertexProject = opts?.vertexProject;
  const client: GatewayLLMClient = {
    async prompt(system, user, opts) {
      // Reset at the START of every call so callers see only the last
      // non-thrown failure from THIS call, not a stale one from a prior
      // successful or different-failure call.
      lastWorkerError = undefined;
      // `model` is mutable: on a 400 model-not-supported the retry loop swaps
      // in a same-provider backup. Protocol is still model-dependent (Copilot
      // serves GPT-5.6 on Responses and gpt-5-mini on Chat Completions), so a
      // swap must resolve a fresh protocol, target, and request.
      let model = opts?.model ?? defaultModel;

      // Skip models already known to produce no usable worker output. Two
      // kinds of "incapable" verdict apply:
      //   - per-worker capability (a model that can distill but not curate) —
      //     scoped to opts.workerID;
      //   - account-wide model-not-supported (a 400 from the fallback path
      //     below, marked with the default ANY_WORKER scope) — the model is
      //     unavailable on this plan for EVERY worker kind.
      // A candidate is unusable if EITHER verdict is set.
      const candidateBlocked = (c: { providerID: string; modelID: string }) =>
        isWorkerIncapable(c.providerID, c.modelID, opts?.workerID) ||
        isWorkerIncapable(c.providerID, c.modelID);

      // Advance PAST any blocklisted candidate to the first usable same-provider
      // backup: once one chunk's model-not-supported 400 has blocklisted the
      // preferred model (markWorkerIncapable below), every later chunk re-enters
      // here with that same preferred model. Without this hop it would be
      // skipped outright and the whole backlog would produce nothing, even
      // though a working backup exists — so pick up where the fallback left off
      // instead of re-failing the swap every chunk. Data stays recallable if
      // none is usable.
      for (const cand of workerModelCandidates(model)) {
        if (!candidateBlocked(cand)) {
          model = cand;
          break;
        }
      }
      if (candidateBlocked(model)) {
        recordPromptFailure(
          "model-unsupported",
          `all ${diagnosticToken(model.providerID)} worker model candidates blocked (likely auth, model-not-supported, or worker-incapable)`,
          { model },
        );
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
        opts?.upstreamProviderID !== undefined &&
        workerProvidersEquivalent(opts.upstreamProviderID, model.providerID);
      let protocol = resolveWorkerProtocol(
        model.providerID,
        sameProviderAsSession ? opts?.protocol : undefined,
        model.modelID,
        // Only inspect the session URL for same-provider workers. A foreign
        // `/backend-api` URL must not change the model provider's protocol.
        sameProviderAsSession ? upstreamOverride : undefined,
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
      let credentialProviderID = model.providerID;
      let cred: AuthCredential | null = null;
      for (const providerID of workerProviderAliasIDs(model.providerID)) {
        if (!workerProviderSupportsProtocol(providerID, protocol)) continue;
        cred = getAuth(opts?.sessionID, providerID);
        if (cred) {
          credentialProviderID = providerID;
          break;
        }
      }
      cred ??= protocol === "vertex" ? { scheme: "bearer", value: "" } : null;
      if (!cred) {
        log.warn("no auth credentials available for worker call");
        recordWorkerFailure(
          opts?.sessionID ?? "_unknown",
          opts?.workerID ?? "unknown",
          "no-auth",
        );
        recordPromptFailure(
          "no-auth",
          `no auth credentials available for ${diagnosticToken(model.providerID)} (set LORE_WORKER_API_KEY, ANTHROPIC_API_KEY, or similar)`,
          { model, protocol },
        );
        return null;
      }
      let target = resolveTarget(
        upstreams,
        protocol,
        upstreamOverride,
        model.providerID,
        opts?.upstreamProviderID,
      );
      // Mutable across the retry loop: a `finish_reason:"length"` empty
      // completion bumps this and rebuilds the request once (see the empty-
      // response block). Starts at the caller's budget or the worker default.
      //
      // Reasoning-headroom floor (protocols with NO thinking-suppression lever):
      // distillation/curation workers pass tiny raw budgets (~1–8K) and no
      // explicit effort, but aggregators (OpenRouter) route reasoning models
      // (anthropic/claude-sonnet-5) that reason REGARDLESS — burning the budget
      // on hidden reasoning and returning empty `finish_reason:"length"`. The
      // Anthropic/Vertex builders suppress this by sending
      // `thinking:{type:"disabled"}` (see `effectiveDisableThinking`), so they
      // need no floor; the OpenAI Chat/Responses and native-Gemini builders
      // have no such lever (Gemini 2.5 reasons by default and counts thinking against
      // `maxOutputTokens`), so we raise the budget to the reasoning floor here.
      // Applied to the LOOP variable (not just the builder) so the floored value
      // is the retry's baseline — a subsequent `finish_reason:"length"` bumps
      // from the effective budget, never from the tiny raw one. Clamped to the
      // model's output limit. `off`/undefined effort + non-reasoning model → 0
      // floor → caller budget unchanged.
      const floorsReasoningBudget =
        target.protocol === "openai" ||
        target.protocol === "openai-responses" ||
        target.protocol === "gemini";
      const rawMaxTokens = opts?.maxTokens ?? DEFAULT_WORKER_MAX_TOKENS;
      const outputTokenCeiling = workerLengthRetryCeiling(model.modelID);
      const reasoningFloor = floorsReasoningBudget
        ? Math.min(
            workerReasoningHeadroomFloor(model, opts?.reasoningEffort),
            outputTokenCeiling,
          )
        : 0;
      let maxTokens = Math.min(
        Math.max(rawMaxTokens, reasoningFloor),
        outputTokenCeiling,
      );

      // Cross-provider fail-closed: the worker model's provider has no route
      // URL (unknown provider, or a local provider missing its explicit
      // upstream). We must NOT fall back to the session's foreign endpoint —
      // that's the exact collusion that caused the minimax→Anthropic 401 loop.
      // Skip the call, record it, and soft-pause so it doesn't re-fire.
      if (target.routeUnavailable || !target.url) {
        log.warn(
          `worker cross-provider: no route for model provider="${diagnosticToken(model.providerID)}" ` +
            `(model=${diagnosticToken(model.modelID)}, worker=${diagnosticToken(opts?.workerID)}, ` +
            `session=${opts?.sessionID?.slice(0, 16) ?? "none"}) — skipping`,
        );
        recordWorkerFailure(
          opts?.sessionID ?? "_unknown",
          opts?.workerID ?? "unknown",
          "cross-provider",
        );
        if (opts?.sessionID) markWorkerPaused(opts.sessionID);
        recordPromptFailure(
          "route-unavailable",
          `no upstream route for ${diagnosticToken(model.providerID)} — provider is unknown or unconfigured (check LORE_*_URL or models.dev cache)`,
          { model, protocol },
        );
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
            `worker protocol mismatch: ${target.protocol} target with non-Anthropic API key — skipping ` +
              `(model=${diagnosticToken(model.modelID)}, worker=${diagnosticToken(opts?.workerID)})`,
          );
          recordWorkerFailure(
            opts?.sessionID ?? "_unknown",
            opts?.workerID ?? "unknown",
            "protocol-mismatch",
          );
          recordPromptFailure(
            "protocol-mismatch",
            `protocol mismatch: ${target.protocol} target but credential is not an Anthropic key (set ANTHROPIC_API_KEY or use an anthropic/* model)`,
            { model, protocol: target.protocol },
          );
          return null;
        }
        if (
          (target.protocol === "openai" ||
            target.protocol === "openai-responses" ||
            target.protocol === "openai-codex-responses") &&
          isAnthropicKey
        ) {
          log.warn(
            `worker protocol mismatch: ${target.protocol} target with Anthropic API key — skipping ` +
              `(model=${diagnosticToken(model.modelID)}, worker=${diagnosticToken(opts?.workerID)})`,
          );
          recordWorkerFailure(
            opts?.sessionID ?? "_unknown",
            opts?.workerID ?? "unknown",
            "protocol-mismatch",
          );
          recordPromptFailure(
            "protocol-mismatch",
            `protocol mismatch: ${target.protocol} target but credential is an Anthropic key (set OPENAI_API_KEY or use an anthropic/* model)`,
            { model, protocol: target.protocol },
          );
          return null;
        }
      }

      // Resolve the effective sampling temperature. It is omitted upfront when
      // models.dev marks the model as not accepting a non-default `temperature`
      // (the deprecated-sampling generation: sonnet-5, opus-4.7+, gpt-5, o3 …)
      // OR when we've already learned it at runtime from a 400 — so we don't
      // burn a wasted round-trip. A runtime-learned 400 below also flips this to
      // undefined for the retry (the offline/models.dev-gap safety net).
      let effectiveTemperature =
        isTemperatureUnsupportedModel(model) ||
        modelRejectsTemperatureByData(model.modelID)
          ? undefined
          : opts?.temperature;

      // Resolve whether to disable thinking. Adaptive thinking is ON BY DEFAULT
      // on the newest generation (claude-sonnet-5 today) and otherwise burns the
      // `max_tokens` budget on a thinking block, starving the visible text and
      // yielding an empty worker response. `workerThinkingOnByDefault` decides
      // this data-drivenly from models.dev `reasoning_options` (with a Claude-id
      // fallback when the data is unavailable). Gated to the Anthropic Messages
      // wire protocols — "anthropic" (direct + Bedrock mantle) and "vertex" —
      // the only builders that emit the `thinking` field. A model observed to
      // reject the param gets it omitted upfront; a runtime-learned 400 below
      // flips this to false for the retry.
      let effectiveDisableThinking =
        (target.protocol === "anthropic" || target.protocol === "vertex") &&
        workerThinkingOnByDefault(model) &&
        !isThinkingUnsupportedModel(model);

      // Reasoning effort (a cost/depth dial). When set to a non-`off` value the
      // builders enable native reasoning (OpenAI reasoning_effort / Anthropic
      // thinking budget) — and the Anthropic/Vertex builders let it override
      // effectiveDisableThinking. `off`/undefined preserves prior behavior.
      const requestedReasoningEffort = opts?.reasoningEffort;
      let reasoningEffort = requestedReasoningEffort;
      if (
        requestedReasoningEffort === "off" &&
        target.protocol === "openai-responses" &&
        reasoningNoneUnsupportedTargets.has(
          reasoningNoneCapabilityKey(target, model),
        )
      ) {
        reasoningEffort = undefined;
      }

      // The credential in effect for the CURRENT attempt. Starts as `cred`; an
      // auth-error refresh reassigns it so every later rebuild in the retry loop
      // (e.g. the temperature-strip rebuild) signs with the fresh key rather
      // than the stale one that just 401'd. Typed non-null (assigned only from
      // non-null values) so the closure keeps the `if (!cred)` guard's narrowing.
      let activeCred: AuthCredential = cred;

      // One deadline covers async request construction (including Vertex ADC
      // discovery/token minting), every fetch, every retry rebuild, and backoff.
      const deadlineController = new AbortController();
      const deadlineTimer = setTimeout(() => {
        deadlineController.abort(
          new DOMException("Worker request deadline exceeded", "TimeoutError"),
        );
      }, WORKER_REQUEST_TIMEOUT_MS);
      const requestSignal = opts?.signal
        ? AbortSignal.any([opts.signal, deadlineController.signal])
        : deadlineController.signal;

      const promptSourceBytes =
        Buffer.byteLength(system) + Buffer.byteLength(user);
      if (promptSourceBytes > MAX_WORKER_PROMPT_SOURCE_BYTES) {
        log.warn(
          `worker prompt rejected before serialization: prompt_bytes=${promptSourceBytes} ` +
            `limit_bytes=${MAX_WORKER_PROMPT_SOURCE_BYTES}`,
        );
        recordWorkerFailure(
          opts?.sessionID ?? "_unknown",
          opts?.workerID ?? "unknown",
          "upstream-error",
        );
        lastWorkerError = `worker prompt exceeded ${MAX_WORKER_PROMPT_SOURCE_BYTES} byte limit`;
        clearTimeout(deadlineTimer);
        return null;
      }

      const buildCurrentRequest = async () =>
        enforceWorkerRequestLimit(
          await buildWorkerRequest(
            target,
            activeCred,
            model,
            system,
            user,
            maxTokens,
            opts?.sessionID,
            effectiveTemperature,
            factoryVertexProject,
            effectiveDisableThinking,
            reasoningEffort,
            requestSignal,
          ),
        );

      // Build and cap the serialized body before opening a connection. The cap
      // is re-applied by every request rebuild below (auth/model/param retries).
      let req: Awaited<ReturnType<typeof buildCurrentRequest>>;
      try {
        req = await buildCurrentRequest();
      } catch (error) {
        if (requestSignal.aborted) {
          clearTimeout(deadlineTimer);
          throw requestSignal.reason;
        }
        if (!(error instanceof WorkerRequestTooLargeError)) {
          clearTimeout(deadlineTimer);
          throw error;
        }
        log.warn(
          `worker request rejected before fetch: request_bytes=${error.bytes} ` +
            `limit_bytes=${MAX_WORKER_REQUEST_BYTES}`,
        );
        recordWorkerFailure(
          opts?.sessionID ?? "_unknown",
          opts?.workerID ?? "unknown",
          "upstream-error",
        );
        lastWorkerError = error.message;
        clearTimeout(deadlineTimer);
        return null;
      }

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
            name: `chat ${diagnosticToken(model.modelID)}`,
            attributes: {
              "gen_ai.operation.name": "chat",
              "gen_ai.request.model": diagnosticToken(model.modelID),
              "gen_ai.provider.name": diagnosticToken(target.providerName),
              "lore.worker_id": diagnosticToken(opts?.workerID),
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
            // Strip the thinking param at most once per call (runtime fallback
            // for a "thinking is unsupported" 400 — see below).
            let thinkingStripped = false;
            // Some Responses-compatible providers reject explicit
            // `reasoning.effort:"none"`. Retry once with omission, while the
            // default Copilot path remains explicit so `off` really means off.
            let reasoningNoneStripped = false;
            // Retry an API/model mismatch once through the alternate OpenAI API.
            let alternateProtocolRetried = false;
            // Raise the output budget at most once per call after an empty
            // `finish_reason:"length"` truncation (a reasoning model that spent
            // its whole allowance on hidden reasoning). See the empty-response
            // block below.
            let lengthRetried = false;
            // Same-provider backup models to try when the current one is
            // unavailable on the account/plan (400 model-not-supported). Seeded
            // from workerModelCandidates minus the active model and any already
            // blocklisted (incapable) candidate; each unsupported-model 400 pops
            // the next one.
            const modelFallbacks = workerModelCandidates(model)
              .slice(1)
              .filter(
                (c) => c.modelID !== model.modelID && !candidateBlocked(c),
              );
            // Resolve the retry budget once per call (not per attempt) — the
            // value can't change mid-loop and re-reading the env each iteration
            // is wasteful.
            const maxRetries = maxRetriesFor();

            const retryPostHeaderTransportFailure = async (
              error: SSEStreamTransportError,
              response: Response,
              attempt: number,
            ): Promise<void> => {
              cancelWorkerResponseForRetry(response, error);
              if (requestSignal.aborted) throw requestSignal.reason;
              if (attempt >= maxRetries) {
                throw new WorkerTransportFailureError(error);
              }
              const delay = backoffMs(attempt, null);
              retryCount++;
              totalDelayMs += delay;
              const code = transportErrorCode(error);
              log.warn(
                `worker response transport failure ` +
                  `(kind=${transportErrorKind(error)}${code ? ` code=${code}` : ""}, ` +
                  `attempt=${attempt + 1}/${maxRetries + 1}, ` +
                  `origin=${sanitizedWorkerOrigin(req.url)}), retrying in ${delay}ms`,
              );
              await abortableSleep(delay, requestSignal);
            };

            // Retry loop for transient errors (429, 5xx)
            for (let attempt = 0; ; attempt++) {
              let response: Response;
              try {
                recordPromptDispatch(model, target.protocol);
                response = await responseAgainstAbort(
                  () =>
                    upstreamFetch(req.url, {
                      method: "POST",
                      headers: req.headers,
                      signal: requestSignal,
                      // The request body may carry `thinking:{type:"disabled"}` for
                      // Claude workers (built above) to SUPPRESS thinking — it never
                      // ENABLES it. opts.thinking is not forwarded.
                      body: req.body,
                    }),
                  requestSignal,
                );
              } catch (e) {
                if (opts?.signal?.aborted) throw opts.signal.reason;
                if (requestSignal.aborted) throw requestSignal.reason;
                // Network/fetch error — retry if attempts remain
                if (attempt < maxRetries) {
                  const delay = backoffMs(attempt, null);
                  retryCount++;
                  totalDelayMs += delay;
                  const code = transportErrorCode(e);
                  log.warn(
                    `worker request transport failure ` +
                      `(kind=${transportErrorKind(e)}${code ? ` code=${code}` : ""}, ` +
                      `attempt=${attempt + 1}/${maxRetries + 1}, ` +
                      `origin=${sanitizedWorkerOrigin(req.url)}), retrying in ${delay}ms`,
                  );
                  await abortableSleep(delay, requestSignal);
                  continue;
                }
                // Enrich span before rethrowing
                if (retryCount > 0) {
                  span.setAttribute("lore.retry.count", retryCount);
                  span.setAttribute("lore.retry.total_delay_ms", totalDelayMs);
                }
                throw new WorkerTransportFailureError(e);
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
                // Same deferred-learning for the `thinking` param: only mark the
                // model on a 2xx after stripping, so a regex false-positive on an
                // unrelated 400 can't permanently mislabel a thinking-capable
                // model.
                if (thinkingStripped) markThinkingUnsupported(model);

                // Guard: Codex workers request streaming, and some other
                // providers stream even when stream:false was sent — sometimes
                // WITHOUT the text/event-stream content-type.
                // Sniff the body: if it's SSE, accumulate the whole stream via
                // the protocol's accumulator (multi-chunk safe) instead of
                // JSON-parsing it (which would throw on "data: {...}" / "event:
                // ..." text — LOREAI-GATEWAY-38 / -1P). A streamed body is a
                // success, so the JSON error-envelope check below never applies
                // to it (bodyErrCode stays null → the block is skipped).
                const upstreamOrigin = sanitizedWorkerOrigin(req.url);
                const contentType = response.headers.get("content-type") ?? "";
                const rejectInvalidWorkerBody = (error: unknown): null => {
                  const detail = safeWorkerBodyErrorDetail(error);
                  log.error(
                    `worker upstream returned invalid ${target.protocol} response — ${detail}` +
                      ` — upstream=${upstreamOrigin}` +
                      ` model=${diagnosticToken(model.providerID)}/${diagnosticToken(model.modelID)}` +
                      ` worker=${diagnosticToken(opts?.workerID)}` +
                      ` session=${opts?.sessionID?.slice(0, 16) ?? "none"}`,
                  );
                  span.setStatus({
                    code: 2,
                    message: "invalid worker response",
                  });
                  recordWorkerFailure(
                    opts?.sessionID ?? "_unknown",
                    opts?.workerID ?? "unknown",
                    "upstream-error",
                  );
                  recordPromptFailure(
                    error instanceof WorkerResponseTooLargeError
                      ? "response-too-large"
                      : error instanceof IncompleteWorkerResponseError
                        ? "incomplete-response"
                        : "invalid-response",
                    `${diagnosticToken(model.providerID)}/${diagnosticToken(model.modelID)}: invalid ${target.protocol} response (${detail})`,
                    {
                      model,
                      protocol: target.protocol,
                      ...(error instanceof IncompleteWorkerResponseError &&
                      error.reason
                        ? { finishReason: error.reason }
                        : {}),
                    },
                  );
                  return null;
                };

                let successBody: WorkerSuccessBody;
                let semanticContentConsumed = false;
                try {
                  successBody = await inspectWorkerSuccessBody(
                    response,
                    requestSignal,
                    () => {
                      semanticContentConsumed = true;
                    },
                  );
                } catch (error) {
                  if (opts?.signal?.aborted) throw opts.signal.reason;
                  if (requestSignal.aborted) throw requestSignal.reason;
                  if (error instanceof SSEStreamTransportError) {
                    if (semanticContentConsumed) {
                      throw new WorkerTransportFailureError(error);
                    }
                    await retryPostHeaderTransportFailure(
                      error,
                      response,
                      attempt,
                    );
                    continue;
                  }
                  return rejectInvalidWorkerBody(error);
                }
                const isSSE = successBody.isSSE;
                const bodyText = successBody.isSSE ? "" : successBody.text;
                let rawData: Record<string, unknown> = {};
                if (!successBody.isSSE) {
                  try {
                    const parsedBody: unknown = JSON.parse(bodyText);
                    if (
                      !parsedBody ||
                      typeof parsedBody !== "object" ||
                      Array.isArray(parsedBody)
                    ) {
                      throw new Error(
                        "worker JSON response root must be an object",
                      );
                    }
                    rawData = parsedBody as Record<string, unknown>;
                  } catch (error) {
                    return rejectInvalidWorkerBody(error);
                  }
                }

                // A 2xx whose body is a provider error envelope (e.g. OpenRouter
                // surfacing an upstream timeout as HTTP 200 + {error:{code:504}})
                // is NOT a usable completion. The status-keyed transient handling
                // below never sees it, and parseWorkerResponse would yield no text
                // → it would be miscounted as an empty/incapable response. Route a
                // transient embedded code into the SAME retry/backoff ladder as a
                // real HTTP-level transient. Non-transient embedded codes fall
                // through to the normal empty-response handling (no regression). #899
                const bodyErrCode = isSSE
                  ? null
                  : extractBodyErrorCode(rawData);
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
                        `— model=${diagnosticToken(model.providerID)}/${diagnosticToken(model.modelID)} ` +
                        `worker=${diagnosticToken(opts?.workerID)} origin=${upstreamOrigin}`,
                    );
                    cancelWorkerResponseForRetry(response, bodyErrCode);
                    await abortableSleep(delay, requestSignal);
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
                      `${maxRetries + 1} attempts — ` +
                      `model=${diagnosticToken(model.providerID)}/${diagnosticToken(model.modelID)} ` +
                      `worker=${diagnosticToken(opts?.workerID)} ` +
                      `session=${opts?.sessionID?.slice(0, 16) ?? "none"} ` +
                      `origin=${upstreamOrigin}`,
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
                        model: diagnosticToken(model.modelID),
                        workerID: diagnosticToken(opts?.workerID),
                        origin: upstreamOrigin,
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
                  recordPromptFailure(
                    bodyErrCode === 429 ? "rate-limited" : "upstream-error",
                    `HTTP 200 with embedded error code ${bodyErrCode} exhausted retries`,
                    {
                      retryable: true,
                      model,
                      protocol: target.protocol,
                      httpStatus: bodyErrCode,
                    },
                  );
                  recordWorkerFailure(
                    opts?.sessionID ?? "_unknown",
                    opts?.workerID ?? "unknown",
                    bodyErrCode === 429 ? "rate-limit" : "upstream-error",
                  );
                  return null;
                }

                // Data-policy error surfaced as an HTTP 200 error-envelope
                // (some aggregators return the upstream 404 body with a 200 wire
                // status — see the transient-envelope handling above). The
                // status-keyed 4xx branch never sees these, so mirror the
                // data-policy handling here.
                //
                // 🔴 Gate on a REAL embedded error code (`bodyErrCode === 404`),
                // NOT `bodyErrCode ?? 404`. A normal successful completion has
                // `bodyErrCode === null`; the `?? 404` fallback would then run
                // the phrase check against ordinary assistant text and
                // FALSE-POSITIVE blocklist a model whenever the reply happened
                // to mention "no endpoints … data policy" (e.g. the model
                // explaining OpenRouter's own error). An HTTP-200 envelope is
                // only a data-policy failure when it actually carries the 404
                // error code AND the data-policy phrase. (Seer #1407.)
                if (
                  !isSSE &&
                  bodyErrCode === 404 &&
                  isDataPolicyBlocked404(bodyErrCode, bodyText)
                ) {
                  log.warn(
                    `worker model ${diagnosticToken(model.providerID)}/${diagnosticToken(model.modelID)} ` +
                      `blocked by account data policy ` +
                      `(HTTP 200 error-envelope) — blocklisting and re-resolving ` +
                      `(worker=${diagnosticToken(opts?.workerID)}, ` +
                      `session=${opts?.sessionID?.slice(0, 16) ?? "none"}, ` +
                      `origin=${upstreamOrigin})`,
                  );
                  markWorkerIncapable(model.providerID, model.modelID);
                  if (model.modelID.endsWith(":free")) {
                    markFreeModelsDataBlocked(model.providerID);
                  }
                  span.setStatus({
                    code: 2,
                    message: "data-policy (HTTP 200 envelope)",
                  });
                  recordWorkerFailure(
                    opts?.sessionID ?? "_unknown",
                    opts?.workerID ?? "unknown",
                    "data-policy",
                  );
                  recordPromptFailure(
                    "data-policy",
                    `HTTP 200/404: data policy blocked — ${diagnosticToken(model.providerID)}/${diagnosticToken(model.modelID)} unavailable (account has not opted in)`,
                    { model, protocol: target.protocol, httpStatus: 404 },
                  );
                  return null;
                }

                // Parse response based on protocol
                // SSE → accumulate the full stream; JSON → parse the body.
                // Capture the SSE stop reason: for a streamed body `rawData` is
                // `{}`, so extractFinishReason(rawData) can't see the truncation
                // — the accumulated GatewayResponse.stopReason is the only place
                // the finish reason survives (OpenAI SSE maps `length` →
                // `max_tokens`). Without this the length-retry below is
                // unreachable for providers that stream even when stream:false
                // was requested (ChatGPT/Copilot/Codex, DeepSeek). (Seer #1413.)
                let sseStopReason: string | undefined;
                let parsed: {
                  text: string | null;
                  usage: AnthropicUsage | null;
                  model: string | null;
                };
                if (successBody.isSSE) {
                  let gwResp: GatewayResponse;
                  try {
                    gwResp = await accumulateWorkerSSE(
                      target.protocol,
                      successBody.response,
                      requestSignal,
                      () => {
                        semanticContentConsumed = true;
                      },
                    );
                  } catch (error) {
                    if (opts?.signal?.aborted) throw opts.signal.reason;
                    if (requestSignal.aborted) throw requestSignal.reason;
                    if (error instanceof SSEStreamTransportError) {
                      if (semanticContentConsumed) {
                        throw new WorkerTransportFailureError(error);
                      }
                      await retryPostHeaderTransportFailure(
                        error,
                        response,
                        attempt,
                      );
                      continue;
                    }
                    return rejectInvalidWorkerBody(error);
                  }
                  sseStopReason = gwResp.stopReason;
                  parsed = gatewayResponseToWorkerResult(gwResp);
                } else {
                  try {
                    parsed = parseWorkerResponse(target.protocol, rawData);
                  } catch (error) {
                    return rejectInvalidWorkerBody(error);
                  }
                }

                const finishReason = isSSE
                  ? sseStopReason
                  : extractFinishReason(rawData);

                // Provider completion metadata is authoritative. A truncated
                // semantic-judge answer can happen to be valid verdict JSON;
                // never accept it merely because it is non-empty and parseable.
                if (parsed.text && isLengthTruncation(finishReason)) {
                  return rejectInvalidWorkerBody(
                    new IncompleteWorkerResponseError(finishReason),
                  );
                }

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
                  // by old, non-consecutive empties. Scoped per worker: a usable
                  // distillation must NOT reset the curator's empty streak.
                  clearEmptyWorkerStreak(
                    model.providerID,
                    model.modelID,
                    opts?.workerID,
                  );
                  return parsed.text;
                }

                // Transport succeeded but the model returned no usable text.
                // Log WHAT came back so an empty no-response can be classified
                // (genuinely empty vs an unread field shape vs a length
                // truncation) instead of being opaque. The raw body is
                // otherwise discarded here. For SSE the finish reason lives on
                // the accumulated stream (rawData is `{}`), so prefer it.
                log.warn(
                  `worker empty response (HTTP ${response.status}, ct=${diagnosticContentKind(contentType)}) ` +
                    `— model=${diagnosticToken(model.providerID)}/${diagnosticToken(model.modelID)} ` +
                    `worker=${diagnosticToken(opts?.workerID)} ` +
                    `session=${opts?.sessionID?.slice(0, 16) ?? "none"} ` +
                    `— ${describeEmptyWorkerResponse(rawData)}`,
                );

                // Empty completion truncated on the OUTPUT BUDGET
                // (`finish_reason:"length"` / `stop_reason:"max_tokens"`): the
                // model spent its entire allowance on hidden reasoning and never
                // reached visible text. This is a budget problem, not a
                // capability one — retry ONCE with the budget multiplied (clamped
                // to the model's own output limit) so a capable reasoning model
                // gets room for both the reasoning pass and the answer. `maxTokens`
                // here is already the effective budget (the OpenAI reasoning floor
                // was applied at loop entry), so the multiply raises from the real
                // baseline, not the tiny raw budget. Rebuild via buildWorkerRequest
                // (not string-editing the body) so the OAuth billing signature is
                // recomputed. Bounded to a single retry per call: a model that
                // truncates even at its max output falls through to the normal
                // empty-response handling.
                const lengthRetryCeiling = workerLengthRetryCeiling(
                  model.modelID,
                );
                if (
                  !lengthRetried &&
                  isLengthTruncation(finishReason) &&
                  maxTokens < lengthRetryCeiling
                ) {
                  lengthRetried = true;
                  const bumped = Math.min(
                    maxTokens * WORKER_LENGTH_RETRY_MULTIPLIER,
                    lengthRetryCeiling,
                  );
                  log.warn(
                    `worker empty response was a budget truncation (finish_reason=${finishReason}) ` +
                      `— retrying once with max_tokens ${maxTokens} → ${bumped} ` +
                      `(model=${diagnosticToken(model.providerID)}/${diagnosticToken(model.modelID)}, ` +
                      `worker=${diagnosticToken(opts?.workerID)})`,
                  );
                  maxTokens = bumped;
                  req = await buildCurrentRequest();
                  // Re-apply a runtime beta strip if one already happened this
                  // call (rebuilding restores the freshly-built header set) —
                  // mirrors the temperature-strip rebuild below.
                  if (betaStripped) {
                    req = { ...req, headers: stripBetaHeaders(req.headers) };
                  }
                  retryCount++;
                  continue;
                }

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
                    opts?.workerID,
                  )
                ) {
                  recordWorkerFailure(
                    opts?.sessionID ?? "_unknown",
                    opts?.workerID ?? "unknown",
                    "worker-incapable",
                  );
                  recordPromptFailure(
                    "worker-incapable",
                    `worker incapable: ${diagnosticToken(model.providerID)}/${diagnosticToken(model.modelID)} produced no usable text`,
                    { model, protocol: target.protocol, finishReason },
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
                recordPromptFailure(
                  isLengthTruncation(finishReason)
                    ? "incomplete-response"
                    : "empty-response",
                  `${diagnosticToken(model.providerID)}/${diagnosticToken(model.modelID)}: no usable text in response (finish=${diagnosticFinishReason(finishReason)})`,
                  { model, protocol: target.protocol, finishReason },
                );
                return null;
              }

              // --- Auth error: 401/403 — mark stale, re-resolve, retry once ---
              if (AUTH_ERROR_CODES.has(response.status)) {
                await readWorkerResponseText(response, requestSignal);
                // Mark this provider's credential stale so resolveAuth()
                // falls through to global — but only for THIS provider,
                // not other providers on the same session. Requires a real
                // session ID (staleness is per-session state).
                if (opts?.sessionID) {
                  markAuthStale(opts.sessionID, credentialProviderID);
                } else {
                  // Session-less worker (e.g. entity-rebuild) — mark the
                  // global fallback as stale so resolveAuth(undefined)
                  // returns null instead of the same rejected token.
                  // Without this, session-less workers hammer indefinitely
                  // because markAuthStale requires a sessionID.
                  markGlobalAuthStale();
                }

                // Re-resolve: credential may have been refreshed by a concurrent client request
                const freshCred = getAuth(
                  opts?.sessionID,
                  credentialProviderID,
                );
                const credentialChanged =
                  !!freshCred && freshCred.value !== cred.value;
                if (credentialChanged && attempt === 0) {
                  // Credential changed — adopt it as the current credential so
                  // any subsequent rebuild (e.g. the temperature-strip retry)
                  // uses the fresh key, then rebuild request and retry once.
                  activeCred = freshCred;
                  log.info(
                    `worker auth error status=${response.status}, credential refreshed — retrying ` +
                      `(origin=${sanitizedWorkerOrigin(req.url)})`,
                  );
                  req = await buildCurrentRequest();
                  retryCount++;
                  continue;
                }

                // Only the terminal auth failure reaches worker health. A
                // rejected stale credential that refreshes successfully is an
                // intermediate attempt, not a failed worker call.
                recordWorkerFailure(
                  opts?.sessionID ?? "_unknown",
                  opts?.workerID ?? "unknown",
                  "auth-rejected",
                );

                // No fresh credential or retry also failed — bail.
                //
                // log.warn (not log.error) because 401/403 is expected,
                // user-actionable state, NOT an outage. Adm hit this in
                // Slack on 2026-07-30 with stale on-disk auth.json keys
                // — that's a config issue, not a gateway failure. The
                // chain's diagnostic already surfaces the actual HTTP
                // status to the user via getLastWorkerError() (PR
                // #1542/#1544); we don't need log.error to also scream.
                //
                log.warn(
                  `worker upstream auth error: status=${response.status}` +
                    ` origin=${sanitizedWorkerOrigin(req.url)}` +
                    ` model=${diagnosticToken(model.providerID)}/${diagnosticToken(model.modelID)}` +
                    ` cred=${cred.scheme} worker=${diagnosticToken(opts?.workerID)}` +
                    ` session=${opts?.sessionID?.slice(0, 16) ?? "none"}`,
                );
                Sentry.captureException(
                  new Error(
                    `Worker upstream auth error: HTTP ${response.status}`,
                  ),
                  {
                    fingerprint: [
                      "LOREAI-GATEWAY",
                      "worker-auth-error",
                      String(response.status),
                    ],
                    extra: {
                      status: response.status,
                      model: diagnosticToken(model.modelID),
                      workerID: diagnosticToken(opts?.workerID),
                      sessionID: opts?.sessionID?.slice(0, 16),
                      origin: sanitizedWorkerOrigin(req.url),
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
                recordPromptFailure(
                  "auth-rejected",
                  `HTTP ${response.status}: authentication rejected`,
                  {
                    model,
                    protocol: target.protocol,
                    httpStatus: response.status,
                  },
                );
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
                await readWorkerResponseText(response, requestSignal);
                log.warn(
                  `worker upstream insufficient credit: status=${response.status}` +
                    ` origin=${sanitizedWorkerOrigin(req.url)}` +
                    ` model=${diagnosticToken(model.providerID)}/${diagnosticToken(model.modelID)}` +
                    ` worker=${diagnosticToken(opts?.workerID)}` +
                    ` session=${opts?.sessionID?.slice(0, 16) ?? "none"}`,
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
                recordPromptFailure(
                  "insufficient-credit",
                  `HTTP ${response.status}: insufficient credit — add credits to your account or switch providers`,
                  {
                    model,
                    protocol: target.protocol,
                    httpStatus: response.status,
                  },
                );
                return null;
              }

              // Non-transient error — fail immediately, no retry
              if (!TRANSIENT_CODES.has(response.status)) {
                const text = await readWorkerResponseText(
                  response,
                  requestSignal,
                );

                // 400 + a beta-related complaint → the request carries a beta
                // header the model/subscription doesn't support. The upfront
                // filter (buildAnthropicWorkerRequest) strips the long-context
                // `context-1m` beta unconditionally for workers (issue #1571:
                // a 1M-capable worker model on a subscription auth without
                // usage credits 429s permanently because the beta rides along),
                // but this is the runtime safety net for any OTHER beta the
                // upstream refuses: retry ONCE with the long-context beta
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
                      `(model=${diagnosticToken(model.providerID)}/${diagnosticToken(model.modelID)}, ` +
                      `worker=${diagnosticToken(opts?.workerID)}, origin=${sanitizedWorkerOrigin(req.url)})`,
                  );
                  retryCount++;
                  continue;
                }

                if (
                  response.status === 400 &&
                  target.protocol === "openai-responses" &&
                  requestedReasoningEffort === "off" &&
                  reasoningEffort === "off" &&
                  !reasoningNoneStripped &&
                  isReasoningNoneUnsupported400(text)
                ) {
                  reasoningNoneStripped = true;
                  reasoningNoneUnsupportedTargets.add(
                    reasoningNoneCapabilityKey(target, model),
                  );
                  reasoningEffort = undefined;
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
                    effectiveDisableThinking,
                    reasoningEffort,
                  );
                  if (betaStripped) {
                    req = { ...req, headers: stripBetaHeaders(req.headers) };
                  }
                  log.warn(
                    `worker 400 rejects reasoning effort none — retrying once without the reasoning field ` +
                      `(model=${model.providerID}/${model.modelID}, worker=${opts?.workerID ?? "unknown"})`,
                  );
                  retryCount++;
                  continue;
                }

                const alternateProtocol = alternateProtocolRetried
                  ? null
                  : isUnsupportedApi400(response.status, text)
                    ? alternateProtocolForUnsupportedApi(target)
                    : null;
                if (alternateProtocol) {
                  alternateProtocolRetried = true;
                  protocol = alternateProtocol;
                  target = resolveTarget(
                    upstreams,
                    protocol,
                    upstreamOverride,
                    model.providerID,
                    opts?.upstreamProviderID,
                  );
                  effectiveDisableThinking = false;
                  reasoningEffort =
                    requestedReasoningEffort === "off" &&
                    protocol === "openai-responses" &&
                    reasoningNoneUnsupportedTargets.has(
                      reasoningNoneCapabilityKey(target, model),
                    )
                      ? undefined
                      : requestedReasoningEffort;
                  if (protocol === "openai") {
                    maxTokens = Math.max(
                      maxTokens,
                      Math.min(
                        workerReasoningHeadroomFloor(model, reasoningEffort),
                        workerLengthRetryCeiling(model.modelID),
                      ),
                    );
                  }
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
                    effectiveDisableThinking,
                    reasoningEffort,
                  );
                  log.warn(
                    `worker 400 reports API unsupported for model — retrying once via ${protocol} ` +
                      `(model=${model.providerID}/${model.modelID}, worker=${opts?.workerID ?? "unknown"})`,
                  );
                  retryCount++;
                  // A bounded route correction must not consume transient budget.
                  attempt--;
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
                  req = await buildCurrentRequest();
                  // Rebuilding restores the freshly-built header set, which
                  // resurrects a beta we may have already stripped at runtime.
                  // The upfront filter strips `context-1m` unconditionally for
                  // workers (issue #1571), so a 400 β-loop on that specific
                  // beta can't happen — but the runtime strip is still in
                  // place for any future beta the upstream rejects, and the
                  // `if (betaStripped)` latch re-applies it after the rebuild
                  // so a model that needed BOTH fixes doesn't regress into a
                  // beta-400 loop.
                  if (betaStripped) {
                    req = { ...req, headers: stripBetaHeaders(req.headers) };
                  }
                  log.warn(
                    `worker 400 reports temperature is unsupported — retrying once without the temperature param ` +
                      `(model=${diagnosticToken(model.providerID)}/${diagnosticToken(model.modelID)}, ` +
                      `worker=${diagnosticToken(opts?.workerID)}, origin=${sanitizedWorkerOrigin(req.url)})`,
                  );
                  retryCount++;
                  continue;
                }

                // 400 + a "thinking is unsupported" complaint → the model rejects
                // the `thinking:{type:"disabled"}` param we add for Claude workers
                // (a model that predates the thinking API, e.g. older claude-3.x).
                // Learn it so future calls omit the param upfront, then rebuild
                // THIS request without it and retry once. Rebuilt via
                // buildWorkerRequest (not string-editing req.body) so the OAuth
                // billing signature is recomputed over the new body. Bounded to
                // one retry per call; composes with the temperature/beta strips
                // above (each rebuild uses the current effective values).
                if (
                  response.status === 400 &&
                  !thinkingStripped &&
                  effectiveDisableThinking &&
                  isThinkingUnsupported400(text)
                ) {
                  thinkingStripped = true;
                  effectiveDisableThinking = false;
                  req = await buildCurrentRequest();
                  // Preserve a runtime beta strip across this rebuild (same
                  // reasoning as the temperature-strip path above).
                  if (betaStripped) {
                    req = { ...req, headers: stripBetaHeaders(req.headers) };
                  }
                  log.warn(
                    `worker 400 reports thinking is unsupported — retrying once without the thinking param ` +
                      `(model=${diagnosticToken(model.providerID)}/${diagnosticToken(model.modelID)}, ` +
                      `worker=${diagnosticToken(opts?.workerID)}, origin=${sanitizedWorkerOrigin(req.url)})`,
                  );
                  retryCount++;
                  continue;
                }

                // Data-policy 404: the selected worker model (typically an
                // OpenRouter `:free` model) is unavailable because the account
                // has not opted into the provider's data-collection policy.
                // This is a per-account availability fact about THIS model, not
                // an outage — retrying is futile. Blocklist the model (and, for
                // a `:free` model, the whole `:free` tier on this provider per
                // the "assume all :free collect data" directive) and classify
                // as `data-policy` so it does NOT feed the Sentry outage ladder
                // or credit-pause the session. Worker-model selection re-resolves
                // to a usable same-family sibling on the next pass; the next real
                // worker call against that sibling is the recovery probe.
                if (isDataPolicyBlocked404(response.status, text)) {
                  log.warn(
                    `worker model ${diagnosticToken(model.providerID)}/${diagnosticToken(model.modelID)} ` +
                      `blocked by account data policy (404) — ` +
                      `blocklisting and re-resolving (worker=${diagnosticToken(opts?.workerID)}, ` +
                      `session=${opts?.sessionID?.slice(0, 16) ?? "none"}, ` +
                      `origin=${sanitizedWorkerOrigin(req.url)})`,
                  );
                  markWorkerIncapable(model.providerID, model.modelID);
                  if (model.modelID.endsWith(":free")) {
                    markFreeModelsDataBlocked(model.providerID);
                  }
                  span.setStatus({
                    code: 2,
                    message: `HTTP ${response.status} (data-policy)`,
                  });
                  recordWorkerFailure(
                    opts?.sessionID ?? "_unknown",
                    opts?.workerID ?? "unknown",
                    "data-policy",
                  );
                  // Do NOT markWorkerPaused: the fix is re-resolution to a
                  // different model, not pausing the session's workers.
                  recordPromptFailure(
                    "data-policy",
                    `HTTP ${response.status}: data policy blocked — ${diagnosticToken(model.providerID)}/${diagnosticToken(model.modelID)} unavailable (account has not opted in)`,
                    {
                      model,
                      protocol: target.protocol,
                      httpStatus: response.status,
                    },
                  );
                  return null;
                }

                // 400 model-not-supported: the requested model is unavailable
                // on this account/plan (Copilot subscription tiers serve
                // different catalogs). This is a per-account capability fact,
                // not an outage — retrying the SAME model is futile. Blocklist
                // it and, if a same-provider backup remains, swap it in and
                // retry (rebuild via buildWorkerRequest so the OAuth billing
                // signature is recomputed over the new body). Bounded by the
                // finite candidate list. Only when NO backup remains do we fall
                // through to the generic failure below.
                if (
                  isModelUnsupported400(response.status, text) &&
                  modelFallbacks.length > 0
                ) {
                  markWorkerIncapable(model.providerID, model.modelID);
                  // length-checked above, so a value is guaranteed.
                  const next = modelFallbacks.shift() ?? model;
                  log.warn(
                    `worker model ${diagnosticToken(model.providerID)}/${diagnosticToken(model.modelID)} ` +
                      `not supported on this account (400) — ` +
                      `falling back to ${diagnosticToken(next.providerID)}/${diagnosticToken(next.modelID)} ` +
                      `(worker=${diagnosticToken(opts?.workerID)}, ` +
                      `session=${opts?.sessionID?.slice(0, 16) ?? "none"}, ` +
                      `origin=${sanitizedWorkerOrigin(req.url)})`,
                  );
                  model = next;
                  // Protocol and target are model-dependent even within one
                  // provider (GitHub Copilot serves gpt-5.6 on Responses but
                  // gpt-5-mini on Chat Completions). Re-resolve the complete
                  // route before rebuilding so URL, body, parser, and model
                  // controls all describe the fallback model.
                  protocol = resolveWorkerProtocol(
                    model.providerID,
                    sameProviderAsSession ? opts?.protocol : undefined,
                    model.modelID,
                    sameProviderAsSession ? upstreamOverride : undefined,
                  );
                  target = resolveTarget(
                    upstreams,
                    protocol,
                    upstreamOverride,
                    model.providerID,
                    opts?.upstreamProviderID,
                  );
                  if (target.routeUnavailable || !target.url) {
                    lastWorkerError = `no upstream route for ${diagnosticToken(model.providerID)} fallback`;
                    return null;
                  }
                  const fallbackFloorsReasoningBudget =
                    target.protocol === "openai" ||
                    target.protocol === "openai-responses" ||
                    target.protocol === "gemini";
                  const fallbackReasoningFloor = fallbackFloorsReasoningBudget
                    ? Math.min(
                        workerReasoningHeadroomFloor(
                          model,
                          opts?.reasoningEffort,
                        ),
                        workerLengthRetryCeiling(model.modelID),
                      )
                    : 0;
                  maxTokens = Math.min(
                    Math.max(rawMaxTokens, fallbackReasoningFloor),
                    workerLengthRetryCeiling(model.modelID),
                  );
                  effectiveTemperature =
                    isTemperatureUnsupportedModel(model) ||
                    modelRejectsTemperatureByData(model.modelID)
                      ? undefined
                      : opts?.temperature;
                  effectiveDisableThinking =
                    (target.protocol === "anthropic" ||
                      target.protocol === "vertex") &&
                    workerThinkingOnByDefault(model) &&
                    !isThinkingUnsupportedModel(model);
                  temperatureStripped = false;
                  thinkingStripped = false;
                  lengthRetried = false;
                  req = await buildCurrentRequest();
                  // Preserve any runtime beta strip across the rebuild (same
                  // reasoning as the temperature/thinking rebuilds above).
                  if (betaStripped) {
                    req = { ...req, headers: stripBetaHeaders(req.headers) };
                  }
                  retryCount++;
                  // A model swap is NOT a transient retry — it's a one-way walk
                  // down a finite candidate list (bounded by modelFallbacks
                  // shrinking). Don't let it consume the transient-error budget
                  // (`attempt < maxRetries`): decrement to cancel the `attempt++`
                  // the loop applies on `continue`, so the working backup keeps
                  // its full 429/5xx retry allowance.
                  attempt--;
                  continue;
                }

                log.error(
                  `worker upstream request failed: status=${response.status}` +
                    ` origin=${sanitizedWorkerOrigin(req.url)}` +
                    ` model=${diagnosticToken(model.providerID)}/${diagnosticToken(model.modelID)}` +
                    ` cred=${cred.scheme} worker=${diagnosticToken(opts?.workerID)}` +
                    ` session=${opts?.sessionID?.slice(0, 16) ?? "none"}`,
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
                recordPromptFailure(
                  isUnsupportedApi400(response.status, text)
                    ? "api-unsupported"
                    : isModelUnsupported400(response.status, text)
                      ? "model-unsupported"
                      : "upstream-error",
                  `HTTP ${response.status}: non-transient upstream error for ${diagnosticToken(model.providerID)}/${diagnosticToken(model.modelID)}`,
                  {
                    model,
                    protocol: target.protocol,
                    httpStatus: response.status,
                  },
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
                  `worker upstream status=${response.status} ` +
                    `(attempt ${attempt + 1}/${maxRetries + 1}, ` +
                    `origin=${sanitizedWorkerOrigin(req.url)}), ` +
                    `retrying in ${delay}ms` +
                    (retryAfter != null
                      ? ` (retry-after: ${Math.round(retryAfter / 1000)}s)`
                      : ""),
                );
                cancelWorkerResponseForRetry(response, response.status);
                await abortableSleep(delay, requestSignal);
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
              await readWorkerResponseText(response, requestSignal);
              const exhaustionMsg =
                `worker upstream request failed after ${maxRetries + 1} attempts:` +
                ` status=${response.status} origin=${sanitizedWorkerOrigin(req.url)}` +
                ` model=${diagnosticToken(model.providerID)}/${diagnosticToken(model.modelID)}` +
                ` cred=${cred.scheme} worker=${diagnosticToken(opts?.workerID)}` +
                ` session=${opts?.sessionID?.slice(0, 16) ?? "none"}`;
              if (urgent) {
                log.warn(exhaustionMsg);
              } else {
                log.error(exhaustionMsg);
              }

              // Capture as Sentry error for alerting
              Sentry.captureException(
                new Error(
                  `Worker upstream exhausted ${maxRetries + 1} retries: HTTP ${response.status}`,
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
                    model: diagnosticToken(model.modelID),
                    workerID: diagnosticToken(opts?.workerID),
                    origin: sanitizedWorkerOrigin(req.url),
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
              recordPromptFailure(
                response.status === 429 ? "rate-limited" : "upstream-error",
                `HTTP ${response.status}: transient upstream error exhausted retries`,
                {
                  retryable: true,
                  model,
                  protocol: target.protocol,
                  httpStatus: response.status,
                },
              );
              return null;
            }
          },
        );
      } catch (e) {
        // Preserve the caller's exact abort reason regardless of its class.
        if (opts?.signal?.aborted) throw opts.signal.reason;
        if (e instanceof DOMException && e.name === "TimeoutError") throw e;

        if (e instanceof WorkerRequestTooLargeError) {
          recordWorkerFailure(
            opts?.sessionID ?? "_unknown",
            opts?.workerID ?? "unknown",
            "upstream-error",
          );
          log.warn(
            `worker request rebuild rejected: request_bytes=${e.bytes} ` +
              `limit_bytes=${MAX_WORKER_REQUEST_BYTES}`,
          );
          lastWorkerError = e.message;
          return null;
        }

        // Client disconnect / abort is benign — downgrade from error to info
        // to avoid Sentry noise from normal connection lifecycle events.
        const isAbort = e instanceof DOMException && e.name === "AbortError";
        // Network/timeout error — no response was received. Record here so the
        // adapter remains the single owner of transport-failure attribution
        // (core workers no longer record on a null return).
        recordWorkerFailure(
          opts?.sessionID ?? "_unknown",
          opts?.workerID ?? "unknown",
          "no-response",
        );
        if (isAbort) {
          log.info("worker prompt aborted (client disconnect or shutdown)");
          recordPromptFailure("aborted", "client disconnect or shutdown", {
            model,
            protocol: target.protocol,
            preserveExisting: true,
          });
        } else {
          const kind = transportErrorKind(e);
          const code = transportErrorCode(e);
          log.error(
            `worker prompt transport failure: kind=${kind}` +
              (code ? ` code=${code}` : "") +
              ` origin=${sanitizedWorkerOrigin(req.url)}` +
              ` provider=${diagnosticToken(model.providerID)}`,
          );
          recordPromptFailure(
            e instanceof DOMException && e.name === "TimeoutError"
              ? "timeout"
              : "network-error",
            `network error: no response from ${diagnosticToken(model.providerID)} ` +
              `(kind=${kind}${code ? `, code=${code}` : ""})`,
            {
              retryable: true,
              model,
              protocol: target.protocol,
              preserveExisting: true,
            },
          );
        }
        return null;
      } finally {
        clearTimeout(deadlineTimer);
        activeWorkerCalls.delete(callID);
      }
    },
    async promptDetailed(system, user, promptOpts) {
      const initialModel = promptOpts?.model ?? defaultModel;
      const context: PromptDiagnosticContext = {
        attempts: 0,
        model: initialModel,
      };
      return promptDiagnosticStorage.run(context, async () => {
        try {
          const text = await client.prompt(system, user, promptOpts);
          if (text !== null) {
            return {
              kind: "success" as const,
              text,
              model: `${context.model.providerID}/${context.model.modelID}`,
              protocol:
                context.protocol ??
                resolveWorkerProtocol(
                  context.model.providerID,
                  promptOpts?.protocol,
                  context.model.modelID,
                  promptOpts?.upstreamUrl,
                ),
              attempts: context.attempts,
            };
          }
        } catch (error) {
          if (promptOpts?.signal?.aborted) {
            const reason = promptOpts.signal.reason;
            recordPromptFailure(
              reason instanceof DOMException && reason.name === "TimeoutError"
                ? "timeout"
                : "aborted",
              error instanceof Error ? error.message : String(error),
              { model: context.model, protocol: context.protocol },
            );
          } else {
            throw error;
          }
        }
        return (
          context.failure ?? {
            kind: "failure" as const,
            code: "upstream-error" as const,
            message:
              lastWorkerError ?? "worker prompt failed without a diagnostic",
            retryable: false,
            model: `${context.model.providerID}/${context.model.modelID}`,
            ...(context.protocol ? { protocol: context.protocol } : {}),
            attempts: context.attempts,
          }
        );
      });
    },
  };
  return client;
}

export interface GatewayInvariantJudgeOptions {
  client: GatewayLLMClient;
  model: { providerID: string; modelID: string };
  effort?: ReasoningEffort;
  sessionID: string;
  candidateTimeoutMs?: number;
  signal?: AbortSignal;
}

/** Bridge detailed gateway transport outcomes into core's semantic judge. */
export function createGatewayInvariantJudge(
  options: GatewayInvariantJudgeOptions,
): invariantCheck.InvariantJudge {
  return {
    async judge(input): Promise<invariantCheck.JudgeOutcome> {
      let semanticCalls = 0;
      let transportAttempts = 0;
      const timeoutSignal =
        options.candidateTimeoutMs == null
          ? undefined
          : AbortSignal.timeout(options.candidateTimeoutMs);
      const signal =
        options.signal && timeoutSignal
          ? AbortSignal.any([options.signal, timeoutSignal])
          : (options.signal ?? timeoutSignal);
      const stats = (): invariantCheck.JudgeStats => ({
        semanticCalls,
        transportAttempts,
      });
      const call = async (user: string): Promise<PromptOutcome> => {
        semanticCalls++;
        const outcome = await options.client.promptDetailed(
          invariantCheck.INVARIANT_JUDGE_SYSTEM,
          user,
          {
            model: options.model,
            workerID: "lore-invariant-check",
            thinking: false,
            reasoningEffort: options.effort,
            urgent: true,
            sessionID: options.sessionID,
            maxTokens: invariantCheck.judgeMaxTokens(options.effort),
            temperature: 0,
            signal,
          },
        );
        transportAttempts += outcome.attempts;
        return outcome;
      };

      let outcome = await call(
        invariantCheck.invariantJudgeUser({
          invariant: input.invariant,
          file: input.file,
          hunk: input.hunk,
        }),
      );
      if (outcome.kind === "failure") {
        return promptFailureToJudgeOutcome(outcome, stats(), options.signal);
      }
      let verdict = invariantCheck.parseInvariantVerdict(outcome.text);
      if (verdict) return { kind: "verdict", ...verdict, stats: stats() };
      if (input.semanticCallBudget < 2) {
        return invalidGatewayVerdict(stats());
      }

      outcome = await call(
        invariantCheck.invariantJudgeRepairUser({
          invariant: input.invariant,
          file: input.file,
          hunk: input.hunk,
          invalidResponse: outcome.text.slice(0, 2_000),
        }),
      );
      if (outcome.kind === "failure") {
        return promptFailureToJudgeOutcome(outcome, stats(), options.signal);
      }
      verdict = invariantCheck.parseInvariantVerdict(outcome.text);
      return verdict
        ? { kind: "verdict", ...verdict, stats: stats() }
        : invalidGatewayVerdict(stats());
    },
  };
}

function invalidGatewayVerdict(
  stats: invariantCheck.JudgeStats,
): invariantCheck.JudgeOutcome {
  return {
    kind: "unresolved",
    failure: {
      code: "invalid-verdict",
      message: "Judge response did not match the required verdict schema",
      scope: "candidate",
      retryable: true,
    },
    stats,
  };
}

function promptFailureToJudgeOutcome(
  outcome: Extract<PromptOutcome, { kind: "failure" }>,
  stats: invariantCheck.JudgeStats,
  overallSignal?: AbortSignal,
): invariantCheck.JudgeOutcome {
  const code = judgeFailureCode(outcome.code);
  const runScoped = new Set<invariantCheck.JudgeFailureCode>([
    "no-auth",
    "auth-rejected",
    "route-unavailable",
    "protocol-mismatch",
    "model-unsupported",
    "api-unsupported",
  ]);
  return {
    kind: "unresolved",
    failure: {
      code,
      message: outcome.message,
      scope:
        runScoped.has(code) ||
        outcome.code === "insufficient-credit" ||
        ((code === "abort" || code === "timeout") && overallSignal?.aborted)
          ? "run"
          : "candidate",
      retryable: outcome.retryable,
    },
    stats,
  };
}

function judgeFailureCode(
  code: PromptFailureCode,
): invariantCheck.JudgeFailureCode {
  switch (code) {
    case "network-error":
      return "network";
    case "invalid-response":
      return "invalid-body";
    case "aborted":
      return "abort";
    case "rate-limited":
      return "rate-limit";
    case "upstream-error":
    case "insufficient-credit":
    case "data-policy":
      return "transport-error";
    case "worker-incapable":
      return "model-unsupported";
    default:
      return code;
  }
}
