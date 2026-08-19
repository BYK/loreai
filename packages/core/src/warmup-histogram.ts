export const WARMUP_HISTOGRAM_BIN_COUNT = 21;
export const MAX_WARMUP_HISTOGRAM_TOTAL = Math.floor(
  Number.MAX_SAFE_INTEGER / 2,
);
const MAX_STORED_HISTOGRAM_CHARS = 64 * 1024;
const COMPACTED_EXACT_TOTAL = 1_000_000_000_000n;

/** Overflow rows retain exact weights so later merges remain associative. */
interface ExactWarmupHistogram {
  v: 1;
  counts: number[];
  exact: string[];
}

/** Oversized rows retain their decimal magnitude with compacted proportions. */
interface CompactedWarmupHistogram {
  v: 2;
  counts: number[];
  exact: string[];
  scale: number;
}

function totalCounts(counts: readonly bigint[]): bigint {
  return counts.reduce((sum, count) => sum + count, 0n);
}

function storedTotalMatches(value: unknown, expected: bigint): boolean {
  if (typeof value === "bigint") return value === expected;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && BigInt(value) === expected;
  }
  return typeof value === "string" && value === expected.toString();
}

function parseLegacyCounts(value: unknown): bigint[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length !== WARMUP_HISTOGRAM_BIN_COUNT ||
    !value.every((count) => Number.isSafeInteger(count) && count >= 0)
  ) {
    return undefined;
  }
  return value.map((count) => BigInt(count));
}

function parseExactCounts(value: unknown): bigint[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length !== WARMUP_HISTOGRAM_BIN_COUNT ||
    !value.every(
      (count) => typeof count === "string" && /^(?:0|[1-9][0-9]*)$/.test(count),
    )
  ) {
    return undefined;
  }
  return value.map((count) => BigInt(count));
}

export function emptyWarmupHistogramCounts(): bigint[] {
  return Array.from({ length: WARMUP_HISTOGRAM_BIN_COUNT }, () => 0n);
}

export function mergeWarmupHistogramCounts(
  target: readonly bigint[],
  source: readonly bigint[],
): bigint[] {
  if (
    target.length !== WARMUP_HISTOGRAM_BIN_COUNT ||
    source.length !== WARMUP_HISTOGRAM_BIN_COUNT
  ) {
    throw new Error("invalid warmup histogram length");
  }
  return target.map((count, index) => count + source[index]);
}

function scaleWarmupHistogram(
  counts: readonly bigint[],
  limit: bigint,
): bigint[] {
  if (
    counts.length !== WARMUP_HISTOGRAM_BIN_COUNT ||
    counts.some((count) => count < 0n) ||
    limit < BigInt(WARMUP_HISTOGRAM_BIN_COUNT)
  ) {
    throw new Error("invalid warmup histogram counts");
  }
  const total = totalCounts(counts);
  if (total <= limit) return [...counts];

  const positive = counts.reduce(
    (count, value) => count + (value > 0n ? 1 : 0),
    0,
  );
  const reserved = BigInt(positive);
  const distributable = limit - reserved;
  const mass = total - reserved;
  const scaledCounts = Array.from(
    { length: WARMUP_HISTOGRAM_BIN_COUNT },
    () => 0n,
  );
  const remainders: Array<{ index: number; remainder: bigint }> = [];
  let scaledTotal = 0n;
  for (let index = 0; index < counts.length; index++) {
    const count = counts[index];
    if (count === 0n) continue;
    const weighted = (count - 1n) * distributable;
    const scaled = 1n + weighted / mass;
    scaledCounts[index] = scaled;
    scaledTotal += scaled;
    remainders.push({ index, remainder: weighted % mass });
  }
  remainders.sort((left, right) =>
    left.remainder === right.remainder
      ? left.index - right.index
      : left.remainder > right.remainder
        ? -1
        : 1,
  );
  const remaining = Number(limit - scaledTotal);
  for (let index = 0; index < remaining; index++) {
    scaledCounts[remainders[index].index]++;
  }
  return scaledCounts;
}

