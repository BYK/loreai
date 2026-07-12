/**
 * Cache analytics — deterministic cache-bust detection using API request
 * body prefix comparison and Anthropic response cache fields.
 *
 * Instead of fingerprinting internal message representations, this module
 * compares the actual serialized JSON request body byte-for-byte across
 * turns. When the prefix diverges, it maps the byte offset back to a
 * semantic location in the JSON structure (e.g. "messages[3].content[1]").
 *
 * The API response's `cache_read_input_tokens` and
 * `cache_creation_input_tokens` provide ground-truth confirmation.
 *
 * Request bodies are stored zstd-compressed (~99.9% reduction on
 * repetitive JSON) to keep per-session memory overhead low.
 */

import type {
  CacheAnalytics,
  CacheTurnAnalysis,
  GatewayUsage,
} from "./translate/types.ts";
import { log, type CacheBustCause, type CacheStrategy } from "@loreai/core";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Compression helpers (node:zlib zstd, available in Node.js >= 22.15)
// ---------------------------------------------------------------------------

export function compressBody(body: string): Uint8Array {
  return zstdCompressSync(Buffer.from(body));
}

export function decompressBody(compressed: Uint8Array): string {
  return zstdDecompressSync(compressed).toString();
}

// ---------------------------------------------------------------------------
// Warmup cache-divergence probe (env-gated, OFF by default → zero hot-path cost)
// ---------------------------------------------------------------------------

/**
 * Env var `LORE_WARMUP_PROBE`: when set to `1`, enables the warmup
 * cache-divergence diagnostic. It logs SHA comparisons of the cacheable
 * segments (the stable head `system[0..1]`, tools, and the distilled prefix
 * `messages[0..1]`) on real turns and warmups to tell an Anthropic-side cache
 * eviction (segments match, `cacheRead=0`) apart from a warmup request-body
 * divergence (segments differ). A debugging aid only; off by default, with zero
 * cost when unset (callers skip all parsing/hashing).
 */
export function isWarmupProbeEnabled(): boolean {
  return process.env.LORE_WARMUP_PROBE === "1";
}

export type CacheSegmentDigest = {
  /** SHA (12 hex) of system blocks up to & including the 1h breakpoint — the
   *  stable "head" (system[0] host prompt + system[1] LTM). system[2]
   *  (context-bound LTM) is excluded: it rides the conversation cache, not the
   *  head, so including it would produce false head-drift. */
  headSha: string;
  /** SHA (12 hex) of the tools array (1h breakpoint on the last tool). */
  toolsSha: string;
  /** SHA (12 hex) of messages[0..1] — Lore's distilled prefix, byte-stable
   *  between meta-distillations and carrying the #1155 1h interior breakpoint. */
  prefixSha: string;
  /** Number of cache_control breakpoints in the serialized body. */
  bpCount: number;
  /** Count of system blocks (sanity: 2 or 3). */
  systemBlocks: number;
  /** Serialized byte length (uncompressed). */
  bytes: number;
};

/**
 * Classify a warmup probe outcome from the head-hash comparison and the
 * observed cache read. Pure (no I/O) so it can be unit-tested directly.
 *
 * - no baseline           → no real turn was analyzed yet this session.
 * - head DIFFERS          → the warmup body genuinely diverges from the last
 *                           real turn at the head (a real body bug).
 * - head MATCH, read > 0  → the warmup read the cache (healthy).
 * - head MATCH, read = 0, cacheLikelyAlive  → EVICTION: an identical, byte-
 *                           stable head that should still have been live was
 *                           nonetheless a full miss (Anthropic-side eviction —
 *                           a stable head cannot diverge).
 * - head MATCH, read = 0, !cacheLikelyAlive → expected TTL expiry, NOT
 *                           eviction (mirrors the sibling `✗ UNCACHED` log,
 *                           which excludes expiry from the circuit breaker).
 */
export function classifyWarmupProbe(args: {
  hasBaseline: boolean;
  headMatch: boolean;
  cacheReadTokens: number;
  cacheLikelyAlive: boolean;
}): string {
  const { hasBaseline, headMatch, cacheReadTokens, cacheLikelyAlive } = args;
  if (!hasBaseline)
    return "no baseline (no real turn analyzed yet this session)";
  if (!headMatch)
    return "HEAD DIVERGENCE (warmup body head != last real turn head)";
  if (cacheReadTokens > 0) return "head identical to last real turn";
  return cacheLikelyAlive
    ? "EVICTION (head identical to last real turn, yet cacheRead=0 while cache should have been live)"
    : "expected expiry (head identical; cache aged past TTL, not eviction)";
}

/**
 * Hash the cacheable segments of a serialized Anthropic request body. Returns
 * null on any parse error (never throws — must be safe on the request path).
 */
