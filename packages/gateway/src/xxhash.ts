/**
 * xxHash64 — non-cryptographic 64-bit hash.
 *
 * Pure-JS implementation of Yann Collet's xxHash64 algorithm. The CLI uses
 * it to replicate Claude Code's `cch` billing header, which is computed
 * by an xxHash64 of the request body (see [[cch.ts]] for the consumer).
 *
 * Reference: https://github.com/Cyan4973/xxHash (BSD-2-Clause)
 *
 * Bun exposes the same algorithm as `Bun.hash.xxHash64(data, seed)` which
 * returns a `bigint`. This module is the Node-compatible replacement so
 * the same code runs under both runtimes without any `Bun.*` reference.
 */

const PRIME64_1 = 0x9e3779b185ebca87n;
const PRIME64_2 = 0xc2b2ae3d27d4eb4fn;
const PRIME64_3 = 0x165667b19e3779f9n;
const PRIME64_4 = 0x85ebca6b3b7b36efn;
const PRIME64_5 = 0x27d4eb2f165667c5n;

/**
 * Read an unsigned little-endian 64-bit integer as a bigint from a byte
 * buffer at the given offset. JavaScript numbers are double-precision
 * floats with only 53 bits of mantissa, so we must use BigInt arithmetic
 * to preserve the full 64-bit range. Uses DataView to avoid non-null
 * assertions on raw byte reads.
 */
function readU64(buf: Uint8Array, offset: number): bigint {
  const view = new DataView(buf.buffer, buf.byteOffset + offset, 8);
  const lo = view.getUint32(0, true);
  const hi = view.getUint32(4, true);
  return (BigInt(hi) << 32n) | BigInt(lo);
}

/**
 * Rotate a 64-bit bigint left by `n` bits. JS bitwise ops are 32-bit, so
 * we use modular arithmetic on the bigint to get the same effect.
 */
function rotl(x: bigint, n: bigint): bigint {
  return ((x << n) | (x >> (64n - n))) & 0xffffffffffffffffn;
}

/**
 * Mix the 64-bit accumulator `acc` with the 64-bit `input`. Standard
 * xxHash64 round: multiply acc by PRIME64_2 (left), xor-rotate by 31
 * after adding a left-rotated PRIME64_1-mixed input, then multiply
 * by PRIME64_1.
 */
function round(acc: bigint, input: bigint): bigint {
  acc =
    (acc + ((input * PRIME64_2) & 0xffffffffffffffffn)) & 0xffffffffffffffffn;
  acc = rotl(acc, 31n);
  acc = (acc * PRIME64_1) & 0xffffffffffffffffn;
  return acc;
}

/**
 * Merge a 64-bit lane into the accumulator with xxHash64's avalanche-style
 * mix. The lanes of a multi-lane input stream are folded in here.
 */
function mergeRound(acc: bigint, val: bigint): bigint {
  val = round(0n, val);
  acc = (acc ^ val) & 0xffffffffffffffffn;
  acc = (acc * PRIME64_1 + PRIME64_4) & 0xffffffffffffffffn;
  return acc;
}

function toBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === "string" ? new TextEncoder().encode(data) : data;
}

/**
 * Compute the 64-bit xxHash of `data` seeded with `seed`.
 *
 * @param data - Bytes (or UTF-8 string) to hash
 * @param seed - Optional 64-bit seed; defaults to 0
 * @returns 64-bit hash as a bigint (matches Bun.hash.xxHash64)
 */
export function xxHash64(
  data: string | Uint8Array,
  seed: bigint | number = 0n,
): bigint {
  const seed64 = BigInt(seed) & 0xffffffffffffffffn;
  const input = toBytes(data);
  const len = input.byteLength;
  let pos = 0;

  let h64: bigint;
  if (len >= 32) {
    let v1 = (seed64 + PRIME64_1 + PRIME64_2) & 0xffffffffffffffffn;
    let v2 = (seed64 + PRIME64_2) & 0xffffffffffffffffn;
    let v3 = (seed64 + 0n) & 0xffffffffffffffffn;
    let v4 = (seed64 - PRIME64_1) & 0xffffffffffffffffn;

    do {
      v1 = round(v1, readU64(input, pos));
      v2 = round(v2, readU64(input, pos + 8));
      v3 = round(v3, readU64(input, pos + 16));
      v4 = round(v4, readU64(input, pos + 24));
      pos += 32;
    } while (pos <= len - 32);

    h64 =
      (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) &
      0xffffffffffffffffn;
    h64 = mergeRound(h64, v1);
    h64 = mergeRound(h64, v2);
    h64 = mergeRound(h64, v3);
    h64 = mergeRound(h64, v4);
  } else {
    h64 = (seed64 + PRIME64_5) & 0xffffffffffffffffn;
  }

  h64 = (h64 + BigInt(len)) & 0xffffffffffffffffn;

  while (pos + 8 <= len) {
    const k1 = round(0n, readU64(input, pos));
    h64 = (h64 ^ k1) & 0xffffffffffffffffn;
    h64 = (rotl(h64, 27n) * PRIME64_1 + PRIME64_4) & 0xffffffffffffffffn;
    pos += 8;
  }

  if (pos + 4 <= len) {
    const view = new DataView(input.buffer, input.byteOffset + pos, 4);
    const k1 = BigInt(view.getUint32(0, true));
    h64 = (h64 ^ (k1 * PRIME64_1)) & 0xffffffffffffffffn;
    h64 = (rotl(h64, 23n) * PRIME64_2 + PRIME64_3) & 0xffffffffffffffffn;
    pos += 4;
  }

  while (pos < len) {
    const view = new DataView(input.buffer, input.byteOffset + pos, 1);
    const k1 = BigInt(view.getUint8(0));
    h64 = (h64 ^ (k1 * PRIME64_5)) & 0xffffffffffffffffn;
    h64 = (rotl(h64, 11n) * PRIME64_1) & 0xffffffffffffffffn;
    pos += 1;
  }

  // Final avalanche
  h64 = (h64 ^ (h64 >> 33n)) & 0xffffffffffffffffn;
  h64 = (h64 * PRIME64_2) & 0xffffffffffffffffn;
  h64 = (h64 ^ (h64 >> 29n)) & 0xffffffffffffffffn;
  h64 = (h64 * PRIME64_3) & 0xffffffffffffffffn;
  h64 = (h64 ^ (h64 >> 32n)) & 0xffffffffffffffffn;

  return h64;
}
