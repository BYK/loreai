/**
 * Tests for the two cache-stability decisions added to the curation pipeline:
 *  - in-flight (turn-based) curation gating (off by default), and
 *  - cold-boundary refresh of the stable LTM block (system[1]).
 *
 * These are the pure decision functions extracted from handleRequest so the
 * actual gating logic is unit-tested (not just the config default).
 */
import { describe, test, expect } from "vitest";
import {
  shouldRunInFlightCuration,
  shouldRefreshStableLtm,
  STABLE_LTM_TTL_MS,
} from "../src/pipeline";

describe("shouldRunInFlightCuration", () => {
  const base = {
    knowledgeEnabled: true,
    inFlight: true,
    turnsSinceCuration: 5,
    effectiveAfterTurns: 3,
    curationScheduled: false,
    curatorBusy: false,
  };

  test("runs when all conditions are met and inFlight is enabled", () => {
    expect(shouldRunInFlightCuration(base)).toBe(true);
  });

  test("does NOT run when inFlight is off (the default) even past the threshold", () => {
    // This is the fix: mid-session curation is gated off by default so it can't
    // rewrite system[2] and bust the prompt cache during an active conversation.
    expect(shouldRunInFlightCuration({ ...base, inFlight: false })).toBe(false);
  });

  test("does NOT run before the turn threshold", () => {
    expect(shouldRunInFlightCuration({ ...base, turnsSinceCuration: 2 })).toBe(
      false,
    );
  });

  test("does NOT run when knowledge is disabled", () => {
    expect(
      shouldRunInFlightCuration({ ...base, knowledgeEnabled: false }),
    ).toBe(false);
  });

  test("does NOT run when a curation is already scheduled (coalesce)", () => {
    expect(
      shouldRunInFlightCuration({ ...base, curationScheduled: true }),
    ).toBe(false);
  });

  test("does NOT run when the curator limiter is busy (coalesce)", () => {
    expect(shouldRunInFlightCuration({ ...base, curatorBusy: true })).toBe(
      false,
    );
  });
});

describe("shouldRefreshStableLtm", () => {
  test("refreshes when idle gap exceeds the 1h system[1] TTL", () => {
    expect(shouldRefreshStableLtm(true, STABLE_LTM_TTL_MS)).toBe(true);
    expect(shouldRefreshStableLtm(true, STABLE_LTM_TTL_MS + 60_000)).toBe(true);
  });

  test("does NOT refresh when system[1] is still warm (gap < 1h)", () => {
    // A 5-minute idle resume cools the conversation cache but NOT the pinned
    // 1h system[1] block — keep it pinned to preserve the cache investment.
    expect(shouldRefreshStableLtm(true, 5 * 60_000)).toBe(false);
    expect(shouldRefreshStableLtm(true, STABLE_LTM_TTL_MS - 1)).toBe(false);
  });

  test("does NOT refresh when there was no idle resume at all", () => {
    expect(shouldRefreshStableLtm(false, STABLE_LTM_TTL_MS * 10)).toBe(false);
  });

  test("STABLE_LTM_TTL_MS matches the 1h system[1] cache breakpoint", () => {
    expect(STABLE_LTM_TTL_MS).toBe(3_600_000);
  });
});
