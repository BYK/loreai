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
  temporalRechunked: 0,
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
  const MB = 1024 * 1024;
  const GB = 1024 * MB;
  it("fires only when the loop is stalled (>=1s) or free memory is critically low (<=512MB)", () => {
    // Healthy host (fast loop, plenty of memory) → normal abort, not captured —
    // even a long-lived stream cancellation is dropped.
    expect(isAbortUnderPressure(200, 4 * GB)).toBe(false);
    expect(isAbortUnderPressure(999, 513 * MB)).toBe(false);
    // Event-loop stalled (boundary inclusive).
    expect(isAbortUnderPressure(1_000, 8 * GB)).toBe(true);
    expect(isAbortUnderPressure(5_000, 8 * GB)).toBe(true);
    // Free memory critically low (boundary inclusive).
    expect(isAbortUnderPressure(0, 512 * MB)).toBe(true);
    expect(isAbortUnderPressure(0, 100 * MB)).toBe(true);
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
