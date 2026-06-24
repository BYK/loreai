import { describe, it, expect, beforeEach, vi } from "vitest";
import { setupBustSpiralCapture } from "../src/sentry";
import * as core from "@loreai/core";

describe("bust-spiral Sentry wiring (#797 / #952)", () => {
  beforeEach(() => {
    core.setBustSpiralHook(null);
  });

  it("setupBustSpiralCapture is safe to call when Sentry is not initialized", () => {
    // Sentry is not initialized in the test process (no DSN configured).
    // The wrapper must register a hook regardless; all hook paths gate on
    // Sentry.isInitialized() at call time, so Sentry-off is a clean no-op.
    expect(() => setupBustSpiralCapture()).not.toThrow();
  });

  it("setupBustSpiralCapture is idempotent (repeat calls are harmless)", () => {
    // Each call replaces the module-level hook (no stacking). Safe to call
    // from startServer() which may be called multiple times across test
    // suites or restarts.
    expect(() => {
      setupBustSpiralCapture();
      setupBustSpiralCapture();
      setupBustSpiralCapture();
    }).not.toThrow();
  });

  it("registers a hook via setBustSpiralHook with all three callbacks", () => {
    // Spy on the core setter to capture the hook the wrapper installs. This
    // is the load-bearing check: if setupBustSpiralCapture ever stops
    // calling setBustSpiralHook, or registers a hook with a different
    // shape, this test breaks.
    const spy = vi.spyOn(core, "setBustSpiralHook");
    try {
      setupBustSpiralCapture();
      expect(spy).toHaveBeenCalledOnce();
      const hook = spy.mock.calls[0][0] as core.BustSpiralHook;
      // Hook shape: all three callbacks should be present (or null/undefined
      // per the optional interface, but production installs all three).
      expect(hook.onColdStart).toBeTypeOf("function");
      expect(hook.onSpiral).toBeTypeOf("function");
      expect(hook.onRecovered).toBeTypeOf("function");
    } finally {
      spy.mockRestore();
    }
  });

  it("calling the registered hook does not throw when Sentry is not initialized", () => {
    // The real Sentry behavior (captureMessage at error level, etc.) is
    // verified by the production code reading the wrapper — vi.mock on
    // @sentry/bun doesn't reach the production namespace import cleanly
    // (alias resolution). The no-op-when-Sentry-off path is the
    // load-bearing one: a thrown error from telemetry would break the
    // request path, which is the standing invariant.
    const spy = vi.spyOn(core, "setBustSpiralHook");
    try {
      setupBustSpiralCapture();
      const hook = spy.mock.calls[0][0] as core.BustSpiralHook;
      const info: core.BustSpiralInfo = {
        sessionID: "s",
        consecutiveBusts: 3,
        transformCount: 5,
        layer: 0,
        capFit: false,
      };
      expect(() => hook.onColdStart?.(info)).not.toThrow();
      expect(() => hook.onSpiral?.(info)).not.toThrow();
      expect(() => hook.onRecovered?.(info)).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});
