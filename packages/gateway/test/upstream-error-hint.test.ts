import { describe, test, expect } from "vitest";
import { upstreamErrorHint } from "../src/upstream-error-hint";

const RATE_LIMIT_BODY = JSON.stringify({
  type: "error",
  error: { type: "rate_limit_error", message: "Error" },
  request_id: "req_011Cd4Lvq487jGTkCUBGJsia",
});

describe("upstreamErrorHint", () => {
  test("anthropic 429 rate_limit_error on a bearer (OAuth) credential → friendly hint", () => {
    const hint = upstreamErrorHint({
      status: 429,
      body: RATE_LIMIT_BODY,
      protocol: "anthropic",
      credScheme: "bearer",
    });
    expect(hint).toContain("Anthropic subscription's rate limit");
    expect(hint).toContain("not a Lore issue");
    expect(hint).toContain("forwarded this request once and did not retry");
    // Must be a suffix (leading separator), never a standalone line.
    expect(hint.startsWith(" — ")).toBe(true);
  });

  test("api-key credential → no hint (only OAuth/subscription tokens rate-limit this way)", () => {
    expect(
      upstreamErrorHint({
        status: 429,
        body: RATE_LIMIT_BODY,
        protocol: "anthropic",
        credScheme: "api-key",
      }),
    ).toBe("");
  });

  test("unknown credential scheme → no hint", () => {
    expect(
      upstreamErrorHint({
        status: 429,
        body: RATE_LIMIT_BODY,
        protocol: "anthropic",
        credScheme: undefined,
      }),
    ).toBe("");
  });

  test("non-anthropic protocol → no hint", () => {
    expect(
      upstreamErrorHint({
        status: 429,
        body: RATE_LIMIT_BODY,
        protocol: "openai",
        credScheme: "bearer",
      }),
    ).toBe("");
  });

  test("429 without rate_limit_error in body → no hint", () => {
    expect(
      upstreamErrorHint({
        status: 429,
        body: JSON.stringify({ error: { type: "overloaded_error" } }),
        protocol: "anthropic",
        credScheme: "bearer",
      }),
    ).toBe("");
  });

  test("non-429 status with rate_limit_error body → no hint", () => {
    // A 400/500 that happens to mention rate_limit_error must not trigger it.
    expect(
      upstreamErrorHint({
        status: 400,
        body: RATE_LIMIT_BODY,
        protocol: "anthropic",
        credScheme: "bearer",
      }),
    ).toBe("");
  });

  test("all four conditions are required (matrix)", () => {
    const base = {
      status: 429,
      body: RATE_LIMIT_BODY,
      protocol: "anthropic",
      credScheme: "bearer" as const,
    };
    // Baseline matches.
    expect(upstreamErrorHint(base)).not.toBe("");
    // Flip each condition individually — each flip must suppress the hint.
    expect(upstreamErrorHint({ ...base, status: 500 })).toBe("");
    expect(upstreamErrorHint({ ...base, protocol: "bedrock" })).toBe("");
    expect(upstreamErrorHint({ ...base, credScheme: "api-key" })).toBe("");
    expect(upstreamErrorHint({ ...base, body: "{}" })).toBe("");
  });
});
