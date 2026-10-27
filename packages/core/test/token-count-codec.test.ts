import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { decodeTokenCounts, encodeTokenCounts } from "../src/token-count-codec";

const version = "test-tokenizer-v1";
const maxEntries = 8192;
const maxBytes = 1_000_000;
const header = Buffer.byteLength(`${version}:binary-v1\0`) + 4;
const values: Array<[string, number]> = [
  ["01".repeat(32), 0],
  ["23".repeat(32), 2 ** 32 + 1],
  ["45".repeat(32), Number.MAX_SAFE_INTEGER],
];
const encode = (data = values) => encodeTokenCounts(version, data, maxEntries)!;
const decode = (payload: unknown) =>
  decodeTokenCounts(payload, version, maxEntries, maxBytes);
const resign = (bytes: Buffer) => {
  const end = bytes.length - 32;
  createHash("sha256").update(bytes.subarray(0, end)).digest().copy(bytes, end);
  return bytes;
};

describe("portable exact-count cache codec", () => {
  it("stores fixed-width keys and exact safe integers without JSON parsing", () => {
    const bytes = encode();
    expect(bytes.length).toBe(header + values.length * 40 + 32);
    expect(decode(bytes)).toEqual(new Map(values));
    expect(decode(encode([]))).toEqual(new Map());
    const padded = Buffer.concat([Buffer.alloc(11), bytes, Buffer.alloc(7)]);
    expect(
      decode(
        new Uint8Array(padded.buffer, padded.byteOffset + 11, bytes.length),
      ),
    ).toEqual(new Map(values));
  });

  it("round trips generated SHA-256 keys and counts", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.uint8Array({ minLength: 32, maxLength: 32 }),
            fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
          ),
          { maxLength: 64 },
        ),
        (items) => {
          const entries = [
            ...new Map(
              items.map(([bytes, count]) => [
                Buffer.from(bytes).toString("hex"),
                count,
              ]),
            ),
          ];
          expect(decode(encode(entries))).toEqual(new Map(entries));
        },
      ),
      { seed: 1737, numRuns: 200 },
    );
  });

  it.each(["header", "key", "count", "checksum"])(
    "rejects %s corruption",
    (field) => {
      const bytes = encode();
      const offset =
        field === "header"
          ? 0
          : field === "key"
            ? header
            : field === "count"
              ? header + 32
              : bytes.length - 1;
      bytes[offset] ^= 1;
      expect(decode(bytes)).toBeUndefined();
    },
  );

  it("checks format, length and bounds even with a valid checksum", () => {
    const bytes = encode();
    expect(decodeTokenCounts(bytes, version, 1, maxBytes)).toBeUndefined();
    expect(
      decodeTokenCounts(bytes, version, maxEntries, bytes.length - 1),
    ).toBeUndefined();
    const badCount = Buffer.from(bytes);
    badCount.writeUInt32LE(maxEntries + 1, header - 4);
    expect(decode(resign(badCount))).toBeUndefined();
    const wrongCount = Buffer.from(bytes);
    wrongCount.writeUInt32LE(1, header - 4);
    expect(decode(resign(wrongCount))).toBeUndefined();
    const badVersion = Buffer.from(bytes);
    badVersion[0] ^= 1;
    expect(decode(resign(badVersion))).toBeUndefined();
    expect(decode(bytes.subarray(0, bytes.length - 1))).toBeUndefined();
    expect(decode(Buffer.concat([bytes, Buffer.from([0])]))).toBeUndefined();
    expect(decode(Buffer.alloc(maxBytes + 1))).toBeUndefined();
    expect(decode(null)).toBeUndefined();
    expect(decode({})).toBeUndefined();
  });

  it.each([-1, 0.5, Infinity, -Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid count %s even with a matching checksum",
    (value) => {
      const bytes = encode();
      bytes.writeDoubleLE(value, header + 32);
      expect(decode(resign(bytes))).toBeUndefined();
      expect(
        encodeTokenCounts(version, [["a".repeat(64), value]], maxEntries),
      ).toBeUndefined();
    },
  );

  it("reads legacy JSON and rejects malformed/schema-incompatible legacy data", () => {
    const legacy = (data: unknown, key = version) =>
      JSON.stringify([
        key,
        data,
        createHash("sha256").update(JSON.stringify(data)).digest("hex"),
      ]);
    expect(decode(legacy(values))).toEqual(new Map(values));
    for (const data of [
      {},
      [["a", 1]],
      [["g".repeat(64), 1]],
      [["a".repeat(64), -1]],
      [["a".repeat(64), "1"]],
    ])
      expect(decode(legacy(data))).toBeUndefined();
    expect(decode(legacy(values, "other-version"))).toBeUndefined();
    expect(decode("{")).toBeUndefined();
    expect(
      decode(JSON.stringify([version, values, "bad checksum"])),
    ).toBeUndefined();
    expect(
      encodeTokenCounts(version, [["not-a-hash", 1]], maxEntries),
    ).toBeUndefined();
    expect(
      encodeTokenCounts(
        version,
        Array.from({ length: maxEntries + 1 }, () => values[0]),
        maxEntries,
      ),
    ).toBeUndefined();
  });
});
