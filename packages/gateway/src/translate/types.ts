/**
 * Internal representation types for the Lore gateway.
 *
 * The gateway accepts both Anthropic (`/v1/messages`) and OpenAI
 * (`/v1/chat/completions`) protocol requests, normalizes them into these
 * types for Lore pipeline processing, then translates back to the original
 * protocol for the upstream response.
 *
 * Design: types are intentionally minimal — only fields that Lore's context
 * management (gradient, LTM, distillation) actually reads/writes. Protocol-
 * specific fields the gateway doesn't process live in `metadata`.
 */

// ---------------------------------------------------------------------------
// Content blocks — discriminated union on `type`
// ---------------------------------------------------------------------------

export type GatewayTextBlock = {
  type: "text";
  text: string;
};

export type GatewayThinkingBlock = {
  type: "thinking";
  thinking: string;
  /** Anthropic extended thinking signature, opaque bytes. */
  signature?: string;
};

export type GatewayToolUseBlock = {
  type: "tool_use";
  /** Provider-assigned tool call ID (e.g. `toolu_…` for Anthropic). */
  id: string;
  name: string;
  input: unknown;
};

export type GatewayToolResultBlock = {
  type: "tool_result";
  /** ID of the tool_use block this result corresponds to. */
  toolUseId: string;
  /**
   * Structured tool-result content. Anthropic `tool_result` content can be a
   * string or an array of blocks (text, image, etc.). We always normalize to
   * a block array so non-text sub-blocks (e.g. an image returned by Claude
   * Code's `Read` tool) survive the gateway round-trip losslessly. A plain
   * text projection is available via `blocksToText()` for memory/FTS and for
   * text-only wire forms (OpenAI `role:"tool"`, Responses `function_call_output`).
   */
  content: GatewayContentBlock[];
  isError?: boolean;
};

/**
 * Opaque passthrough block — carries any content block type the gateway does
 * not actively process (image, audio, document, and any future modality)
 * verbatim through the entire pipeline. This makes the gateway lossless by
 * default: instead of an allowlist that coerces unknown blocks to text (and
 * thereby silently corrupts/drops images), unrecognized blocks are preserved
 * exactly as received and re-emitted unchanged on egress.
 *
 * `raw` holds the original protocol block (e.g. an Anthropic
 * `{ type: "image", source: { type: "base64", media_type, data } }`).
 */
export type GatewayOpaqueBlock = {
  type: "opaque";
  raw: Record<string, unknown>;
};

export type GatewayContentBlock =
  | GatewayTextBlock
  | GatewayThinkingBlock
  | GatewayToolUseBlock
  | GatewayToolResultBlock
  | GatewayOpaqueBlock;

/**
 * Project a content-block array down to a plain-text representation.
 *
 * Used wherever a string is required: memory/FTS storage, deterministic
 * message-ID hashing, and text-only egress wire forms (OpenAI tool messages,
 * Responses `function_call_output.output`). Non-text blocks become a stable,
 * deterministic placeholder (NO base64 payload — keeps the projection compact
 * and the hash stable regardless of payload size).
 */
export function blocksToText(blocks: GatewayContentBlock[], depth = 0): string {
  // Guard against adversarial/malformed deeply nested tool_result content.
  if (depth > 10) return "[nested content]";
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        parts.push(block.text);
        break;
      case "thinking":
        parts.push(block.thinking);
        break;
      case "tool_use":
        parts.push(`[tool_use:${block.name}]`);
        break;
      case "tool_result":
        parts.push(blocksToText(block.content, depth + 1));
        break;
      case "opaque":
        parts.push(opaquePlaceholder(block.raw));
        break;
    }
  }
  return parts.join("\n");
}

/**
 * Deterministic placeholder for an opaque block. Derives a compact descriptor
 * from common media fields (type, media_type, payload byte length) without
 * embedding the payload itself — so the placeholder is stable and cheap.
 */
