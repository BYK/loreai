import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@sentry/bun", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/bun")>()),
  captureMessage: vi.fn(),
}));

import * as Sentry from "@sentry/bun";
import { buildSentryOptions } from "../instrument";
import {
  _resetForTest,
  _setNowForTest,
  getWorkerHealth,
  recordWorkerFailure,
  type WorkerResponseDiagnostic,
} from "../src/worker-health";

describe("worker response alert delivery", () => {
  beforeEach(() => {
    _resetForTest();
    vi.resetAllMocks();
  });

  test("retries after a rejected transport send but cools down after a confirmed send", async () => {
    const clock = { now: 1_000_000 };
    _setNowForTest(() => clock.now);
    const firstID = "00000000000000000000000000000001";
    const secondID = "00000000000000000000000000000002";
    vi.mocked(Sentry.captureMessage)
      .mockReturnValueOnce(firstID)
      .mockReturnValueOnce(secondID);
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("private-provider-secret"))
      .mockResolvedValueOnce({ statusCode: 200 });
    const transport = buildSentryOptions(() => ({
      send,
      flush: () => Promise.resolve(true),
    })).transport?.({
      url: "https://sentry.invalid",
      recordDroppedEvent: () => {},
    });
    if (!transport) throw new Error("missing transport");
    const envelope = (eventID: string) =>
      [
        { event_id: eventID, sent_at: new Date(0).toISOString() },
        [
          [
            { type: "event" },
            { event_id: eventID, message: "Worker response rejected" },
          ],
        ],
      ] as Parameters<typeof transport.send>[0];
    const diagnostic: WorkerResponseDiagnostic = {
      protocol: "anthropic",
      stage: "decode",
      content: "json",
      category: "malformed JSON body",
      finishReason: "n/a",
      httpStatus: 200,
    };

    recordWorkerFailure("s1", "lore-distill", "upstream-error", diagnostic);
    await expect(transport.send(envelope(firstID))).rejects.toThrow();
    expect(getWorkerHealth()[0]?.failureCount).toBe(1);

    clock.now += 60_000;
    recordWorkerFailure("s2", "lore-distill", "upstream-error", diagnostic);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(2);
    await transport.send(envelope(secondID));
    clock.now += 60_000;
    recordWorkerFailure("s3", "lore-distill", "upstream-error", diagnostic);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(2);
    expect(getWorkerHealth()).toHaveLength(3);
  });

  test("starts the long cooldown when a delayed transport send confirms delivery", async () => {
    const clock = { now: 1_000_000 };
    _setNowForTest(() => clock.now);
    const eventID = "00000000000000000000000000000007";
    vi.mocked(Sentry.captureMessage).mockReturnValueOnce(eventID);
    const confirmation = Promise.withResolvers<{ statusCode: number }>();
    const transport = buildSentryOptions(() => ({
      send: () => confirmation.promise,
      flush: () => Promise.resolve(true),
    })).transport?.({
      url: "https://sentry.invalid",
      recordDroppedEvent: () => {},
    });
    if (!transport) throw new Error("missing transport");
    const diagnostic: WorkerResponseDiagnostic = {
      protocol: "anthropic",
      stage: "decode",
      content: "json",
      category: "malformed JSON body",
      finishReason: "n/a",
      httpStatus: 200,
    };

    recordWorkerFailure("s1", "lore-distill", "upstream-error", diagnostic);
    const sending = transport.send([
      { event_id: eventID, sent_at: new Date(0).toISOString() },
      [
        [
          { type: "event" },
          { event_id: eventID, message: "Worker response rejected" },
        ],
      ],
    ]);
    clock.now += 14 * 60_000;
    confirmation.resolve({ statusCode: 200 });
    await sending;
    clock.now += 2 * 60_000;
    recordWorkerFailure("s2", "lore-distill", "upstream-error", diagnostic);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    clock.now += 14 * 60_000;
    recordWorkerFailure("s3", "lore-distill", "upstream-error", diagnostic);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(2);
    expect(getWorkerHealth()).toHaveLength(3);
  });

  test.each([{ statusCode: 429 }, {}])(
    "does not treat a non-delivery transport response as success: %j",
    async (response) => {
      const clock = { now: 1_000_000 };
      _setNowForTest(() => clock.now);
      const eventID = "00000000000000000000000000000005";
      vi.mocked(Sentry.captureMessage).mockReturnValueOnce(eventID);
      const transport = buildSentryOptions(() => ({
        send: () => Promise.resolve(response),
        flush: () => Promise.resolve(true),
      })).transport?.({
        url: "https://sentry.invalid",
        recordDroppedEvent: () => {},
      });
      if (!transport) throw new Error("missing transport");
      const diagnostic: WorkerResponseDiagnostic = {
        protocol: "openai",
        stage: "parse",
        content: "json",
        category: "invalid response body",
        finishReason: "n/a",
        httpStatus: 200,
      };

      recordWorkerFailure("s1", "lore-distill", "upstream-error", diagnostic);
      await transport.send([
        { event_id: eventID, sent_at: new Date(0).toISOString() },
        [
          [
            { type: "event" },
            { event_id: eventID, message: "Worker response rejected" },
          ],
        ],
      ]);
      clock.now += 60_000;
      recordWorkerFailure("s2", "lore-distill", "upstream-error", diagnostic);
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(2);
      expect(getWorkerHealth()).toHaveLength(2);
    },
  );

  test("ignores late delivery from an attempt superseded by a failed capture", async () => {
    const clock = { now: 1_000_000 };
    _setNowForTest(() => clock.now);
    const eventID = "00000000000000000000000000000006";
    vi.mocked(Sentry.captureMessage)
      .mockReturnValueOnce(eventID)
      .mockImplementationOnce(() => {
        throw new Error("private-provider-secret");
      });
    const transport = buildSentryOptions(() => ({
      send: () => Promise.resolve({ statusCode: 200 }),
      flush: () => Promise.resolve(true),
    })).transport?.({
      url: "https://sentry.invalid",
      recordDroppedEvent: () => {},
    });
    if (!transport) throw new Error("missing transport");
    const diagnostic: WorkerResponseDiagnostic = {
      protocol: "anthropic",
      stage: "decode",
      content: "json",
      category: "malformed JSON body",
      finishReason: "n/a",
      httpStatus: 200,
    };
    recordWorkerFailure("s1", "lore-distill", "upstream-error", diagnostic);
    clock.now += 60_000;
    recordWorkerFailure("s2", "lore-distill", "upstream-error", diagnostic);
    await transport.send([
      { event_id: eventID, sent_at: new Date(0).toISOString() },
      [
        [
          { type: "event" },
          { event_id: eventID, message: "Worker response rejected" },
        ],
      ],
    ]);
    clock.now += 60_000;
    recordWorkerFailure("s3", "lore-distill", "upstream-error", diagnostic);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(3);
    expect(getWorkerHealth()).toHaveLength(3);
  });
});
