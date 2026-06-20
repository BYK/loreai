// ---------------------------------------------------------------------------
// Shared cache economics
// ---------------------------------------------------------------------------
//
// WHY THIS MODULE EXISTS
//
// Two subsystems independently model the SAME future event — "what happens to
// the prompt cache when the user next returns to an idle session" — but with
// inconsistent assumptions, so they fight each other:
//
//   * The cache warmer (gateway/cache-warmer.ts) prices the value of warming as
//     "avoid a full-body WRITE on return" (costThreshold = read/(write-read),
//     maxProfitableCycles = (write-read)/read). It implicitly assumes that NOT
//     warming means the return turn pays a full cold write of the CURRENT body.
//
//   * The bust calculator (gradient.ts: shouldCompress) prices "continue" as a
//     cheap READ of the current body (repriced to write only under a sustained
//     bust run). It ignores warming and ignores that a cold/expired return is a
//     full WRITE, not a read.
//
// The only coupling was a single boolean (isCacheWarm) wired into onIdleResume's
// skipCompact. When the warmer's write-efficiency guard stopped warming a large
// session, isCacheWarm flipped false, which re-enabled post-idle compaction,
// which busted the cache the warming was trying to preserve — an oscillation.
//
// THE CRUX
//
// The genuine tradeoff is NOT "read vs write of the full body on one turn". It
// is "keep the session large and warm" vs "compact it once and run small from
// then on". Staying large means paying to read the full body on EVERY future
// turn; compacting pays a single compressed write now and reads a small body
// forever after. The decision therefore has to account for the ONGOING cost of
// the chosen body size, not just the single return turn.
//
// This module is the one place that comparison lives. It is pure (no I/O, no
// module state) so both the gateway warmer and the core gradient can call it
// with the same numbers and agree. Both `shouldWarm` (warmer) and
// `shouldCompress`/`onIdleResume` (gradient) are intended to derive their
// decision from `decideCacheStrategy` so the two never disagree.

/**
 * The chosen strategy for an idle session over the horizon until the user
 * returns (or the session ends).
 *
 *  - `hold-warm`       Keep the current (large) body cached via warmups and do
 *                      NOT compact on return; the return turn is a cheap cache
 *                      read. Worth it only when the session is likely to return
 *                      soon AND staying large is cheaper than compacting.
 *  - `cool-bust`       Stop warming; on return, compact (one compressed write)
 *                      and run small thereafter. This is also the natural,
 *                      "free" moment to flush deferred LTM/distillation work
 *                      (the prefix is busting anyway).
 *  - `cool-full-write` Degenerate fallback: don't warm and don't compact, so a
 *                      cold return pays a full-body write. Chosen when
 *                      compression offers no benefit (e.g. a small layer-0
 *                      session below the compaction tier boundary) yet warming
 *                      still isn't worth it.
 */
export type CacheStrategy = "hold-warm" | "cool-bust" | "cool-full-write";

export interface CacheEconomicsInput {
  /** Expected input tokens if the session stays at its current layer. */
  fullBodyTokens: number;
  /**
   * Expected input tokens after compaction. A caller with no compaction
   * available (e.g. a layer-0 session below the tier boundary) passes
   * `compressedTokens === fullBodyTokens`, which collapses `cool-bust` into
   * `cool-full-write` and reduces the decision to the classic warm-vs-cold one.
   */
  compressedTokens: number;
  /** Per-token cost to READ from cache ($/token). */
  readPerToken: number;
  /** Per-token cost to WRITE/miss ($/token). */
  writePerToken: number;
  /** Probability the session returns within the warming horizon (0..1). */
  pReturn: number;
  /**
   * Expected number of warmup cycles spent before the session resolves
   * (returns or is abandoned). Encodes the idle keepalive spend in expectation;
   * forward-looking only (sunk cycles are intentionally excluded — callers keep
   * their own hard cycle cap as a separate guard).
   */
  expectedCycles: number;
  /**
   * Expected number of turns the resumed session runs before it ends. This is
   * the "ongoing cost" horizon that captures the crux: staying large costs
   * `fullBody·read` every one of these turns, vs `compressed·read` if compacted.
   */
  expectedFutureTurns: number;
}