export function opaquePlaceholder(raw: Record<string, unknown>): string {
  const type = String(raw.type ?? "unknown");
  const source = raw.source as Record<string, unknown> | undefined;
  const mediaType =
    (source?.media_type as string | undefined) ??
    (raw.media_type as string | undefined);
  const data =
    (source?.data as string | undefined) ?? (raw.data as string | undefined);
  const bytes = typeof data === "string" ? data.length : undefined;
  const descriptor = [
    type,
    mediaType,
    bytes != null ? `${bytes} chars` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  return `[${descriptor}]`;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Normalized message — system messages are extracted to `GatewayRequest.system`. */
export type GatewayMessage = {
  role: "user" | "assistant";
  content: GatewayContentBlock[];
};

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** Normalized tool definition. Both protocols use JSON Schema for input. */
export type GatewayTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Request — the normalized form after ingress translation
// ---------------------------------------------------------------------------

export type GatewayProtocol = "anthropic" | "openai" | "openai-responses";

/** Normalized request after ingress translation from either protocol. */
export type GatewayRequest = {
  /** Which protocol the request arrived as — determines egress translation. */
  protocol: GatewayProtocol;
  /** Model identifier (e.g. `claude-sonnet-4-20250514`, `gpt-4o`). */
  model: string;
  /**
   * Extracted system prompt.
   * - Anthropic: top-level `system` field.
   * - OpenAI: first message with `role: "system"`, removed from messages.
   */
  system: string;
  messages: GatewayMessage[];
  tools: GatewayTool[];
  stream: boolean;
  maxTokens: number;
  /**
   * Protocol-specific parameters the gateway doesn't process but must
   * forward to the upstream provider (e.g. `temperature`, `top_p`,
   * `stop_sequences`, `tool_choice`).
   */
  metadata: Record<string, unknown>;
  /** Original request headers — passed through for auth, tracing, etc. */
  rawHeaders: Record<string, string>;
  /**
   * Additional OpenAI-compatible parameters preserved for upstream forwarding.
   * Populated by `parseOpenAIRequest`.
   */
  extras?: {
    temperature?: number;
    top_p?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    user?: string;
    logprobs?: boolean;
    top_logprobs?: number;
    /** OpenAI Responses API: previous response ID for conversation continuation. */
    previous_response_id?: string;
    /** OpenAI Responses API: reasoning configuration. */
    reasoning?: unknown;
    /** OpenAI Responses API: truncation settings. */
    truncation?: unknown;
    /**
     * Codex (ChatGPT) control fields. Preserved verbatim so the upstream
     * `/backend-api/codex/responses` call keeps Codex's semantics. `store` is
     * deliberately absent — the builder always forces `store: false` (ChatGPT
     * rejects `store: true`), so echoing the client value would be dead state.
     */
    include?: unknown;
    prompt_cache_key?: string;
    text?: unknown;
    tool_choice?: unknown;
    parallel_tool_calls?: boolean;
    service_tier?: string;
  };
  /**
   * Set when the request originated from Pi's `openai-codex` provider (ingress
   * path `/v1/codex/responses`). The protocol stays `"openai-responses"`; this
   * flag only steers the upstream URL (`/backend-api/codex/responses`) and the
   * preservation of Codex control fields in the upstream body.
   */
  codex?: boolean;
};

// ---------------------------------------------------------------------------
// Response — accumulated from upstream streaming/non-streaming response
// ---------------------------------------------------------------------------

export type GatewayUsage = {
  inputTokens: number;
  outputTokens: number;
  /** Anthropic prompt caching — present when cache hits occur. */
  cacheReadInputTokens?: number;
  /** Anthropic prompt caching — tokens written to cache on this request. */
  cacheCreationInputTokens?: number;
};

/**
 * Zero-value usage — used as a safe fallback when `resp.usage` is undefined
 * at runtime (e.g. vLLM or partial responses from OpenAI-compatible providers).
 *
 * INVARIANT: Must only contain required fields (inputTokens, outputTokens).
 * Do NOT add cacheReadInputTokens or cacheCreationInputTokens here — their
 * *presence* (even as 0) makes downstream `!= null` guards emit cache fields
 * in the wire response when no caching actually occurred. This invariant is
 * enforced by a test in translate-types.test.ts.
 */
export const ZERO_USAGE: GatewayUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
});

/**
 * Extract a JSON payload from an SSE response body.
 *
 * Some providers (e.g. DeepSeek) return SSE-formatted responses even when
 * `stream: false` was sent. This function reads all `data: ` lines, ignores
 * the `data: [DONE]` sentinel, and returns the **last** non-sentinel data
 * payload as parsed JSON. The final `data:` line contains the full response
 * object in this scenario.
 *
 * NOTE: This does not handle the SSE spec's multiline `data:` continuation
 * (consecutive `data:` lines joined by `\n`). In practice, providers that
 * return a complete non-streaming response as SSE always send the JSON
 * object on a single `data:` line.
 */
