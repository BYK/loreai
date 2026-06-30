/**
 * End-to-end wiring guard for #1052.
 *
 * Drives a real `POST /v1/chat/completions` through the full gateway pipeline
 * (handleRequest → forwardToUpstream) and captures the exact URL the gateway
 * forwards to upstream. This pins the BEHAVIOR — not just the pure helpers — so
 * a revert of the `verbatimUpstreamUrl(...)` wiring in forwardToUpstream fails
 * here even though the unit tests would still pass.
 *
 * Mechanism: `upstreamFetch` is mocked to capture its URL, and the upstream
 * interceptor is overridden to invoke `makeRealRequest()` (whose closure holds
 * the resolved url) so the mocked fetch runs and records the destination.
 */
import { describe, test, expect, afterEach, vi } from "vitest";

vi.mock("../src/fetch", () => ({ upstreamFetch: vi.fn() }));

import { upstreamFetch } from "../src/fetch";
import type { Harness } from "./helpers/harness";
import { createHarness } from "./helpers/harness";

const mockFetch = vi.mocked(upstreamFetch);

function openAIResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-x",
      object: "chat.completion",
      model: "gpt-4.1",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** Send an OpenAI chat-completions request and return the captured upstream URL. */
async function captureUpstreamUrl(
  harness: Harness,
  headers: Record<string, string>,
): Promise<string> {
  const { setUpstreamInterceptor } = await import("../src/pipeline");
  // Replace the harness replay interceptor with one that performs the REAL
  // (mocked) upstream call, so the resolved URL flows into mockFetch.
  setUpstreamInterceptor(async (_body, _model, _stream, makeReal) =>
    makeReal(),
  );
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(openAIResponse());

  const res = await fetch(`${harness.baseURL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer gho_test",
      "x-lore-project": "/tmp/copilot-e2e",
      ...headers,
    },
    body: JSON.stringify({
      model: "gpt-4.1",
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  await res.text().catch(() => undefined);

  expect(mockFetch).toHaveBeenCalled();
  return String(mockFetch.mock.calls[0][0]);
}

describe("github-copilot upstream URL — full pipeline wiring (#1052)", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.teardown();
    harness = undefined;
  });

  test("forwards verbatim to /chat/completions (no /v1) for github-copilot", async () => {
    harness = await createHarness({ fixtures: [] });
    const url = await captureUpstreamUrl(harness, {
      "x-lore-provider": "github-copilot",
      "x-lore-upstream-url": "https://api.githubcopilot.com",
      "x-lore-upstream-path": "/chat/completions",
    });
    expect(url).toBe("https://api.githubcopilot.com/chat/completions");
  });

  test("preserves a non-/v1 prefix verbatim (Google /v1beta/openai/...)", async () => {
    // Demonstrates verbatim's general value: the host-aware helper would
    // reconstruct `/v1/chat/completions` here, but the preserved path wins.
    harness = await createHarness({ fixtures: [] });
    const url = await captureUpstreamUrl(harness, {
      "x-lore-provider": "google",
      "x-lore-upstream-url": "https://generativelanguage.googleapis.com",
      "x-lore-upstream-path": "/v1beta/openai/chat/completions",
    });
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    );
  });
});
