import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentryMocks = vi.hoisted(() => ({
  count: vi.fn(),
}));

vi.mock("@sentry/bun", () => ({
  isInitialized: vi.fn(() => true),
  metrics: { count: sentryMocks.count },
}));

import { isInitialized } from "@sentry/bun";
import {
  reportPrincipalTransportFailure,
  setPrincipalTransportFailureHook,
  type PrincipalTransportFailureSample,
} from "../src/principal-transport-failure";
import { setupPrincipalTransportFailureCapture } from "../src/sentry";

describe("setupPrincipalTransportFailureCapture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isInitialized).mockReturnValue(true);
    setPrincipalTransportFailureHook(undefined);
  });

  afterEach(() => {
    setPrincipalTransportFailureHook(undefined);
  });

  it("emits only the fixed transport dimensions", () => {
    setupPrincipalTransportFailureCapture();
    reportPrincipalTransportFailure({
      kind: "read",
      stage: "post_tool",
      outcome: "continue",
      private_detail: "secret\nforged-metric",
    } as unknown as PrincipalTransportFailureSample);

    expect(sentryMocks.count).toHaveBeenCalledWith(
      "lore.responses.principal_transport",
      1,
      {
        attributes: {
          kind: "read",
          stage: "post_tool",
          outcome: "continue",
        },
      },
    );
  });

  it("does nothing when Sentry is not initialized", () => {
    vi.mocked(isInitialized).mockReturnValue(false);
    setupPrincipalTransportFailureCapture();
    reportPrincipalTransportFailure({
      kind: "inactivity",
      stage: "pre_output",
      outcome: "failed",
    });

    expect(sentryMocks.count).not.toHaveBeenCalled();
  });

  it("contains metric failures", () => {
    sentryMocks.count.mockImplementation(() => {
      throw new Error("private metric failure");
    });
    setupPrincipalTransportFailureCapture();

    expect(() =>
      reportPrincipalTransportFailure({
        kind: "read",
        stage: "pre_output",
        outcome: "retry",
      }),
    ).not.toThrow();
  });

  it("drops values outside the runtime allowlist", () => {
    setupPrincipalTransportFailureCapture();
    reportPrincipalTransportFailure({
      kind: "private provider detail",
      stage: "post_output",
      outcome: "continue",
    } as unknown as PrincipalTransportFailureSample);

    expect(sentryMocks.count).not.toHaveBeenCalled();
  });

  it("contains hostile telemetry objects with throwing getters", () => {
    setupPrincipalTransportFailureCapture();
    const hostile = Object.defineProperty({}, "kind", {
      get() {
        throw new Error("private getter failure");
      },
    }) as PrincipalTransportFailureSample;

    expect(() => reportPrincipalTransportFailure(hostile)).not.toThrow();
    expect(sentryMocks.count).not.toHaveBeenCalled();
  });
});
