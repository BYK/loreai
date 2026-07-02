import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @sentry/bun BEFORE importing the module under test (mirrors
// readpath-capture.test.ts). A full factory replaces the shared instance for
// both this test and src/sentry.ts, so we can drive isInitialized() and assert
// the exact metric attributes emitted.
vi.mock("@sentry/bun", () => ({
  isInitialized: vi.fn(() => false),
  metrics: {
    distribution: vi.fn(),
    count: vi.fn(),
  },
}));

import * as Sentry from "@sentry/bun";
import { emitCacheBustMetric } from "../src/sentry";

type Attrs = Record<string, unknown>;

function distAttrs(name: string): Attrs | undefined {
  const call = vi
    .mocked(Sentry.metrics.distribution)
    .mock.calls.find((c) => c[0] === name);
  return (call?.[2] as { attributes?: Attrs })?.attributes;
}

function countAttrs(name: string): Attrs | undefined {
  const call = vi
    .mocked(Sentry.metrics.count)
    .mock.calls.find((c) => c[0] === name);
  return (call?.[2] as { attributes?: Attrs })?.attributes;
}

describe("emitCacheBustMetric idle_resume dimension", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Sentry.isInitialized).mockReturnValue(true);
  });

  it("tags a WARM prefix-rewrite (idle_resume=false) — the avoidable leak signal", () => {
    emitCacheBustMetric(
      "prefix-rewrite",
      192878,
      "claude-opus-4-8",
      false,
      false,
    );

    expect(distAttrs("lore.cache_bust_tokens")).toMatchObject({
      cause: "prefix-rewrite",
      idle_resume: false,
    });
    expect(countAttrs("lore.cache_bust")).toMatchObject({
      cause: "prefix-rewrite",
      idle_resume: false,
    });
  });

  it("tags a COLD idle-resume prefix-rewrite (idle_resume=true) — free, distinct from the leak", () => {
    emitCacheBustMetric(
      "prefix-rewrite",
      192878,
      "claude-opus-4-8",
      false,
      true,
    );

    expect(distAttrs("lore.cache_bust_tokens")?.idle_resume).toBe(true);
    expect(countAttrs("lore.cache_bust")?.idle_resume).toBe(true);
  });

  it("defaults idle_resume to false when the arg is omitted (back-compat)", () => {
    emitCacheBustMetric("window-shift", 1000, "claude-opus-4-8");

    expect(distAttrs("lore.cache_bust_tokens")?.idle_resume).toBe(false);
    expect(countAttrs("lore.cache_bust")?.idle_resume).toBe(false);
  });

  it("emits nothing when Sentry is not initialized", () => {
    vi.mocked(Sentry.isInitialized).mockReturnValue(false);
    emitCacheBustMetric("prefix-rewrite", 500, "m", false, false);

    expect(Sentry.metrics.distribution).not.toHaveBeenCalled();
    expect(Sentry.metrics.count).not.toHaveBeenCalled();
  });
});
