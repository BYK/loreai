/**
 * Wiring guard for the pipeline → recordCacheUsage bust-cause thread (#928,
 * follow-up to PR #926 / adversarial-review Mutation D).
 *
 * The two halves of the prefix-rewrite exemption are unit-tested elsewhere:
 *   - categorizeBust → "prefix-rewrite" for messages[0/1] divergence
 *     (cache-analytics.test.ts)
 *   - recordCacheUsage exempts "prefix-rewrite" from consecutiveBusts
 *     (gradient.test.ts, mutation-verified)
 * …but the WIRE that connects them inside the pipeline — analyzeCacheTurn →
 * categorizeBust → recordCacheUsage(..., bustCause) — was previously only
 * reachable through the full request path, so a mutation dropping the bustCause
 * argument (reverting to the legacy "count it" default) shipped green.
 *
 * recordCacheTurnUsage() is the extracted seam. These tests drive it with real
 * request bodies + usage so categorizeBust runs for real (no mocking), then
 * assert BOTH the returned cause (scenario is set up correctly) AND the
 * consecutive-bust counter side effect (the wire is intact). If the seam stops
 * threading bustCause into recordCacheUsage, the prefix-rewrite turn is counted
 * and the `toBe(0)` assertion fails.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { recordCacheTurnUsage } from "../src/pipeline";
import { compressBody } from "../src/cache-analytics";
import type { CacheAnalytics, SessionState } from "../src/translate/types";
import {
  getConsecutiveBusts,
  getCacheStrategy,
  evictSession,
  inspectSessionState,
  log,
} from "@loreai/core";

const MODEL = "claude-test";
const PROJECT = "/tmp/test-pipeline-cache-turn";

// A full cache bust: nothing read, a large prefix freshly written. ratio≈1.0.
// Frozen so a future mutating consumer of `usage` can't silently corrupt the
// shared fixture across tests (analyzeCacheTurn/recordCacheUsage only read it).
const BUST_USAGE = Object.freeze({
  inputTokens: 3,
  outputTokens: 50,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 100_000,
});

/** Build a request body with one text block per provided message string. */
function body(texts: string[]): string {
  return JSON.stringify({
    model: MODEL,
    system: "You are a helpful coding agent.",
    messages: texts.map((t, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: t }],
    })),
  });
}

/**
 * Minimal SessionState seeded so analyzeCacheTurn() treats the NEXT call as
 * turn 2 (turnCount becomes 2 → past the first-turn guard) with `prevBody` as
 * the prior upstream body to diverge against.
 *
 * `lastTurnWasIdle` is seedable so a test can verify the seam actually CONSUMES
 * it (sets it back to false): seeding `true` and asserting `false` afterwards is
 * a real guard, whereas seeding `false` would pass even if the consumption line
 * were deleted.
 */
function seedSession(
  sessionID: string,
  prevBody: string,
  lastTurnWasIdle = false,
): SessionState {
  const cacheAnalytics: CacheAnalytics = {
    lastRequestBody: compressBody(prevBody),
    lastRequestBodyLength: prevBody.length,
    lastCacheRead: 90_000,
    lastCacheCreation: 0,
    turnCount: 1, // analyzeCacheTurn increments → turn 2 (not first-turn)
    bustCount: 0,
  };
  return {
    sessionID,
    messageCount: 3,
    lastTurnWasIdle,
    cacheAnalytics,
  } as unknown as SessionState;
}