export interface CacheEconomicsResult {
  strategy: CacheStrategy;
  // The *Cost fields are in the SAME currency unit as the pricing inputs. The
  // chosen `strategy` is invariant to a common scaling of read+write pricing,
  // but these reported costs are only dollars if pricing was passed as $/token
  // (NOT $/MTok). They are primarily for logging/telemetry.
  /** Expected cost of holding the body warm across the horizon. */
  holdWarmCost: number;
  /** Expected cost of cooling and compacting on return ($). */
  coolBustCost: number;
  /** Expected cost of cooling without compacting (cold full write) ($). */
  coolFullWriteCost: number;
  /**
   * False when inputs were insufficient to trust the comparison (e.g. missing
   * pricing). Callers MUST fall back to their legacy heuristic when false
   * rather than acting on the (meaningless) strategy.
   */
  confident: boolean;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0; // +Inf→1, -Inf/NaN→0
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/** A finite, non-negative count; non-finite or negative inputs collapse to 0. */
function finiteNonNeg(x: number): number {
  return Number.isFinite(x) && x > 0 ? x : 0;
}

/**
 * Decide the cheapest cache strategy for an idle session.
 *
 * Expected-cost model over the idle→return horizon (all terms in $):
 *
 *   holdWarm      = expectedCycles · full · read                 (idle keepalive: warmups READ the still-warm cache to refresh its TTL)
 *                 + pReturn · (1 + futureTurns) · full · read     (warm return read + ongoing reads while staying large)
 *
 *   coolBust      = pReturn · ( compressed · write               (one compaction WRITE on return)
 *                             + futureTurns · compressed · read ) (ongoing reads of the small body)
 *
 *   coolFullWrite = pReturn · ( full · write                     (cold full WRITE on return, no compaction)
 *                             + futureTurns · full · read )       (ongoing reads while staying large)
 *
 * The keepalive term is unconditional (warming is paid during idle whether or
 * not the user returns); every return-conditional term is scaled by `pReturn`.
 * The function returns the cheapest of the three.
 *
 * Notes on how this subsumes the legacy heuristics:
 *  - With `compressed === full` (no compaction available) `coolBust === coolFullWrite`,
 *    and `holdWarm < coolFullWrite` reduces to `cycles·read + pReturn·read < pReturn·write`
 *    — i.e. exactly the classic costThreshold / maxProfitableCycles break-even.
 *  - The write-efficiency guard becomes unnecessary: a large body that is cheap
 *    to compact yields `coolBust < holdWarm` directly, so warming stops without
 *    a separate "low read/write ratio" gate.
 */
export function decideCacheStrategy(
  input: CacheEconomicsInput,
): CacheEconomicsResult {
  const { fullBodyTokens, readPerToken, writePerToken } = input;
  const pReturn = clamp01(input.pReturn);
  const cycles = finiteNonNeg(input.expectedCycles);
  const futureTurns = finiteNonNeg(input.expectedFutureTurns);

  // Without finite, positive pricing (or with a non-finite/empty body) the
  // comparison is meaningless — signal low confidence so the caller keeps its
  // legacy behaviour. The finiteness checks are LOAD-BEARING: a model missing
  // from the pricing table arrives here as undefined/NaN, and `NaN <= 0` is
  // false, so a bare `<= 0` guard would let garbage through and report it as a
  // trustworthy decision (NaN costs → arbitrary strategy, confident:true).
  if (
    !Number.isFinite(readPerToken) ||
    !Number.isFinite(writePerToken) ||
    !Number.isFinite(fullBodyTokens) ||
    readPerToken <= 0 ||
    writePerToken <= 0 ||
    fullBodyTokens <= 0
  ) {
    return {
      strategy: "cool-full-write",
      holdWarmCost: 0,
      coolBustCost: 0,
      coolFullWriteCost: 0,
      confident: false,
    };
  }

  // The compacted body can never be larger than the full body. A non-finite
  // estimate means the caller had no compaction figure — treat it as "no
  // compaction available" (compressed === full), which collapses cool-bust into
  // cool-full-write rather than fabricating a phantom (and falsely cheapest)
  // bust from a NaN cost.
  const compressed = Number.isFinite(input.compressedTokens)
    ? Math.min(Math.max(0, input.compressedTokens), fullBodyTokens)
    : fullBodyTokens;

  const holdWarmCost =
    cycles * fullBodyTokens * readPerToken +
    pReturn * (1 + futureTurns) * fullBodyTokens * readPerToken;

  const coolBustCost =
    pReturn *
    (compressed * writePerToken + futureTurns * compressed * readPerToken);

  const coolFullWriteCost =
    pReturn *
    (fullBodyTokens * writePerToken +
      futureTurns * fullBodyTokens * readPerToken);

  // Pick the cheapest. Among the two cool options, prefer `cool-bust` only when
  // compaction is STRICTLY cheaper — a tie means compaction buys nothing (e.g.
  // compressed === full), so default to `cool-full-write` and never claim a
  // pointless bust. Choose `hold-warm` only when it is STRICTLY cheaper than the
  // best cool option — never pay to warm on a tie.
  const bestCool: CacheStrategy =
    coolBustCost < coolFullWriteCost ? "cool-bust" : "cool-full-write";
  const bestCoolCost = Math.min(coolBustCost, coolFullWriteCost);
  const strategy: CacheStrategy =
    holdWarmCost < bestCoolCost ? "hold-warm" : bestCool;

  return {
    strategy,
    holdWarmCost,
    coolBustCost,
    coolFullWriteCost,
    confident: true,
  };
}

/** Whether the chosen strategy calls for the cache warmer to keep warming. */
export function strategyWantsWarming(strategy: CacheStrategy): boolean {
  return strategy === "hold-warm";
}

/**
 * Whether the chosen strategy calls for compaction (a deliberate cache bust) on
 * the next turn. This is also the signal that deferred LTM/distillation work may
 * piggy-back for free (the prefix is busting anyway).
 */
export function strategyWantsCompaction(strategy: CacheStrategy): boolean {
  return strategy === "cool-bust";
}
