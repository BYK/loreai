import { describe, test, expect, beforeEach, vi } from "vitest";
import {
  recordWorkerFailure,
  recordWorkerSuccess,
  getStatus,
  getDegradationWarning,
  getWorkerHealth,
  _resetForTest,
  _setNowForTest,
  type FailureReason,
} from "../src/worker-health";

vi.mock("@sentry/bun", () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("@loreai/core", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe("worker-health", () => {
  beforeEach(() => {
    _resetForTest();
    _setNowForTest(() => 1_000_000);
  });

  describe("sliding window", () => {
    test("first 1-2 failures: log only, no alert", () => {
      recordWorkerFailure("s1", "lore-distill", "no-auth");
      recordWorkerFailure("s1", "lore-distill", "no-auth");
      expect(getStatus("s1")).toBe("healthy");
      expect(getDegradationWarning("s1")).toBeNull();
    });

    test("3rd failure in window: still healthy (degraded is time-based)", () => {
      recordWorkerFailure("s1", "lore-distill", "no-auth");
      recordWorkerFailure("s1", "lore-distill", "no-auth");
      recordWorkerFailure("s1", "lore-distill", "no-auth");
      expect(getStatus("s1")).toBe("healthy");
    });

    test("sustained 30+ min: degraded status and warning", () => {
      let t = 1_000_000;
      _setNowForTest(() => t);
      for (let i = 0; i < 3; i++) {
        recordWorkerFailure("s1", "lore-distill", "no-auth");
        t += 5 * 60 * 1000; // 5 min between failures — outside the 5-min window
      }
      // 10 minutes since first failure — still healthy
      expect(getStatus("s1")).toBe("healthy");
      // Advance to 31 min — degraded
      t = 1_000_000 + 31 * 60 * 1000;
      _setNowForTest(() => t);
      expect(getStatus("s1")).toBe("degraded");
      expect(getDegradationWarning("s1")).not.toBeNull();
    });

    test("sustained 60+ min: critical status", () => {
      let t = 1_000_000;
      _setNowForTest(() => t);
      for (let i = 0; i < 3; i++) {
        recordWorkerFailure("s1", "lore-distill", "no-auth");
        t += 5 * 60 * 1000;
      }
      t = 1_000_000 + 61 * 60 * 1000;
      _setNowForTest(() => t);
      expect(getStatus("s1")).toBe("critical");
    });

    test("sliding window resets counter but preserves firstFailureAt", () => {
      // Regression: previously, after the 5-min window expired the code
      // replaced the entry wholesale with a new firstFailureAt. This meant
      // a session failing every 4 minutes could NEVER reach 30 min of
      // sustained outage. The fix: reset the counter on new windows, but
      // keep firstFailureAt until SESSION_TTL_MS elapses.
      let t = 1_000_000;
      _setNowForTest(() => t);
      for (let i = 0; i < 3; i++) {
        recordWorkerFailure("s1", "lore-distill", "no-auth");
        t += 5 * 60 * 1000; // 5 min apart — outside the sliding window
      }
      // t is now 1_000_000 + 10 min after firstFailureAt
      // We need 30 min from firstFailureAt to reach "degraded".
      // Currently we're 10 min in. Advance to 31 min.
      t = 1_000_000 + 31 * 60 * 1000;
      _setNowForTest(() => t);
      expect(getStatus("s1")).toBe("degraded");
    });

    test("ttl expiry: after 1h since lastFailureAt, state is fully evicted", () => {
      let t = 1_000_000;
      _setNowForTest(() => t);
      recordWorkerFailure("s1", "lore-distill", "no-auth");
      // 1h+ later — entry should be evicted
      t = 1_000_000 + 61 * 60 * 1000;
      _setNowForTest(() => t);
      recordWorkerFailure("s1", "lore-distill", "no-auth");
      // We just recorded a fresh entry; status reflects fresh start
      expect(getStatus("s1")).toBe("healthy");
    });
  });

  describe("recovery", () => {
    test("recordWorkerSuccess clears state and emits nothing if not alerted", () => {
      recordWorkerFailure("s1", "lore-distill", "no-auth");
      recordWorkerSuccess("s1");
      expect(getStatus("s1")).toBe("healthy");
      expect(
        getWorkerHealth().find((h) => h.sessionID === "s1"),
      ).toBeUndefined();
    });

    test("recordWorkerSuccess after degraded state recovers", () => {
      let t = 1_000_000;
      _setNowForTest(() => t);
      for (let i = 0; i < 3; i++) {
        recordWorkerFailure("s1", "lore-distill", "no-auth");
        t += 5 * 60 * 1000;
      }
      t = 1_000_000 + 31 * 60 * 1000;
      _setNowForTest(() => t);
      expect(getStatus("s1")).toBe("degraded");
      recordWorkerSuccess("s1");
      expect(getStatus("s1")).toBe("healthy");
    });
  });

  describe("reasons and worker IDs", () => {
    test("tracks unique reasons and worker IDs per session", () => {
      recordWorkerFailure("s1", "lore-distill", "no-auth");
      recordWorkerFailure("s1", "lore-distill", "parse-error");
      recordWorkerFailure("s1", "lore-curator", "upstream-error");
      const entry = getWorkerHealth().find((h) => h.sessionID === "s1");
      expect(entry?.reasons).toEqual(
        expect.arrayContaining<FailureReason>([
          "no-auth",
          "parse-error",
          "upstream-error",
        ]),
      );
      expect(entry?.workerIDs).toEqual(
        expect.arrayContaining(["lore-distill", "lore-curator"]),
      );
    });
  });

  describe("multi-session isolation", () => {
    test("failures in one session do not affect another", () => {
      recordWorkerFailure("s1", "lore-distill", "no-auth");
      recordWorkerFailure("s1", "lore-distill", "no-auth");
      recordWorkerFailure("s1", "lore-distill", "no-auth");
      expect(getStatus("s2")).toBe("healthy");
      expect(getDegradationWarning("s2")).toBeNull();
    });
  });
});