export async function extractJSONFromSSE(
  response: Response,
): Promise<Record<string, unknown>> {
  const text = await response.text();
  const lines = text.split("\n");
  let lastPayload: string | null = null;

  for (const line of lines) {
    if (line.startsWith("data: ")) {
      const payload = line.slice(6).trim();
      if (payload && payload !== "[DONE]") {
        lastPayload = payload;
      }
    }
  }

  if (!lastPayload) {
    throw new Error(
      "upstream returned SSE but no data payload found — expected JSON in data: lines",
    );
  }

  return JSON.parse(lastPayload) as Record<string, unknown>;
}

/** Accumulated response from the upstream provider. */
export type GatewayResponse = {
  id: string;
  model: string;
  content: GatewayContentBlock[];
  /** Provider stop reason (e.g. `end_turn`, `stop`, `tool_use`, `length`). */
  stopReason: string;
  /**
   * Token usage from the upstream provider. Optional because some providers
   * (vLLM, partial responses) may omit it entirely at runtime even though
   * accumulators always try to populate it.
   */
  usage?: GatewayUsage;
};

// ---------------------------------------------------------------------------
// Recall store (cross-request, gateway recall interception)
// ---------------------------------------------------------------------------

/** Stored recall result for marker-based round-trip expansion. */
export type StoredRecall = {
  /** The tool_use ID to reconstruct in the upstream request. */
  toolUseId: string;
  /** Original recall input (query + scope). */
  input: { query: string; scope?: string };
  /** Position (content block index) in the original assistant message. */
  position: number;
  /** Executed recall result (formatted markdown). */
  result: string;
};

/** Map from marker key (`${scope}:${query}`) → stored recall data. */
export type RecallStore = Map<string, StoredRecall>;

// ---------------------------------------------------------------------------
// Session state — per-session tracking for Lore pipeline integration
// ---------------------------------------------------------------------------

/** Per-turn cache analysis emitted as structured log data. */
export type CacheTurnAnalysis = {
  /** Turn number within this session. */
  turn: number;

  // --- Ground truth from API response ---
  /** Tokens served from prompt cache (hit). */
  cacheRead: number;
  /** Tokens written to prompt cache (miss / new). */
  cacheCreation: number;
  /** Uncached input tokens. */
  inputTokens: number;
  /** cacheRead / total input — 0..1. */
  cacheHitRate: number;

  // --- Request body prefix comparison ---
  /** Bytes matching from start of serialized request body vs previous turn. */
  prefixMatchBytes: number;
  /** prefixMatchBytes / min(prev, current) body length — 0..1. */
  prefixMatchPercent: number;
  /** Semantic location of the first divergence (e.g. "messages[3].content[1]"). */
  divergencePoint: string;
  /** Human-readable reason (e.g. "system prompt changed", "new message appended"). */
  divergenceReason: string;

  // --- Forensic snippets for early divergences (< 5% prefix match) ---
  /** Short snippet of previous body around the divergence point. */
  prevSnippet?: string;
  /** Short snippet of current body around the divergence point. */
  currSnippet?: string;
};

/** Per-session cache analytics state. */
export type CacheAnalytics = {
  /** Deflate-compressed serialized request body from the last turn. */
  lastRequestBody: Uint8Array | null;
  /** Uncompressed byte length of lastRequestBody (for prefix match %). */
  lastRequestBodyLength: number;
  /** cache_read_input_tokens from last API response. */
  lastCacheRead: number;
  /** cache_creation_input_tokens from last API response. */
  lastCacheCreation: number;
  /** Total turns observed. */
  turnCount: number;
  /** Confirmed busts (API returned cacheRead=0 with cacheCreation>0). */
  bustCount: number;
};

/** Routing snapshot captured from the last successful session request.
 *  Workers (distillation, curation) and the cache warmer use this
 *  to route through the same upstream with matching credentials.
 *  Single source of truth — replaces lastModel, lastProtocol,
 *  lastProviderID, lastUpstreamUrl, lastAnthropicBeta. */
export interface UpstreamSnapshot {
  /** Resolved upstream base URL (e.g., "https://api.minimax.io/anthropic"). */
  url: string;
  /** Wire protocol used for the request. */
  protocol: "anthropic" | "openai" | "openai-responses";
  /** Provider ID from X-Lore-Provider header (for worker model selection). */
  providerID?: string;
  /** Session model ID (for cost-aware worker model downgrade). */
  model: string;
  /** Non-managed headers to forward upstream (anthropic-beta, etc.). */
  headers: Record<string, string>;
}

