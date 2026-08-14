import { describe, expect, test, vi } from "vitest";
import {
  MAX_WARMUP_HISTOGRAM_TOTAL,
  WARMUP_HISTOGRAM_BIN_COUNT,
  decodeWarmupHistogram,
  emptyWarmupHistogramCounts,
  encodeWarmupHistogram,
  mergeWarmupHistogramCounts,
  normalizeWarmupHistogram,
} from "../src/warmup-histogram";

function counts(...entries: Array<[number, bigint]>): bigint[] {
  const result = emptyWarmupHistogramCounts();
  for (const [index, count] of entries) result[index] = count;
  return result;
}

describe("warmup histogram persistence", () => {
  test("normalization preserves every nonzero bucket with a safe exact total", () => {
    const normalized = normalizeWarmupHistogram(
      counts([0, BigInt(Number.MAX_SAFE_INTEGER) - 1n], [1, 1n], [2, 1n]),
    );

    expect(normalized.counts.slice(0, 3).every((count) => count > 0)).toBe(
      true,
    );
    expect(normalized.counts.reduce((sum, count) => sum + count, 0)).toBe(
      MAX_WARMUP_HISTOGRAM_TOTAL,
    );
    expect(normalized.total).toBe(MAX_WARMUP_HISTOGRAM_TOTAL);
  });

  test("encoded exact weights make chained merges grouping-independent", () => {
    const large = counts([0, BigInt(Number.MAX_SAFE_INTEGER) - 1n], [1, 1n]);
    const second = counts([2, 1n]);
    const third = counts([3, 1n]);

    const leftEncoded = encodeWarmupHistogram(
      mergeWarmupHistogramCounts(large, second),
    );
    const left = decodeWarmupHistogram(leftEncoded.counts, leftEncoded.total);
    const rightEncoded = encodeWarmupHistogram(
      mergeWarmupHistogramCounts(second, third),
    );
    const right = decodeWarmupHistogram(
      rightEncoded.counts,
      rightEncoded.total,
    );
    expect(left).toBeDefined();
    expect(right).toBeDefined();

    const leftGrouped = mergeWarmupHistogramCounts(left ?? [], third);
    const rightGrouped = mergeWarmupHistogramCounts(large, right ?? []);
    expect(leftGrouped).toEqual(rightGrouped);
    expect(normalizeWarmupHistogram(leftGrouped).counts.slice(0, 4)).toEqual(
      normalizeWarmupHistogram(rightGrouped).counts.slice(0, 4),
    );
    expect(
      normalizeWarmupHistogram(leftGrouped)
        .counts.slice(0, 4)
        .every((count) => count > 0),
    ).toBe(true);
  });

  test("round-trips a legacy safe-integer row above the normalization limit", () => {
    const legacy = Array.from({ length: WARMUP_HISTOGRAM_BIN_COUNT }, () => 0);
    legacy[0] = Number.MAX_SAFE_INTEGER;
    const decoded = decodeWarmupHistogram(
      JSON.stringify(legacy),
      String(Number.MAX_SAFE_INTEGER),
    );
    expect(decoded?.[0]).toBe(BigInt(Number.MAX_SAFE_INTEGER));

    const encoded = encodeWarmupHistogram(decoded ?? []);
    expect(decodeWarmupHistogram(encoded.counts, encoded.total)).toEqual(
      decoded,
    );
  });

  test("remains decodable when accepted weights gain a digit during merge", () => {
    const boundary = 10n ** 1000n - 1n;
    const first = encodeWarmupHistogram(counts([0, boundary], [1, 1n]));
    const second = encodeWarmupHistogram(counts([0, boundary], [2, 1n]));
    const firstWeights = decodeWarmupHistogram(first.counts, first.total);
    const secondWeights = decodeWarmupHistogram(second.counts, second.total);
    expect(firstWeights).toBeDefined();
    expect(secondWeights).toBeDefined();

    const merged = encodeWarmupHistogram(
      mergeWarmupHistogramCounts(firstWeights ?? [], secondWeights ?? []),
    );
    const decoded = decodeWarmupHistogram(merged.counts, merged.total);
    expect(decoded).toBeDefined();
    expect(decoded?.[0].toString()).toHaveLength(1001);
    expect(decoded?.slice(0, 3).every((count) => count > 0n)).toBe(true);
  });

  test("compacts encoder output to the decoder storage budget", () => {
    const huge = 10n ** 4000n;
    const weights = Array.from(
      { length: WARMUP_HISTOGRAM_BIN_COUNT },
      () => huge,
    );
    const visible = normalizeWarmupHistogram(weights);
    const oversized = JSON.stringify({
      v: 1,
      counts: visible.counts,
      exact: weights.map(String),
    });
    expect(oversized.length).toBeGreaterThan(64 * 1024);
    expect(decodeWarmupHistogram(oversized, visible.total)).toBeUndefined();

    const encoded = encodeWarmupHistogram(weights);
    expect(encoded.counts.length).toBeLessThanOrEqual(64 * 1024);
    const decoded = decodeWarmupHistogram(encoded.counts, encoded.total);
    expect(decoded).toEqual(encoded.weights);
    expect(decoded?.every((count) => count > 0n)).toBe(true);

    const merged = encodeWarmupHistogram(
      mergeWarmupHistogramCounts(decoded ?? [], decoded ?? []),
    );
    expect(decodeWarmupHistogram(merged.counts, merged.total)).toEqual(
      merged.weights,
    );
  });

  test("retains compacted history magnitude when a smaller row is merged later", () => {
    const huge = 10n ** 4000n;
    const history = Array.from(
      { length: WARMUP_HISTOGRAM_BIN_COUNT },
      (_, index) => (index < 17 ? huge : 0n),
    );
    const encoded = encodeWarmupHistogram(history);
    const retained = decodeWarmupHistogram(encoded.counts, encoded.total);
    expect(retained?.[0].toString().length).toBeGreaterThan(3000);

    const later = counts([20, 10n ** 3000n]);
    const merged = normalizeWarmupHistogram(
      mergeWarmupHistogramCounts(retained ?? [], later),
    );
    expect(merged.counts[0]).toBeGreaterThan(merged.counts[20]);
  });

  test.each([0, 64 * 1024])("rejects invalid compacted scale %i", (scale) => {
    const huge = 10n ** 4000n;
    const encoded = encodeWarmupHistogram(
      Array.from({ length: WARMUP_HISTOGRAM_BIN_COUNT }, () => huge),
    );
    const stored = JSON.parse(encoded.counts) as { scale: number };
    stored.scale = scale;
    expect(
      decodeWarmupHistogram(JSON.stringify(stored), encoded.total),
    ).toBeUndefined();
  });

  test("rejects noncanonical exact strings without another mismatch", () => {
    const encoded = encodeWarmupHistogram(
      counts([0, BigInt(Number.MAX_SAFE_INTEGER)], [1, 1n]),
    );
    const stored = JSON.parse(encoded.counts) as {
      exact: string[];
    };
    stored.exact[0] = `0${stored.exact[0]}`;
    expect(
      decodeWarmupHistogram(JSON.stringify(stored), encoded.total),
    ).toBeUndefined();
  });

  test("rejects incorrect visible counts with the correct visible total", () => {
    const encoded = encodeWarmupHistogram(
      counts([0, BigInt(Number.MAX_SAFE_INTEGER)], [1, 1n]),
    );
    const stored = JSON.parse(encoded.counts) as {
      counts: number[];
    };
    stored.counts[0]--;
    stored.counts[1]++;
    expect(
      decodeWarmupHistogram(JSON.stringify(stored), encoded.total),
    ).toBeUndefined();
  });

  test("rejects an incorrect exact total with otherwise valid fields", () => {
    const encoded = encodeWarmupHistogram(
      counts([0, BigInt(Number.MAX_SAFE_INTEGER)], [1, 1n]),
    );
    expect(
      decodeWarmupHistogram(encoded.counts, encoded.total + 1),
    ).toBeUndefined();
  });

  test("rejects an unsafe numeric total that otherwise matches legacy counts", () => {
    const legacy = Array.from({ length: WARMUP_HISTOGRAM_BIN_COUNT }, () => 0);
    legacy[0] = Number.MAX_SAFE_INTEGER;
    legacy[1] = 1;
    expect(
      decodeWarmupHistogram(
        JSON.stringify(legacy),
        Number.MAX_SAFE_INTEGER + 1,
      ),
    ).toBeUndefined();
  });

  test("rejects negative bigint weights before normalization", () => {
    expect(() => normalizeWarmupHistogram(counts([0, -1n], [1, 2n]))).toThrow(
      "invalid warmup histogram counts",
    );
  });

  test("rejects an exact vector with the wrong shape", () => {
    const encoded = encodeWarmupHistogram(
      counts([0, BigInt(Number.MAX_SAFE_INTEGER)]),
    );
    const stored = JSON.parse(encoded.counts) as { exact: string[] };
    stored.exact.pop();
    expect(
      decodeWarmupHistogram(JSON.stringify(stored), encoded.total),
    ).toBeUndefined();
    expect(() =>
      normalizeWarmupHistogram(Array.from({ length: 20 }, () => 0n)),
    ).toThrow("invalid warmup histogram counts");
  });

  test("rejects an oversized exact vector before bigint expansion", () => {
    const bigint = vi.spyOn(globalThis, "BigInt");
    try {
      const raw = JSON.stringify({
        v: 2,
        counts: Array.from({ length: WARMUP_HISTOGRAM_BIN_COUNT }, () => 0),
        exact: Array.from({ length: 1000 }, () => "1"),
        scale: 100,
      });
      expect(decodeWarmupHistogram(raw, "0")).toBeUndefined();
      expect(bigint).toHaveBeenCalledTimes(WARMUP_HISTOGRAM_BIN_COUNT);
      expect(bigint.mock.calls.every(([value]) => value === 0)).toBe(true);
    } finally {
      bigint.mockRestore();
    }
  });

  test.each([
    ["invalid JSON", "{", "0"],
    ["wrong legacy length", "[]", "0"],
    [
      "negative legacy bucket",
      JSON.stringify([-1, 2, ...Array.from({ length: 19 }, () => 0)]),
      "1",
    ],
    [
      "unsafe legacy bucket",
      JSON.stringify([
        Number.MAX_SAFE_INTEGER + 1,
        ...Array.from({ length: 20 }, () => 0),
      ]),
      String(Number.MAX_SAFE_INTEGER + 1),
    ],
    [
      "legacy total mismatch",
      JSON.stringify([1, ...Array.from({ length: 20 }, () => 0)]),
      "2",
    ],
    [
      "unknown exact version",
      JSON.stringify({
        v: 3,
        counts: Array.from({ length: 21 }, () => 0),
        exact: Array.from({ length: 21 }, () => "0"),
      }),
      "0",
    ],
    [
      "invalid exact bucket",
      JSON.stringify({
        v: 1,
        counts: Array.from({ length: 21 }, () => 0),
        exact: ["-1", ...Array.from({ length: 20 }, () => "0")],
      }),
      "0",
    ],
  ] as const)("rejects %s", (_name, rawCounts, rawTotal) => {
    expect(decodeWarmupHistogram(rawCounts, rawTotal)).toBeUndefined();
  });
});