export function cacheSegmentDigest(
  serializedBody: string,
): CacheSegmentDigest | null {
  try {
    const body = JSON.parse(serializedBody) as Record<string, unknown>;
    const sha = (v: unknown) =>
      createHash("sha256")
        .update(JSON.stringify(v ?? null))
        .digest("hex")
        .slice(0, 12);

    const systemBlocks = Array.isArray(body.system)
      ? (body.system as Array<Record<string, unknown>>)
      : [];
    // Head = blocks up to & including the first one carrying a cache_control
    // (the 1h stable-LTM breakpoint). Falls back to the whole array if none.
    let headEnd = systemBlocks.length;
    for (let i = 0; i < systemBlocks.length; i++) {
      if (systemBlocks[i]?.cache_control) {
        headEnd = i + 1;
        break;
      }
    }
    const messages = Array.isArray(body.messages)
      ? (body.messages as unknown[])
      : [];
    return {
      headSha: sha(systemBlocks.slice(0, headEnd)),
      toolsSha: sha(body.tools),
      prefixSha: sha(messages.slice(0, 2)),
      bpCount: (serializedBody.match(/"cache_control"/g) ?? []).length,
      systemBlocks: systemBlocks.length,
      bytes: serializedBody.length,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Body normalization for stable comparison
// ---------------------------------------------------------------------------

/**
 * Normalize a serialized request body for cache comparison by stripping
 * volatile metadata that clients embed in the request.
 *
 * The upstream request is NEVER modified — only the analytics copy.
 * Both the stored (previous) and current bodies are normalized, so
 * variable-width replacements are safe (offsets stay aligned across turns).
 */

/**
 * Claude Code content-cache hash: changes every turn.
 *
 * Matches the billing-header form (`cch=abcde;`) AND content occurrences that
 * appear as markdown code spans or quoted text (`` `cch=abcde` ``,
 * `"cch=abcde"`) or bare/whitespace-terminated tokens. These content tokens
 * are NOT real upstream cache busts (Anthropic strips `cch=` before computing
 * its cache key), but if left un-normalized they produce false-positive
 * `messages[N]`/`system[N]` divergence in this analytics comparison.
 *
 * The trailing terminator (`;`, backtick, quote, whitespace, or end) is kept
 * out of the match so it is preserved and byte offsets stay aligned.
 */
const CCH_PATTERN = /cch=[0-9a-fA-F]+(?=[;`"'\s\\]|$)/g;
const CCH_REPLACEMENT = "cch=__";

/**
 * Claude Code version suffix: 3 hex chars derived from
 * sha256(salt + chars_from_first_user_message + version).
 * Changes between sessions. Only the suffix is normalized —
 * the base version (e.g. 2.1.37) is preserved so genuine
 * version upgrades still show as divergence.
 */
const CC_VERSION_SUFFIX_PATTERN = /(cc_version=\d+\.\d+\.\d+)\.[0-9a-f]{3};/g;
const CC_VERSION_SUFFIX_REPLACEMENT = "$1.___;";

/**
 * Top-level max_tokens: Claude Code may vary this between turns.
 * Anchored to the JSON body start so it only matches the top-level
 * field, not occurrences in message content or tool descriptions.
 */
const TOP_LEVEL_MAX_TOKENS = /^(\{"model":"[^"]+","max_tokens":)\d+/;

/**
 * Anthropic prompt-cache breakpoint marker. Clients place an ephemeral
 * `cache_control` on the LAST cacheable block; it advances to the newest
 * message every turn. Left in place, the byte at the previous breakpoint's
 * position always differs from the next turn's body (marker removed there,
 * present elsewhere), producing a false-positive mid-conversation divergence
 * even when the upstream prompt-cache prefix is fully intact.
 *
 * Removing the marker from BOTH the stored (previous) and current bodies makes
 * breakpoint movement invisible to the prefix comparison. Matches an optional
 * leading comma so the surrounding JSON stays well-formed, and tolerates an
 * optional `ttl` field (extended-cache tier).
 */
// Match the whole `cache_control` object regardless of inner key order
// (e.g. `{"type":"ephemeral"}` or `{"ttl":"1h","type":"ephemeral"}`). The
// optional leading comma keeps surrounding JSON well-formed in the common case
// where the marker is a trailing property. Edge case: if `cache_control` were
// the FIRST key of its object, the trailing comma would be left behind
// (`{,"text":…}`) — harmless here because (a) Anthropic always appends the
// marker as the last property of a content block, and (b) this normalized
// string is only ever byte-compared against another normalized string, never
// re-parsed or sent upstream (the wire body is never modified by analytics).
const CACHE_CONTROL_PATTERN =
  /,?"cache_control":\{[^{}]*"type":"ephemeral"[^{}]*\}/g;
const CACHE_CONTROL_REPLACEMENT = "";

/** API cache hit-rate below which an "early divergence" is logged at INFO (a
 *  real bust worth surfacing) rather than DEBUG (normal tail-growth noise). */
const LOW_HIT_FOR_DIVERGENCE_LOG = 0.5;

export function normalizeBodyForComparison(body: string): string {
  return body
    .replace(CCH_PATTERN, CCH_REPLACEMENT)
    .replace(CC_VERSION_SUFFIX_PATTERN, CC_VERSION_SUFFIX_REPLACEMENT)
    .replace(CACHE_CONTROL_PATTERN, CACHE_CONTROL_REPLACEMENT)
    .replace(TOP_LEVEL_MAX_TOKENS, "$10");
}

// ---------------------------------------------------------------------------
// Byte-level prefix comparison
// ---------------------------------------------------------------------------

/**
 * Find the byte offset where two strings first differ.
 * Returns the length of the shorter string if one is a prefix of the other.
 */
export function findDivergenceOffset(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return i;
  }
  return len;
}

// ---------------------------------------------------------------------------
// Relocatable-span classification (issue #791 — measure-first gate)
// ---------------------------------------------------------------------------

/**
 * Value patterns for "relocatable" dynamic content — the class of span that a
 * CacheAligner-style optimization could move out of the cached prefix into a
 * dynamic tail without changing semantics (display dates/times/timestamps/IDs).
 *
 * Known agent volatile tokens (cch, cc_version suffix, top-level max_tokens,
 * cache_control) are already stripped by normalizeBodyForComparison BEFORE any
 * comparison, so these patterns only ever see the RESIDUAL divergence.
 *
 * Patterns are intentionally NUMERIC/structural-shaped (a date/time/uuid/long-
 * digit-run), NOT label-shaped. This is a deliberate PRECISION-over-recall
 * choice: the gate's whole job is to separate relocatable dynamic content from
 * genuine prose rewrites, so a false "relocatable" is worse than a miss — it
 * would inflate the very number that drives the build-vs-close decision.
 *
 * In particular we do NOT match bare day-of-week / month NAMES (e.g. "Monday",
 * "March"): those collide with ordinary English words ("Maybe", "Marketing",
 * "Decision", "Janitor", "August"), which would misclassify a host-prompt
 * rewrite as relocatable. Agents emit dates in ISO/numeric form anyway
 * ("Today's date: 2025-06-18"), which the numeric patterns below cover. A
 * human-readable date whose only changed token is a bare month/day name is
 * intentionally treated as a (rare) miss rather than risk a prose false match.
 */
const RELOCATABLE_SPAN_PATTERNS: RegExp[] = [
  /\d{4}-\d{2}-\d{2}/, // ISO date (2024-12-15)
  /\d{1,2}\/\d{1,2}\/\d{2,4}/, // slash date (12/15/2024)
  /\d{1,2}:\d{2}(?::\d{2})?/, // clock time (09:30[:15])
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, // UUID
  /\d{6,}/, // long digit run (epoch / counter)
];

/** Chars that belong to a single "value token" (used to expand a minimal diff
 *  out to its enclosing token before pattern-testing). */
const TOKEN_CHAR = /[0-9A-Za-z:/_.-]/;

/**
 * Decide whether the divergence between two strings (or local windows around a
 * divergence) is a RELOCATABLE dynamic span.
 *
 * The minimal byte diff is often a single char (e.g. `2024-12-1[5→6]`), so we
 * first locate the changed region (between the common prefix and common suffix)
 * and EXPAND it outward to token boundaries, then test the full changed token
 * against {@link RELOCATABLE_SPAN_PATTERNS}.
 *
 * Pure/deterministic; never touches the wire body. Returns false for identical
 * inputs and for prose-only changes.
 *
 * NOTE: callers should pass a bounded window centered on the FIRST divergence
 * (not whole bodies) so an unrelated tail change can't smuggle a date into the
 * tested region.
 */
export function classifyRelocatableSpan(prev: string, curr: string): boolean {
  if (prev === curr) return false;
  const plen = prev.length;
  const clen = curr.length;

  // Common prefix.
  const maxPrefix = Math.min(plen, clen);
  let p = 0;
  while (p < maxPrefix && prev[p] === curr[p]) p++;

  // Common suffix (cannot overlap the shared prefix in either string).
  let s = 0;
  const maxSuffix = Math.min(plen - p, clen - p);
  while (s < maxSuffix && prev[plen - 1 - s] === curr[clen - 1 - s]) s++;

  // Changed region in curr is [p, clen - s). Expand to enclosing token.
  let left = p;
  while (left > 0 && TOKEN_CHAR.test(curr[left - 1])) left--;
  let right = clen - s;
  while (right < clen && TOKEN_CHAR.test(curr[right])) right++;

  const token = curr.slice(left, right);
  if (!token) return false;
  return RELOCATABLE_SPAN_PATTERNS.some((re) => re.test(token));
}

/** Window (in bytes) sliced on each side of a divergence offset before running
 *  {@link classifyRelocatableSpan}. Large enough to contain a date/uuid token
 *  with surrounding context; small enough to exclude unrelated tail changes. */
const RELOCATABLE_WINDOW = 80;

// ---------------------------------------------------------------------------
// Semantic location mapping
// ---------------------------------------------------------------------------

/**
 * Map a byte offset in a serialized JSON string to a semantic JSON path.
 *
 * Walks the JSON structure character-by-character, tracking the current
 * path (keys and array indices). Stops when we reach the target offset.
 *
 * Returns a human-readable path like "messages[3].content[1].text" or
 * "system" or "tools[2].name".
 */
export function mapOffsetToJsonPath(json: string, offset: number): string {
  if (offset >= json.length) return "<end>";
  if (offset === 0) return "<start>";

  // Stack-based JSON path tracker. Each frame represents a nesting level.
  // - object frames: { kind: "object", key: current key or "" }
  // - array frames:  { kind: "array", index: current element index }
  type Frame =
    | { kind: "object"; key: string }
    | { kind: "array"; index: number };

  const stack: Frame[] = [];
  let inString = false;
  let escaped = false;
  let currentKey = "";
  let collectingKey = false;

  for (let i = 0; i < json.length && i < offset; i++) {
    const ch = json[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        if (collectingKey) currentKey += ch;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        if (collectingKey) currentKey += ch;
        continue;
      }
      if (ch === '"') {
        inString = false;
        collectingKey = false;
        continue;
      }
      if (collectingKey) currentKey += ch;
      continue;
    }

    switch (ch) {
      case '"':
        inString = true;
        // Determine if this quote starts a key (object context, key position)
        collectingKey = isObjectKeyPosition(json, i);
        if (collectingKey) currentKey = "";
        break;

      case "{":
        stack.push({ kind: "object", key: "" });
        break;

      case "[":
        stack.push({ kind: "array", index: 0 });
        break;

      case "}":
      case "]":
        stack.pop();
        break;

      case ":":
        // Assign the collected key to the current object frame
        if (currentKey && stack.length > 0) {
          const top = stack[stack.length - 1];
          if (top.kind === "object") {
            top.key = currentKey;
          }
          currentKey = "";
        }
        break;

      case ",":
        // In array context, advance to the next element
        if (stack.length > 0) {
          const top = stack[stack.length - 1];
          if (top.kind === "array") {
            top.index++;
          }
        }
        break;
    }
  }

  // Build path from the stack
  const parts: string[] = [];
  for (const frame of stack) {
    if (frame.kind === "object" && frame.key) {
      parts.push(parts.length === 0 ? frame.key : `.${frame.key}`);
    } else if (frame.kind === "array") {
      parts.push(`[${frame.index}]`);
    }
  }

  return parts.length === 0 ? "<root>" : parts.join("");
}

/**
 * Determine if a '"' at `offset` starts an object key.
 * Scans backwards to find the last structural character — if it's '{' or ','
 * we're in key position (not value position).
 */
function isObjectKeyPosition(json: string, offset: number): boolean {
  for (let i = offset - 1; i >= 0; i--) {
    const ch = json[i];
    if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t") continue;
    // After '{' or ',' in object = key position
    return ch === "{" || ch === ",";
  }
  return false;
}

// ---------------------------------------------------------------------------
// Divergence reason inference
// ---------------------------------------------------------------------------

/**
 * Infer a human-readable reason from the semantic path.
 *
 * Maps raw JSON paths to intuitive descriptions:
 *  - system[0] → host system prompt (stable, cached)
 *  - system[1] → LTM knowledge block (our injection)
 *  - messages near end → "new user/assistant message"
 *  - messages mid-conversation → "earlier message modified" (distillation rewrite)
 *
 * @param messageCount - total messages in the current request (for end-detection)
 * @param turn - 1-based turn number (for disambiguating the turn-2 system[2] insertion)
 */
export function inferDivergenceReason(
  path: string,
  prevLength: number,
  currLength: number,
  messageCount?: number,
  turn?: number,
): string {
  if (path === "<end>") {
    return currLength > prevLength
      ? "new message appended (normal conversation growth)"
      : "context window compressed (gradient eviction)";
  }
  if (path === "<start>") return "request structure changed from start";
  if (path === "<root>") return "top-level structure changed";

  // System prompt blocks (3-block architecture):
  //  system[0] = host system prompt (stable, cached with 1h TTL)
  //  system[1] = stable LTM: preferences (pinned >=1h, cached with 1h TTL)
  //  system[2] = context-bound LTM: non-preference entries (diff-pinned, rides conversation cache)
  //  bare "system" = plain string system prompt (no array structure)
  if (path === "system[0]" || path.startsWith("system[0]"))
    return "host system prompt changed";
  if (path === "system[1]" || path.startsWith("system[1]")) {
    // The PATH SUFFIX reliably disambiguates the two very different system[1]
    // divergence cases (the old turn===2-only heuristic conflated them and hid
    // the ses_14b9bf3d… incident, where consolidation deleted entries that were
    // in the frozen system[1]):
    //
    //  (a) BARE "system[1]" — the system array GREW: context-bound LTM
    //      (system[2]) is injected for the first time, so the first differing
    //      byte lands at the array boundary (`]`→`,`) right after system[1]
    //      while system[1] itself is byte-identical. mapOffsetToJsonPath reports
    //      the array-frame path with no inner key (no ".text"). On turn 2 this
    //      is the expected one-shot transient; otherwise it is a structural
    //      block-insertion shift.
    //  (b) "system[1].text" (any sub-path) — system[1]'s OWN content changed
    //      (preference re-curation/consolidation add/remove/edit). This busts
    //      the entire prefix and is a REAL bust regardless of turn number.
    if (path === "system[1]") {
      if (turn === 2)
        return "stable LTM array grew — context-bound LTM (system[2]) first injected on turn 2 (expected, not a real system[1] change)";
      return "stable LTM block boundary shifted (system-block insertion)";
    }
    return "stable LTM block content changed (preference re-curation/consolidation — prefix bust)";
  }
  if (path === "system[2]" || path.startsWith("system[2]"))
    return "context-bound LTM changed (non-preference entries re-ranked)";
  if (path === "system" || path.startsWith("system"))
    return "system prompt changed";

  if (path === "model") return "model changed";
  if (path === "max_tokens") return "max_tokens changed";
  if (path === "tools" || path.startsWith("tools"))
    return "tool definitions changed";

  // messages[N] patterns
  const msgMatch = path.match(/^messages\[(\d+)\]/);
  if (msgMatch) {
    const idx = parseInt(msgMatch[1], 10);

    // Determine if this is a new message at the end or a mid-conversation change
    if (messageCount != null && messageCount > 0) {
      // New messages: index near the end of the conversation (within last 2 messages)
      if (idx >= messageCount - 2) {
        return "new conversation message (normal turn progression)";
      }
      // Early messages: likely distilled prefix rewrite
      if (idx <= 1) {
        return "distilled conversation prefix changed (meta-distillation rewrite)";
      }
      // Mid-conversation: window shift or content edit
      return `earlier message modified at position ${idx} (window shift or content change)`;
    }

    // Fallback without message count context
    const rest = path.slice(msgMatch[0].length);
    if (!rest) return `message at position ${idx} structure changed`;
    if (rest === ".role") return `message at position ${idx} role changed`;
    if (rest.startsWith(".content"))
      return `message at position ${idx} content changed`;
  }

  return `changed at ${path}`;
}

// ---------------------------------------------------------------------------
// Main analytics function
// ---------------------------------------------------------------------------

/**
 * Analyze cache performance for a turn. Compares the current request body
 * with the previous turn's (stored compressed) and incorporates the API
 * response's cache usage fields.
 *
 * Updates `analytics` state in-place and returns the per-turn analysis.
 */
export function analyzeCacheTurn(
  analytics: CacheAnalytics,
  currentBody: string,
  usage: GatewayUsage,
  sessionID?: string,
  /** Number of messages in the current request (for human-friendly divergence reasons). */
  messageCount?: number,
  /**
   * The session's current unified cache strategy (`hold-warm` / `cool-bust` /
   * `cool-full-write`). When set, the dramatic-drop WARN is suppressed for
   * `cool-bust` and `cool-full-write` sessions — those strategies EXPLICITLY
   * chose to let the prefix go cold, so a "dramatic" hit-rate drop is the
   * expected outcome (the economic model decided warming wasn't worth it).
   * `hold-warm` sessions and the no-strategy-supplied default keep the WARN
   * — for hold-warm, a drop means the warmer is failing; for unknown, we
   * can't decide, so we keep the existing noisy behavior to avoid surprises.
   */
  cacheStrategy?: CacheStrategy,
): CacheTurnAnalysis {
  analytics.turnCount++;

  const cacheRead = usage.cacheReadInputTokens ?? 0;
  const cacheCreation = usage.cacheCreationInputTokens ?? 0;
  const inputTokens = usage.inputTokens ?? 0;
  const totalInput = cacheRead + cacheCreation + inputTokens;
  const cacheHitRate = totalInput > 0 ? cacheRead / totalInput : 0;

  // Capture previous turn's values BEFORE overwriting (lines below).
  // Used to detect sudden cache drops for diagnostics.
  // Note: prevTotal excludes uncached inputTokens (not stored in CacheAnalytics)
  // which is typically ~3 tokens — negligible for this diagnostic comparison.
  const prevCacheRead = analytics.lastCacheRead;
  const prevTotal = analytics.lastCacheRead + analytics.lastCacheCreation;
  const prevHitRate = prevTotal > 0 ? analytics.lastCacheRead / prevTotal : 0;

  // Track confirmed busts (API says no cache hit + new cache written)
  if (cacheRead === 0 && cacheCreation > 0 && analytics.turnCount > 1) {
    analytics.bustCount++;
  }

  // Default values for first turn (no previous body to compare)
  let prefixMatchBytes = 0;
  let prefixMatchPercent = 0;
  let divergencePoint = "<first-turn>";
  let divergenceReason = "first turn — no previous request to compare";
  let prevSnippet: string | undefined;
  let currSnippet: string | undefined;
  // system[0] cache-alignment measurement (issue #791).
  let system0Bust = false;
  let relocatable = false;

  // Normalize the current body for comparison: strip volatile client metadata
  // (e.g. Claude Code's per-turn `cch=XXXXX;` hash) so it doesn't pollute
  // prefix comparison. The previous body was already normalized before storage.
  const normalizedBody = normalizeBodyForComparison(currentBody);

  // Compare with previous body if available
  if (analytics.lastRequestBody !== null) {
    // We need the previous turn's NORMALIZED body for an apples-to-apples
    // divergence comparison. That exact string was already computed last turn
    // (it was that turn's `normalizedBody`), so reuse the memoized copy and
    // skip a full re-normalization of the whole previous body. The memo is
    // stored zstd-compressed and written together with `lastRequestBody` (see
    // the write site below); `lastRequestBody` is assigned a non-null value in
    // exactly one place, so whenever this guard passes the memo reflects the
    // same body. The fallback branch covers callers/fixtures that built this
    // analytics object without the optional memo field; `lastRequestBody`
    // keeps the RAW (cache_control intact) body for the warmer, so
    // normalize-on-read stays byte-identical to storing the normalized form
    // directly.
    const prevBody = analytics.lastNormalizedBody
      ? decompressBody(analytics.lastNormalizedBody)
      : normalizeBodyForComparison(decompressBody(analytics.lastRequestBody));
    const prevLength = prevBody.length;
    const currLength = normalizedBody.length;

    prefixMatchBytes = findDivergenceOffset(prevBody, normalizedBody);
    const minLength = Math.min(prevLength, currLength);
    prefixMatchPercent = minLength > 0 ? prefixMatchBytes / minLength : 0;

    if (prefixMatchBytes < minLength) {
      // Actual divergence within the shared prefix
      divergencePoint = mapOffsetToJsonPath(normalizedBody, prefixMatchBytes);
      divergenceReason = inferDivergenceReason(
        divergencePoint,
        prevLength,
        currLength,
        messageCount,
        analytics.turnCount,
      );

      // Refine the misleading "earlier message modified" verdict. When the
      // previous body CLOSES the messages array (`]`) exactly where this body
      // CONTINUES it (`,`), the previous turn's messages are a structural prefix
      // of this turn's — the divergence is TAIL GROWTH (the returning turn
      // appended messages), NOT a mid-conversation content edit. This is the
      // signature of an idle-resume cache miss: the body is fine, but the
      // returning turn can't reuse the cache and falls back to the nearest
      // breakpoint. The generic label made these look like content edits at
      // messages[N] and obscured that the real cost is the missing interior
      // breakpoint (addressed by the distilled-prefix breakpoint, PR #1155).
      if (
        divergenceReason.startsWith("earlier message modified") &&
        // Bare top-level `messages[N]` only. The `]`→`,` transition also occurs
        // when a nested `content` array grows (e.g. a tool_use block appended to
        // an existing message) — there the path is `messages[N].content[M]`, a
        // genuine content edit we must NOT relabel. A top-level element boundary
        // maps to a bare `messages[N]`.
        /^messages\[\d+\]$/.test(divergencePoint) &&
        prevBody[prefixMatchBytes] === "]" &&
        normalizedBody[prefixMatchBytes] === ","
      ) {
        divergenceReason =
          "returning-turn tail growth (previous messages are a prefix — " +
          "cache miss on resume, not a content edit)";
      }

      // system[0] cache-alignment measurement (issue #791): when the first
      // divergence lands in the agent-owned host prompt, decide whether the
      // changed span is relocatable dynamic content (a date/timestamp/uuid)
      // vs a genuine prompt rewrite. Computed from a bounded window centered
      // on the divergence — INDEPENDENT of the INFO-log snippet gate below —
      // so it is captured for every system[0] divergence, not just logged ones.
      system0Bust = divergencePoint.startsWith("system[0]");
      if (system0Bust) {
        const wStart = Math.max(0, prefixMatchBytes - RELOCATABLE_WINDOW);
        const wEnd = prefixMatchBytes + RELOCATABLE_WINDOW;
        relocatable = classifyRelocatableSpan(
          prevBody.slice(wStart, wEnd),
          normalizedBody.slice(wStart, wEnd),
        );
      }

      // Capture and log diverging byte snippets to help diagnose what changed
      // (e.g. timestamps, turn counters, host-side message re-rendering).
      // Logged for early divergences (< 5% prefix match) AND for any
      // mid-conversation messages[N] content change — the latter is the
      // expensive "earlier message modified" case where we need to see whether
      // the change originates upstream (host) or in lore's own pipeline.
      const isMidConversationMessageChange =
        /^messages\[\d+\]/.test(divergencePoint) &&
        !divergenceReason.startsWith("new conversation message");
      // Most mid-conversation divergences are NORMAL tail growth: the previous
      // turn's body simply ended where this turn appends new messages, and the
      // API still reports a near-100% cache hit. Only surface the snippet when
      // it correlates with an ACTUAL cache bust (low hit-rate) or a genuine
      // early prefix divergence; the high-hit tail-growth case is pure noise
      // (the logger has no debug level, so we suppress it rather than spam INFO).
      const isRealBust =
        cacheHitRate < LOW_HIT_FOR_DIVERGENCE_LOG || prefixMatchPercent < 0.05;
      if (
        (prefixMatchPercent < 0.05 || isMidConversationMessageChange) &&
        isRealBust
      ) {
        const start = Math.max(0, prefixMatchBytes - 20);
        const end = prefixMatchBytes + 80;
        prevSnippet = prevBody.slice(start, Math.min(prevLength, end));
        currSnippet = normalizedBody.slice(start, Math.min(currLength, end));
        log.info(
          `cache-analytics: early divergence at byte ${prefixMatchBytes}` +
            `\n  prev: ${JSON.stringify(prevSnippet)}` +
            `\n  curr: ${JSON.stringify(currSnippet)}`,
        );
      }
    } else if (prevLength !== currLength) {
      // One is a prefix of the other — new content appended/removed
      divergencePoint = "<end>";
      divergenceReason =
        currLength > prevLength
          ? "new message appended (normal conversation growth)"
          : "context window compressed (gradient eviction)";
    } else {
      // Identical bodies
      divergencePoint = "<identical>";
      divergenceReason = "request bodies are identical";
    }
  }

  // Store the RAW (as-sent) compressed body for next turn. Two consumers read
  // it: (1) the divergence comparison above, which normalizes on read so it
  // stays apples-to-apples; (2) the cache warmer, which REPLAYS it upstream.
  //
  // Why raw (this fixes the large-session cacheRead=0 bug): the warmer replays
  // exactly what it reads here. The normalized form must NEVER go upstream — it
  // rewrites the billing header in system[0] into NON-HEX placeholders
  // (CCH_REPLACEMENT "cch=__", CC_VERSION_SUFFIX_REPLACEMENT ".___;"; see the
  // "never re-parsed or sent upstream" note at CACHE_CONTROL_PATTERN). Anthropic
  // strips a VALID-hex cch/cc_version before hashing the cache key (which is why
  // real turns hit 92-100% despite cch changing every turn), but it does NOT
  // strip the non-hex artifacts — so the old warmup's system[0] diverged from
  // the cached prefix BEFORE the first breakpoint => guaranteed cacheRead=0 +
  // full rewrite. Normalization also stripped every cache_control, so the warmup
  // additionally collapsed to one end-of-body breakpoint (ensureCacheBreakpoint)
  // instead of the real system[1]/tools/conversation layout. Storing raw fixes
  // BOTH: the warmer replays the exact upstream bytes (valid-hex header via
  // resignBody + real breakpoints). lastRequestBodyLength stays the NORMALIZED
  // length — it is only the divergence-ratio denominator (prefixMatchBytes is
  // measured on normalized bodies).
  analytics.lastRequestBody = compressBody(currentBody);
  // Memoize the normalized form for next turn's divergence comparison. Stored
  // compressed (these bodies compress ~99.9%, so the extra blob is a few
  // hundred bytes) and written here alongside the raw body. This is the ONLY
  // place `lastRequestBody` is assigned a non-null value, and the divergence
  // reader above only consults `lastNormalizedBody` under the `!== null` guard,
  // so the two never desync — the reset sites that set `lastRequestBody = null`
  // simply skip the guard, and the stale memo (never read) is overwritten here
  // on the next analyzed turn. No reset-site changes required.
  analytics.lastNormalizedBody = compressBody(normalizedBody);
  analytics.lastRequestBodyLength = normalizedBody.length;
  analytics.lastCacheRead = cacheRead;
  analytics.lastCacheCreation = cacheCreation;

  // --- Warmup cache-divergence probe (env-gated) ---
  // Hash this real turn's cacheable segments; detect drift vs the previous turn
  // (a "stable" head/prefix that changes IS a divergence source), then store for
  // the next warmup to compare against. Parsing/hashing is skipped entirely when
  // the probe is off, so there is zero hot-path cost in production by default.
  // Wrapped in try/catch: this is a diagnostic and must never break the request
  // path (a throw here would propagate into the response stream's onComplete).
  if (isWarmupProbeEnabled()) {
    try {
      const dg = cacheSegmentDigest(currentBody);
      if (dg) {
        const sidStr = sessionID ? ` session=${sessionID.slice(0, 16)}` : "";
        const drift: string[] = [];
        if (analytics.probeHeadSha && analytics.probeHeadSha !== dg.headSha)
          drift.push(`head ${analytics.probeHeadSha}->${dg.headSha}`);
        if (analytics.probeToolsSha && analytics.probeToolsSha !== dg.toolsSha)
          drift.push(`tools ${analytics.probeToolsSha}->${dg.toolsSha}`);
        if (
          analytics.probePrefixSha &&
          analytics.probePrefixSha !== dg.prefixSha
        )
          drift.push(`prefix ${analytics.probePrefixSha}->${dg.prefixSha}`);
        if (drift.length > 0) {
          log.info(
            `warmup-probe: turn${sidStr} SEGMENT DRIFT [${drift.join(", ")}] ` +
              `(a stable-segment change busts the cached prefix)`,
          );
        }
        log.info(
          `warmup-probe: turn${sidStr} head=${dg.headSha} tools=${dg.toolsSha} ` +
            `prefix=${dg.prefixSha} bp=${dg.bpCount} sysBlocks=${dg.systemBlocks} ` +
            `read=${cacheRead} create=${cacheCreation}`,
        );
        analytics.probeHeadSha = dg.headSha;
        analytics.probeToolsSha = dg.toolsSha;
        analytics.probePrefixSha = dg.prefixSha;
      }
    } catch (err) {
      log.warn(`warmup-probe: turn probe failed (ignored): ${String(err)}`);
    }
  }

  const result: CacheTurnAnalysis = {
    turn: analytics.turnCount,
    cacheRead,
    cacheCreation,
    inputTokens,
    cacheHitRate,
    prefixMatchBytes,
    prefixMatchPercent,
    divergencePoint,
    divergenceReason,
    prevSnippet,
    currSnippet,
    system0Bust,
    relocatable,
  };

  // Log structured analysis
  if (analytics.turnCount > 1) {
    const bustStr = cacheRead === 0 && cacheCreation > 0 ? " [BUST]" : "";
    // issue #791: surface relocatable system[0] busts in the per-turn line.
    const sys0Str = system0Bust
      ? relocatable
        ? " [SYSTEM0-RELOCATABLE]"
        : " [SYSTEM0]"
      : "";
    const sidStr = sessionID ? ` session=${sessionID.slice(0, 16)}` : "";
    log.info(
      `cache-analytics:${sidStr} turn=${result.turn}` +
        ` hit=${(result.cacheHitRate * 100).toFixed(0)}%` +
        ` read=${cacheRead} create=${cacheCreation} input=${inputTokens}` +
        ` prefixMatch=${(result.prefixMatchPercent * 100).toFixed(1)}%` +
        ` (${prefixMatchBytes}/${analytics.lastRequestBodyLength}B)` +
        ` divergence="${divergencePoint}" reason="${divergenceReason}"` +
        bustStr +
        sys0Str,
    );

    // Warn on dramatic cache hit rate drops (e.g. 99% → 23%) to help
    // diagnose cache eviction or unexpected prefix divergence.
    //
    // Skip when the session is in a `cool-*` strategy: the unified cache
    // strategy EXPLICITLY chose to let the prefix go cold, so a dramatic
    // hit-rate drop is the expected outcome, not a bug. The economic model
    // already decided warming isn't worth it (see `evaluateCacheStrategy`
    // in @loreai/core) — alerting on a known-acceptable outcome is just
    // noise that drowns out real signals on hold-warm sessions.
    // hold-warm sessions and the no-strategy default keep the WARN: for
    // hold-warm, a drop means the warmer is failing; for unknown, we
    // err on the side of surfacing the signal.
    const isExpectedBust =
      cacheStrategy === "cool-bust" || cacheStrategy === "cool-full-write";
    if (
      analytics.turnCount > 2 &&
      prevHitRate > 0.5 &&
      cacheHitRate < prevHitRate * 0.4 &&
      !isExpectedBust
    ) {
      log.warn(
        `cache-analytics:${sidStr} dramatic hit rate drop:` +
          ` ${(prevHitRate * 100).toFixed(0)}% → ${(cacheHitRate * 100).toFixed(0)}%` +
          ` (read ${prevCacheRead}→${cacheRead})` +
          ` divergence="${divergencePoint}"`,
      );
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Bust cause categorization
// ---------------------------------------------------------------------------

// Re-export for callers that imported CacheBustCause from this module. The
// canonical definition lives in @loreai/core (so recordCacheUsage can use it
// without a circular gateway→core import).
export type { CacheBustCause };

/**
 * Categorize a cache event from the turn analysis.
 *
 * Uses the divergence point from byte-level prefix comparison plus the
 * API's cache usage fields to classify what caused the event.
 *
 * @param analysis - Per-turn analysis from analyzeCacheTurn()
 * @param isPostIdle - Whether this turn is a post-idle resume
 */
export function categorizeBust(
  analysis: CacheTurnAnalysis,
  isPostIdle: boolean,
): CacheBustCause {
  const { turn, cacheRead, cacheCreation, divergencePoint } = analysis;

  // First turn — no prior request to compare
  if (turn <= 1 || divergencePoint === "<first-turn>") return "first-turn";

  // Prefix-rewrite signature: divergence at messages[0/1] AND something
  // was actually written to the cache means the synthetic distilled
  // prefix was rewritten (meta-distillation). This is a LORE-INTERNAL
  // cause, not user-context growth — must be exempt from the
  // consecutive-bust counter even with a partial cache hit (some earlier
  // prefix matched, the distillation block was regenerated). Counting
  // these as "incremental" tripped false "unsustainable conversation"
  // warnings on sessions with sustained meta-distillation activity.
  //
  // We also require cacheCreation > 0 because "prefix-rewrite" implies
  // a real rewrite — a divergence reported at messages[0/1] with no new
  // cache content is a no-op turn (bustRatio=0), and labeling it a
  // "rewrite" would be misleading. Seer PR #943 review (LOW severity).
  const msgMatch = divergencePoint.match(/^messages\[(\d+)\]/);
  if (msgMatch && cacheCreation > 0) {
    const idx = parseInt(msgMatch[1], 10);
    if (idx <= 1) return "prefix-rewrite";
  }

  // Not a bust: cache read > 0, creation is only the new tail
  if (cacheRead > 0 && cacheCreation > 0) return "incremental";
  if (cacheRead > 0 && cacheCreation === 0) return "incremental";

  // Full bust: cacheRead === 0 and cacheCreation > 0
  if (cacheRead === 0 && cacheCreation > 0) {
    // Post-idle: cold cache regardless of divergence reason
    if (isPostIdle) return "idle-resume";

    // Classify by divergence location
    if (divergencePoint === "<identical>") return "unknown"; // shouldn't happen with a bust
    if (divergencePoint === "<start>" || divergencePoint === "<root>")
      return "prefix-rewrite";
    // Split host (system[0]) from lore's own LTM (system[1]/[2]). system[0] is
    // the agent-owned host prompt and the only CacheAligner relocation target
    // (issue #791); everything else under "system" is lore-managed churn.
    // NOTE: a bare "system" path (top-level STRING system prompt) maps to
    // system-ltm-change, slightly under-counting host busts — but that path
    // only occurs in the no-cache fallback (host+LTM concatenated into one
    // string), which is not the cached-prefix scenario the gate measures.
    if (divergencePoint.startsWith("system[0]")) return "system-host-change";
    if (divergencePoint === "system" || divergencePoint.startsWith("system"))
      return "system-ltm-change";
    if (divergencePoint === "tools" || divergencePoint.startsWith("tools"))
      return "tools-change";

    // Message-level divergence (messages[idx>=2])
    if (msgMatch) return "window-shift";

    return "unknown";
  }

  // No cache activity at all (unusual)
  return "unknown";
}

/**
 * Log a cache analytics summary for the session.
 * Suitable for calling on session cleanup or periodically.
 */
export function logCacheAnalyticsSummary(
  sessionID: string,
  analytics: CacheAnalytics,
): void {
  if (analytics.turnCount === 0) return;

  const bustRate =
    analytics.turnCount > 1
      ? analytics.bustCount / (analytics.turnCount - 1)
      : 0;

  log.info(
    `cache-analytics summary: session=${sessionID.slice(0, 16)}` +
      ` turns=${analytics.turnCount}` +
      ` busts=${analytics.bustCount}` +
      ` bustRate=${(bustRate * 100).toFixed(0)}%`,
  );
}
