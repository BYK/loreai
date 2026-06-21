import { describe, it, expect } from "vitest";
import {
  spanStartupBackfill,
  emitResourceGauge,
  startResourceMonitor,
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
