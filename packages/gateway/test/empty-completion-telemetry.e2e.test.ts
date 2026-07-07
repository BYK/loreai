/**
 * Wiring test: when the finalize path is about to return a completion with no
 * usable content, the gateway emits the empty-completion diagnostic
 * (log.warn + captureEmptyCompletion). Drives a real in-process gateway over the
 * openai conversation path with a canned EMPTY upstream reply (no network).
 */
import { describe, test, expect, afterEach, vi } from "vitest";
import * as core from "@loreai/core";
import { createHarness, type Harness } from "./helpers/harness";

let harness: Harness | undefined;

afterEach(() => {
  harness?.teardown();
  harness = undefined;
  vi.restoreAllMocks();
});

/** Send a non-streaming openai chat request; `upstreamBody` is returned as-is. */
async function runWithUpstream(
  upstreamBody: string,
  contentType = "application/json",
): Promise<void> {
  harness = await createHarness({ fixtures: [] });
  const { setUpstreamInterceptor } = await import("../src/pipeline");
  setUpstreamInterceptor(
    async () =>
      new Response(upstreamBody, {
        status: 200,
        headers: { "content-type": contentType },
      }),
  );
  await fetch(`${harness.baseURL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer sk-test",
      "x-lore-agent": "code", // force the conversation path (not meta)
      "x-lore-session-id": "sess-empty",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      max_tokens: 50,
    }),
  });
}

const EMPTY_OPENAI = JSON.stringify({
  id: "c1",
  model: "gpt-4o-mini",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 5, completion_tokens: 0 },
});

const NONEMPTY_OPENAI = JSON.stringify({
  id: "c2",
  model: "gpt-4o-mini",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "hello" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 5, completion_tokens: 1 },
});

describe("empty-completion telemetry wiring", () => {
  test("logs the empty-completion diagnostic when the model returns no content", async () => {
    const warn = vi.spyOn(core.log, "warn");
    await runWithUpstream(EMPTY_OPENAI);
    const emptyWarn = warn.mock.calls.find((c) =>
      String(c[0]).includes("empty completion → client"),
    );
    expect(emptyWarn, "expected an 'empty completion' warning").toBeTruthy();
    expect(String(emptyWarn?.[0])).toContain("protocol=openai");
  });

  test("does NOT log the diagnostic for a normal (non-empty) completion", async () => {
    const warn = vi.spyOn(core.log, "warn");
    await runWithUpstream(NONEMPTY_OPENAI);
    const emptyWarn = warn.mock.calls.find((c) =>
      String(c[0]).includes("empty completion → client"),
    );
    expect(emptyWarn).toBeUndefined();
  });
});
