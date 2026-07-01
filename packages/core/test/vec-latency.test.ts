import { afterEach, describe, expect, test } from "vitest";
import {
  _resetVecReadLatencyForTest,
  formatVecReadLatencyHeartbeat,
  recordVecReadLatency,
  setVecReadLatencyHook,
  VEC_LATENCY_WINDOW,
  type VecReadLatencySample,
  vecReadLatencyStats,
  vecReadLatencyTotalSamples,
} from "../src/vec-latency";

afterEach(() => {
  _resetVecReadLatencyForTest();
});

describe("vec-latency rolling telemetry", () => {
  test("computes nearest-rank p50/p95 per cohort", () => {
    // 10 samples 10..100; nearest-rank: p50 -> rank ceil(0.5*10)=5 -> 50,
    // p95 -> rank ceil(0.95*10)=10 -> 100.
    for (let v = 10; v <= 100; v += 10) recordVecReadLatency("vec0", v);
    const stats = vecReadLatencyStats();
    expect(stats).toHaveLength(1);
    const s = stats[0];
    expect(s.readMode).toBe("vec0");
    expect(s.count).toBe(10);
    expect(s.p50).toBe(50);
    expect(s.p95).toBe(100);
  });

  test("a single sample reports itself as both p50 and p95", () => {
    recordVecReadLatency("blob-native", 42);
    const [s] = vecReadLatencyStats();
    expect(s.count).toBe(1);
    expect(s.p50).toBe(42);
    expect(s.p95).toBe(42);
  });

  test("cohorts are isolated — vec0 vs degraded never mix", () => {
    // Fast healthy vec0 reads vs slow degraded JS-fallback reads: the whole
    // point of #1065 is that these are separable.
    for (let i = 0; i < 20; i++) recordVecReadLatency("vec0", 5);
    for (let i = 0; i < 20; i++) recordVecReadLatency("degraded", 9000);
    const stats = vecReadLatencyStats();
    // Sorted by readMode: "degraded" < "vec0".
    expect(stats.map((s) => s.readMode)).toEqual(["degraded", "vec0"]);
    const degraded = stats.find((s) => s.readMode === "degraded");
    const vec0 = stats.find((s) => s.readMode === "vec0");
    expect(vec0?.p95).toBe(5);
    expect(degraded?.p95).toBe(9000);
  });

  test("rolling window is bounded — oldest samples drop out", () => {
    // Fill past the window with a low baseline, then push a burst of highs.
    for (let i = 0; i < VEC_LATENCY_WINDOW; i++) {
      recordVecReadLatency("vec0", 1);
    }
    for (let i = 0; i < VEC_LATENCY_WINDOW; i++) {
      recordVecReadLatency("vec0", 1000);
    }
    const [s] = vecReadLatencyStats();
    // Window never exceeds its cap...
    expect(s.count).toBe(VEC_LATENCY_WINDOW);
    // ...and the low baseline has been fully evicted (percentiles reflect the
    // recent highs only). Without the ring bound the old 1s samples would still
    // be present and p50 would be 1, not 1000.
    expect(s.p50).toBe(1000);
    // Total counter still reflects every recorded read, not just the window.
    expect(vecReadLatencyTotalSamples()).toBe(2 * VEC_LATENCY_WINDOW);
  });

  test("ignores non-finite and negative latencies", () => {
    recordVecReadLatency("vec0", Number.NaN);
    recordVecReadLatency("vec0", Number.POSITIVE_INFINITY);
    recordVecReadLatency("vec0", -3);
    expect(vecReadLatencyStats()).toHaveLength(0);
    expect(vecReadLatencyTotalSamples()).toBe(0);
    recordVecReadLatency("vec0", 7);
    expect(vecReadLatencyTotalSamples()).toBe(1);
  });

  test("empty cohorts are omitted from the snapshot", () => {
    expect(vecReadLatencyStats()).toEqual([]);
  });

  test("fires the host hook once per recorded read", () => {
    const seen: VecReadLatencySample[] = [];
    setVecReadLatencyHook((s) => seen.push(s));
    recordVecReadLatency("blob-js", 12);
    recordVecReadLatency("vec0", 34);
    expect(seen).toEqual([
      { readMode: "blob-js", elapsedMs: 12 },
      { readMode: "vec0", elapsedMs: 34 },
    ]);
  });

  test("a throwing hook never breaks recording", () => {
    setVecReadLatencyHook(() => {
      throw new Error("boom");
    });
    expect(() => recordVecReadLatency("vec0", 5)).not.toThrow();
    const [s] = vecReadLatencyStats();
    expect(s.count).toBe(1);
  });

  test("heartbeat line renders rounded per-cohort p50/p95, or null when empty", () => {
    // Nothing recorded yet → nothing to log.
    expect(formatVecReadLatencyHeartbeat()).toBeNull();

    recordVecReadLatency("vec0", 12.6);
    recordVecReadLatency("degraded", 9000);
    // Sorted by readMode (degraded < vec0); latencies rounded to whole ms.
    expect(formatVecReadLatencyHeartbeat()).toBe(
      "degraded p50=9000ms p95=9000ms n=1 | vec0 p50=13ms p95=13ms n=1",
    );
  });

  test("dropped hook stops receiving samples", () => {
    let calls = 0;
    setVecReadLatencyHook(() => calls++);
    recordVecReadLatency("vec0", 1);
    setVecReadLatencyHook(null);
    recordVecReadLatency("vec0", 2);
    expect(calls).toBe(1);
    // Recording still works with no hook installed.
    expect(vecReadLatencyStats()[0].count).toBe(2);
  });
});