describe("recordCacheTurnUsage — pipeline bust-cause wiring (#928)", () => {
  const sessions: string[] = [];

  beforeEach(() => {
    sessions.length = 0;
  });

  afterEach(() => {
    for (const sid of sessions) evictSession(sid);
  });

  test("a prefix-rewrite bust (messages[0] divergence, cacheRead=0) is NOT counted", () => {
    const sessionID = "cache-turn-prefix-rewrite";
    sessions.push(sessionID);
    // messages[0] text differs → divergence inside messages[0].content[0].text.
    const prev = body([
      "DISTILLED PREFIX v1 — long stable text here",
      "reply 0",
      "user msg 2",
    ]);
    const curr = body([
      "DISTILLED PREFIX v2 — long stable text here",
      "reply 0",
      "user msg 2",
    ]);
    const state = seedSession(sessionID, prev);

    const cause = recordCacheTurnUsage(state, BUST_USAGE, MODEL, PROJECT, curr);

    // Scenario sanity: the seam really categorized this as a prefix rewrite…
    expect(cause).toBe("prefix-rewrite");
    // …and the wire held the counter (this is what a dropped bustCause breaks).
    expect(getConsecutiveBusts(sessionID)).toBe(0);
  });

  test("a window-shift bust (messages[2] divergence, cacheRead=0) IS counted (control)", () => {
    const sessionID = "cache-turn-window-shift";
    sessions.push(sessionID);
    // messages[0] and [1] identical; only messages[2] text differs → idx >= 2.
    const prev = body([
      "stable user 0",
      "stable assistant 1",
      "OLD third message",
    ]);
    const curr = body([
      "stable user 0",
      "stable assistant 1",
      "NEW third message, longer",
    ]);
    const state = seedSession(sessionID, prev);

    const cause = recordCacheTurnUsage(state, BUST_USAGE, MODEL, PROJECT, curr);

    expect(cause).toBe("window-shift");
    // A genuine user-context-growth bust DOES advance the counter — proving the
    // prefix-rewrite case above is a real exemption, not a dead no-op path.
    expect(getConsecutiveBusts(sessionID)).toBe(1);
  });

  test("prefix-rewrite holds (does not erase) a genuine prior bust run", () => {
    const sessionID = "cache-turn-hold";
    sessions.push(sessionID);

    // Turn A: a real window-shift bust → counter 0 → 1.
    const prevA = body(["u0", "a1", "OLD msg2"]);
    const currA = body(["u0", "a1", "NEW msg2 longer"]);
    const stateA = seedSession(sessionID, prevA);
    expect(
      recordCacheTurnUsage(stateA, BUST_USAGE, MODEL, PROJECT, currA),
    ).toBe("window-shift");
    expect(getConsecutiveBusts(sessionID)).toBe(1);

    // Turn B: a prefix-rewrite bust on the SAME session → held at 1 (neither
    // advanced toward the unsustainable threshold nor reset).
    const prevB = body(["PREFIX v1 stable tail", "a1", "msg2"]);
    const currB = body(["PREFIX v2 stable tail", "a1", "msg2"]);
    const stateB = seedSession(sessionID, prevB);
    expect(
      recordCacheTurnUsage(stateB, BUST_USAGE, MODEL, PROJECT, currB),
    ).toBe("prefix-rewrite");
    expect(getConsecutiveBusts(sessionID)).toBe(1);
  });

  test("a partial-cache-hit turn with messages[0/1] divergence is classified prefix-rewrite (not counted)", () => {
    const sessionID = "cache-turn-partial-hit-prefix-rewrite";
    sessions.push(sessionID);
    // Partial cache hit: read=53_412, create=109_745 — production-mirroring
    // numbers from a session with sustained meta-distillation activity. The
    // distilled prefix (messages[1] in this body) was rewritten but a sizeable
    // earlier prefix (the system block) still matched.
    // Mirror of the live-log signature:
    //   [cache-analytics: session=... hit=34% read=53412 create=109745 ...]
    //   [bust-tracker: ... ratio=0.673 (write=109745 read=53412 ...) ...]
    const PARTIAL_HIT_USAGE = Object.freeze({
      inputTokens: 2,
      outputTokens: 50,
      cacheReadInputTokens: 53_412,
      cacheCreationInputTokens: 109_745,
    });
    // system block matches; messages[0] identical; messages[1] text differs.
    // → divergence is at messages[1], which is the synthetic distilled prefix.
    const prev = body([
      "stable user 0",
      "DISTILLED PREFIX v1 — long stable text here",
      "user msg 2",
    ]);
    const curr = body([
      "stable user 0",
      "DISTILLED PREFIX v2 — long stable text here",
      "user msg 2",
    ]);
    const state = seedSession(sessionID, prev);

    const cause = recordCacheTurnUsage(
      state,
      PARTIAL_HIT_USAGE,
      MODEL,
      PROJECT,
      curr,
    );

    // Sanity: scenario really is a partial hit with prefix divergence.
    // The wire must classify this as "prefix-rewrite" (not "incremental") —
    // categorizeBust now recognizes messages[0/1] divergence regardless of
    // cache activity, closing the gap that #926 left for partial hits.
    expect(cause).toBe("prefix-rewrite");
    // The consecutive-bust counter MUST stay at 0 — this is the regression
    // guard for the false "unsustainable conversation" warnings on sessions
    // with sustained meta-distillation activity. Without the fix, this would
    // be classified "incremental" and the counter would jump to 1, just like
    // the 12na8hXrpthm52Hl / 0GZ6jpMwyZ6n09xm sessions in the production logs.
    expect(getConsecutiveBusts(sessionID)).toBe(0);
  });

  test("a partial-cache-hit turn with messages[2+] divergence is classified incremental (control)", () => {
    const sessionID = "cache-turn-partial-hit-incremental";
    sessions.push(sessionID);
    // Partial cache hit + divergence deep in messages — a normal user-context
    // growth. MUST classify as "incremental" (the pre-existing semantics) so
    // the gate only exempts prefix-rewrite signatures, not all partial hits.
    // This is the negative control proving the new check is narrowly scoped
    // to messages[0/1] and does not leak exemptions to genuine growth busts.
    const PARTIAL_HIT_USAGE = Object.freeze({
      inputTokens: 2,
      outputTokens: 50,
      cacheReadInputTokens: 53_412,
      cacheCreationInputTokens: 1_000,
    });
    const prev = body(["u0", "a1", "OLD third message"]);
    const curr = body(["u0", "a1", "NEW third message, longer"]);
    const state = seedSession(sessionID, prev);

    const cause = recordCacheTurnUsage(
      state,
      PARTIAL_HIT_USAGE,
      MODEL,
      PROJECT,
      curr,
    );

    expect(cause).toBe("incremental");
  });

  test("the no-request-body path records a turn without a cause (legacy count)", () => {
    const sessionID = "cache-turn-no-body";
    sessions.push(sessionID);
    const state = seedSession(sessionID, body(["x"]));

    // No requestBody → bustCause undefined → recordCacheUsage falls back to the
    // legacy "count it" behavior. A full bust therefore advances the counter.
    const cause = recordCacheTurnUsage(
      state,
      BUST_USAGE,
      MODEL,
      PROJECT,
      undefined,
    );

    expect(cause).toBeUndefined();
    expect(getConsecutiveBusts(sessionID)).toBe(1);
  });

  test("updates the rolling cold-cache window and consumes lastTurnWasIdle", () => {
    const sessionID = "cache-turn-coldwindow";
    sessions.push(sessionID);
    const prev = body(["u0", "a1", "OLD msg2"]);
    const curr = body(["u0", "a1", "NEW msg2"]);
    // Seed lastTurnWasIdle = true so the "consumed -> false" assertion below is a
    // real guard on the consumption line (seeding false would pass even if that
    // line were removed). The cold-window push is independent of idle status.
    const state = seedSession(sessionID, prev, true);

    recordCacheTurnUsage(state, BUST_USAGE, MODEL, PROJECT, curr);

    // cacheRead=0 && cacheCreation>0 → this turn is a cold turn.
    expect(state.coldCacheWindow).toEqual([true]);
    // lastTurnWasIdle was seeded true and must be consumed (reset to false).
    expect(state.lastTurnWasIdle).toBe(false);
    // sanity: the core session state actually exists after recording
    // (inspectSessionState returns null — not undefined — when absent).
    expect(inspectSessionState(sessionID)).not.toBeNull();
  });

  test("pipeline wires the session's cool-bust strategy into the dramatic-drop warn suppression", async () => {
    // Adversarial-review NIT on PR #948: the 4 new unit tests in
    // cache-analytics.test.ts exercise the new cacheStrategy parameter, but
    // they call analyzeCacheTurn directly and never go through
    // recordCacheTurnUsage. The bridge from getCacheStrategy() →
    // recordCacheTurnUsage → analyzeCacheTurn was untested. This test drives
    // the full path and asserts the warn is suppressed when the session's
    // stored strategy is cool-bust, mutation-verified below.
    const sessionID = "cache-turn-cool-bust-suppress-warn";
    sessions.push(sessionID);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});

    // Mock getCacheStrategy to report a confident cool-bust decision for
    // this session. The pipeline reads this on every recordCacheTurnUsage
    // call and passes the strategy to analyzeCacheTurn.
    const strategySpy = vi.spyOn(
      await import("@loreai/core"),
      "getCacheStrategy",
    );
    strategySpy.mockReturnValue({
      result: {
        confident: true,
        strategy: "cool-bust",
        // Other fields unused by the test — fill with sane defaults
        // matching the CacheEconomicsResult interface.
        holdWarmCost: 0,
        coolBustCost: 0,
        coolFullWriteCost: 0,
      },
      decidedAt: Date.now(),
    });

    // 3 turns: establish a high hit rate, hold it, then drop dramatically
    // (the same shape that trips the warn condition in cache-analytics.ts).
    // Without the cool-bust strategy, turn 3 would emit the
    // "dramatic hit rate drop" WARN. With the strategy, the pipeline must
    // pass it through and analyzeCacheTurn must skip the warn.
    const state = seedSession(sessionID, body(["warm user message"]));
    const warm = body(["warm user message"]);
    const cold = body(["DIFFERENT cold user message"]); // divergence at messages[0]
    const warmUsage = Object.freeze({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 900,
      cacheCreationInputTokens: 0,
    });
    const coldUsage = Object.freeze({
      inputTokens: 1000,
      outputTokens: 50,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });

    recordCacheTurnUsage(state, warmUsage, MODEL, PROJECT, warm);
    recordCacheTurnUsage(state, warmUsage, MODEL, PROJECT, warm);
    recordCacheTurnUsage(state, coldUsage, MODEL, PROJECT, cold);

    // Assert: the strategy was consulted (proves the wiring ran).
    expect(strategySpy).toHaveBeenCalledWith(sessionID);
    // Assert: the dramatic-drop warn was NOT emitted (proves the strategy
    // gated the warn). Without the wiring, this would be a noisy warn
    // because cool-bust is the very signal that says "let the cache die".
    const calls = warn.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(
      calls.some((c: string) => c.includes("dramatic hit rate drop")),
    ).toBe(false);

    warn.mockRestore();
    strategySpy.mockRestore();
  });
});
