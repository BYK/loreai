import { describe, expect, test } from "vitest";
import {
  type AnthropicCacheOptions,
  buildAnthropicRequest,
} from "../src/translate/anthropic";
import {
  type CacheSegmentDigest,
  cacheSegmentDigest,
  classifyWarmupProbe,
  isWarmupProbeEnabled,
} from "../src/cache-analytics";
import type { GatewayRequest } from "../src/translate/types";

function req(prefixText: string, tailText: string): GatewayRequest {
  return {
    protocol: "anthropic",
    model: "claude-opus-4-8",
    system: "host prompt",
    maxTokens: 1024,
    stream: true,
    rawHeaders: {},
    metadata: {},
    tools: [
      { name: "bash", description: "run", inputSchema: { type: "object" } },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: prefixText }] },
      { role: "assistant", content: [{ type: "text", text: "ack" }] },
      { role: "user", content: [{ type: "text", text: tailText }] },
    ],
  };
}

const opts: AnthropicCacheOptions = {
  systemTTL: "1h",
  stableLtmSystem: "STABLE LTM",
  ltmSystem: "context LTM",
  cacheTools: true,
  cacheConversation: true,
  conversationTTL: "5m",
  distilledPrefixLength: 2,
};

function digest(prefixText: string, tailText: string): CacheSegmentDigest {
  const body = JSON.stringify(
    buildAnthropicRequest(req(prefixText, tailText), opts).body,
  );
  const d = cacheSegmentDigest(body);
  if (!d) throw new Error("expected a non-null digest");
  return d;
}

describe("cacheSegmentDigest", () => {
  test("returns stable hashes and 4 breakpoints for a distilled body", () => {
    const d = digest("prefix v1", "tail A");
    expect(d.bpCount).toBe(4); // system[1], tools, distilled-prefix, tail
    expect(d.systemBlocks).toBe(3); // host + stableLtm + contextLtm
    expect(d.headSha).toMatch(/^[0-9a-f]{12}$/);
  });

  test("head/tools/prefix stay identical when only the conversation tail grows", () => {
    const a = digest("prefix v1", "tail A");
    const b = digest("prefix v1", "tail A then B");
    expect(b.headSha).toBe(a.headSha); // head is byte-stable across tail growth
    expect(b.toolsSha).toBe(a.toolsSha);
    expect(b.prefixSha).toBe(a.prefixSha); // distilled prefix unchanged
  });

  test("prefix hash changes when the distilled prefix is rewritten (meta-distillation)", () => {
    const a = digest("prefix v1", "tail A");
    const b = digest("prefix v2 REWRITTEN", "tail A");
    expect(b.prefixSha).not.toBe(a.prefixSha); // detects prefix drift
    expect(b.headSha).toBe(a.headSha); // but the head is untouched
  });

  test("returns null on unparseable body (never throws on the request path)", () => {
    expect(cacheSegmentDigest("not json{")).toBeNull();
  });

  test("probe is off by default", () => {
    const prev = process.env.LORE_WARMUP_PROBE;
    delete process.env.LORE_WARMUP_PROBE;
    expect(isWarmupProbeEnabled()).toBe(false);
    process.env.LORE_WARMUP_PROBE = "1";
    expect(isWarmupProbeEnabled()).toBe(true);
    if (prev === undefined) delete process.env.LORE_WARMUP_PROBE;
    else process.env.LORE_WARMUP_PROBE = prev;
  });
});

describe("classifyWarmupProbe", () => {
  const base = {
    headMatch: true,
    cacheReadTokens: 100,
    cacheLikelyAlive: true,
  };

  test("no baseline before any real turn analyzed", () => {
    expect(classifyWarmupProbe({ ...base, hasBaseline: false })).toMatch(
      /no baseline/,
    );
  });

  test("head mismatch => HEAD DIVERGENCE (the body-bug signal)", () => {
    expect(
      classifyWarmupProbe({ ...base, hasBaseline: true, headMatch: false }),
    ).toMatch(/HEAD DIVERGENCE/);
  });

  test("head match with a read is healthy", () => {
    expect(
      classifyWarmupProbe({
        ...base,
        hasBaseline: true,
        cacheReadTokens: 5000,
      }),
    ).toBe("head identical to last real turn");
  });

  test("head match + read=0 while cache should be live => EVICTION", () => {
    expect(
      classifyWarmupProbe({
        hasBaseline: true,
        headMatch: true,
        cacheReadTokens: 0,
        cacheLikelyAlive: true,
      }),
    ).toMatch(/EVICTION/);
  });

  test("head match + read=0 past TTL => expected expiry, NOT eviction", () => {
    const v = classifyWarmupProbe({
      hasBaseline: true,
      headMatch: true,
      cacheReadTokens: 0,
      cacheLikelyAlive: false,
    });
    expect(v).toMatch(/expected expiry/);
    expect(v).not.toMatch(/EVICTION/);
  });
});
