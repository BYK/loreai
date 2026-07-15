import { describe, test, expect, beforeEach, vi } from "vitest";
import * as Sentry from "@sentry/bun";
import {
  recordWorkerFailure,
  recordWorkerSuccess,
  allowWorkerProbe,
  getStatus,
  getDegradationWarning,
  getWorkerHealth,
  workerHealthSummary,
  markWorkerPaused,
  isWorkerCreditPaused,
  clearWorkerPaused,
  markWorkerIncapable,
  isWorkerIncapable,
  isCapabilityEmpty,
  recordEmptyWorkerResponse,
  clearEmptyWorkerStreak,
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

    test("workerHealthSummary: ok when nothing is failing", () => {
      _setNowForTest(() => 1_000_000);
      const s = workerHealthSummary();
      expect(s.ok).toBe(true);
      expect(s.degradedSessions).toBe(0);
    });

    test("workerHealthSummary: rolls up sustained failures as degraded", () => {
      let t = 1_000_000;
      _setNowForTest(() => t);
      recordWorkerFailure("s1", "lore-distill", "no-auth");
      // 31 min later the single session is past the degraded threshold.
      t = 1_000_000 + 31 * 60 * 1000;
      _setNowForTest(() => t);
      const s = workerHealthSummary();
      expect(s.ok).toBe(false);
      expect(s.degradedSessions).toBe(1);
      expect(s.detail).toContain("stalled");
    });

    test("degradation warning points at a REAL CLI command (lore doctor, not lore status)", () => {
      // Regression (Sergiy's report, 2026-07-06): the warning told users to run
      // `lore status`, which is not a command — the CLI has `doctor` for
      // routing/env/auth diagnostics. A warning that hands the user a bogus
      // command is worse than useless when their workers are already failing.
      let t = 1_000_000;
      _setNowForTest(() => t);
      for (let i = 0; i < 3; i++) {
        recordWorkerFailure("s1", "lore-distill", "no-auth");
        t += 5 * 60 * 1000;
      }
      t = 1_000_000 + 31 * 60 * 1000;
      _setNowForTest(() => t);
      const warning = getDegradationWarning("s1");
      expect(warning).not.toBeNull();
      expect(warning).toContain("`lore doctor`");
      expect(warning).not.toContain("lore status");
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

  // Regression (LOREAI-GATEWAY-3J): credential/config failures (no-auth,
  // cross-provider) on a self-hosted gateway are the user's local setup, not a
  // lore bug. They must NOT spawn a "Worker health degraded/critical" Sentry
  // issue — but the local error log, degraded STATUS, and `lore doctor` warning
  // are preserved. A window mixing in any genuine outage reason still escalates.
  describe("credential-class reasons do not escalate to Sentry (#3J)", () => {
    test("no-auth-only window: degrades locally but sends NO Sentry issue", () => {
      // 3 rapid no-auth failures reach the degraded threshold in one window.
      recordWorkerFailure("s1", "lore-contradiction", "no-auth");
      recordWorkerFailure("s1", "lore-contradiction", "no-auth");
      recordWorkerFailure("s1", "lore-contradiction", "no-auth");

      // No "Worker health degraded" issue for a purely credential-class run.
      expect(Sentry.captureMessage).not.toHaveBeenCalled();

      // The local, user-facing signal is preserved: sustained 30+ min →
      // degraded status + the actionable `lore doctor` warning.
      _setNowForTest(() => 1_000_000 + 31 * 60 * 1000);
      expect(getStatus("s1")).toBe("degraded");
      expect(getDegradationWarning("s1")).not.toBeNull();
    });

    test("cross-provider-only window: sends NO Sentry issue", () => {
      recordWorkerFailure("s1", "lore-distill", "cross-provider");
      recordWorkerFailure("s1", "lore-distill", "cross-provider");
      recordWorkerFailure("s1", "lore-distill", "cross-provider");
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });

    test("window mixing a genuine outage reason STILL escalates", () => {
      recordWorkerFailure("s1", "lore-distill", "no-auth");
      recordWorkerFailure("s1", "lore-distill", "no-auth");
      recordWorkerFailure("s1", "lore-distill", "upstream-error"); // genuine
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
      const [msg] = (Sentry.captureMessage as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(msg).toBe("Worker health degraded");
    });

    test("a genuine reason after a suppressed window still fires the first alert", () => {
      // Drive 3 credential-class failures so the escalation path actually RUNS
      // (failureCount reaches DEGRADED_THRESHOLD) and is suppressed — this is
      // the path that, if buggy, would wrongly stamp `alertSentAt`.
      recordWorkerFailure("s1", "lore-distill", "no-auth");
      recordWorkerFailure("s1", "lore-distill", "no-auth");
      recordWorkerFailure("s1", "lore-distill", "no-auth");
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
      // A genuine outage in the same window must still fire the FIRST alert:
      // `alertSentAt` was left unset by the suppressed run, so the debounce
      // does not swallow it.
      recordWorkerFailure("s1", "lore-distill", "upstream-error");
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    });

    test("sustained credential-class failure does NOT fire the critical exception", () => {
      // Keep failures inside the 5-min window (no rotation) so firstFailureAt
      // stays put while sustained duration crosses the 60-min critical mark.
      let t = 1_000_000;
      for (let i = 0; i <= 16; i++) {
        _setNowForTest(() => t);
        recordWorkerFailure("s1", "lore-contradiction", "no-auth");
        t += 4 * 60 * 1000; // 4 min apart — inside the 5-min window
      }
      expect(Sentry.captureException).not.toHaveBeenCalled();
      // Local critical status is still reflected.
      _setNowForTest(() => 1_000_000 + 65 * 60 * 1000);
      expect(getStatus("s1")).toBe("critical");
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

  // ---------------------------------------------------------------------------
  // Credit pause (HTTP 402)
  // ---------------------------------------------------------------------------

  describe("credit pause (402)", () => {
    const PROBE_INTERVAL_MS = 5 * 60 * 1000;

    test("markWorkerPaused pauses the session", () => {
      expect(isWorkerCreditPaused("s1")).toBe(false);
      markWorkerPaused("s1");
      expect(isWorkerCreditPaused("s1")).toBe(true);
      // Other sessions are unaffected.
      expect(isWorkerCreditPaused("s2")).toBe(false);
    });

    test("re-marking does not reset the probe clock (idempotent)", () => {
      const t0 = 2_000_000;
      _setNowForTest(() => t0);
      markWorkerPaused("s1");

      // Advance to just before the probe interval, then re-mark.
      _setNowForTest(() => t0 + PROBE_INTERVAL_MS - 1);
      markWorkerPaused("s1"); // no-op — already paused
      expect(isWorkerCreditPaused("s1")).toBe(true);

      // Crossing the original interval still allows a probe.
      _setNowForTest(() => t0 + PROBE_INTERVAL_MS);
      expect(isWorkerCreditPaused("s1")).toBe(false);
    });

    test("allows one probe per CIRCUIT_PROBE_INTERVAL_MS, then re-pauses", () => {
      const t0 = 3_000_000;
      _setNowForTest(() => t0);
      markWorkerPaused("s1");
      expect(isWorkerCreditPaused("s1")).toBe(true);

      // Before the interval: still paused.
      _setNowForTest(() => t0 + PROBE_INTERVAL_MS - 1);
      expect(isWorkerCreditPaused("s1")).toBe(true);

      // At the interval: one probe allowed (returns false once)...
      _setNowForTest(() => t0 + PROBE_INTERVAL_MS);
      expect(isWorkerCreditPaused("s1")).toBe(false);
      // ...and immediately re-pauses for the next interval.
      expect(isWorkerCreditPaused("s1")).toBe(true);
    });

    test("recordWorkerSuccess clears the credit pause", () => {
      markWorkerPaused("s1");
      expect(isWorkerCreditPaused("s1")).toBe(true);
      // Note: no failure-ladder entry exists for a credit-paused session.
      recordWorkerSuccess("s1");
      expect(isWorkerCreditPaused("s1")).toBe(false);
    });

    test("clearWorkerPaused clears the pause", () => {
      markWorkerPaused("s1");
      expect(isWorkerCreditPaused("s1")).toBe(true);
      clearWorkerPaused("s1");
      expect(isWorkerCreditPaused("s1")).toBe(false);
    });

    test("_resetForTest clears all credit pauses", () => {
      markWorkerPaused("s1");
      markWorkerPaused("s2");
      _resetForTest();
      expect(isWorkerCreditPaused("s1")).toBe(false);
      expect(isWorkerCreditPaused("s2")).toBe(false);
    });

    test("does not feed the failure ladder (no Sentry escalation)", () => {
      // Many credit pauses must never open the failure circuit.
      for (let i = 0; i < 10; i++) markWorkerPaused("s1");
      expect(allowWorkerProbe("s1")).toBe(true); // failure circuit untouched
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
      expect(Sentry.captureException).not.toHaveBeenCalled();
    });
  });

  describe("worker-incapable verdict", () => {
    test("mark + query a model as incapable", () => {
      expect(isWorkerIncapable("opencode", "mimo-v2.5-free")).toBe(false);
      markWorkerIncapable("opencode", "mimo-v2.5-free");
      expect(isWorkerIncapable("opencode", "mimo-v2.5-free")).toBe(true);
    });

    test("verdict is scoped per provider+model", () => {
      markWorkerIncapable("opencode", "mimo-v2.5-free");
      expect(isWorkerIncapable("opencode", "mimo-v2.5-free")).toBe(true);
      // Different model on same provider is unaffected.
      expect(isWorkerIncapable("opencode", "deepseek-v4-flash-free")).toBe(
        false,
      );
      // Same model name on a different provider is unaffected.
      expect(isWorkerIncapable("anthropic", "mimo-v2.5-free")).toBe(false);
    });

    test("recording worker-incapable does NOT escalate the failure ladder", () => {
      // Even many worker-incapable records must never open the failure circuit
      // or trigger Sentry — it's a capability fact, not an outage.
      for (let i = 0; i < 10; i++) {
        recordWorkerFailure("s1", "lore-distill", "worker-incapable");
      }
      expect(getStatus("s1")).toBe("healthy");
      expect(allowWorkerProbe("s1")).toBe(true);
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
      expect(Sentry.captureException).not.toHaveBeenCalled();
    });

    test("_resetForTest clears incapable verdicts", () => {
      markWorkerIncapable("opencode", "mimo-v2.5-free");
      _resetForTest();
      expect(isWorkerIncapable("opencode", "mimo-v2.5-free")).toBe(false);
    });
  });

  describe("isCapabilityEmpty — finish-reason classification", () => {
    test("capability signals: stop / end_turn", () => {
      expect(isCapabilityEmpty("stop")).toBe(true);
      expect(isCapabilityEmpty("end_turn")).toBe(true);
    });

    test("NOT capability: budget truncation (length AND max_tokens)", () => {
      // length = OpenAI, max_tokens = Anthropic — both are budget truncations,
      // not capability facts. The Anthropic spelling was the merge blocker.
      expect(isCapabilityEmpty("length")).toBe(false);
      expect(isCapabilityEmpty("max_tokens")).toBe(false);
    });

    test("NOT capability: content_filter and tool calls", () => {
      expect(isCapabilityEmpty("content_filter")).toBe(false);
      expect(isCapabilityEmpty("tool_calls")).toBe(false);
      expect(isCapabilityEmpty("tool_use")).toBe(false);
    });

    test("NOT capability: unknown/undefined finish reason", () => {
      expect(isCapabilityEmpty(undefined)).toBe(false);
    });
  });

  describe("recordEmptyWorkerResponse — consecutive-empty threshold", () => {
    test("does not mark incapable before 3 consecutive complete empties", () => {
      expect(recordEmptyWorkerResponse("opencode", "m", "stop")).toBe(false);
      expect(recordEmptyWorkerResponse("opencode", "m", "stop")).toBe(false);
      expect(isWorkerIncapable("opencode", "m")).toBe(false);
      // 3rd consecutive → marks.
      expect(recordEmptyWorkerResponse("opencode", "m", "stop")).toBe(true);
      expect(isWorkerIncapable("opencode", "m")).toBe(true);
    });

    test("a budget truncation does NOT count and resets the streak", () => {
      recordEmptyWorkerResponse("opencode", "m", "stop");
      recordEmptyWorkerResponse("opencode", "m", "stop");
      // Anthropic truncation in the middle resets the streak — never marks.
      expect(recordEmptyWorkerResponse("opencode", "m", "max_tokens")).toBe(
        false,
      );
      expect(recordEmptyWorkerResponse("opencode", "m", "stop")).toBe(false);
      expect(recordEmptyWorkerResponse("opencode", "m", "stop")).toBe(false);
      expect(isWorkerIncapable("opencode", "m")).toBe(false);
    });

    test("clearEmptyWorkerStreak resets the counter", () => {
      recordEmptyWorkerResponse("opencode", "m", "stop");
      recordEmptyWorkerResponse("opencode", "m", "stop");
      clearEmptyWorkerStreak("opencode", "m");
      expect(recordEmptyWorkerResponse("opencode", "m", "stop")).toBe(false);
      expect(isWorkerIncapable("opencode", "m")).toBe(false);
    });

    test("content_filter never marks a model incapable, no matter how many", () => {
      for (let i = 0; i < 10; i++) {
        expect(
          recordEmptyWorkerResponse("opencode", "m", "content_filter"),
        ).toBe(false);
      }
      expect(isWorkerIncapable("opencode", "m")).toBe(false);
    });
  });

  describe("per-worker incapable streak (regression: distill must not reset curator)", () => {
    // Production repro (2026-07-15): openrouter/meta-llama/llama-4-scout could
    // distill (returned text, resetting the streak) but returned empty for the
    // curator every time. With a per-MODEL streak, the interleaved distillation
    // successes reset the curator empty streak before it reached 3, so the model
    // was never marked incapable and the failure ladder escalated forever with a
    // misleading "auth stale" warning. The streak must be scoped per worker.
    const P = "openrouter";
    const M = "meta-llama/llama-4-scout";

    test("a usable distillation does NOT reset the curator empty streak", () => {
      // Two consecutive curator empties.
      expect(recordEmptyWorkerResponse(P, M, "stop", "lore-curator")).toBe(
        false,
      );
      expect(recordEmptyWorkerResponse(P, M, "stop", "lore-curator")).toBe(
        false,
      );
      // A successful distillation on the SAME model clears only its own streak.
      clearEmptyWorkerStreak(P, M, "lore-distill");
      // 3rd consecutive curator empty must still mark the curator incapable.
      expect(recordEmptyWorkerResponse(P, M, "stop", "lore-curator")).toBe(
        true,
      );
      expect(isWorkerIncapable(P, M, "lore-curator")).toBe(true);
    });

    test("clearEmptyWorkerStreak only resets the streak for its OWN worker", () => {
      // Locks the keyspace-coherence invariant: recordEmptyWorkerResponse and
      // clearEmptyWorkerStreak MUST share the same per-worker key. Without the
      // workerID dimension on clear, a distill success would wipe the curator
      // streak (the original bug). This asserts BOTH directions:
      //   (a) clearing a DIFFERENT worker does not reset curator, and
      //   (b) clearing the SAME worker DOES reset it.
      const P2 = "openrouter";
      const M2 = "some/other-model";
      // (a) Different-worker clear must not touch curator's streak.
      recordEmptyWorkerResponse(P2, M2, "stop", "lore-curator"); // curator=1
      recordEmptyWorkerResponse(P2, M2, "stop", "lore-curator"); // curator=2
      clearEmptyWorkerStreak(P2, M2, "lore-distill"); // must NOT reset curator
      expect(recordEmptyWorkerResponse(P2, M2, "stop", "lore-curator")).toBe(
        true, // curator reached 3 → incapable
      );
      // (b) Same-worker clear must reset that worker's streak. Use a fresh model
      // so the incapable verdict above doesn't interfere.
      const M3 = "some/third-model";
      recordEmptyWorkerResponse(P2, M3, "stop", "lore-curator"); // curator=1
      recordEmptyWorkerResponse(P2, M3, "stop", "lore-curator"); // curator=2
      clearEmptyWorkerStreak(P2, M3, "lore-curator"); // resets curator to 0
      // Next empty is streak=1, NOT 3 → must not mark incapable.
      expect(recordEmptyWorkerResponse(P2, M3, "stop", "lore-curator")).toBe(
        false,
      );
      expect(isWorkerIncapable(P2, M3, "lore-curator")).toBe(false);
    });

    test("incapable verdict is scoped per worker — distillation stays usable", () => {
      for (let i = 0; i < 3; i++) {
        recordEmptyWorkerResponse(P, M, "stop", "lore-curator");
      }
      expect(isWorkerIncapable(P, M, "lore-curator")).toBe(true);
      // The model is NOT marked incapable for distillation.
      expect(isWorkerIncapable(P, M, "lore-distill")).toBe(false);
    });

    test("empties from different workers accumulate on independent streaks", () => {
      // One empty each for curator and distill — neither reaches the threshold.
      expect(recordEmptyWorkerResponse(P, M, "stop", "lore-curator")).toBe(
        false,
      );
      expect(recordEmptyWorkerResponse(P, M, "stop", "lore-distill")).toBe(
        false,
      );
      expect(recordEmptyWorkerResponse(P, M, "stop", "lore-curator")).toBe(
        false,
      );
      expect(recordEmptyWorkerResponse(P, M, "stop", "lore-distill")).toBe(
        false,
      );
      // Neither is incapable yet (each has 2, not 3).
      expect(isWorkerIncapable(P, M, "lore-curator")).toBe(false);
      expect(isWorkerIncapable(P, M, "lore-distill")).toBe(false);
    });
  });

  describe("getDegradationWarning — cause derived from reasons (Fix B)", () => {
    test("no-response reasons name the worker model, not auth", () => {
      const t0 = 1_000_000;
      _setNowForTest(() => t0);
      recordWorkerFailure("s-nr", "lore-curator", "no-response");
      // Advance past the 30m response-message threshold.
      _setNowForTest(() => t0 + 31 * 60 * 1000);
      // Keep the entry alive with another failure in the current window.
      recordWorkerFailure("s-nr", "lore-curator", "no-response");
      const warning = getDegradationWarning("s-nr");
      expect(warning).not.toBeNull();
      expect(warning).toContain("workerModel");
      expect(warning).toContain("`lore doctor`");
      expect(warning).not.toContain("lore status");
      expect(warning).not.toContain("authentication has gone stale");
    });

    test("auth reasons still surface the stale-auth guidance", () => {
      const t0 = 2_000_000;
      _setNowForTest(() => t0);
      recordWorkerFailure("s-auth", "lore-curator", "auth-rejected");
      _setNowForTest(() => t0 + 31 * 60 * 1000);
      recordWorkerFailure("s-auth", "lore-curator", "auth-rejected");
      const warning = getDegradationWarning("s-auth");
      expect(warning).not.toBeNull();
      expect(warning).toContain("authentication has gone stale");
    });
  });
});
