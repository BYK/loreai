import * as Sentry from "@sentry/bun";
import { afterEach, describe, expect, it } from "vitest";
import { buildSentryOptions } from "../instrument";
import {
  reportRecallContinuationFailure,
  setRecallContinuationFailureHook,
} from "../src/recall-continuation-failure";
import { setupRecallContinuationFailureCapture } from "../src/sentry";

describe("recall-continuation Sentry envelope", () => {
  afterEach(() => {
    setRecallContinuationFailureHook(undefined);
  });

  it("exports no inherited request or trace state through the real SDK", async () => {
    const previousBun = Reflect.get(globalThis, "Bun");
    Reflect.set(globalThis, "Bun", { version: "1.3.0", revision: "test" });
    const sent: unknown[] = [];
    const options = buildSentryOptions(() => ({
      send(envelope) {
        sent.push(envelope);
        return Promise.resolve({ statusCode: 200 });
      },
      flush: () => Promise.resolve(true),
    }));
    if (!options.transport) throw new Error("test transport is required");
    const client = new Sentry.BunClient({
      ...options,
      integrations: [],
      transport: options.transport,
      stackParser: Sentry.defaultStackParser,
    });
    client.init();
    const current = new Sentry.Scope();
    const isolation = new Sentry.Scope();
    current.setClient(client);
    current.setSDKProcessingMetadata({
      normalizedRequest: {
        method: "POST",
        url: "https://private.invalid/private-metadata-path",
      },
    });
    current.setContext("trace", { trace_id: "private-trace" });
    isolation.setContext("request", {
      method: "POST",
      url: "https://private.invalid/private-path",
    });

    try {
      await Sentry.withIsolationScope(isolation, () =>
        Sentry.withScope(current, () =>
          Sentry.startSpan(
            { name: "private-model-transaction", op: "private-operation" },
            async () => {
              setupRecallContinuationFailureCapture();
              reportRecallContinuationFailure("follow_up_failed");
              await client.flush(5_000);
            },
          ),
        ),
      );

      const recallEnvelope = sent.find((envelope) =>
        JSON.stringify(envelope).includes("Recall continuation failed"),
      );
      const serialized = JSON.stringify(recallEnvelope);
      expect(serialized).toContain("Recall continuation failed");
      expect(serialized).not.toContain("private");
      expect(serialized).not.toContain('"trace"');
      expect(serialized).not.toContain('"request"');
    } finally {
      await client.close(5_000);
      if (previousBun === undefined) Reflect.deleteProperty(globalThis, "Bun");
      else Reflect.set(globalThis, "Bun", previousBun);
    }
  });
});
