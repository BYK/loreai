/**
 * Tests for `forwardClientHeaders` — which client headers are passed through to
 * the upstream and which are gateway-managed (dropped).
 *
 * Regression for issue #1032: `content-encoding` must NOT be forwarded. The
 * gateway decodes the client body and re-serializes (then re-compresses) it, so
 * it owns the upstream `content-encoding` header — forwarding the client's raw
 * value would mislabel the re-serialized body.
 */
import { describe, test, expect } from "vitest";
import { forwardClientHeaders } from "../src/translate/types";

describe("forwardClientHeaders", () => {
  test("drops content-encoding and accept-encoding (gateway-owned framing)", () => {
    const forwarded = forwardClientHeaders({
      "content-encoding": "zstd",
      "accept-encoding": "gzip, br",
      "content-type": "application/json",
      "content-length": "123",
    });
    expect(forwarded["content-encoding"]).toBeUndefined();
    expect(forwarded["accept-encoding"]).toBeUndefined();
    expect(forwarded["content-type"]).toBeUndefined();
    expect(forwarded["content-length"]).toBeUndefined();
  });

  test("forwards non-managed provider headers untouched", () => {
    const forwarded = forwardClientHeaders({
      "content-encoding": "zstd",
      "anthropic-beta": "prompt-caching-2024-07-31",
      "openai-organization": "org-123",
    });
    expect(forwarded["anthropic-beta"]).toBe("prompt-caching-2024-07-31");
    expect(forwarded["openai-organization"]).toBe("org-123");
    expect(forwarded["content-encoding"]).toBeUndefined();
  });

  test("drops auth + x-lore-* control headers", () => {
    const forwarded = forwardClientHeaders({
      "x-api-key": "sk-secret",
      authorization: "Bearer tok",
      "x-lore-project": "/home/me/proj",
      "content-encoding": "gzip",
    });
    expect(forwarded["x-api-key"]).toBeUndefined();
    expect(forwarded.authorization).toBeUndefined();
    expect(forwarded["x-lore-project"]).toBeUndefined();
    expect(forwarded["content-encoding"]).toBeUndefined();
  });
});
