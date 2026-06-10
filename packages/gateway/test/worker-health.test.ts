import { describe, test, expect, beforeEach, vi } from "vitest";
import * as Sentry from "@sentry/bun";
import {
  recordWorkerFailure,
  recordWorkerSuccess,
  allowWorkerProbe,
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
  addBreadcrumb: vi.fn(),
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
    vi.clearAllMocks();
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

  // Regression: variable data (session ID, counts, durations) used to be
  // embedded in the Sentry message/Error text, spawning a new issue per
  // session — dozens of one-off LOREAI-GATEWAY worker-health issues. Stable
  // message + fingerprint groups them into one issue per worker.
  describe("Sentry grouping", () => {
    test("degraded alert uses stable message + fingerprint, ids in tags", () => {
      // 3 rapid failures in the window fire the degraded alert.
      recordWorkerFailure("s1", "lore-distill", "no-response");
      recordWorkerFailure("s1", "lore-distill", "no-response");
      recordWorkerFailure("s1", "lore-distill", "no-response");

      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
      const [msg, opts] = (Sentry.captureMessage as ReturnType<typeof vi.fn>)
        .mock.calls[0];
      expect(msg).toBe("Worker health degraded");
      expect(opts.fingerprint).toEqual([
        "worker-health-degraded",
        "lore-distill",
      ]);
      // Variable data must live in tags, NOT the grouping message.
      expect(opts.tags.session_id).toBe("s1");
      expect(opts.tags.worker_id).toBe("lore-distill");
    });

    test("critical alert uses stable Error message + fingerprint", () => {
      // Keep failures within the 5-min window (no reset) so firstFailureAt
      // stays put while sustained duration crosses the 60-min threshold.
      // 17 failures × 4 min = 68 min elapsed > 60-min CRITICAL_THRESHOLD_MS,
      // so the captureException fires on the failure at the 60-min mark.
      let t = 1_000_000;
      for (let i = 0; i <= 16; i++) {
        _setNowForTest(() => t);
        recordWorkerFailure("s1", "lore-distill", "no-response");
        t += 4 * 60 * 1000; // 4 min apart — inside the 5-min window
      }

      expect(Sentry.captureException).toHaveBeenCalled();
      const [err, opts] = (Sentry.captureException as ReturnType<typeof vi.fn>)
        .mock.calls[0];
      expect((err as Error).message).toBe(
        "Worker health critical: sustained worker failure",
      );
      expect(opts.fingerprint).toEqual([
        "worker-health-critical",
        "lore-distill",
      ]);
      expect(opts.tags.session_id).toBe("s1");
    });

    test("recovery is a breadcrumb, not a captured issue", () => {
      // Drive to degraded so the recovery path is in alert state.
      let t = 1_000_000;
      for (let i = 0; i < 3; i++) {
        _setNowForTest(() => t);
        recordWorkerFailure("s1", "lore-distill", "no-response");
        t += 5 * 60 * 1000;
      }
      _setNowForTest(() => 1_000_000 + 31 * 60 * 1000);
      expect(getStatus("s1")).toBe("degraded");

      recordWorkerSuccess("s1");
      expect(Sentry.addBreadcrumb).toHaveBeenCalledTimes(1);
      const [crumb] = (Sentry.addBreadcrumb as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(crumb.message).toBe("Worker health recovered");
    });
  });

  describe("circuit breaker (allowWorkerProbe)", () => {
    test("healthy session is always allowed", () => {
      expect(allowWorkerProbe("s1")).toBe(true);
    });

    test("recent failures keep the circuit closed (allowed)", () => {
      recordWorkerFailure("s1", "lore-distill", "no-response");
      recordWorkerFailure("s1", "lore-distill", "no-response");
      expect(allowWorkerProbe("s1")).toBe(true);
    });

    test("sustained failure opens circuit and throttles to one probe per interval", () => {
      const t0 = 1_000_000;
      // First failure sets firstFailureAt.
      _setNowForTest(() => t0);
      recordWorkerFailure("s1", "lore-distill", "no-response");
      // A failure 31 min later: window rotates, firstFailureAt preserved →
      // sustained 31 min ≥ 30 min open threshold.
      _setNowForTest(() => t0 + 31 * 60 * 1000);
      recordWorkerFailure("s1", "lore-distill", "no-response");

      // Just failed → within probe cooldown → blocked.
      expect(allowWorkerProbe("s1")).toBe(false);

      // 5 min after the last failure → one probe allowed.
      _setNowForTest(() => t0 + 36 * 60 * 1000);
      expect(allowWorkerProbe("s1")).toBe(true);

      // A failed probe refreshes lastFailureAt → blocked again.
      recordWorkerFailure("s1", "lore-distill", "no-response");
      expect(allowWorkerProbe("s1")).toBe(false);
    });

    test("a successful worker call closes the circuit", () => {
      const t0 = 1_000_000;
      _setNowForTest(() => t0);
      recordWorkerFailure("s1", "lore-distill", "no-response");
      _setNowForTest(() => t0 + 31 * 60 * 1000);
      recordWorkerFailure("s1", "lore-distill", "no-response");
      expect(allowWorkerProbe("s1")).toBe(false);

      recordWorkerSuccess("s1");
      expect(allowWorkerProbe("s1")).toBe(true);
    });

    test("long gap since last failure allows a probe even while open", () => {
      // After the circuit opens, a long stretch with no new failures means
      // the next attempt is always allowed (probe interval long-since passed),
      // so a recovered upstream is re-probed rather than starved forever.
      const t0 = 1_000_000;
      _setNowForTest(() => t0);
      recordWorkerFailure("s1", "lore-distill", "no-response");
      _setNowForTest(() => t0 + 31 * 60 * 1000);
      recordWorkerFailure("s1", "lore-distill", "no-response");
      expect(allowWorkerProbe("s1")).toBe(false); // just failed → cooldown

      // 61 min after the last failure — well past the 5-min probe interval.
      _setNowForTest(() => t0 + 31 * 60 * 1000 + 61 * 60 * 1000);
      expect(allowWorkerProbe("s1")).toBe(true);
    });

    test("breaker is per-session, spanning workers (one circuit per session)", () => {
      // Failures attributed to different workers in the same session share one
      // circuit — when the upstream is down, distill failures gate curation too.
      const t0 = 1_000_000;
      _setNowForTest(() => t0);
      recordWorkerFailure("s1", "lore-distill", "no-response");
      _setNowForTest(() => t0 + 31 * 60 * 1000);
      recordWorkerFailure("s1", "lore-curator", "no-response");
      // Circuit is open for the whole session regardless of which worker asks.
      expect(allowWorkerProbe("s1")).toBe(false);
      // A different session is unaffected.
      expect(allowWorkerProbe("s2")).toBe(true);
    });
  });
});
