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
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { recordCacheTurnUsage } from "../src/pipeline";
import { compressBody } from "../src/cache-analytics";
import type { CacheAnalytics, SessionState } from "../src/translate/types";
import {
  getConsecutiveBusts,
  evictSession,
  inspectSessionState,
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
});
