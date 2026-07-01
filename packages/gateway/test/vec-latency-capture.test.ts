import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @sentry/bun BEFORE importing the module under test (mirrors
// readpath-capture.test.ts). A full factory replaces the shared instance for
// both this test and src/sentry.ts, so we can drive isInitialized() and assert
// the exact distribution + attributes emitted.
vi.mock("@sentry/bun", () => ({
  isInitialized: vi.fn(() => false),
  metrics: {
    distribution: vi.fn(),
    count: vi.fn(),
  },
}));

import * as core from "@loreai/core";
import * as Sentry from "@sentry/bun";
import { setupVecReadLatencyCapture, vecCohortTags } from "../src/sentry";

type VecHook = (s: core.VecReadLatencySample) => void;

function installAndGetHook(): VecHook {
  const setterSpy = vi.spyOn(core, "setVecReadLatencyHook");
  try {
    setupVecReadLatencyCapture();
    expect(setterSpy).toHaveBeenCalledOnce();
    return setterSpy.mock.calls[0][0] as VecHook;
  } finally {
    setterSpy.mockRestore();
  }
}

describe("vecCohortTags", () => {
  it("splits each read cohort into storage_mode × vec_available", () => {
    expect(vecCohortTags("vec0")).toEqual({
      read_mode: "vec0",
      storage_mode: "vec0",
      vec_available: "true",
    });
    // A vec0-layout host with no extension: the degraded JS-fallback we must be
    // able to spot in production.
    expect(vecCohortTags("degraded")).toEqual({
      read_mode: "degraded",
      storage_mode: "vec0",
      vec_available: "false",
    });
    expect(vecCohortTags("blob-native")).toEqual({
      read_mode: "blob-native",
      storage_mode: "blob",
      vec_available: "true",
    });
    expect(vecCohortTags("blob-js")).toEqual({
      read_mode: "blob-js",
      storage_mode: "blob",
      vec_available: "false",
    });
  });
});

describe("vector read-latency Sentry capture (#1065)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Sentry.isInitialized).mockReturnValue(true);
    core.setVecReadLatencyHook(null);
  });

  it("forwards each sample as a cohort-tagged distribution", () => {
    const hook = installAndGetHook();
    hook({ readMode: "vec0", elapsedMs: 12 });

    const calls = vi.mocked(Sentry.metrics.distribution).mock.calls;
    const dist = calls.find((c) => c[0] === "lore.vec.read_latency_ms");
    expect(dist).toBeDefined();
    expect(dist?.[1]).toBe(12);
    const opts = dist?.[2] as {
      unit?: string;
      attributes?: Record<string, string>;
    };
    expect(opts?.unit).toBe("millisecond");
    expect(opts?.attributes).toEqual({
      read_mode: "vec0",
      storage_mode: "vec0",
      vec_available: "true",
    });
  });

  it("tags a degraded read distinctly from a healthy vec0 read", () => {
    const hook = installAndGetHook();
    hook({ readMode: "degraded", elapsedMs: 9000 });
    const dist = vi
      .mocked(Sentry.metrics.distribution)
      .mock.calls.find((c) => c[0] === "lore.vec.read_latency_ms");
    expect(
      (dist?.[2] as { attributes?: Record<string, string> })?.attributes,
    ).toEqual({
      read_mode: "degraded",
      storage_mode: "vec0",
      vec_available: "false",
    });
  });

  it("emits nothing when Sentry is not initialized", () => {
    vi.mocked(Sentry.isInitialized).mockReturnValue(false);
    const hook = installAndGetHook();
    hook({ readMode: "vec0", elapsedMs: 5 });
    expect(Sentry.metrics.distribution).not.toHaveBeenCalled();
  });
});
