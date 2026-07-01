import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ensureProject } from "../src/db";
import { vectorSearch, vectorSearchTemporal } from "../src/embedding";
import {
  _resetVecReadLatencyForTest,
  setVecReadLatencyHook,
  type VecReadLatencySample,
  vecReadLatencyStats,
  vecReadLatencyTotalSamples,
} from "../src/vec-latency";

const PROJECT = "/test/vec-latency-instrument";

// A query vector's exact dimension is irrelevant here: with an empty knowledge
// table the blob path compares against zero rows, and even if a path throws it
// is caught inside `poolOrInProcess` — the latency sample is recorded in the
// `finally` either way, which is exactly what these tests pin down.
const query = new Float32Array(768).fill(0.01);

describe("vector search records a read-latency sample (#1065)", () => {
  beforeEach(() => {
    ensureProject(PROJECT);
    _resetVecReadLatencyForTest();
  });
  afterEach(() => {
    _resetVecReadLatencyForTest();
  });

  test("each vectorSearch call fires exactly one sample through the chokepoint", async () => {
    const seen: VecReadLatencySample[] = [];
    setVecReadLatencyHook((s) => seen.push(s));

    await vectorSearch(query, 5);
    expect(seen).toHaveLength(1);
    expect(seen[0].elapsedMs).toBeGreaterThanOrEqual(0);

    // A second, different vector search kind also routes through the same
    // instrumented chokepoint.
    await vectorSearchTemporal(query, PROJECT, 5);
    expect(seen).toHaveLength(2);
  });

  test("recorded samples land in the rolling stats + total counter", async () => {
    expect(vecReadLatencyTotalSamples()).toBe(0);
    await vectorSearch(query, 5);
    expect(vecReadLatencyTotalSamples()).toBe(1);
    const stats = vecReadLatencyStats();
    expect(stats.reduce((n, s) => n + s.count, 0)).toBe(1);
  });
});
