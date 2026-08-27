import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scopeMocks = vi.hoisted(() => ({
  current: { kind: "current", setClient: vi.fn() },
  isolation: { kind: "isolation" },
  index: 0,
  client: { kind: "client" },
}));

vi.mock("@sentry/bun", () => ({
  isInitialized: vi.fn(() => true),
  getClient: vi.fn(() => scopeMocks.client),
  captureEvent: vi.fn(() => "event-id"),
  Scope: vi.fn(
    class Scope {
      constructor() {
        return [scopeMocks.current, scopeMocks.isolation][
          scopeMocks.index++
        ] as unknown as this;
      }
    },
  ),
}));

import * as Sentry from "@sentry/bun";
import {
  reportRecallContinuationFailure,
  type RecallContinuationFailureCategory,
  setRecallContinuationFailureHook,
} from "../src/recall-continuation-failure";
import { setupRecallContinuationFailureCapture } from "../src/sentry";

describe("setupRecallContinuationFailureCapture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scopeMocks.index = 0;
    scopeMocks.current.setClient.mockClear();
    vi.mocked(Sentry.isInitialized).mockReturnValue(true);
    setRecallContinuationFailureHook(undefined);
  });

  afterEach(() => {
    setRecallContinuationFailureHook(undefined);
  });

  it("captures one fixed event containing only the allowlisted category", () => {
    setupRecallContinuationFailureCapture();
    reportRecallContinuationFailure("follow_up_failed");

    expect(Sentry.captureEvent).toHaveBeenCalledWith({
      level: "warning",
      message: "Recall continuation failed",
      fingerprint: ["recall-continuation-failure", "follow_up_failed"],
      contexts: {
        recall_continuation_failure: {
          category: "follow_up_failed",
        },
      },
      sdkProcessingMetadata: {
        capturedSpanScope: scopeMocks.current,
        capturedSpanIsolationScope: scopeMocks.isolation,
      },
    });
    expect(scopeMocks.current.setClient).toHaveBeenCalledWith(
      scopeMocks.client,
    );
  });

  it("does nothing when Sentry is not initialized", () => {
    vi.mocked(Sentry.isInitialized).mockReturnValue(false);
    setupRecallContinuationFailureCapture();
    reportRecallContinuationFailure("follow_up_setup");

    expect(Sentry.captureEvent).not.toHaveBeenCalled();
  });

  it("contains Sentry failures", () => {
    vi.mocked(Sentry.captureEvent).mockImplementation(() => {
      throw new Error("private sentry failure");
    });
    setupRecallContinuationFailureCapture();

    expect(() =>
      reportRecallContinuationFailure("follow_up_protocol"),
    ).not.toThrow();
  });

  it("drops categories outside the runtime allowlist", () => {
    setupRecallContinuationFailureCapture();
    reportRecallContinuationFailure(
      "private provider detail" as RecallContinuationFailureCategory,
    );

    expect(Sentry.captureEvent).not.toHaveBeenCalled();
  });
});