/** Per-session state tracked by the gateway for Lore pipeline decisions. */
export type SessionState = {
  sessionID: string;
  projectPath: string;
  /** True when `projectPath` was set from a low-confidence source (the cwd
   *  fallback or a synthetic "unattributed" bucket) rather than an explicit
   *  `X-Lore-Project` header or a path inferred from the system prompt. While
   *  provisional, a later turn that DOES carry a confident path is allowed to
   *  overwrite `projectPath` (and re-point any rows already stored under the
   *  provisional path). Cleared once a confident path binds the session. */
  projectPathProvisional?: boolean;
  /** Normalized git remote URL received via `X-Lore-Git-Remote` header.
   *  Cached on the session so subsequent turns benefit even if the header
   *  is absent (e.g. prompt-cache probes). */
  gitRemote?: string;
  /** SHA-256 fingerprint of the first user message — used for Tier 3 session correlation. */
  fingerprint: string;
  /** Unix timestamp (ms) of the last request in this session. */
  lastRequestTime: number;
  /** Unix timestamp (ms) of the request before the current one — used by budget
   *  throttle to compute elapsed time since the previous turn for cache TTL safety. */
  prevRequestTime?: number;
  /** Unix timestamp (ms) of the last user-initiated turn — excludes tool-use
   *  auto-continuations. Used exclusively for inter-turn gap histogram
   *  recording (survival analysis). */
  lastUserTurnTime: number;
  /** Total user+assistant messages seen in this session. */
  messageCount: number;
  /** Turns since last curation run — triggers background curation. */
  turnsSinceCuration: number;
  /** True while a background curation has been scheduled for this session but
   *  has not yet entered curatorLimiter (i.e. still waiting in the global
   *  background queue). `curatorLimiter.isBusy` only flips once the task
   *  executes, so under a saturated global queue it stays false between
   *  scheduling and execution — this synchronous flag closes that window so
   *  subsequent turns don't re-schedule duplicate curations. Set before
   *  runBackground(), cleared in its .finally(). Transient (not persisted). */
  curationScheduled?: boolean;
  /** Stored recall results for marker-based round-trip expansion. */
  recallStore: RecallStore;
  /** Cache analytics — request body prefix comparison + API cache fields. */
  cacheAnalytics: CacheAnalytics;
  /** Set true in handleConversationTurn when an idle resume was detected;
   *  consumed by postResponse for cache-bust cause telemetry. One-shot. */
  lastTurnWasIdle?: boolean;
  /** Rolling window of recent turns' cold-cache status for auto-TTL upgrade.
   *  true = cold cache (full bust), false = cache hit. */
  coldCacheWindow?: boolean[];
  /** Resolved conversation TTL for this session ("5m" | "1h"). Updated by
   *  the auto-upgrade logic each turn. */
  resolvedConversationTTL?: "5m" | "1h";
  /** Consecutive turns where cold fraction < 0.2 while TTL is "1h".
   *  Used for hysteresis: only downgrade after N consecutive qualifying turns
   *  to avoid compounding cache busts from a single fluctuation. */
  ttlDowngradeStreak?: number;

  // --- Sub-agent detection ---

  /** True when a request in this session carried an `x-parent-session-id`
   *  header, indicating it belongs to an ephemeral sub-agent (e.g. OpenCode
   *  explore). Sub-agent sessions are exempt from cache warming — they are
   *  too short-lived (1-3 turns) for warming to be profitable. */
  isSubagent?: boolean;

  /** Lore internal session ID of the parent session (resolved from the
   *  `x-parent-session-id` header value via the headerSessionIndex).
   *  NULL/undefined for root (non-sub-agent) sessions. */
  parentSessionId?: string;

  // --- Tier 1/2 session header identification ---

  /** Header-based session ID value (Tier 1 known header or Tier 2 promoted learned header). */
  headerSessionId?: string;
  /** Name of the header that provided `headerSessionId`. */
  headerName?: string;
  /** Candidate headers being tracked during the Tier 2 learning phase.
   *  Key: header name. Value: last seen value + consecutive stable turn count. */
  candidateHeaders?: Map<string, { value: string; seenCount: number }>;

  // --- Dynamic max_tokens sizing ---

  /** EMA of output tokens across recent turns (α=0.3). */
  outputTokensEMA?: number;
  /** Stop reason from the last completed turn (e.g. "end_turn", "tool_use", "length"). */
  lastStopReason?: string;
  /** Total input tokens from the last completed turn (for headroom calculation). */
  lastInputTokens?: number;

  // --- Cache warming ---

  /** Consecutive turns where stop_reason was "end_turn" and the response
   *  contained no tool_use blocks (text-only replies). Resets to 0 whenever
   *  a tool_use turn occurs. Used to dampen the survival estimate — multiple
   *  text-only replies suggest the model is done working. */
  consecutiveTextOnlyTurns: number;

  /** Cache warming state for speculative keep-alive pings. */
  warmup?: WarmupState;
  /** Per-session survival model (inter-turn gap histogram). */
  survivalModel?: InterTurnHistogram;
  /** Routing snapshot from the most recent session request.
   *  Used by cache warmer (targets the most-recent provider) and as
   *  a convenience accessor. For provider-specific lookups (workers,
   *  auth), use `upstreamByProvider` instead. */
  lastUpstream?: UpstreamSnapshot;
  /** Per-provider routing snapshots. Keyed by provider ID (e.g. "anthropic",
   *  "minimax-coding-plan", "openrouter"). Workers and auth resolution use
   *  this to find the correct URL/credentials when the session has used
   *  multiple providers within the same conversation. */
  upstreamByProvider: Map<string, UpstreamSnapshot>;

  // --- Synthetic project-resolution probe ---

  /**
   * State machine for synthetic project-resolution probes. Bounded: ≤2
   * probes per session (read then shell).
   *
   * Transitions:
   *   undefined/"none" ──(read tool? emit read probe)──> "readPending"
   *   undefined/"none" ──(no read, shell tool? emit shell)──> "shellPending"
   *   undefined/"none" ──(no usable tool)──> "done"
   *   "readPending" ──(remote parsed)──> "done"
   *   "readPending" ──(no remote, shell tool? emit shell)──> "shellPending"
   *   "readPending" ──(no remote, no shell / no result)──> "done"
   *   "shellPending" ──(parsed | no result)──> "done"
   */
  syntheticResolveState?: "none" | "readPending" | "shellPending" | "done";
  /** The synthetic tool_use ID we minted (to match the returning tool_result). */
  syntheticResolveToolUseId?: string;
  /** Which probe kind is currently pending (to parse the result correctly). */
  syntheticResolveKind?: "read" | "shell";
  /** Tracks which stages have been attempted. Bounds escalation. */
  syntheticResolveStage?: "readTried" | "shellTried";

  // --- Amnesia mode ---

  /** When true, temporal storage and background work (distillation, curation)
   *  are suppressed. The session still gets full Lore processing (LTM injection,
   *  recall tool, gradient transform) but doesn't write to memory.
   *  Toggled via `/lore:amnesia:on` and `/lore:amnesia:off`. */
  amnesia?: boolean;

  // --- Periodic persistence ---

  /** Set true when session state changes that need periodic flush to DB.
   *  Consumed by the 30s idle tick — only dirty sessions are flushed. */
  _dirty?: boolean;

  /** Set true by the post-response processing when a client-side compaction
   *  dropped the message count by 50%+ (compaction anomaly). Consumed by
   *  scheduleBackgroundWork on the next turn to trigger urgent distillation
   *  — without this, the dropped context is lost from the Lore-side view
   *  (temporal storage) and never gets distilled. One-shot. */
  compactionAnomalyPending?: boolean;
};

