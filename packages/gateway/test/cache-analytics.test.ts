import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { log } from "@loreai/core";
import {
  compressBody,
  decompressBody,
  findDivergenceOffset,
  mapOffsetToJsonPath,
  inferDivergenceReason,
  analyzeCacheTurn,
  categorizeBust,
  classifyRelocatableSpan,
  normalizeBodyForComparison,
} from "../src/cache-analytics";
import type {
  CacheAnalytics,
  CacheTurnAnalysis,
  GatewayUsage,
} from "../src/translate/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCacheAnalytics(): CacheAnalytics {
  return {
    lastRequestBody: null,
    lastRequestBodyLength: 0,
    lastCacheRead: 0,
    lastCacheCreation: 0,
    turnCount: 0,
    bustCount: 0,
  };
}

function makeUsage(overrides: Partial<GatewayUsage> = {}): GatewayUsage {
  return {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadInputTokens: 900,
    cacheCreationInputTokens: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Compression round-trip
// ---------------------------------------------------------------------------

describe("compression", () => {
  test("round-trips a JSON body through zstd", () => {
    const body = JSON.stringify({
      model: "claude-opus-4-20250514",
      messages: [{ role: "user", content: "hello world" }],
    });
    const compressed = compressBody(body);
    // Small bodies may not compress (zstd frame overhead) — just verify round-trip
    expect(decompressBody(compressed)).toBe(body);
  });

  test("round-trips large repetitive JSON", () => {
    const body = JSON.stringify({
      messages: Array.from({ length: 100 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `message ${i} with some content`,
      })),
    });
    const compressed = compressBody(body);
    expect(compressed.length).toBeLessThan(body.length / 2);
    expect(decompressBody(compressed)).toBe(body);
  });
});

// ---------------------------------------------------------------------------
// findDivergenceOffset
// ---------------------------------------------------------------------------

describe("findDivergenceOffset", () => {
  test("identical strings → returns length", () => {
    expect(findDivergenceOffset("abc", "abc")).toBe(3);
  });

  test("different at start", () => {
    expect(findDivergenceOffset("abc", "xyz")).toBe(0);
  });

  test("different in middle", () => {
    expect(findDivergenceOffset("abcdef", "abcXYZ")).toBe(3);
  });

  test("one is prefix of the other", () => {
    expect(findDivergenceOffset("abc", "abcdef")).toBe(3);
    expect(findDivergenceOffset("abcdef", "abc")).toBe(3);
  });

  test("empty strings", () => {
    expect(findDivergenceOffset("", "")).toBe(0);
    expect(findDivergenceOffset("abc", "")).toBe(0);
    expect(findDivergenceOffset("", "abc")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// mapOffsetToJsonPath
// ---------------------------------------------------------------------------

describe("mapOffsetToJsonPath", () => {
  test("offset 0 → <start>", () => {
    expect(mapOffsetToJsonPath('{"a":1}', 0)).toBe("<start>");
  });

  test("offset past end → <end>", () => {
    expect(mapOffsetToJsonPath('{"a":1}', 100)).toBe("<end>");
  });

  test("top-level key", () => {
    const json = '{"model":"opus","system":"hello"}';
    // Find offset where "system" value starts
    const offset = json.indexOf('"hello"');
    const path = mapOffsetToJsonPath(json, offset);
    expect(path).toBe("system");
  });

  test("nested messages array — later element", () => {
    const json = JSON.stringify({
      model: "opus",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
        { role: "user", content: "CHANGED" },
      ],
    });
    const offset = json.indexOf("CHANGED");
    const path = mapOffsetToJsonPath(json, offset);
    expect(path).toMatch(/messages\[2\]/);
  });

  test("nested messages array — first element (index 0)", () => {
    const json = JSON.stringify({
      model: "opus",
      messages: [
        { role: "user", content: "CHANGED" },
        { role: "assistant", content: "second" },
      ],
    });
    const offset = json.indexOf("CHANGED");
    const path = mapOffsetToJsonPath(json, offset);
    expect(path).toBe("messages[0].content");
  });

  test("system block array (Anthropic cache format)", () => {
    const json = JSON.stringify({
      model: "opus",
      system: [
        {
          type: "text",
          text: "CHANGED_HERE",
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [],
    });
    const offset = json.indexOf("CHANGED_HERE");
    const path = mapOffsetToJsonPath(json, offset);
    expect(path).toBe("system[0].text");
  });

  test("content block array within message", () => {
    const json = JSON.stringify({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "first block" },
            { type: "text", text: "DIVERGED" },
          ],
        },
      ],
    });
    const offset = json.indexOf("DIVERGED");
    const path = mapOffsetToJsonPath(json, offset);
    expect(path).toBe("messages[0].content[1].text");
  });

  test("system prompt change", () => {
    const json = JSON.stringify({
      model: "opus",
      system: "You are a helpful assistant",
      messages: [],
    });
    const offset = json.indexOf("helpful");
    const path = mapOffsetToJsonPath(json, offset);
    expect(path).toBe("system");
  });

  test("tools array", () => {
    const json = JSON.stringify({
      model: "opus",
      tools: [
        { name: "read", description: "Read a file" },
        { name: "write", description: "DIFFERENT" },
      ],
      messages: [],
    });
    const offset = json.indexOf("DIFFERENT");
    const path = mapOffsetToJsonPath(json, offset);
    expect(path).toMatch(/tools\[1\]/);
  });
});

// ---------------------------------------------------------------------------
// inferDivergenceReason
// ---------------------------------------------------------------------------

describe("inferDivergenceReason", () => {
  test("system prompt — bare", () => {
    expect(inferDivergenceReason("system", 100, 100)).toBe(
      "system prompt changed",
    );
  });

  test("system prompt — host block", () => {
    expect(inferDivergenceReason("system[0].text", 100, 100)).toBe(
      "host system prompt changed",
    );
  });

  test("system prompt — bare system[1] boundary on turn 2 is the system[2] insertion", () => {
    // The turn-2 transient: context-bound LTM (system[2]) is injected for the
    // first time, growing the system array. system[1] itself is byte-identical,
    // so the first differing byte lands at the array boundary (`]`→`,`) right
    // after system[1] — mapOffsetToJsonPath reports the BARE "system[1]" path
    // (no ".text" suffix). This is expected and not a real content change.
    expect(inferDivergenceReason("system[1]", 12000, 12500, undefined, 2)).toBe(
      "stable LTM array grew — context-bound LTM (system[2]) first injected on turn 2 (expected, not a real system[1] change)",
    );
  });

  test("system prompt — bare system[1] boundary after turn 2 is a block-insertion shift", () => {
    // A bare-boundary divergence outside the turn-2 transient means the system
    // array structure shifted (a block was inserted/removed) without system[1]'s
    // own content changing.
    expect(inferDivergenceReason("system[1]", 12000, 12500, undefined, 5)).toBe(
      "stable LTM block boundary shifted (system-block insertion)",
    );
  });

  test("system prompt — system[1].text content change is a REAL bust, even on turn 2", () => {
    // Regression for the ses_14b9bf3d… incident: a divergence INSIDE system[1]'s
    // text value (path "system[1].text") means the stable LTM block's bytes
    // genuinely changed — a preference was added/removed/edited by the curator or
    // consolidation mid-session. This busts the entire prefix and must NOT be
    // dismissed as the benign turn-2 array-grew transient (which the old turn===2
    // heuristic did, hiding the incident).
    const realChange =
      "stable LTM block content changed (preference re-curation/consolidation — prefix bust)";
    expect(
      inferDivergenceReason("system[1].text", 12000, 12500, undefined, 2),
    ).toBe(realChange);
    expect(
      inferDivergenceReason("system[1].text", 12000, 12500, undefined, 5),
    ).toBe(realChange);
    // Same when the turn is unknown.
    expect(inferDivergenceReason("system[1].text", 100, 100)).toBe(realChange);
  });

  test("system prompt — context-bound LTM block", () => {
    expect(inferDivergenceReason("system[2].text", 100, 100)).toBe(
      "context-bound LTM changed (non-preference entries re-ranked)",
    );
  });

  test("model change", () => {
    expect(inferDivergenceReason("model", 100, 100)).toBe("model changed");
  });

  test("tools change", () => {
    expect(inferDivergenceReason("tools[1].name", 100, 100)).toBe(
      "tool definitions changed",
    );
  });

  test("message content change — no message count", () => {
    expect(inferDivergenceReason("messages[3].content[1]", 100, 100)).toBe(
      "message at position 3 content changed",
    );
  });

  test("message content change — new message at end", () => {
    expect(inferDivergenceReason("messages[9].content[0]", 100, 120, 10)).toBe(
      "new conversation message (normal turn progression)",
    );
  });

  test("message content change — earlier message modified", () => {
    expect(inferDivergenceReason("messages[3].content[1]", 100, 100, 10)).toBe(
      "earlier message modified at position 3 (window shift or content change)",
    );
  });

  test("message content change — distilled prefix rewrite", () => {
    expect(inferDivergenceReason("messages[0].content[0]", 100, 100, 10)).toBe(
      "distilled conversation prefix changed (meta-distillation rewrite)",
    );
  });

  test("appended content", () => {
    expect(inferDivergenceReason("<end>", 100, 200)).toBe(
      "new message appended (normal conversation growth)",
    );
  });

  test("truncated content", () => {
    expect(inferDivergenceReason("<end>", 200, 100)).toBe(
      "context window compressed (gradient eviction)",
    );
  });
});

// ---------------------------------------------------------------------------
// analyzeCacheTurn — integration
// ---------------------------------------------------------------------------

describe("analyzeCacheTurn — early-divergence log noise gating", () => {
  afterEach(() => vi.restoreAllMocks());

  // Two bodies that diverge at an EARLY message (mid-conversation message
  // change), so isMidConversationMessageChange is true. The only difference
  // between the two scenarios below is the API cache hit-rate.
  const bodyA = JSON.stringify({
    model: "opus",
    messages: [
      { role: "user", content: "first message original" },
      { role: "assistant", content: "reply one" },
      { role: "user", content: "second" },
    ],
  });
  const bodyB = JSON.stringify({
    model: "opus",
    messages: [
      { role: "user", content: "first message CHANGED EARLY" },
      { role: "assistant", content: "reply one" },
      { role: "user", content: "second" },
    ],
  });

  function earlyDivergenceLogs(infoSpy: ReturnType<typeof vi.spyOn>): number {
    return infoSpy.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes("early divergence at byte"),
    ).length;
  }

  test("does NOT log the divergence snippet at INFO when the cache hit-rate is high (normal tail growth)", () => {
    const analytics = makeCacheAnalytics();
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});
    // high hit-rate: cacheRead dominates → ~99%
    const highHit = makeUsage({
      inputTokens: 2,
      cacheReadInputTokens: 100_000,
      cacheCreationInputTokens: 500,
    });
    analyzeCacheTurn(analytics, bodyA, highHit);
    analyzeCacheTurn(analytics, bodyB, highHit);
    expect(earlyDivergenceLogs(infoSpy)).toBe(0);
  });

  test("DOES log the divergence snippet at INFO when the cache hit-rate is low (real bust)", () => {
    const analytics = makeCacheAnalytics();
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});
    // low hit-rate: cacheCreation dominates → big bust
    const lowHit = makeUsage({
      inputTokens: 2,
      cacheReadInputTokens: 5_000,
      cacheCreationInputTokens: 200_000,
    });
    analyzeCacheTurn(analytics, bodyA, lowHit);
    analyzeCacheTurn(analytics, bodyB, lowHit);
    expect(earlyDivergenceLogs(infoSpy)).toBeGreaterThan(0);
  });
});

