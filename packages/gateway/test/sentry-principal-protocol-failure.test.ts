import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scopes = vi.hoisted(() => ({
  current: { setClient: vi.fn() },
  isolation: {},
  index: 0,
  client: {},
}));

vi.mock("@sentry/bun", () => ({
  isInitialized: vi.fn(() => true),
  getClient: vi.fn(() => scopes.client),
  captureEvent: vi.fn(),
  Scope: vi.fn(
    class Scope {
      constructor() {
        return [scopes.current, scopes.isolation][scopes.index++] as this;
      }
    },
  ),
}));

import * as Sentry from "@sentry/bun";
import {
  reportInvalidRecallArguments,
  reportPrincipalProtocolFailure,
  setInvalidRecallArgumentsHook,
  setPrincipalProtocolFailureHook,
  type PrincipalProtocolFailureSample,
} from "../src/principal-protocol-failure";
import { setupPrincipalProtocolFailureCapture } from "../src/sentry";

describe("setupPrincipalProtocolFailureCapture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scopes.index = 0;
    vi.mocked(Sentry.isInitialized).mockReturnValue(true);
    setPrincipalProtocolFailureHook(undefined);
    setInvalidRecallArgumentsHook(undefined);
  });

  afterEach(() => {
    setPrincipalProtocolFailureHook(undefined);
    setInvalidRecallArgumentsHook(undefined);
  });

  it("captures a recovered invalid recall using only a fixed validation code", () => {
    setupPrincipalProtocolFailureCapture();
    reportInvalidRecallArguments("missing_selector");
    reportInvalidRecallArguments(
      "private argument content" as "missing_selector",
    );
    expect(Sentry.captureEvent).toHaveBeenCalledTimes(1);
    expect(Sentry.captureEvent).toHaveBeenCalledWith({
      level: "warning",
      message: "Responses recall arguments rejected",
      fingerprint: ["responses-recall-arguments", "missing_selector"],
      contexts: { responses_recall_arguments: { issue: "missing_selector" } },
      sdkProcessingMetadata: {
        capturedSpanScope: scopes.current,
        capturedSpanIsolationScope: scopes.isolation,
      },
    });
  });

  it("captures only fixed fields in fresh scopes", () => {
    setupPrincipalProtocolFailureCapture();
    reportPrincipalProtocolFailure({
      phase: "terminal",
      event: "terminal",
      reason: "upstream_failed",
      private_payload: "private ciphertext and prompt",
    } as PrincipalProtocolFailureSample);

    expect(Sentry.captureEvent).toHaveBeenCalledWith({
      level: "warning",
      message: "Responses principal protocol failed",
      fingerprint: [
        "responses-principal-protocol",
        "terminal",
        "upstream_failed",
      ],
      contexts: {
        responses_principal_protocol: {
          phase: "terminal",
          event: "terminal",
          reason: "upstream_failed",
        },
      },
      sdkProcessingMetadata: {
        capturedSpanScope: scopes.current,
        capturedSpanIsolationScope: scopes.isolation,
      },
    });
    expect(scopes.current.setClient).toHaveBeenCalledWith(scopes.client);
  });

  it("does not capture when Sentry is disabled or fields are unrecognized", () => {
    setupPrincipalProtocolFailureCapture();
    reportPrincipalProtocolFailure({
      phase: "private" as PrincipalProtocolFailureSample["phase"],
      event: "created",
      reason: "other",
    });
    vi.mocked(Sentry.isInitialized).mockReturnValue(false);
    reportPrincipalProtocolFailure({
      phase: "decode",
      event: "created",
      reason: "malformed_json",
    });
    expect(Sentry.captureEvent).not.toHaveBeenCalled();
  });
});
