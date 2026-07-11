import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  embeddingStatus,
  maybeSelfHealEmbeddingProvider,
  _markLocalProviderUnavailable,
  _resetLocalProviderProbe,
} from "../src/embedding";

// maybeSelfHealEmbeddingProvider() is the idle-loop backstop that recovers a
// LOCAL embedding provider which latched FTS-only for the process lifetime.
// It re-probes recoverable causes on a slow cadence but never the terminal
// missing-stack cause (that needs a reinstall).

const SIX_H = 6 * 60 * 60 * 1000;

describe("maybeSelfHealEmbeddingProvider", () => {
  beforeEach(() => {
    _resetLocalProviderProbe();
  });
  afterEach(() => {
    _resetLocalProviderProbe();
  });

  it("does nothing when the provider is healthy", () => {
    expect(maybeSelfHealEmbeddingProvider(1_000)).toBe(false);
  });

  it("primes on the first call, then re-probes a recoverable latch after the interval", () => {
    _markLocalProviderUnavailable(); // recoverable latch
    expect(embeddingStatus().state).toBe("unavailable");

    const t0 = 1_000_000;
    // First call primes the clock — no re-probe yet.
    expect(maybeSelfHealEmbeddingProvider(t0)).toBe(false);
    expect(embeddingStatus().state).toBe("unavailable");
    // Before the interval elapses: still parked.
    expect(maybeSelfHealEmbeddingProvider(t0 + SIX_H - 1)).toBe(false);
    expect(embeddingStatus().state).toBe("unavailable");
    // After the interval: clears the latch → provider healthy again.
    expect(maybeSelfHealEmbeddingProvider(t0 + SIX_H + 1)).toBe(true);
    expect(embeddingStatus().available).toBe(true);
    expect(embeddingStatus().state).toBe("ok");
  });

  it("never re-probes the terminal missing-stack cause", () => {
    _markLocalProviderUnavailable(true); // stack-missing = terminal
    const t0 = 1_000_000;
    expect(maybeSelfHealEmbeddingProvider(t0)).toBe(false);
    // Even long after the interval, a missing stack is never re-probed.
    expect(maybeSelfHealEmbeddingProvider(t0 + 10 * SIX_H)).toBe(false);
    expect(embeddingStatus().state).toBe("unavailable");
  });
});
