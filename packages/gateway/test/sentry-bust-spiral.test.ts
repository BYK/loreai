import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock @sentry/bun BEFORE importing the module under test. A complete factory
// (vs. vi.spyOn, which cannot redefine ESM namespace exports) replaces the
// shared module instance for both this test and src/sentry.ts, so we can both
// drive `isInitialized()` per-test and assert the exact capture payloads.
vi.mock("@sentry/bun", () => ({
  isInitialized: vi.fn(() => false),
  captureMessage: vi.fn(() => "event-id"),
  addBreadcrumb: vi.fn(),
}));

import { setupBustSpiralCapture } from "../src/sentry";
import * as core from "@loreai/core";
import * as Sentry from "@sentry/bun";

const sampleInfo = (
  over: Partial<core.BustSpiralInfo> = {},
): core.BustSpiralInfo => ({
  sessionID: "sess-abc",
  consecutiveBusts: 3,
  transformCount: 5,
  layer: 0,
  capFit: false,
  ...over,
});

/** Install the capture wiring and return the hook the production code registers. */
function installAndGetHook(): core.BustSpiralHook {
  const setterSpy = vi.spyOn(core, "setBustSpiralHook");
  try {
    setupBustSpiralCapture();
    expect(setterSpy).toHaveBeenCalledOnce();
    return setterSpy.mock.calls[0][0] as core.BustSpiralHook;
  } finally {
    setterSpy.mockRestore();
  }
}

describe("bust-spiral Sentry wiring (#797 / #952)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Sentry.isInitialized).mockReturnValue(false);
    core.setBustSpiralHook(null);
  });

  it("registers a hook via setBustSpiralHook with all three callbacks", () => {
    // Load-bearing structural check: if setupBustSpiralCapture ever stops
    // calling setBustSpiralHook, or registers a hook with a different shape,
    // this breaks.
    const hook = installAndGetHook();
    expect(hook.onColdStart).toBeTypeOf("function");
    expect(hook.onSpiral).toBeTypeOf("function");
    expect(hook.onRecovered).toBeTypeOf("function");
  });

  it("is idempotent (repeat calls are harmless)", () => {
    // Each call replaces the module-level hook (no stacking). startServer() may
    // run multiple times across test suites / restarts.
    expect(() => {
      setupBustSpiralCapture();
      setupBustSpiralCapture();
      setupBustSpiralCapture();
    }).not.toThrow();
  });

  describe("Sentry NOT initialized → clean no-op (telemetry must never break the request path)", () => {
    beforeEach(() => {
      vi.mocked(Sentry.isInitialized).mockReturnValue(false);
    });

    it("setupBustSpiralCapture does not throw", () => {
      expect(() => setupBustSpiralCapture()).not.toThrow();
    });

    it("every hook callback is a no-op that emits nothing and does not throw", () => {
      const hook = installAndGetHook();
      const info = sampleInfo();
      expect(() => hook.onColdStart?.(info)).not.toThrow();
      expect(() => hook.onSpiral?.(info)).not.toThrow();
      expect(() => hook.onRecovered?.(info)).not.toThrow();
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
      expect(Sentry.addBreadcrumb).not.toHaveBeenCalled();
    });
  });

  describe("Sentry initialized → captures the bust-spiral contract", () => {
    beforeEach(() => {
      vi.mocked(Sentry.isInitialized).mockReturnValue(true);
    });

    it("onSpiral fires a high-severity captureMessage with a stable fingerprint + bust_spiral context", () => {
      // Locks the alert contract (NIT from the #952 review, kills the
      // level:error→warning and fingerprint mutations): a past-grace spiral is
      // a high-severity, fingerprint-grouped issue. The BustSpiralInfo —
      // including the #952 `capFit` field — must reach the Sentry context so
      // dashboards can distinguish structural busts from growth busts.
      const hook = installAndGetHook();
      hook.onSpiral?.(sampleInfo({ capFit: false }));

      expect(Sentry.captureMessage).toHaveBeenCalledOnce();
      expect(Sentry.addBreadcrumb).not.toHaveBeenCalled();
      const [message, opts] = vi.mocked(Sentry.captureMessage).mock
        .calls[0] as [string, Record<string, unknown>];
      expect(message).toContain("Cache bust spiral");
      expect(opts.level).toBe("error");
      expect(opts.fingerprint).toEqual(["bust-spiral-past-grace"]);
      const contexts = opts.contexts as { bust_spiral: core.BustSpiralInfo };
      expect(contexts.bust_spiral.sessionID).toBe("sess-abc");
      expect(contexts.bust_spiral.capFit).toBe(false);
    });

    it("onColdStart emits an info-level breadcrumb (not an alert)", () => {
      const hook = installAndGetHook();
      hook.onColdStart?.(sampleInfo({ capFit: true }));

      expect(Sentry.captureMessage).not.toHaveBeenCalled();
      expect(Sentry.addBreadcrumb).toHaveBeenCalledOnce();
      const [crumb] = vi.mocked(Sentry.addBreadcrumb).mock.calls[0] as [
        Record<string, unknown>,
      ];
      expect(crumb.level).toBe("info");
      expect(crumb.category).toBe("lore.cache.bust_spiral");
      expect((crumb.data as core.BustSpiralInfo).capFit).toBe(true);
    });

    it("onRecovered emits an info-level breadcrumb (not an alert)", () => {
      const hook = installAndGetHook();
      hook.onRecovered?.(sampleInfo({ consecutiveBusts: 0 }));

      expect(Sentry.captureMessage).not.toHaveBeenCalled();
      expect(Sentry.addBreadcrumb).toHaveBeenCalledOnce();
      const [crumb] = vi.mocked(Sentry.addBreadcrumb).mock.calls[0] as [
        Record<string, unknown>,
      ];
      expect(crumb.level).toBe("info");
      expect(crumb.category).toBe("lore.cache.bust_spiral");
    });
  });
});