// ---------------------------------------------------------------------------
// Cache warming types
// ---------------------------------------------------------------------------

/** Binned histogram of inter-turn gaps for survival analysis. */
export type InterTurnHistogram = {
  /** Count per bin (length = number of bin edges + 1 for overflow). */
  counts: number[];
  /** Total observations (sum of counts). */
  total: number;
};

/** Per-session cache warming state. */
export type WarmupState = {
  /** Timestamp (ms) of the last warmup ping sent. Cleared when consumed (user returns). */
  lastWarmupAt: number;
  /** Warmup pings sent in the CURRENT break period (reset on user return). Used for break-even cap. */
  warmupCount: number;
  /** Lifetime total warmup pings sent across all break periods in this session. */
  totalWarmups: number;
  /** Warmups followed by a user return within TTL (confirmed saves). */
  warmupHits: number;
  /** Session marked as dead — survival dropped below threshold. Resets on real request. */
  disabled: boolean;
  /** User explicitly requested keep-warm via /lore:warm:keep command. Bypasses survival analysis. */
  forceKeepWarm?: boolean;
  /**
   * cache_read tokens the LAST warmup actually refreshed (from the warmup
   * response usage). Used to credit savings against the prefix the warmup
   * paid to keep alive — NOT the returning turn's (often ~10× smaller)
   * cacheReadInputTokens. Set by executeWarmup on success; consumed (zeroed
   * with lastWarmupAt) when a hit is credited.
   *
   * 🔴 INVARIANT: this is ONLY ever non-zero on a session that itself fired
   * the warmup (executeWarmup ran with this session's ID). It is NEVER
   * inherited across session-identity changes (rotation refusal / new
   * session) — restore scrubs it when totalWarmups===0. A non-zero value is
   * therefore proof THIS session paid for the warmup, which gates hit
   * attribution to prevent phantom savings.
   */
  lastWarmupRefreshTokens?: number;
};

