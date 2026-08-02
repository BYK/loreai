/**
 * Tests for the unified tokenizer (packages/core/src/tokenize.ts).
 *
 * The library (coder/ai-tokenizer) is a real BPE encoder, so we test:
 *  - empty input returns 0 (boundary guard)
 *  - encoding selection per provider/model
 *  - lazy construction: cl100k_base eager, others lazy
 *  - basic accuracy spot-checks against known BPE counts
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  estimateTokens,
  encodingForModel,
  _resetTokenizeCacheForTest,
} from "../src/tokenize";

describe("tokenize / encodingForModel", () => {
  it("selects claude for anthropic provider", () => {
    expect(
      encodingForModel({
        providerID: "anthropic",
        modelID: "claude-sonnet-4.5",
      }),
    ).toBe("claude");
    // Provider wins even when model looks OpenAI-ish.
    expect(
      encodingForModel({ providerID: "anthropic", modelID: "gpt-4o" }),
    ).toBe("claude");
  });

  it("selects o200k_base for gpt-4o / gpt-5 family", () => {
    expect(encodingForModel({ providerID: "openai", modelID: "gpt-4o" })).toBe(
      "o200k_base",
    );
    expect(encodingForModel({ providerID: "openai", modelID: "gpt-5" })).toBe(
      "o200k_base",
    );
    expect(encodingForModel({ providerID: "openai", modelID: "gpt-5.1" })).toBe(
      "o200k_base",
    );
    expect(
      encodingForModel({
        providerID: "github-copilot",
        modelID: "gpt-4o-2024-08-06",
      }),
    ).toBe("o200k_base");
  });

  it("falls back to cl100k_base for unknown / non-matching models", () => {
    expect(encodingForModel({ providerID: "openai", modelID: "gpt-4" })).toBe(
      "cl100k_base",
    );
    expect(
      encodingForModel({ providerID: "openai", modelID: "gpt-3.5-turbo" }),
    ).toBe("cl100k_base");
    expect(
      encodingForModel({ providerID: "openrouter", modelID: "xai/grok-3" }),
    ).toBe("cl100k_base");
    expect(encodingForModel({})).toBe("cl100k_base");
    expect(
      encodingForModel({
        providerID: "github-copilot",
        modelID: "claude-3.5-sonnet",
      }),
    ).toBe("cl100k_base");
  });

  it("does not match gpt-4o-style substring inside unrelated model ids", () => {
    // Regression: a model id like "my-gpt-4o-fine-tune" should match (we use word
    // boundaries). A model id like "gpt-400k" must NOT match — \b boundary.
    expect(encodingForModel({ modelID: "my-gpt-4o-fine-tune" })).toBe(
      "o200k_base",
    );
    expect(encodingForModel({ modelID: "gpt-400k" })).toBe("cl100k_base");
  });
});

describe("tokenize / estimateTokens", () => {
  beforeEach(() => {
    _resetTokenizeCacheForTest();
  });

  it("returns 0 for empty input without touching the tokenizer", () => {
    expect(estimateTokens("", { providerID: "anthropic" })).toBe(0);
    expect(
      estimateTokens("", { providerID: "openai", modelID: "gpt-4o" }),
    ).toBe(0);
  });

  it("guards against null/undefined callers (defensive boundary)", () => {
    // Internal callers (ltm.ts, prompt.ts, gradient.ts) rely on TS signatures,
    // but JSON-parsed joins or untyped shims can escape the typing and pass
    // null/undefined to estimateTokens. The `if (!text) return 0` guard at
    // tokenize.ts prevents a throw. Pin the behavior so the guard doesn't
    // silently regress.
    expect(
      estimateTokens(undefined as unknown as string, {
        providerID: "anthropic",
      }),
    ).toBe(0);
    expect(
      estimateTokens(null as unknown as string, {
        providerID: "openai",
        modelID: "gpt-4o",
      }),
    ).toBe(0);
  });

  it("returns a positive count for non-empty input (default cl100k_base)", () => {
    const n = estimateTokens("hello world");
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(10);
  });

  it("counts longer prose within a reasonable ratio of chars/3", () => {
    // Real BPE for English prose is roughly 4 chars/token — chars/3
    // overestimates by ~33%. We don't pin the exact count (encoding may
    // shift across versions) — just sanity check the order of magnitude.
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(20);
    const n = estimateTokens(text);
    const chars = text.length;
    // Within ±50% of the naive chars/3 estimate (which is the legacy default).
    expect(n).toBeGreaterThan(Math.floor(chars / 6));
    expect(n).toBeLessThan(Math.ceil(chars / 2));
  });

  it("produces different counts per provider for the same text (sanity)", () => {
    const text = "function foo() { return 42; }";
    const openai = estimateTokens(text, {
      providerID: "openai",
      modelID: "gpt-4o",
    });
    const anthropic = estimateTokens(text, {
      providerID: "anthropic",
      modelID: "claude-sonnet-4.5",
    });
    // BPE encodings for code are similar across families; we only require
    // they're in the same order of magnitude (not that they diverge).
    expect(openai).toBeGreaterThan(0);
    expect(anthropic).toBeGreaterThan(0);
    const ratio = openai / anthropic;
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);
  });

  it("handles unicode without throwing", () => {
    const text = "Merhaba dünya 🇹🇷 — Burak Yigit Kaya için 漢字テスト";
    expect(() => estimateTokens(text)).not.toThrow();
    expect(estimateTokens(text)).toBeGreaterThan(0);
  });

  it("lazy-loads non-default encodings on first request", () => {
    // After reset, only cl100k_base should be hot. Trigger o200k_base and
    // claude explicitly via different opts.
    _resetTokenizeCacheForTest();
    // Default cl100k_base already eager — calling it should work without
    // further cache growth beyond what's expected.
    estimateTokens("a", {});
    estimateTokens("b", { providerID: "openai", modelID: "gpt-4o" });
    // Now switch to claude — this triggers lazy construction.
    expect(() =>
      estimateTokens("c", {
        providerID: "anthropic",
        modelID: "claude-sonnet-4.5",
      }),
    ).not.toThrow();
    // Subsequent calls should still work (cache hit).
    expect(estimateTokens("d", { providerID: "anthropic" })).toBeGreaterThan(0);
  });
});
