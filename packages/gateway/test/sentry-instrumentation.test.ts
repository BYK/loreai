import { describe, it, expect } from "vitest";
import {
  spanStartupBackfill,
  emitResourceGauge,
  startResourceMonitor,
  isAbortUnderPressure,
  getEventLoopLagP99Ms,
  captureClientAbortUnderPressure,
} from "../src/sentry";

const stats = {
  pendingKnowledge: 0,
  pendingDistillations: 0,
  knowledgeEmbedded: 0,
  distillationEmbedded: 0,
  entityEmbedded: 0,
  knowledgeTotal: 0,
  knowledgeWithEmbedding: 0,
  distillationTotal: 0,
  distillationWithEmbedding: 0,
};

// Sentry is not initialized in the test process, so these exercise the
// Sentry-off fallback paths — which must always run the work and never throw.
describe("embedding/resource instrumentation helpers", () => {
  it("spanStartupBackfill runs the backfill and resolves", async () => {
    let called = 0;
    await expect(
      spanStartupBackfill(async () => {
        called++;
        return stats;
      }),
    ).resolves.toBeUndefined();
    expect(called).toBe(1);
  });

  it("spanStartupBackfill propagates an error from the backfill", async () => {
    await expect(
      spanStartupBackfill(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("emitResourceGauge is a safe no-op", () => {
    expect(() => emitResourceGauge()).not.toThrow();
  });

  it("startResourceMonitor is a safe, idempotent no-op", () => {
    expect(() => startResourceMonitor()).not.toThrow();
    expect(() => startResourceMonitor()).not.toThrow();
  });
});

describe("client-abort-under-pressure", () => {
  it("fires only above the in-flight (10s) OR loop-lag (1s) thresholds", () => {
    // Below both → normal abort, not captured.
    expect(isAbortUnderPressure(5_000, 500)).toBe(false);
    expect(isAbortUnderPressure(9_999, 999)).toBe(false);
    // In-flight threshold (boundary inclusive).
    expect(isAbortUnderPressure(10_000, 0)).toBe(true);
    expect(isAbortUnderPressure(60_000, 0)).toBe(true);
    // Loop-lag threshold (boundary inclusive).
    expect(isAbortUnderPressure(0, 1_000)).toBe(true);
    expect(isAbortUnderPressure(0, 5_000)).toBe(true);
  });

  it("getEventLoopLagP99Ms returns a non-negative number", () => {
    const lag = getEventLoopLagP99Ms();
    expect(typeof lag).toBe("number");
    expect(lag).toBeGreaterThanOrEqual(0);
  });

  it("captureClientAbortUnderPressure is a safe no-op when Sentry is off", () => {
    expect(() =>
      captureClientAbortUnderPressure({
        startMs: Date.now() - 30_000,
        route: "stream",
        sessionID: "abc",
      }),
    ).not.toThrow();
  });
});
