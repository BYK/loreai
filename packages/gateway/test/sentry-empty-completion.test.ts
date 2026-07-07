import { describe, it, expect, beforeEach, vi } from "vitest";

// Replace @sentry/bun with a complete mock so we can drive isInitialized() and
// assert the exact captureMessage payload (see sentry-bust-spiral.test.ts).
vi.mock("@sentry/bun", () => ({
  isInitialized: vi.fn(() => true),
  captureMessage: vi.fn(() => "event-id"),
}));

import { captureEmptyCompletion } from "../src/sentry";
import * as Sentry from "@sentry/bun";

const INFO = {
  protocol: "openai",
  model: "gpt-4o-mini",
  sessionID: "sess-abc",
  stopReason: "end_turn",
  outputTokens: 0,
  recallDepth: 0,
};

describe("captureEmptyCompletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Sentry.isInitialized).mockReturnValue(true);
  });

  it("captures a warning grouped by protocol with the diagnostic context", () => {
    captureEmptyCompletion({ ...INFO, protocol: "openai-responses" });
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    const [message, opts] = vi.mocked(Sentry.captureMessage).mock.calls[0];
    expect(message).toMatch(/empty completion/i);
    expect(opts).toMatchObject({
      level: "warning",
      fingerprint: ["empty-completion", "openai-responses"],
    });
    // Full diagnostic payload is attached for triage.
    expect(
      (opts as { contexts: { empty_completion: Record<string, unknown> } })
        .contexts.empty_completion,
    ).toMatchObject({ protocol: "openai-responses", model: "gpt-4o-mini" });
  });

  it("is a no-op when Sentry is not initialized", () => {
    vi.mocked(Sentry.isInitialized).mockReturnValue(false);
    captureEmptyCompletion(INFO);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it("groups distinct protocols into distinct fingerprints", () => {
    captureEmptyCompletion({ ...INFO, protocol: "gemini" });
    captureEmptyCompletion({ ...INFO, protocol: "openai" });
    const fps = vi
      .mocked(Sentry.captureMessage)
      .mock.calls.map((c) => (c[1] as { fingerprint: string[] }).fingerprint);
    expect(fps).toEqual([
      ["empty-completion", "gemini"],
      ["empty-completion", "openai"],
    ]);
  });
});
