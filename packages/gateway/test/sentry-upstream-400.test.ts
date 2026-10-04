import { beforeEach, describe, expect, it, vi } from "vitest";

const scopes = vi.hoisted(() => ({
  current: { setClient: vi.fn() },
  isolation: {},
  client: {},
  index: 0,
}));

vi.mock("@sentry/bun", () => ({
  isInitialized: vi.fn(() => true),
  getClient: vi.fn(() => scopes.client),
  captureEvent: vi.fn(),
  Scope: vi.fn(
    class Scope {
      constructor() {
        return [scopes.current, scopes.isolation][
          scopes.index++
        ] as unknown as this;
      }
    },
  ),
}));

import * as Sentry from "@sentry/bun";
import { captureUpstream400 } from "../src/sentry";
import { scrubTelemetryEvent } from "../src/telemetry-privacy";

describe("upstream 400 Sentry diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scopes.index = 0;
    vi.mocked(Sentry.isInitialized).mockReturnValue(true);
  });

  it("captures a fixed, alertable event with only numeric request dimensions", () => {
    captureUpstream400("openai-responses", {
      bodyBytes: 8_100_000,
      instructionsBytes: 172,
      inputItems: 769,
      tools: 3,
      largestItemBytes: 780_000,
      largestItemType: "function_call_output",
    });

    expect(Sentry.captureEvent).toHaveBeenCalledOnce();
    const event = vi.mocked(Sentry.captureEvent).mock.calls[0][0];
    expect(event).toMatchObject({
      level: "warning",
      message: "Upstream request rejected (HTTP 400)",
      fingerprint: ["upstream-400", "openai-responses"],
      tags: { protocol: "openai-responses" },
      contexts: {
        upstream_request_shape: {
          request_bytes: 8_100_000,
          instructions_bytes: 172,
          input_items: 769,
          tool_count: 3,
          largest_item_bytes: 780_000,
          largest_item_type: "function_call_output",
        },
      },
    });
    expect(event.sdkProcessingMetadata).toEqual({
      capturedSpanScope: scopes.current,
      capturedSpanIsolationScope: scopes.isolation,
    });
    expect(scopes.current.setClient).toHaveBeenCalledWith(scopes.client);
    expect(scrubTelemetryEvent(event).message).toBe(event.message);
  });

  it("is a no-op without Sentry and contains Sentry failures", () => {
    vi.mocked(Sentry.isInitialized).mockReturnValue(false);
    captureUpstream400("openai");
    expect(Sentry.captureEvent).not.toHaveBeenCalled();

    vi.mocked(Sentry.isInitialized).mockReturnValue(true);
    vi.mocked(Sentry.captureEvent).mockImplementation(() => {
      throw new Error("private Sentry failure");
    });
    expect(() => captureUpstream400("openai")).not.toThrow();
  });
});