export function normalizeWarmupHistogram(counts: readonly bigint[]): {
  counts: number[];
  total: number;
} {
  const scaled = scaleWarmupHistogram(
    counts,
    BigInt(MAX_WARMUP_HISTOGRAM_TOTAL),
  );
  return {
    counts: scaled.map(Number),
    total: Number(totalCounts(scaled)),
  };
}

export function encodeWarmupHistogram(counts: readonly bigint[]): {
  counts: string;
  total: number;
  weights: bigint[];
} {
  let weights = [...counts];
  let normalized = normalizeWarmupHistogram(weights);
  if (totalCounts(counts) <= BigInt(MAX_WARMUP_HISTOGRAM_TOTAL)) {
    return {
      counts: JSON.stringify(normalized.counts),
      total: normalized.total,
      weights,
    };
  }
  let serialized = JSON.stringify({
    v: 1,
    counts: normalized.counts,
    exact: weights.map(String),
  } satisfies ExactWarmupHistogram);
  if (serialized.length > MAX_STORED_HISTOGRAM_CHARS) {
    const compacted = scaleWarmupHistogram(weights, COMPACTED_EXACT_TOTAL);
    const scale =
      totalCounts(weights).toString().length -
      totalCounts(compacted).toString().length;
    const compactedDigits = compacted.reduce(
      (max, count) => Math.max(max, count.toString().length),
      1,
    );
    if (scale <= 0 || scale + compactedDigits > MAX_STORED_HISTOGRAM_CHARS) {
      throw new Error("warmup histogram encoding exceeds storage limit");
    }
    const multiplier = 10n ** BigInt(scale);
    weights = compacted.map((count) => count * multiplier);
    normalized = normalizeWarmupHistogram(weights);
    serialized = JSON.stringify({
      v: 2,
      counts: normalized.counts,
      exact: compacted.map(String),
      scale,
    } satisfies CompactedWarmupHistogram);
  }
  if (serialized.length > MAX_STORED_HISTOGRAM_CHARS) {
    throw new Error("warmup histogram encoding exceeds storage limit");
  }
  return { counts: serialized, total: normalized.total, weights };
}

export function decodeWarmupHistogram(
  rawCounts: string,
  rawTotal: unknown,
): bigint[] | undefined {
  if (rawCounts.length > MAX_STORED_HISTOGRAM_CHARS) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(rawCounts) as unknown;
    const legacy = parseLegacyCounts(parsed);
    if (legacy) {
      return storedTotalMatches(rawTotal, totalCounts(legacy))
        ? legacy
        : undefined;
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return undefined;
    }
    const stored = parsed as Partial<
      ExactWarmupHistogram | CompactedWarmupHistogram
    >;
    if (stored.v !== 1 && stored.v !== 2) return undefined;
    let exact = parseExactCounts(stored.exact);
    const visible = parseLegacyCounts(stored.counts);
    if (!exact || !visible) return undefined;
    if (stored.v === 2) {
      const scale = stored.scale;
      if (
        !Number.isSafeInteger(scale) ||
        (scale ?? 0) <= 0 ||
        (scale ?? 0) +
          exact.reduce(
            (max, count) => Math.max(max, count.toString().length),
            1,
          ) >
          MAX_STORED_HISTOGRAM_CHARS
      ) {
        return undefined;
      }
      const multiplier = 10n ** BigInt(scale ?? 0);
      exact = exact.map((count) => count * multiplier);
    }
    const normalized = normalizeWarmupHistogram(exact);
    if (
      !storedTotalMatches(rawTotal, BigInt(normalized.total)) ||
      visible.some((count, index) => count !== BigInt(normalized.counts[index]))
    ) {
      return undefined;
    }
    return exact;
  } catch {
    return undefined;
  }
}
