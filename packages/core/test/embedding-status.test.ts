import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  embeddingStatus,
  _markLocalProviderUnavailable,
  _resetLocalProviderProbe,
  _setLocalInitRetryAtForTest,
} from "../src/embedding";

// embeddingStatus() is the read-only health snapshot behind `/health` and
// `lore doctor`. Unlike isAvailable() it must never mutate state (no retry, no
// worker spawn, no logging) — it just reports whether vector recall is live or
// silently degraded to FTS-only. The default test config uses the local
// (ONNX) provider.

describe("embeddingStatus", () => {
  beforeEach(() => {
    _resetLocalProviderProbe();
  });
  afterEach(() => {
    _resetLocalProviderProbe();
  });

  it("reports ok for a healthy local provider", () => {
    const s = embeddingStatus();
    expect(s.provider).toBe("local");
    expect(s.available).toBe(true);
    expect(s.state).toBe("ok");
  });

  it("reports unavailable + FTS-only once the local provider is latched broken", () => {
    _markLocalProviderUnavailable();
    const s = embeddingStatus();
    expect(s.available).toBe(false);
    expect(s.state).toBe("unavailable");
    expect(s.provider).toBe("local");
    expect(s.detail).toContain("FTS-only");
  });

  it("reports retrying (FTS-only) while a transient-failure retry is armed", () => {
    _setLocalInitRetryAtForTest(Date.now() + 60_000);
    const s = embeddingStatus();
    expect(s.available).toBe(false);
    expect(s.state).toBe("retrying");
    expect(s.provider).toBe("local");
  });

  it("stays retrying after the cooldown elapses, until an embed recovers (Seer regression)", () => {
    // Deadline in the PAST: cooldown elapsed but the retry hasn't run yet. A
    // pure health read must not report a false "ok" here.
    _setLocalInitRetryAtForTest(Date.now() - 60_000);
    const s = embeddingStatus();
    expect(s.available).toBe(false);
    expect(s.state).toBe("retrying");
  });
});
