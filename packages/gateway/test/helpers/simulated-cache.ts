/**
 * Simulated prompt-cache oracle for the gateway replay harness.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * Replay fixtures script their `usage` statically and omit cache fields
 * entirely (see fixtures.ts: only input_tokens/output_tokens are set). So in
 * every replay test the gateway's real cache oracles — analyzeCacheTurn,
 * categorizeBust, recordCacheUsage, and calibrate() — are fed
 * `cache_read=0, cache_creation=0` every turn and therefore CAN NEVER OBSERVE A
 * BUST. A bug that rewrites the whole prompt prefix produces zero observable
 * difference in a replay test. This is why three separate production
 * cache-bust bugs (tier-gate, raw-window pin-march, LTM-delta-churn) all slipped
 * past the suite: the suite asserts on cache *inputs* (byte stability) but the
 * oracle that measures the cache *output* was blindfolded.
 *
 * WHAT THIS DOES
 * --------------
 * Wraps a replay interceptor and, before handing back the fixture response,
 * OVERWRITES its usage.cache_read_input_tokens / cache_creation_input_tokens
 * with values COMPUTED from the actual upstream request body — exactly the way
 * Anthropic's prompt cache behaves:
 *
 *   - The cache reads the longest common *prefix* (in bytes) shared with the
 *     previous turn's request, up to the last cache breakpoint, and rewrites
 *     everything after the first divergence.
 *   - read_tokens     ≈ prefixBytes / CHARS_PER_TOKEN
 *   - creation_tokens ≈ (currentBytes - prefixBytes) / CHARS_PER_TOKEN
 *   - First turn (no prior body): cold cache → all creation, zero read.
 *
 * This makes the gateway's own oracles see production-faithful numbers, so a
 * mid-history divergence (window march, delta append, system churn) shows up as
 * a real cache bust (high creation / low read, categorizeBust → window-shift /
 * system-change / prefix-rewrite) — observable and assertable in an e2e test.
 *
 * Lives under test/helpers (excluded from coverage) and is wired only into the
 * gateway harness via createHarness({ simulateCache: true }).
 */
import {
  findDivergenceOffset,
  normalizeBodyForComparison,
} from "../../src/cache-analytics";
import type { UpstreamInterceptor } from "../../src/recorder";

/** Anthropic-ish bytes→tokens heuristic. Only the RATIO matters for the
 *  oracles (bust detection thresholds, write:read ratio), not the absolute
 *  count, so a constant divisor is sufficient and stable. */
const CHARS_PER_TOKEN = 4;

/** One per-turn cache observation, as the simulated cache computed it. */
export interface SimulatedCacheTurn {
  /** 0-based turn index (order of upstream requests). */
  turn: number;
  /** Bytes of the normalized body shared as a prefix with the previous turn. */
  prefixBytes: number;
  /** Total bytes of the normalized current body. */
  totalBytes: number;
  /** Simulated cache_read_input_tokens injected into the response. */
  cacheReadTokens: number;
  /** Simulated cache_creation_input_tokens injected into the response. */
  cacheCreationTokens: number;
  /** prefixBytes / totalBytes — 1.0 = full cache hit, low = bust. */
  prefixMatch: number;
}

function clonePlainResponse(resp: unknown): Record<string, unknown> {
  // Fixtures are plain JSON objects; structuredClone keeps us from mutating the
  // caller's fixture array across turns.
  return typeof resp === "object" && resp !== null
    ? (structuredClone(resp) as Record<string, unknown>)
    : {};
}

/**
 * Wrap an interceptor so each replayed response carries cache usage computed
 * from real prompt-prefix stability. Records a per-turn trace accessible via
 * the returned `turns` array (the harness exposes this as `cacheTurns()`).
 */
export function withSimulatedCache(inner: UpstreamInterceptor): {
  interceptor: UpstreamInterceptor;
  turns: SimulatedCacheTurn[];
} {
  const turns: SimulatedCacheTurn[] = [];
  let prevNormalized: string | null = null;
  let turnIndex = 0;

  const interceptor: UpstreamInterceptor = async (
    requestBody,
    model,
    wasStreaming,
    makeRealRequest,
  ) => {
    const turn = turnIndex++;

    // Serialize + normalize the upstream body the SAME way the production
    // analyzer does (strips volatile per-turn client metadata like cch=).
    const raw =
      typeof requestBody === "string"
        ? requestBody
        : JSON.stringify(requestBody ?? {});
    const normalized = normalizeBodyForComparison(raw);
    const totalBytes = normalized.length;

    let prefixBytes: number;
    if (prevNormalized === null) {
      // Cold cache: nothing cached yet → full creation, zero read.
      prefixBytes = 0;
    } else {
      prefixBytes = findDivergenceOffset(prevNormalized, normalized);
    }
    prevNormalized = normalized;

    const cacheReadTokens = Math.floor(prefixBytes / CHARS_PER_TOKEN);
    const cacheCreationTokens = Math.max(
      0,
      Math.floor((totalBytes - prefixBytes) / CHARS_PER_TOKEN),
    );
    turns.push({
      turn,
      prefixBytes,
      totalBytes,
      cacheReadTokens,
      cacheCreationTokens,
      prefixMatch: totalBytes > 0 ? prefixBytes / totalBytes : 1,
    });

    // Get the fixture response from the inner interceptor, then re-stamp usage.
    const response = await inner(
      requestBody,
      model,
      wasStreaming,
      makeRealRequest,
    );

    // SSE streaming path: the inner interceptor already serialized the body to
    // an event stream. Rewriting usage inside SSE is brittle; the production
    // bust oracles read usage from the accumulated non-stream usage, which for
    // streaming responses the gateway derives from message_start/message_delta.
    // To keep this oracle simple and deterministic, simulated-cache tests drive
    // NON-streaming turns (stream:false), so we only handle JSON here. If a
    // streaming response slips through, pass it untouched (the test should use
    // non-streaming bodies to get faithful numbers).
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      return response;
    }

    const json = clonePlainResponse(await response.json());
    const usage = (
      typeof json.usage === "object" && json.usage !== null ? json.usage : {}
    ) as Record<string, unknown>;
    usage.cache_read_input_tokens = cacheReadTokens;
    usage.cache_creation_input_tokens = cacheCreationTokens;
    // input_tokens excludes cached/created in Anthropic's accounting; keep it
    // tiny so total input ≈ read + creation (the bust ratio denominator).
    usage.input_tokens =
      typeof usage.input_tokens === "number" && usage.input_tokens < 100
        ? usage.input_tokens
        : 2;
    json.usage = usage;

    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  return { interceptor, turns };
}
