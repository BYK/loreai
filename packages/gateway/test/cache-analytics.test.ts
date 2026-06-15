import { describe, test, expect } from "vitest";
import {
  compressBody,
  decompressBody,
  findDivergenceOffset,
  mapOffsetToJsonPath,
  inferDivergenceReason,
  analyzeCacheTurn,
  categorizeBust,
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

  test("system prompt — system[1] divergence on turn 2 is the system[2] insertion", () => {
    // The turn-2 transient: context-bound LTM (system[2]) is injected for the
    // first time, shifting the array boundary so the byte diff lands at system[1].
    expect(
      inferDivergenceReason("system[1].text", 12000, 12500, undefined, 2),
    ).toBe(
      "stable LTM pinned — context-bound LTM (system[2]) first injected on turn 2 (expected, not a real system[1] change)",
    );
  });

  test("system prompt — system[1] divergence after turn 2 is ambiguous (not over-claimed)", () => {
    // After turn 2 we can't cheaply tell a real preference re-curation from a
    // block insertion (body delta is dominated by message growth), so we report
    // the honest ambiguous wording rather than asserting a specific cause.
    expect(
      inferDivergenceReason("system[1].text", 12000, 12500, undefined, 5),
    ).toBe(
      "stable LTM block diverged (preference re-curation or system-block insertion)",
    );
    // Same when the turn is unknown.
    expect(inferDivergenceReason("system[1].text", 100, 100)).toBe(
      "stable LTM block diverged (preference re-curation or system-block insertion)",
    );
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
      categorizeBust(makeAnalysis({ divergencePoint: "system[2]" }), false),
    ).toBe("system-change");
    expect(
      categorizeBust(makeAnalysis({ divergencePoint: "tools[0].name" }), false),
    ).toBe("tools-change");
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
