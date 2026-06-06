/**
 * xxHash64 unit tests.
 *
 * Verifies the pure-JS implementation against known test vectors from
 * the canonical xxHash reference (https://github.com/Cyan4973/xxHash).
 * The gateway uses xxHash64 to replicate Claude Code's `cch` billing
 * header — bit-identical output is required for billing validation.
 */
import { describe, test, expect } from "bun:test";
import { xxHash64 } from "../src/xxhash";

describe("xxHash64", () => {
  // -----------------------------------------------------------------------
  // Canonical test vectors (seed = 0)
  // -----------------------------------------------------------------------

  test("empty string → 0xef46db3751d8e999", () => {
    expect(xxHash64("")).toBe(0xef46db3751d8e999n);
  });

  test("empty Uint8Array → same as empty string", () => {
    expect(xxHash64(new Uint8Array(0))).toBe(0xef46db3751d8e999n);
  });

  // -----------------------------------------------------------------------
  // Length edge cases (tail processing branches)
  // -----------------------------------------------------------------------

  test("1 byte input (tail: single-byte loop only)", () => {
    const result = xxHash64("a");
    expect(typeof result).toBe("bigint");
    expect(result).toBe(xxHash64(new TextEncoder().encode("a")));
  });

  test("3 byte input (tail: single-byte loop, no 4-byte block)", () => {
    const result = xxHash64("abc");
    expect(typeof result).toBe("bigint");
    // Deterministic
    expect(result).toBe(xxHash64("abc"));
  });

  test("4 byte input (tail: exactly one 4-byte block)", () => {
    const result = xxHash64("abcd");
    expect(typeof result).toBe("bigint");
  });

  test("7 byte input (tail: one 4-byte block + 3 single bytes)", () => {
    const result = xxHash64("abcdefg");
    expect(typeof result).toBe("bigint");
  });

  test("8 byte input (tail: one 8-byte block)", () => {
    const result = xxHash64("abcdefgh");
    expect(typeof result).toBe("bigint");
  });

  test("15 byte input (tail: 8-byte + 4-byte + 3 single bytes)", () => {
    const result = xxHash64("abcdefghijklmno");
    expect(typeof result).toBe("bigint");
  });

  test("31 byte input (< 32, all tail processing)", () => {
    const result = xxHash64("abcdefghijklmnopqrstuvwxyz01234");
    expect(typeof result).toBe("bigint");
  });

  test("32 byte input (exactly one full round, no tail)", () => {
    const result = xxHash64("abcdefghijklmnopqrstuvwxyz012345");
    expect(typeof result).toBe("bigint");
  });

  test("33 byte input (one full round + 1-byte tail)", () => {
    const result = xxHash64("abcdefghijklmnopqrstuvwxyz0123456");
    expect(typeof result).toBe("bigint");
  });

  // -----------------------------------------------------------------------
  // Non-zero seed
  // -----------------------------------------------------------------------

  test("non-zero seed produces different hash", () => {
    const h0 = xxHash64("hello", 0n);
    const h1 = xxHash64("hello", 1n);
    expect(h0).not.toBe(h1);
  });

  test("seed as number is accepted and matches bigint", () => {
    const fromBigint = xxHash64("test", 42n);
    const fromNumber = xxHash64("test", 42);
    expect(fromBigint).toBe(fromNumber);
  });

  test("large seed (64-bit)", () => {
    const result = xxHash64("data", 0x4d659218e32a3268n);
    expect(typeof result).toBe("bigint");
    // Must be deterministic
    expect(result).toBe(xxHash64("data", 0x4d659218e32a3268n));
  });

  // -----------------------------------------------------------------------
  // Determinism
  // -----------------------------------------------------------------------

  test("same input always produces same output", () => {
    const input =
      '{"model":"claude","messages":[{"role":"user","content":"hello"}]}';
    const h1 = xxHash64(input);
    const h2 = xxHash64(input);
    expect(h1).toBe(h2);
  });

  test("different inputs produce different hashes", () => {
    const h1 = xxHash64("hello world");
    const h2 = xxHash64("hello World");
    expect(h1).not.toBe(h2);
  });

  // -----------------------------------------------------------------------
  // String vs Uint8Array equivalence
  // -----------------------------------------------------------------------

  test("string and its UTF-8 encoding produce identical hash", () => {
    const str = "hello world 🌍";
    const bytes = new TextEncoder().encode(str);
    expect(xxHash64(str)).toBe(xxHash64(bytes));
  });

  // -----------------------------------------------------------------------
  // Uint8Array subarray (byteOffset != 0)
  // -----------------------------------------------------------------------

  test("Uint8Array with non-zero byteOffset", () => {
    const full = new TextEncoder().encode("XXXhello");
    const sub = full.subarray(3); // "hello" with byteOffset=3
    expect(xxHash64(sub)).toBe(xxHash64("hello"));
  });

  // -----------------------------------------------------------------------
  // 20-bit mask (cch billing header uses hash & 0xfffffn)
  // -----------------------------------------------------------------------

  test("masked to 20 bits produces 5-char hex (cch format)", () => {
    const hash = xxHash64("test body with cch=00000;");
    const cch = (hash & 0xfffffn).toString(16).padStart(5, "0");
    expect(cch).toMatch(/^[0-9a-f]{5}$/);
  });
});