describe("analyzeCacheTurn", () => {
  test("first turn — no comparison, stores body", () => {
    const analytics = makeCacheAnalytics();
    const body = JSON.stringify({
      model: "opus",
      messages: [{ role: "user", content: "hello" }],
    });

    const result = analyzeCacheTurn(analytics, body, makeUsage());

    expect(result.turn).toBe(1);
    expect(result.divergencePoint).toBe("<first-turn>");
    expect(result.cacheHitRate).toBeCloseTo(0.9);
    expect(analytics.lastRequestBody).not.toBeNull();
    expect(analytics.lastRequestBodyLength).toBe(body.length);
    expect(analytics.turnCount).toBe(1);
    expect(analytics.bustCount).toBe(0);
  });

  test("stores the RAW body (cache_control retained) so the warmer replays breakpoints", () => {
    const analytics = makeCacheAnalytics();
    const body = JSON.stringify({
      model: "opus",
      system: [
        { type: "text", text: "host" },
        {
          type: "text",
          text: "stableLtm",
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [{ name: "t", cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi", cache_control: { type: "ephemeral" } },
          ],
        },
      ],
    });

    analyzeCacheTurn(analytics, body, makeUsage());

    // The warmer replays decompressBody(lastRequestBody); it MUST see the real
    // multi-breakpoint layout, not a normalized (stripped) body that collapses
    // to a single end-of-body breakpoint (the cacheRead=0 bug on large sessions).
    const compressed = analytics.lastRequestBody;
    if (!compressed) throw new Error("lastRequestBody should be set");
    const stored = decompressBody(compressed);
    expect((stored.match(/"cache_control"/g) ?? []).length).toBe(3);
    // The divergence-ratio denominator stays the NORMALIZED length (< raw).
    expect(analytics.lastRequestBodyLength).toBeLessThan(body.length);
  });

  test("comparison normalizes on read: a cache_control-only change is not divergence", () => {
    const analytics = makeCacheAnalytics();
    const withCC = JSON.stringify({
      model: "opus",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "hello world",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
    });
    const withoutCC = JSON.stringify({
      model: "opus",
      messages: [
        { role: "user", content: [{ type: "text", text: "hello world" }] },
      ],
    });

    analyzeCacheTurn(analytics, withCC, makeUsage()); // stores RAW (with cc)
    const result = analyzeCacheTurn(analytics, withoutCC, makeUsage());

    // prevBody is normalized on read, so the only difference (cache_control)
    // vanishes on both sides → identical, NOT a false divergence. (Without the
    // normalize-on-read this would diverge at the cache_control offset.)
    expect(result.prefixMatchPercent).toBe(1);
    expect(result.divergencePoint).toBe("<identical>");
  });

  test("identical request bodies → 100% prefix match", () => {
    const analytics = makeCacheAnalytics();
    const body = JSON.stringify({
      model: "opus",
      messages: [{ role: "user", content: "hello" }],
    });

    analyzeCacheTurn(analytics, body, makeUsage());
    const result = analyzeCacheTurn(analytics, body, makeUsage());

    expect(result.turn).toBe(2);
    expect(result.prefixMatchPercent).toBe(1);
    expect(result.divergencePoint).toBe("<identical>");
    expect(result.divergenceReason).toBe("request bodies are identical");
  });

  test("new message appended → divergence at end", () => {
    const analytics = makeCacheAnalytics();
    const body1 = JSON.stringify({
      model: "opus",
      messages: [{ role: "user", content: "hello" }],
    });
    const body2 = JSON.stringify({
      model: "opus",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
        { role: "user", content: "how are you" },
      ],
    });

    analyzeCacheTurn(analytics, body1, makeUsage());
    const result = analyzeCacheTurn(analytics, body2, makeUsage());

    expect(result.turn).toBe(2);
    // body1 is a prefix of body2 (minus the closing brackets)
    expect(result.prefixMatchPercent).toBeGreaterThan(0.5);
  });

  test("system prompt changed → divergence at system", () => {
    const analytics = makeCacheAnalytics();
    const body1 = JSON.stringify({
      model: "opus",
      system: "You are helpful",
      messages: [{ role: "user", content: "hello" }],
    });
    const body2 = JSON.stringify({
      model: "opus",
      system: "You are DIFFERENT",
      messages: [{ role: "user", content: "hello" }],
    });

    analyzeCacheTurn(analytics, body1, makeUsage());
    const result = analyzeCacheTurn(analytics, body2, makeUsage());

    expect(result.divergencePoint).toBe("system");
    expect(result.divergenceReason).toBe("system prompt changed");
    expect(result.prefixMatchPercent).toBeLessThan(0.5);
  });

  test("confirmed bust when cache_read=0 and cache_creation>0", () => {
    const analytics = makeCacheAnalytics();
    const body = JSON.stringify({ model: "opus", messages: [] });

    // First turn — never a bust
    analyzeCacheTurn(analytics, body, makeUsage());
    expect(analytics.bustCount).toBe(0);

    // Second turn with cache miss
    analyzeCacheTurn(
      analytics,
      body,
      makeUsage({
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 500,
        inputTokens: 100,
      }),
    );
    expect(analytics.bustCount).toBe(1);
  });

  test("no bust when cache_read > 0", () => {
    const analytics = makeCacheAnalytics();
    const body = JSON.stringify({ model: "opus", messages: [] });

    analyzeCacheTurn(analytics, body, makeUsage());
    analyzeCacheTurn(
      analytics,
      body,
      makeUsage({
        cacheReadInputTokens: 500,
        cacheCreationInputTokens: 100,
        inputTokens: 50,
      }),
    );
    expect(analytics.bustCount).toBe(0);
  });

  test("cache hit rate computation", () => {
    const analytics = makeCacheAnalytics();
    const body = JSON.stringify({ model: "opus", messages: [] });

    const result = analyzeCacheTurn(
      analytics,
      body,
      makeUsage({
        cacheReadInputTokens: 800,
        cacheCreationInputTokens: 100,
        inputTokens: 100,
      }),
    );

    // 800 / (800 + 100 + 100) = 0.8
    expect(result.cacheHitRate).toBeCloseTo(0.8);
  });

  test("compressed body is smaller than original", () => {
    const analytics = makeCacheAnalytics();
    const body = JSON.stringify({
      model: "opus",
      messages: Array.from({ length: 50 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `message ${i} with repeated content to compress well`,
      })),
    });

    analyzeCacheTurn(analytics, body, makeUsage());

    expect(analytics.lastRequestBody?.length).toBeLessThan(body.length);
    expect(analytics.lastRequestBodyLength).toBe(body.length);
  });

  test("message content change — divergence in messages", () => {
    const analytics = makeCacheAnalytics();
    const body1 = JSON.stringify({
      model: "opus",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "original response" },
        { role: "user", content: "follow up" },
      ],
    });
    const body2 = JSON.stringify({
      model: "opus",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "MODIFIED response" },
        { role: "user", content: "follow up" },
      ],
    });

    analyzeCacheTurn(analytics, body1, makeUsage());
    const result = analyzeCacheTurn(analytics, body2, makeUsage());

    expect(result.divergencePoint).toMatch(/messages\[1\]/);
    expect(result.divergenceReason).toMatch(
      /message at position 1 content changed/,
    );
  });

  test("tail growth after idle is classified as returning-turn growth, NOT an edit", () => {
    const analytics = makeCacheAnalytics();
    // prev: the stored (pre-idle) body. curr: the returning turn — identical
    // messages plus several NEW ones appended at the tail. prev's messages
    // array CLOSES (`]`) exactly where curr CONTINUES (`,`). Because the
    // divergence lands >2 messages back from curr's tail, the generic
    // classifier calls it "earlier message modified"; the refinement must
    // recognize the `]`→`,` signature and relabel it as tail growth.
    const msg = (r: string, c: string) => ({ role: r, content: c });
    const prev = JSON.stringify({
      model: "opus",
      messages: [
        msg("user", "one"),
        msg("assistant", "two"),
        msg("user", "three"),
        msg("assistant", "four"),
      ],
      tools: [],
    });
    const curr = JSON.stringify({
      model: "opus",
      messages: [
        msg("user", "one"),
        msg("assistant", "two"),
        msg("user", "three"),
        msg("assistant", "four"),
        msg("user", "five"),
        msg("assistant", "six"),
        msg("user", "seven"),
        msg("assistant", "eight"),
      ],
      tools: [],
    });

    analyzeCacheTurn(analytics, prev, makeUsage(), undefined, 4);
    // messageCount=8 → the divergence at the append boundary (≈position 4) is
    // >2 back from the tail, so the generic classifier says "earlier message
    // modified" — exactly the misleading case the refinement must catch.
    const result = analyzeCacheTurn(analytics, curr, makeUsage(), undefined, 8);

    expect(result.divergenceReason).toBe(
      "returning-turn tail growth (previous messages are a prefix — " +
        "cache miss on resume, not a content edit)",
    );
    // Must NOT be the misleading "earlier message modified" verdict.
    expect(result.divergenceReason).not.toMatch(/earlier message modified/);
  });

  test("extending a message's content array is NOT relabeled as tail growth", () => {
    // Sentry bot #15026759: the `]`→`,` transition also fires when a nested
    // `content` array grows (e.g. a tool_use block appended to an existing
    // assistant message). That is a genuine content edit at messages[N] — the
    // path is `messages[N].content[M]`, so the bare-path guard must reject it.
    const analytics = makeCacheAnalytics();
    const t = (text: string) => ({
      role: "user",
      content: [{ type: "text", text }],
    });
    // message[2]'s content array gains a tool_use block. With 6 messages, idx=2
    // is mid-conversation (not <=1, not within the last 2) → the classifier says
    // "earlier message modified", so the outer guard passes and the bare-path
    // guard is what must reject it (path is messages[2].content[1]).
    const prev = JSON.stringify({
      model: "opus",
      messages: [
        t("m0"),
        t("m1"),
        { role: "assistant", content: [{ type: "text", text: "look" }] },
        t("m3"),
        t("m4"),
        t("m5"),
      ],
      tools: [],
    });
    const curr = JSON.stringify({
      model: "opus",
      messages: [
        t("m0"),
        t("m1"),
        {
          role: "assistant",
          content: [
            { type: "text", text: "look" },
            { type: "tool_use", id: "t1", name: "bash", input: {} },
          ],
        },
        t("m3"),
        t("m4"),
        t("m5"),
      ],
      tools: [],
    });

    analyzeCacheTurn(analytics, prev, makeUsage(), undefined, 6);
    const result = analyzeCacheTurn(analytics, curr, makeUsage(), undefined, 6);

    // A real mid-message content edit — the path is nested (messages[2].content),
    // so it must NOT be relabeled as tail growth.
    expect(result.divergencePoint).toMatch(/^messages\[2\]\.content/);
    expect(result.divergenceReason).not.toMatch(/returning-turn tail growth/);
    expect(result.divergenceReason).toMatch(/earlier message modified/);
  });
});