/** Result from a warmup request — used for circuit breaker and metrics. */
export type WarmupResult = {
  /** Whether the upstream accepted the request (HTTP 2xx). */
  ok: boolean;
  /** Cache read tokens from the warmup response (confirms cache was refreshed). */
  cacheReadTokens: number;
  /** Cache creation tokens (non-zero means warmup caused a fresh write — bad). */
  cacheCreationTokens: number;
};

// ---------------------------------------------------------------------------
// Header forwarding — transparent upstream proxy
// ---------------------------------------------------------------------------

/**
 * Headers that the gateway manages itself — never forwarded from the client.
 * Auth headers are listed because each request builder handles them
 * explicitly (extractAuth + authHeaders) to preserve the correct scheme.
 */
const GATEWAY_MANAGED_HEADERS = new Set([
  // HTTP framing
  "content-type",
  "content-length",
  "host",
  "connection",
  "transfer-encoding",
  "accept-encoding",
  // Lore-specific (injected by fetch interceptor / plugin hooks)
  "x-lore-provider",
  "x-lore-upstream-url",
  "x-lore-session-id",
  "x-lore-project",
  "x-lore-git-remote",
  "x-lore-agent",
  "x-lore-no-store",
  "x-lore-recall-invoked",
  // Protocol version — set explicitly by each builder
  "anthropic-version",
  // Session identification — consumed by gateway, not meaningful to upstream
  "x-parent-session-id",
  "x-session-affinity",
  "x-claude-code-session-id",
  // Auth — handled separately by each builder (extractAuth + authHeaders)
  "x-api-key",
  "authorization",
]);

/**
 * Forward non-managed headers from the client request to the upstream.
 *
 * The fetch interceptor preserves all original headers (including provider-
 * specific ones like `anthropic-beta`, `OpenAI-Organization`, etc.) on the
 * request to the gateway. This function extracts them for forwarding to the
 * upstream, filtering out headers the gateway sets itself.
 *
 * User-supplied `extraHeaders` (from `LORE_UPSTREAM_EXTRA_HEADERS`) are
 * applied separately at the end of each request builder so they overlay
 * both the forwarded client headers AND the gateway-reconstructed auth
 * (`x-api-key` / `Authorization`). This is intentional: a corporate-proxy
 * or service-account scenario needs to override the session's credential
 * for the upstream call.
 */
export function forwardClientHeaders(
  rawHeaders: Record<string, string>,
): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    const lower = key.toLowerCase();
    if (!lower.startsWith("x-lore-") && !GATEWAY_MANAGED_HEADERS.has(lower)) {
      forwarded[lower] = value;
    }
  }
  return forwarded;
}

/**
 * Apply user-supplied `LORE_UPSTREAM_EXTRA_HEADERS` as a final overlay on a
 * built upstream `headers` object. Keys are already lowercased by
 * `parseCurlHeaders`. Empty input is a no-op.
 *
 * Used by every upstream-headers construction site (anthropic/openai/openai-
 * responses builders, the upstream snapshot in `pipeline.ts`, and the
 * passthrough endpoints in `server.ts` / `cache-warmer.ts` /
 * `passthroughResponsesCompact`) to keep precedence consistent:
 * client-forwarded headers → gateway-managed overlay → user extras.
 */
export function applyUpstreamExtraHeaders(
  headers: Record<string, string>,
  extras?: Record<string, string>,
): void {
  if (!extras) return;
  for (const [key, value] of Object.entries(extras)) {
    headers[key] = value;
  }
}
