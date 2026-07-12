import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @sentry/bun BEFORE importing the module under test (mirrors
// sentry-bust-spiral.test.ts). A full factory replaces the shared instance for
// both this test and src/sentry.ts, so we can drive isInitialized() and assert
// the exact distributions emitted.
vi.mock("@sentry/bun", () => ({
  isInitialized: vi.fn(() => false),
  metrics: {
    distribution: vi.fn(),
    count: vi.fn(),
  },
}));

import * as core from "@loreai/core";
import * as Sentry from "@sentry/bun";
import { setupReadPathTimingCapture } from "../src/sentry";

type ReadPathHook = (t: core.ReadPathTiming) => void;

function installAndGetHook(): ReadPathHook {
  const setterSpy = vi.spyOn(core, "setReadPathTimingHook");
  try {
    setupReadPathTimingCapture();
    expect(setterSpy).toHaveBeenCalledOnce();
    return setterSpy.mock.calls[0][0] as ReadPathHook;
  } finally {
    setterSpy.mockRestore();
  }
}

const sample = (
  over: Partial<core.ReadPathTiming> = {},
): core.ReadPathTiming => ({
  op: "forSession",
  totalMs: 100,
  awaitedMs: 80,
  embedMs: 30,
  vectorSearchMs: 45,
  syncBlockingMs: 20,
  candidateCount: 7,
  ...over,
});

function distNames(): string[] {
  return vi.mocked(Sentry.metrics.distribution).mock.calls.map((c) => c[0]);
}

describe("read-path timing Sentry capture (#999)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Sentry.isInitialized).mockReturnValue(true);
    core.setReadPathTimingHook(null);
  });

  it("forwards embed_ms and vector_search_ms as their own distributions", () => {
    const hook = installAndGetHook();
    hook(sample());

    const calls = vi.mocked(Sentry.metrics.distribution).mock.calls;
    const embed = calls.find((c) => c[0] === "lore.readpath.embed_ms");
    const vector = calls.find((c) => c[0] === "lore.readpath.vector_search_ms");

    expect(embed).toBeDefined();
    expect(embed?.[1]).toBe(30);
    expect((embed?.[2] as { unit?: string })?.unit).toBe("millisecond");
    expect(
      (embed?.[2] as { attributes?: Record<string, string> })?.attributes?.op,
    ).toBe("forSession");

    expect(vector).toBeDefined();
    expect(vector?.[1]).toBe(45);
    expect((vector?.[2] as { unit?: string })?.unit).toBe("millisecond");

    // The pre-existing aggregate buckets are still emitted alongside.
    expect(distNames()).toEqual(
      expect.arrayContaining([
        "lore.readpath.total_ms",
        "lore.readpath.awaited_ms",
        "lore.readpath.embed_ms",
        "lore.readpath.vector_search_ms",
      ]),
    );
  });

  it("emits nothing when Sentry is not initialized", () => {
    vi.mocked(Sentry.isInitialized).mockReturnValue(false);
    const hook = installAndGetHook();
    hook(sample());
    expect(Sentry.metrics.distribution).not.toHaveBeenCalled();
  });
});