// ---------------------------------------------------------------------------
// analyzeCacheTurn — normalized-body memoization (#1078)
// ---------------------------------------------------------------------------

describe("analyzeCacheTurn — normalized-body memoization", () => {
  // A body that carries volatile tokens (cch + cache_control) so that
  // normalizeBodyForComparison actually transforms it — otherwise the memo and
  // a fresh normalize would be trivially equal even if the memo were ignored.
  function turnBody(userText: string): string {
    return JSON.stringify({
      model: "opus",
      max_tokens: 1000,
      system: [
        { type: "text", text: "host cch=deadbeef;" },
        {
          type: "text",
          text: "stable ltm",
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: userText,
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
    });
  }

  test("stores the NORMALIZED body compressed, alongside the RAW body", () => {
    const analytics = makeCacheAnalytics();
    const body = turnBody("hello");

    analyzeCacheTurn(analytics, body, makeUsage());

    // Raw body retains cache_control for the warmer …
    const rawStored = analytics.lastRequestBody;
    if (!rawStored) throw new Error("lastRequestBody should be set");
    expect(decompressBody(rawStored)).toBe(body);
    // … while the memo holds exactly the normalized form (cache_control + cch
    // stripped), i.e. what a re-normalization would have produced.
    const memoStored = analytics.lastNormalizedBody;
    if (!memoStored) throw new Error("lastNormalizedBody should be set");
    expect(decompressBody(memoStored)).toBe(normalizeBodyForComparison(body));
  });

  test("memoized path is byte-identical to the decompress+normalize fallback", () => {
    const body1 = turnBody("hello");
    const body2 = turnBody("hello there, how are you today");

    // Path A: normal flow — turn 2 reuses the memo from turn 1.
    const a = makeCacheAnalytics();
    analyzeCacheTurn(a, body1, makeUsage());
    const withMemo = analyzeCacheTurn(a, body2, makeUsage());

    // Path B: identical inputs, but drop the memo after turn 1 so turn 2 is
    // forced down the legacy decompress(raw)+normalize fallback.
    const b = makeCacheAnalytics();
    analyzeCacheTurn(b, body1, makeUsage());
    b.lastNormalizedBody = undefined;
    const withFallback = analyzeCacheTurn(b, body2, makeUsage());

    // Every divergence-derived field must match — the memo is a pure
    // performance shortcut with no behavioral effect.
    expect(withMemo.prefixMatchBytes).toBe(withFallback.prefixMatchBytes);
    expect(withMemo.prefixMatchPercent).toBe(withFallback.prefixMatchPercent);
    expect(withMemo.divergencePoint).toBe(withFallback.divergencePoint);
    expect(withMemo.divergenceReason).toBe(withFallback.divergenceReason);
    expect(a.lastRequestBodyLength).toBe(b.lastRequestBodyLength);
  });

  test("the memo actually drives the comparison (mutation guard)", () => {
    // If the reader ignored lastNormalizedBody and always re-normalized the raw
    // body, corrupting the memo would have no effect. Prove it is consulted: a
    // corrupted memo makes an otherwise-identical turn report divergence.
    const analytics = makeCacheAnalytics();
    const body = turnBody("hello");

    analyzeCacheTurn(analytics, body, makeUsage());
    analytics.lastNormalizedBody = compressBody(
      normalizeBodyForComparison(turnBody("a completely different message")),
    );

    const result = analyzeCacheTurn(analytics, body, makeUsage());

    // Same raw body twice would normally be <identical>; the poisoned memo
    // forces an early divergence instead.
    expect(result.divergencePoint).not.toBe("<identical>");
    expect(result.prefixMatchPercent).toBeLessThan(1);
  });

  test("a stale memo left after a reset is never consulted", () => {
    // Reset-safety invariant: `lastRequestBody === null` is the guard, so a
    // stale `lastNormalizedBody` left behind by an earlier turn must NOT leak
    // into a later comparison. Simulate a mid-session cache reset that nulls the
    // raw body but (adversarially) leaves a poisoned memo behind.
    const analytics = makeCacheAnalytics();
    analyzeCacheTurn(analytics, turnBody("first epoch"), makeUsage());

    // Reset the raw body (what every reset site does) but keep a poisoned memo.
    analytics.lastRequestBody = null;
    analytics.lastNormalizedBody = compressBody(
      normalizeBodyForComparison(turnBody("poison from a previous epoch")),
    );

    // Next turn: the null guard must skip comparison entirely (first-turn),
    // never touching the stale memo, and re-establish fresh state.
    const afterReset = analyzeCacheTurn(
      analytics,
      turnBody("second"),
      makeUsage(),
    );
    expect(afterReset.divergencePoint).toBe("<first-turn>");

    // The turn after that repeats the same body: it must be identical, proving
    // the memo now in effect is the fresh one from `afterReset`, not the poison.
    const repeat = analyzeCacheTurn(analytics, turnBody("second"), makeUsage());
    expect(repeat.divergencePoint).toBe("<identical>");
    expect(repeat.prefixMatchPercent).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// normalizeBodyForComparison
// ---------------------------------------------------------------------------

describe("normalizeBodyForComparison", () => {
  test("replaces cch= hex hash with fixed placeholder", () => {
    const body =
      '{"system":[{"type":"text","text":"entrypoint=cli; cch=f0e67;\\nYou are Claude Code"}]}';
    const normalized = normalizeBodyForComparison(body);
    expect(normalized).toBe(
      '{"system":[{"type":"text","text":"entrypoint=cli; cch=__;\\nYou are Claude Code"}]}',
    );
  });

  test("handles varying cch lengths", () => {
    expect(normalizeBodyForComparison("cch=abc;")).toBe("cch=__;");
    expect(normalizeBodyForComparison("cch=abcdef0123;")).toBe("cch=__;");
    expect(normalizeBodyForComparison("cch=A1B2C3;")).toBe("cch=__;");
  });

  test("does not modify bodies without cch=", () => {
    const body = '{"model":"opus","system":"You are Claude"}';
    expect(normalizeBodyForComparison(body)).toBe(body);
  });

  test("handles multiple cch= occurrences", () => {
    const body = "cch=aaa; some text cch=bbb;";
    expect(normalizeBodyForComparison(body)).toBe("cch=__; some text cch=__;");
  });

  test("normalizes backtick/quote-terminated cch= tokens in content", () => {
    // Markdown code span (`` `cch=2d825` ``) and quoted forms previously
    // slipped past the `;`-only pattern, producing false-positive divergence.
    expect(normalizeBodyForComparison("note: `cch=2d825` end")).toBe(
      "note: `cch=__` end",
    );
    expect(normalizeBodyForComparison('"cch=64ee6"')).toBe('"cch=__"');
    // Two turns with different content hashes normalize identically → no
    // false-positive divergence.
    expect(normalizeBodyForComparison("x `cch=2d825` y")).toBe(
      normalizeBodyForComparison("x `cch=928b9` y"),
    );
  });

  test("normalizes cc_version suffix to fixed placeholder", () => {
    const body =
      '{"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.37.5a7; cc_entrypoint=cli; cch=__;\\nYou are Claude Code"}]}';
    const normalized = normalizeBodyForComparison(body);
    expect(normalized).toBe(
      '{"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.37.___; cc_entrypoint=cli; cch=__;\\nYou are Claude Code"}]}',
    );
  });

  test("preserves cc_version base version (only strips suffix)", () => {
    const body1 = normalizeBodyForComparison("cc_version=2.1.37.abc;");
    const body2 = normalizeBodyForComparison("cc_version=2.1.37.def;");
    expect(body1).toBe(body2); // same base version → identical

    const body3 = normalizeBodyForComparison("cc_version=2.2.0.abc;");
    expect(body3).not.toBe(body1); // different base version → different
  });

  test("normalizes top-level max_tokens", () => {
    const body =
      '{"model":"claude-sonnet-4-20250514","max_tokens":16000,"stream":true}';
    const normalized = normalizeBodyForComparison(body);
    expect(normalized).toBe(
      '{"model":"claude-sonnet-4-20250514","max_tokens":0,"stream":true}',
    );
  });

  test("does not normalize max_tokens in message content", () => {
    const body =
      '{"model":"claude-sonnet-4-20250514","max_tokens":8192,"stream":true,"messages":[{"content":"set max_tokens to 16000"}]}';
    const normalized = normalizeBodyForComparison(body);
    // Top-level normalized, but content preserved
    expect(normalized).toContain('"max_tokens":0,');
    expect(normalized).toContain("set max_tokens to 16000");
  });

  test("handles different max_tokens digit counts identically", () => {
    const make = (n: number) =>
      `{"model":"claude-sonnet-4-20250514","max_tokens":${n},"stream":true}`;
    const a = normalizeBodyForComparison(make(4096));
    const b = normalizeBodyForComparison(make(16000));
    const c = normalizeBodyForComparison(make(128000));
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  test("strips the moving cache_control ephemeral breakpoint", () => {
    // Anthropic clients place an ephemeral cache breakpoint on the LAST
    // cacheable block; it advances to the newest message every turn. Left
    // un-normalized, the byte at the previous breakpoint's position always
    // differs from the next turn's body, producing a false-positive
    // mid-conversation divergence (observed on session 1PgnnnH43rJVO5nyX).
    const body =
      '{"messages":[{"role":"assistant","content":[{"type":"text","text":"hi","cache_control":{"type":"ephemeral"}}]}]}';
    expect(normalizeBodyForComparison(body)).toBe(
      '{"messages":[{"role":"assistant","content":[{"type":"text","text":"hi"}]}]}',
    );
  });

  test("append-only turns differing only by a moved breakpoint normalize identically up to the new tail", () => {
    // Turn N: breakpoint on the last (assistant) message.
    const prev =
      '{"messages":[' +
      '{"role":"user","content":[{"type":"text","text":"q1"}]},' +
      '{"role":"assistant","content":[{"type":"text","text":"a1","cache_control":{"type":"ephemeral"}}]}' +
      "]}";
    // Turn N+1: breakpoint moved to the newly-appended message; the old
    // message no longer carries the marker.
    const curr =
      '{"messages":[' +
      '{"role":"user","content":[{"type":"text","text":"q1"}]},' +
      '{"role":"assistant","content":[{"type":"text","text":"a1"}]},' +
      '{"role":"user","content":[{"type":"text","text":"q2","cache_control":{"type":"ephemeral"}}]}' +
      "]}";
    const nPrev = normalizeBodyForComparison(prev);
    const nCurr = normalizeBodyForComparison(curr);
    // After normalization, the entire previous body up to its closing brackets
    // must be a byte-identical prefix of the current body — i.e. the only
    // change is the genuine append, NOT a mid-conversation edit at the old
    // breakpoint position. (prev ends with the array+object close `]}` that
    // curr replaces with `,{...new message...}]}`.)
    const prevPrefix = nPrev.slice(0, nPrev.length - "]}".length);
    expect(nCurr.startsWith(prevPrefix)).toBe(true);
    // The first real divergence is therefore at or after message index 1's
    // end — never inside messages[0] or messages[1] content (the false
    // "earlier message modified at position N" mislabel).
    const offset = findDivergenceOffset(nPrev, nCurr);
    expect(offset).toBeGreaterThanOrEqual(prevPrefix.length);
    // The divergence must NOT fall inside an early message's CONTENT (the
    // false "earlier message modified at position N" mislabel). A structural
    // boundary after message 1 is fine; an edit inside messages[0/1].content
    // is not.
    const path = mapOffsetToJsonPath(nCurr, offset);
    expect(path.startsWith("messages[0].content")).toBe(false);
    expect(path.startsWith("messages[1].content")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// analyzeCacheTurn — cch= normalization
// ---------------------------------------------------------------------------

describe("analyzeCacheTurn — cch normalization", () => {
  test("treats bodies differing only in cch= as identical", () => {
    const analytics = makeCacheAnalytics();
    const body1 = JSON.stringify({
      system: [
        {
          type: "text",
          text: "entrypoint=cli; cch=f0e67;\nYou are Claude Code",
        },
      ],
      messages: [{ role: "user", content: "hello" }],
    });
    const body2 = JSON.stringify({
      system: [
        {
          type: "text",
          text: "entrypoint=cli; cch=35c93;\nYou are Claude Code",
        },
      ],
      messages: [{ role: "user", content: "hello" }],
    });

    analyzeCacheTurn(analytics, body1, makeUsage());
    const result = analyzeCacheTurn(analytics, body2, makeUsage());

    expect(result.divergencePoint).toBe("<identical>");
    expect(result.divergenceReason).toBe("request bodies are identical");
  });

  test("still detects real system prompt changes alongside cch=", () => {
    const analytics = makeCacheAnalytics();
    const body1 = JSON.stringify({
      system: [
        {
          type: "text",
          text: "entrypoint=cli; cch=f0e67;\nYou are Claude Code v1",
        },
      ],
      messages: [{ role: "user", content: "hello" }],
    });
    const body2 = JSON.stringify({
      system: [
        {
          type: "text",
          text: "entrypoint=cli; cch=35c93;\nYou are Claude Code v2",
        },
      ],
      messages: [{ role: "user", content: "hello" }],
    });

    analyzeCacheTurn(analytics, body1, makeUsage());
    const result = analyzeCacheTurn(analytics, body2, makeUsage());

    expect(result.divergencePoint).toMatch(/system/);
    expect(result.prefixMatchPercent).toBeGreaterThan(0.5);
  });

  test("treats bodies differing only in cc_version suffix as identical", () => {
    const analytics = makeCacheAnalytics();
    const make = (suffix: string) =>
      JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 8192,
        stream: true,
        system: [
          {
            type: "text",
            text: `x-anthropic-billing-header: cc_version=2.1.37.${suffix}; cc_entrypoint=cli; cch=abc12;\nYou are Claude Code`,
          },
        ],
        messages: [{ role: "user", content: "hello" }],
      });

    analyzeCacheTurn(analytics, make("aba"), makeUsage());
    const result = analyzeCacheTurn(analytics, make("5a7"), makeUsage());

    expect(result.divergencePoint).toBe("<identical>");
    expect(result.divergenceReason).toBe("request bodies are identical");
  });

  test("treats bodies differing only in max_tokens as identical", () => {
    const analytics = makeCacheAnalytics();
    const make = (tokens: number) =>
      JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: tokens,
        stream: true,
        system: [{ type: "text", text: "You are Claude Code" }],
        messages: [{ role: "user", content: "hello" }],
      });

    analyzeCacheTurn(analytics, make(16000), makeUsage());
    const result = analyzeCacheTurn(analytics, make(8192), makeUsage());

    expect(result.divergencePoint).toBe("<identical>");
    expect(result.divergenceReason).toBe("request bodies are identical");
  });
});

// ---------------------------------------------------------------------------
// categorizeBust — previously had ZERO test coverage. This classifier is the
// telemetry oracle that distinguishes a raw-window march ("window-shift") from
// other bust causes; the layer-1 pin-march bug escaped because nothing tested it.
// ---------------------------------------------------------------------------

describe("categorizeBust", () => {
  function makeAnalysis(
    overrides: Partial<CacheTurnAnalysis> = {},
  ): CacheTurnAnalysis {
    // A full cache bust (cacheRead=0, cacheCreation>0) on a steady-state turn,
    // so categorizeBust classifies by divergence location.
    return {
      turn: 5,
      cacheRead: 0,
      cacheCreation: 100_000,
      inputTokens: 2,
      cacheHitRate: 0,
      prefixMatchBytes: 0,
      prefixMatchPercent: 0,
      divergencePoint: "messages[42].content[0].text",
      divergenceReason: "",
      prevSnippet: undefined,
      currSnippet: undefined,
      system0Bust: false,
      relocatable: false,
      ...overrides,
    };
  }

  test("classifies a mid-history message divergence as window-shift", () => {
    // messages[idx>1] divergence on a full bust = raw window eviction shifted
    // message positions — the exact signature of the layer-1 pin march.
    expect(
      categorizeBust(
        makeAnalysis({ divergencePoint: "messages[42].content[0].text" }),
        false,
      ),
    ).toBe("window-shift");
    expect(
      categorizeBust(makeAnalysis({ divergencePoint: "messages[2]" }), false),
    ).toBe("window-shift");
  });

  test("classifies an early-message divergence as prefix-rewrite", () => {
    // messages[0/1] are the synthetic distilled prefix → meta-distillation rewrite.
    expect(
      categorizeBust(makeAnalysis({ divergencePoint: "messages[0]" }), false),
    ).toBe("prefix-rewrite");
    expect(
      categorizeBust(
        makeAnalysis({ divergencePoint: "messages[1].content[0].text" }),
        false,
      ),
    ).toBe("prefix-rewrite");
  });

  test("classifies system/tools divergences distinctly", () => {
    expect(
      categorizeBust(makeAnalysis({ divergencePoint: "tools[0].name" }), false),
    ).toBe("tools-change");
  });

  test("splits host (system[0]) vs LTM (system[1]/[2]) system busts", () => {
    // system[0] = agent-owned host prompt — the CacheAligner relocation target.
    expect(
      categorizeBust(
        makeAnalysis({ divergencePoint: "system[0].text" }),
        false,
      ),
    ).toBe("system-host-change");
    expect(
      categorizeBust(makeAnalysis({ divergencePoint: "system[0]" }), false),
    ).toBe("system-host-change");
    // system[1]/[2] = lore's own LTM blocks — already managed by 3-block pinning.
    expect(
      categorizeBust(
        makeAnalysis({ divergencePoint: "system[1].text" }),
        false,
      ),
    ).toBe("system-ltm-change");
    expect(
      categorizeBust(makeAnalysis({ divergencePoint: "system[2]" }), false),
    ).toBe("system-ltm-change");
    // Bare "system" (non-array string prompt) → treated as LTM-side / generic.
    expect(
      categorizeBust(makeAnalysis({ divergencePoint: "system" }), false),
    ).toBe("system-ltm-change");
  });

  test("does not classify a cache-hit turn as a window-shift", () => {
    // cacheRead > 0 → incremental append, never a bust regardless of divergence.
    expect(
      categorizeBust(
        makeAnalysis({
          cacheRead: 50_000,
          cacheCreation: 1_000,
          divergencePoint: "messages[42].content[0].text",
        }),
        false,
      ),
    ).toBe("incremental");
  });

  test("classifies messages[0/1] divergence as prefix-rewrite even with partial cache hit", () => {
    // Partial cache hit + divergence at messages[0/1] = meta-distillation
    // rewrote the distilled prefix even though some earlier prefix matched.
    // This MUST classify as prefix-rewrite (not incremental) so the
    // consecutive-bust counter exempts it — the cause is Lore's own
    // meta-distillation pipeline, not user-context growth.
    // Regression test for the false "unsustainable conversation" warnings
    // observed on sessions with sustained meta-distillation activity.
    expect(
      categorizeBust(
        makeAnalysis({
          cacheRead: 53_412,
          cacheCreation: 109_745,
          divergencePoint: "messages[1].content[0].text",
        }),
        false,
      ),
    ).toBe("prefix-rewrite");
    expect(
      categorizeBust(
        makeAnalysis({
          cacheRead: 53_412,
          cacheCreation: 109_745,
          divergencePoint: "messages[0]",
        }),
        false,
      ),
    ).toBe("prefix-rewrite");
  });

  test("messages[0/1] divergence with cacheCreation=0 stays 'incremental' (no-op turn is not a rewrite)", () => {
    // A divergence reported at messages[0/1] with NO new cache content is
    // a no-op turn (bustRatio=0 — the counter won't advance regardless of
    // label). "prefix-rewrite" implies a real rewrite happened, so this
    // case is semantically "incremental" not "prefix-rewrite". Seer review
    // on PR #943 flagged the missing distinction (LOW severity): the
    // cacheCreation > 0 guard in categorizeBust ensures the label stays
    // accurate even when bustRatio would also be 0.
    expect(
      categorizeBust(
        makeAnalysis({
          cacheRead: 50_000,
          cacheCreation: 0,
          divergencePoint: "messages[1].content[0].text",
        }),
        false,
      ),
    ).toBe("incremental");
    expect(
      categorizeBust(
        makeAnalysis({
          cacheRead: 50_000,
          cacheCreation: 0,
          divergencePoint: "messages[0]",
        }),
        false,
      ),
    ).toBe("incremental");
  });

  test("full bust on post-idle + messages[0/1] divergence is 'prefix-rewrite' (structural cause wins over idle context)", () => {
    // Pin down the chosen label for a full bust at messages[0/1] on an
    // idle resume. Pre-PR this returned "idle-resume"; post-PR it returns
    // "prefix-rewrite" because the new messages[0/1] check fires before
    // the post-idle branch. The counter is exempt in both cases (both
    // causes are OR'd in gradient.ts:323), so the bust-pressure semantics
    // are unchanged — but the cause label feeds telemetry
    // (setCacheAnalyticsAttributes, emitCacheBustMetric,
    // recordCacheBustObservation), and "prefix-rewrite" is the more
    // specific signal (a structural prefix change is the dominant cause;
    // "idle-resume" is about cache TTL, not what changed in the prefix).
    // Adversarial review NIT on PR #943: pin the label so future readers
    // don't accidentally regress to the old behavior.
    expect(
      categorizeBust(
        makeAnalysis({
          cacheRead: 0,
          cacheCreation: 100_000,
          divergencePoint: "messages[0]",
        }),
        true,
      ),
    ).toBe("prefix-rewrite");
    expect(
      categorizeBust(
        makeAnalysis({
          cacheRead: 0,
          cacheCreation: 100_000,
          divergencePoint: "messages[1].content[0].text",
        }),
        true,
      ),
    ).toBe("prefix-rewrite");
  });

  test("post-idle cold cache is idle-resume, not window-shift", () => {
    expect(
      categorizeBust(
        makeAnalysis({ divergencePoint: "messages[42].content[0].text" }),
        true,
      ),
    ).toBe("idle-resume");
  });

  test("first turn is never a bust", () => {
    expect(
      categorizeBust(
        makeAnalysis({ turn: 1, divergencePoint: "<first-turn>" }),
        false,
      ),
    ).toBe("first-turn");
  });
});

// ---------------------------------------------------------------------------
// classifyRelocatableSpan — the measure-first gate's relocatability oracle
// (issue #791). Given the diverging region between two bodies/windows, decides
// whether the CHANGED token is a relocatable dynamic span (date/time/uuid/...)
// vs a genuine prose/structural change. Known volatile tokens (cch, cc_version,
// max_tokens, cache_control) are already normalized out BEFORE this runs, so
// this classifies the residual divergence only.
// ---------------------------------------------------------------------------

describe("classifyRelocatableSpan", () => {
  test("ISO date change is relocatable", () => {
    expect(
      classifyRelocatableSpan(
        'text":"Current Date: 2024-12-15 — be helpful"',
        'text":"Current Date: 2024-12-16 — be helpful"',
      ),
    ).toBe(true);
  });

  test("date change where only one digit differs expands to the full token", () => {
    // The minimal byte diff is "5"→"6"; the classifier must expand to the full
    // "2024-12-16" token before testing, otherwise the ISO pattern won't match.
    expect(
      classifyRelocatableSpan("at 2024-12-15 end", "at 2024-12-16 end"),
    ).toBe(true);
  });

  test("slash date change is relocatable", () => {
    expect(classifyRelocatableSpan("on 12/15/2024 x", "on 12/16/2024 x")).toBe(
      true,
    );
  });

  test("clock time change is relocatable", () => {
    expect(classifyRelocatableSpan("at 09:30 today", "at 11:45 today")).toBe(
      true,
    );
  });

  test("a BARE day-of-week name change is NOT relocatable (precision)", () => {
    // "Monday"→"Tuesday" with no numeric date component is indistinguishable
    // from a prose word swap; matching it risks false positives ("Maybe",
    // "Marketing"). Deliberately treated as a miss — agents emit numeric dates.
    expect(classifyRelocatableSpan("is Monday now", "is Tuesday now")).toBe(
      false,
    );
  });

  test("a BARE month name change is NOT relocatable (precision)", () => {
    // "January"→"February" alone would also match prose like "March"/"Mayor";
    // numeric date forms are covered by the ISO/slash patterns instead.
    expect(classifyRelocatableSpan("in January here", "in February here")).toBe(
      false,
    );
  });

  test("UUID change is relocatable", () => {
    expect(
      classifyRelocatableSpan(
        "id abcdef12-3456-7890-abcd-ef1234567890 x",
        "id abcdef12-3456-7890-abcd-ef1234567891 x",
      ),
    ).toBe(true);
  });

  test("long digit run (epoch/counter) change is relocatable", () => {
    expect(classifyRelocatableSpan("ts 1700000000 x", "ts 1700000600 x")).toBe(
      true,
    );
  });

  test("prose word change is NOT relocatable", () => {
    expect(
      classifyRelocatableSpan("You are helpful.", "You are concise."),
    ).toBe(false);
  });

  test("prose words that look like month prefixes are NOT relocatable", () => {
    // Regression guard: a greedy month-name pattern would match these; the
    // gate must not count host-prompt prose rewrites as relocatable.
    expect(classifyRelocatableSpan("a Decision now", "a Choice now")).toBe(
      false,
    );
    expect(
      classifyRelocatableSpan("do Marketing work", "do Janitor work"),
    ).toBe(false);
    expect(classifyRelocatableSpan("say Maybe today", "say Never today")).toBe(
      false,
    );
  });

  test("identical input is not relocatable", () => {
    expect(classifyRelocatableSpan("same text", "same text")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// analyzeCacheTurn — system0Bust / relocatable enrichment (issue #791)
// ---------------------------------------------------------------------------

describe("analyzeCacheTurn — system[0] relocatability fields", () => {
  function body(date: string, system1?: string): string {
    const system: Array<{ type: string; text: string }> = [
      { type: "text", text: `Host prompt. Today: ${date}` },
    ];
    if (system1 !== undefined) system.push({ type: "text", text: system1 });
    return JSON.stringify({
      model: "claude-3",
      max_tokens: 1000,
      system,
      messages: [{ role: "user", content: "hi" }],
    });
  }

  test("flags a relocatable system[0] date bust", () => {
    const analytics = makeCacheAnalytics();
    // Turn 1: seed prior body (first turn never compares).
    analyzeCacheTurn(
      analytics,
      body("2024-12-15"),
      makeUsage({ cacheReadInputTokens: 0, cacheCreationInputTokens: 5000 }),
    );
    // Turn 2: only the system[0] date changed → full bust.
    const result = analyzeCacheTurn(
      analytics,
      body("2024-12-16"),
      makeUsage({ cacheReadInputTokens: 0, cacheCreationInputTokens: 5000 }),
    );
    expect(result.divergencePoint.startsWith("system[0]")).toBe(true);
    expect(result.system0Bust).toBe(true);
    expect(result.relocatable).toBe(true);
  });

  test("does not flag a system[1] (LTM) change as system0/relocatable", () => {
    const analytics = makeCacheAnalytics();
    analyzeCacheTurn(
      analytics,
      body("2024-12-15", "Pref: use tabs"),
      makeUsage({ cacheReadInputTokens: 0, cacheCreationInputTokens: 5000 }),
    );
    const result = analyzeCacheTurn(
      analytics,
      body("2024-12-15", "Pref: use spaces"),
      makeUsage({ cacheReadInputTokens: 0, cacheCreationInputTokens: 5000 }),
    );
    expect(result.divergencePoint.startsWith("system[1]")).toBe(true);
    expect(result.system0Bust).toBe(false);
    expect(result.relocatable).toBe(false);
  });

  test("defaults system0Bust/relocatable to false on the first turn", () => {
    const analytics = makeCacheAnalytics();
    const result = analyzeCacheTurn(analytics, body("2024-12-15"), makeUsage());
    expect(result.system0Bust).toBe(false);
    expect(result.relocatable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Strategy-aware warn gating: a dramatic hit-rate drop on a session whose
// cache strategy is cool-* is by DESIGN (we chose to let the prefix go cold)
// and the WARN is just noise in that case. hold-warm sessions and the
// no-strategy-supplied default still emit the WARN.
// ---------------------------------------------------------------------------

describe("analyzeCacheTurn — strategy-aware dramatic-drop warn gating", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Clear the log.warn spy between tests — `vi.spyOn` accumulates calls
    // across the whole describe block by default, which would let one test's
    // emitted warn leak into another test's assertion.
    warn = vi.spyOn(log, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  const dramaticBodyA = JSON.stringify({
    system: "stable host",
    messages: [{ role: "user", content: "first user message here" }],
  });
  // Same system, divergent messages → bust (low hit rate, divergence at messages[0])
  const dramaticBodyB = JSON.stringify({
    system: "stable host",
    messages: [
      { role: "user", content: "first user message here (REWRITTEN)" },
    ],
  });

  // The dramatic-drop warn is gated on `analytics.turnCount > 2`, so we need
  // a 3-turn sequence: (1) establish a baseline hit rate, (2) maintain the
  // hit rate, (3) drop dramatically → the warn fires on turn 3.
  function runDramaticDropScenario(
    analytics: ReturnType<typeof makeCacheAnalytics>,
    cacheStrategy?: "hold-warm" | "cool-bust" | "cool-full-write",
  ): void {
    // Turn 1: high cache hit (900 read of 1000) → prevHitRate baseline 0.9
    analyzeCacheTurn(analytics, dramaticBodyA, makeUsage());
    // Turn 2: same high-hit baseline so the previous-turn cacheRead stays at 900
    analyzeCacheTurn(analytics, dramaticBodyA, makeUsage());
    // Turn 3: cold (0 read, 1000 input) → drop from 0.9 → 0 (>40% of 0.9)
    analyzeCacheTurn(
      analytics,
      dramaticBodyB,
      makeUsage({
        inputTokens: 1000,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      }),
      undefined,
      undefined,
      cacheStrategy,
    );
  }

  test("emits the dramatic-drop warn when cacheStrategy is omitted (default behavior)", () => {
    runDramaticDropScenario(makeCacheAnalytics());

    const calls = warn.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(
      calls.some((c: string) => c.includes("dramatic hit rate drop")),
    ).toBe(true);
  });

  test("emits the dramatic-drop warn when cacheStrategy is 'hold-warm'", () => {
    runDramaticDropScenario(makeCacheAnalytics(), "hold-warm");

    const calls = warn.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(
      calls.some((c: string) => c.includes("dramatic hit rate drop")),
    ).toBe(true);
  });

  test("suppresses the dramatic-drop warn when cacheStrategy is 'cool-bust'", () => {
    runDramaticDropScenario(makeCacheAnalytics(), "cool-bust");

    const calls = warn.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(
      calls.some((c: string) => c.includes("dramatic hit rate drop")),
    ).toBe(false);
  });

  test("suppresses the dramatic-drop warn when cacheStrategy is 'cool-full-write'", () => {
    runDramaticDropScenario(makeCacheAnalytics(), "cool-full-write");

    const calls = warn.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(
      calls.some((c: string) => c.includes("dramatic hit rate drop")),
    ).toBe(false);
  });
});
