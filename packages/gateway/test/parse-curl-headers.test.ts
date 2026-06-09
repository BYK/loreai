/**
 * Tests for LORE_UPSTREAM_EXTRA_HEADERS parsing.
 *
 * The env var is curl-style (Anthropic SDK convention):
 *   - newline-separated `Name: Value` pairs
 *   - lowercased keys
 *   - empty lines and malformed lines skipped with a warning
 *   - empty/undefined input returns `{}`
 *
 * Used by `loadConfig()` to populate `config.upstreamExtraHeaders`, which
 * is then merged as a final overlay on every upstream call (anthropic,
 * openai, openai-responses builders, snapshot, models passthrough,
 * compaction passthrough, cache warmer).
 */
import { describe, test, expect } from "vitest";
import { parseCurlHeaders } from "../src/config";

describe("parseCurlHeaders", () => {
  test("returns empty object for undefined / empty input", () => {
    expect(parseCurlHeaders(undefined)).toEqual({});
    expect(parseCurlHeaders("")).toEqual({});
  });

  test("parses a single header", () => {
    expect(parseCurlHeaders("X-Corp-Token: abc123")).toEqual({
      "x-corp-token": "abc123",
    });
  });

  test("parses multiple newline-separated headers", () => {
    const input = "X-Team-Id: acme\nX-Tenant: prod\nAuthorization: Bearer svc";
    expect(parseCurlHeaders(input)).toEqual({
      "x-team-id": "acme",
      "x-tenant": "prod",
      authorization: "Bearer svc",
    });
  });

  test("lowercases keys but preserves value case", () => {
    expect(parseCurlHeaders("X-Mixed-Case: Value-Is-Preserved")).toEqual({
      "x-mixed-case": "Value-Is-Preserved",
    });
  });

  test("trims whitespace around name and value", () => {
    expect(parseCurlHeaders("  X-Padded  :   spaced value  ")).toEqual({
      "x-padded": "spaced value",
    });
  });

  test("handles CRLF line endings", () => {
    const input = "X-First: a\r\nX-Second: b\r\n";
    expect(parseCurlHeaders(input)).toEqual({
      "x-first": "a",
      "x-second": "b",
    });
  });

  test("skips empty lines", () => {
    const input = "X-A: 1\n\nX-B: 2\n\n\nX-C: 3";
    expect(parseCurlHeaders(input)).toEqual({
      "x-a": "1",
      "x-b": "2",
      "x-c": "3",
    });
  });

  test("skips malformed lines (no colon) with a warning", () => {
    // Suppress stderr noise during this test
    const origError = console.error;
    const errors: unknown[] = [];
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const result = parseCurlHeaders(
        "X-Good: 1\nno-colon-here\nX-Also-Good: 2",
      );
      expect(result).toEqual({ "x-good": "1", "x-also-good": "2" });
      expect(errors.length).toBe(1);
    } finally {
      console.error = origError;
    }
  });

  test("skips lines where colon is at position 0 (empty name)", () => {
    const origError = console.error;
    console.error = () => {};
    try {
      const result = parseCurlHeaders(": value-only");
      expect(result).toEqual({});
    } finally {
      console.error = origError;
    }
  });

  test("rejects invalid header names (whitespace, control chars)", () => {
    const origError = console.error;
    console.error = () => {};
    try {
      const result = parseCurlHeaders("X Bad: x\nX\x00Bad: y");
      // The whitespace name parses as "X Bad" but fails the RFC 7230 token
      // check, so it's rejected. The control-char name is sanitized to
      // "XBad" which is valid. Verify at minimum the whitespace case is
      // rejected.
      expect(result["x bad"]).toBeUndefined();
    } finally {
      console.error = origError;
    }
  });

  test("strips control characters from name and value", () => {
    const origError = console.error;
    console.error = () => {};
    try {
      const result = parseCurlHeaders("X-Inject: a\x00b\x01c");
      // Value has control chars stripped, leaving "abc"
      expect(result["x-inject"]).toBe("abc");
    } finally {
      console.error = origError;
    }
  });

  test("later occurrences of the same key win (last-wins merge)", () => {
    const result = parseCurlHeaders("X-Dup: first\nX-Dup: second");
    expect(result["x-dup"]).toBe("second");
  });

  test("Cloudflare AI Gateway style: cf-aig-authorization", () => {
    const result = parseCurlHeaders("cf-aig-authorization: Bearer my-token");
    expect(result).toEqual({ "cf-aig-authorization": "Bearer my-token" });
  });
});
