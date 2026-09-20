/**
 * Busy-fixture metrics (UI-06c): the sampler is bounded, the percentile is
 * exact on the retained window, start/stop never stack observers or frame
 * loops, and the report is honest about what has not been observed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { BusyMetrics, percentile } from "~/fixture/busy-metrics";

describe("percentile", () => {
  it("is null on an empty sample and exact on small samples", () => {
    expect(percentile([], 95)).toBeNull();
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([3, 1, 2], 50)).toBe(2);
    expect(percentile([3, 1, 2], 95)).toBe(3);
    expect(percentile([3, 1, 2], 0)).toBe(1);
  });

  it("picks the nearest-rank value without interpolating", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 99)).toBe(99);
    expect(percentile(values, 100)).toBe(100);
  });
});

describe("BusyMetrics", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports nulls and zeros before anything was observed", () => {
    const r = new BusyMetrics().report();
    expect(r.inputToPaintP95).toBeNull();
    expect(r.frames).toEqual({ count: 0, p95: null, max: null });
    expect(r.longTasks).toEqual({ count: 0, totalMs: 0, maxMs: null });
    expect(r.apply).toEqual({ count: 0, totalMs: 0, p95: null });
    expect(r.queueHighWater).toBe(0);
    expect(r.deltas).toEqual({ count: 0, chars: 0, minChars: 0, maxChars: 0 });
  });

  it("tracks apply time, queue high-water and delta bounds", () => {
    const m = new BusyMetrics();
    m.recordApply(2, 5);
    m.recordApply(9, 48);
    m.recordApply(1, 3);
    m.recordDelta(6);
    m.recordDelta(42);
    m.recordDelta(11);
    const r = m.report();
    expect(r.apply).toEqual({ count: 3, totalMs: 12, p95: 9 });
    expect(r.queueHighWater).toBe(48);
    expect(r.deltas).toEqual({
      count: 3,
      chars: 59,
      minChars: 6,
      maxChars: 42,
    });
  });

  it("keeps a bounded sample window so a long run cannot grow memory", () => {
    const m = new BusyMetrics();
    for (let i = 0; i < 20_000; i++) m.recordApply(i, 1);
    const r = m.report();
    expect(r.apply.count).toBe(20_000);
    // The total and the maximum cover every sample, the percentile the
    // newest retained window.
    expect(r.apply.totalMs).toBe((19_999 * 20_000) / 2);
    expect(r.apply.p95).toBeGreaterThan(19_000);
  });

  it("start() twice does not stack frame loops or observers; stop() releases them", () => {
    const disconnect = vi.fn();
    const observed: PerformanceObserverInit[] = [];
    class FakeObserver {
      static supportedEntryTypes = ["event", "longtask"];
      constructor(_cb: PerformanceObserverCallback) {}
      observe(init: PerformanceObserverInit) {
        observed.push(init);
      }
      disconnect = disconnect;
    }
    vi.stubGlobal("PerformanceObserver", FakeObserver);
    let nextRaf = 1;
    const cancelled: number[] = [];
    vi.stubGlobal("requestAnimationFrame", () => nextRaf++);
    vi.stubGlobal("cancelAnimationFrame", (id: number) => cancelled.push(id));

    const m = new BusyMetrics();
    m.start();
    m.start();
    // The first frame loop (raf 1) was cancelled when the second start ran,
    // and its two observers were disconnected before being replaced.
    expect(cancelled).toEqual([1]);
    expect(disconnect).toHaveBeenCalledTimes(2);
    // Buffered entries (generation, first render) replay on the first start
    // only; a restart would otherwise count the same long tasks twice.
    expect(observed.map((o) => o.buffered)).toEqual([true, true, false, false]);
    m.stop();
    expect(cancelled).toEqual([1, 2]);
    expect(disconnect).toHaveBeenCalledTimes(4);
    // A second stop is a no-op.
    m.stop();
    expect(cancelled).toEqual([1, 2]);
    expect(disconnect).toHaveBeenCalledTimes(4);
  });

  it("frame intervals are measured between consecutive frames only", () => {
    let cb: FrameRequestCallback | null = null;
    vi.stubGlobal("PerformanceObserver", undefined);
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
      cb = fn;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const m = new BusyMetrics();
    m.start();
    cb!(1000);
    cb!(1016.7);
    cb!(1050);
    const r = m.report();
    expect(r.frames.count).toBe(2);
    expect(r.frames.max).toBeCloseTo(33.3, 1);
    m.stop();
    // After a stop the next frame after a restart does not measure the gap.
    m.start();
    cb!(5000);
    expect(m.report().frames.count).toBe(2);
  });
});
