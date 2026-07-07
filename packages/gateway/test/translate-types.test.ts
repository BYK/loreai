import { describe, it, expect } from "vitest";
import { ZERO_USAGE, looksLikeSSE } from "../src/translate/types";

// ---------------------------------------------------------------------------
// ZERO_USAGE
// ---------------------------------------------------------------------------

describe("ZERO_USAGE", () => {
  it("must not include optional cache fields", () => {
    // INVARIANT: ZERO_USAGE must only contain required fields (inputTokens,
    // outputTokens). The optional cache fields (cacheReadInputTokens,
    // cacheCreationInputTokens) must NOT be present — their mere presence
    // (even as 0) causes downstream `!= null` guards to emit cache fields
    // in the wire response, leaking "cache_read_input_tokens: 0" to clients
    // when no caching actually occurred.
    expect(Object.keys(ZERO_USAGE).sort()).toEqual([
      "inputTokens",
      "outputTokens",
    ]);
    expect(ZERO_USAGE).not.toHaveProperty("cacheReadInputTokens");
    expect(ZERO_USAGE).not.toHaveProperty("cacheCreationInputTokens");
  });

  it("has zero values for required fields", () => {
    expect(ZERO_USAGE.inputTokens).toBe(0);
    expect(ZERO_USAGE.outputTokens).toBe(0);
  });

  it("is frozen to prevent accidental mutation", () => {
    expect(Object.isFrozen(ZERO_USAGE)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// looksLikeSSE — body-prefix sniffing (content-type may be mislabeled)
// ---------------------------------------------------------------------------

describe("looksLikeSSE", () => {
  it("true for a text/event-stream content-type regardless of body", () => {
    expect(looksLikeSSE("text/event-stream; charset=utf-8", "{}")).toBe(true);
  });

  it("sniffs data:/event: bodies even when the content-type is wrong or empty", () => {
    for (const head of [
      "data: {",
      "data:{", // no space after colon
      "event: response.created",
    ]) {
      expect(looksLikeSSE("application/json", `${head}\n`)).toBe(true);
      expect(looksLikeSSE("", `${head}\n`)).toBe(true);
    }
  });

  it("tolerates a BOM / leading whitespace before the SSE field", () => {
    expect(looksLikeSSE("", '\uFEFFdata: {"a":1}')).toBe(true);
    expect(looksLikeSSE("", "  \n event: x")).toBe(true);
  });

  it("false for a JSON body (object or array), tolerating BOM/leading whitespace", () => {
    expect(looksLikeSSE("application/json", '{"a":1}')).toBe(false);
    expect(looksLikeSSE("", "  \n [1,2]")).toBe(false);
    expect(looksLikeSSE("", '\uFEFF{"a":1}')).toBe(false);
  });

  it("does NOT false-positive on plaintext beginning with id:/retry:/`:` (only data:/event: count)", () => {
    // A completion SSE stream always opens with data: or event:. Narrowing the
    // sniff to those two avoids treating a plaintext error body as SSE.
    expect(looksLikeSSE("text/plain", "retry: later please")).toBe(false);
    expect(looksLikeSSE("text/plain", "id: 12345 not found")).toBe(false);
    expect(looksLikeSSE("text/plain", ": a leading comment line")).toBe(false);
    expect(looksLikeSSE("text/plain", "404 page not found")).toBe(false);
  });
});
