/**
 * cyrb53 — a small, fast, well-distributed 53-bit string hash (public domain,
 * bryc). Deterministic across browsers because it only uses `Math.imul` and
 * 32-bit arithmetic on UTF-16 code units.
 *
 * It is a *revision check*, not a security primitive: source anchors carry it
 * so a passage whose text changed since the link was minted is reported as
 * "source changed" instead of being highlighted at the same offsets. A 53-bit
 * hash makes an accidental collision on a real edit vanishingly unlikely; it
 * does not resist deliberate collisions, and nothing here relies on that.
 */
export function cyrb53(text: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** cyrb53 as a compact, URL-safe base36 string (up to 11 characters). */
export function contentHash(text: string): string {
  return cyrb53(text).toString(36);
}
