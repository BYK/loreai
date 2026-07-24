import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @sentry/bun BEFORE importing the module under test (mirrors
// cache-bust-metric.test.ts). We drive isInitialized() and capture startSpan +
// metrics.distribution calls.
vi.mock("@sentry/bun", () => ({
  isInitialized: vi.fn(() => false),
  metrics: {
    distribution: vi.fn(),
    count: vi.fn(),
  },
  startSpan: vi.fn(),
}));

import * as Sentry from "@sentry/bun";
import { spanDeltaUpgrade } from "../src/sentry";

type Attrs = Record<string, unknown>;

// Run startSpan by invoking the callback with a recording fake span.
function setupStartSpan(): { attrs: Attrs } {
  const attrs: Attrs = {};
  vi.mocked(Sentry.startSpan).mockImplementation(async (_opts, cb) =>
    cb({
      setAttribute: (k: string, v: unknown) => {
        attrs[k] = v;
      },
    } as unknown as Sentry.Span),
  );
  return { attrs };
}

const BASE = { channel: "stable", fromVersion: "1.0.0", toVersion: "1.1.0" };

function distCall(name: string): { value: number; attrs?: Attrs } | undefined {
  const call = vi
    .mocked(Sentry.metrics.distribution)
    .mock.calls.find((c) => c[0] === name);
  if (!call) return undefined;
  return {
    value: call[1],
    attrs: (call[2] as { attributes?: Attrs })?.attributes,
  };
}

describe("spanDeltaUpgrade", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Sentry.isInitialized).mockReturnValue(true);
  });

  it("emits patch_bytes + chain_length distributions and span attributes on ok", async () => {
    const { attrs } = setupStartSpan();
    const out = await spanDeltaUpgrade(BASE, async (report) => {
      report({
        channel: "stable",
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
        source: "network",
        result: "ok",
        patchBytes: 12_400_000,
        chainLength: 3,
        sha256: "abcdef1234567890deadbeef",
      });
      return "done";
    });

    expect(out).toBe("done");
    expect(attrs["delta.result"]).toBe("ok");
    expect(attrs["delta.source"]).toBe("network");
    expect(attrs["delta.patch_bytes"]).toBe(12_400_000);
    expect(attrs["delta.chain_length"]).toBe(3);
    // sha256 is truncated to 12 chars on the span
    expect(attrs["delta.sha256"]).toBe("abcdef123456");

    const pb = distCall("lore.upgrade.delta.patch_bytes");
    expect(pb?.value).toBe(12_400_000);
    expect(pb?.attrs).toEqual({ channel: "stable" });
    const cl = distCall("lore.upgrade.delta.chain_length");
    expect(cl?.value).toBe(3);
  });

  it("emits NO distributions on unavailable (graceful fallback) and records the reason", async () => {
    const { attrs } = setupStartSpan();
    await spanDeltaUpgrade(BASE, async (report) => {
      report({
        channel: "stable",
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
        result: "unavailable",
        reason: "malformed_chain",
      });
      return null;
    });
    expect(Sentry.metrics.distribution).not.toHaveBeenCalled();
    expect(attrs["delta.result"]).toBe("unavailable");
    // The poisoned-publish signal must reach the span so it is alertable.
    expect(attrs["delta.reason"]).toBe("malformed_chain");
  });

  it("emits NO distributions when a non-ok report carries patch metrics (ok-gate is load-bearing)", async () => {
    // Drives the real invariant the `result === "ok"` guard protects: a report
    // that carries patchBytes/chainLength but is NOT ok must not emit
    // distributions. Without this, the guard mutation ships GREEN (vacuous).
    setupStartSpan();
    await spanDeltaUpgrade(BASE, async (report) => {
      report({
        channel: "stable",
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
        result: "error",
        patchBytes: 9_999,
        chainLength: 5,
        errorMessage: "apply failed mid-chain",
      });
      return null;
    });
    expect(Sentry.metrics.distribution).not.toHaveBeenCalled();
  });

  it("emits NO distributions on error and records the error attribute", async () => {
    const { attrs } = setupStartSpan();
    await spanDeltaUpgrade(BASE, async (report) => {
      report({
        channel: "stable",
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
        result: "error",
        errorMessage: "SHA-256 mismatch",
      });
      return null;
    });
    expect(attrs["delta.result"]).toBe("error");
    expect(attrs["delta.error"]).toBe("SHA-256 mismatch");
    expect(Sentry.metrics.distribution).not.toHaveBeenCalled();
  });

  it("is a no-op pass-through when Sentry is not initialized", async () => {
    vi.mocked(Sentry.isInitialized).mockReturnValue(false);
    const out = await spanDeltaUpgrade(BASE, async (report) => {
      report({
        channel: "stable",
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
        result: "ok",
        patchBytes: 1,
      });
      return "ran";
    });
    expect(out).toBe("ran");
    expect(Sentry.startSpan).not.toHaveBeenCalled();
    expect(Sentry.metrics.distribution).not.toHaveBeenCalled();
  });
});
