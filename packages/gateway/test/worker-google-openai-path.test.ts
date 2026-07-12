/**
 * Issue #1070 — background worker requests routed to the `google` provider must
 * target Google's OpenAI-compatibility endpoint
 * `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`,
 * NOT the conventional `/v1/chat/completions` (which 404s). Workers build
 * prompts from scratch (no original request to forward verbatim), so the URL is
 * reconstructed host-aware by `buildOpenAIChatCompletionsUrl`.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { fetchArgUrl } from "./helpers/fetch-url";

vi.mock("../src/fetch", () => ({ upstreamFetch: vi.fn() }));

import { createGatewayLLMClient } from "../src/llm-adapter";
import { upstreamFetch } from "../src/fetch";
import { clearAllCosts } from "../src/cost-tracker";
import { resetBackgroundLimiter } from "../src/background-limiter";

const mockFetch = vi.mocked(upstreamFetch);

const UPSTREAMS = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
};

function okResponse() {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: "ok" } }],
      model: "m",
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("worker google URL (#1070)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(okResponse());
  });
  afterEach(() => {
    mockFetch.mockReset();
    clearAllCosts();
    resetBackgroundLimiter();
  });

  test("forwards to /v1beta/openai/chat/completions", async () => {
    const client = createGatewayLLMClient(
      UPSTREAMS,
      (_sid, providerID) =>
        providerID === "google"
          ? { scheme: "bearer", value: "g_worker" }
          : null,
      { providerID: "google", modelID: "gemini-2.5-flash" },
    );

    await client.prompt("system", "user", {
      sessionID: "sess-google",
      workerID: "lore-distill",
      model: { providerID: "google", modelID: "gemini-2.5-flash" },
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = fetchArgUrl(mockFetch.mock.calls[0][0]);
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    );
    expect(url).not.toContain("/v1/chat/completions");
  });

  test("accumulates a MULTI-CHUNK SSE reply (mislabeled application/json) into the full text", async () => {
    // An OpenAI-compat provider that streams even for a stream:false worker
    // request, WITHOUT a text/event-stream content-type. The worker must sniff
    // the body and merge every chunk — a last-data-line reader would return only
    // the finish chunk (empty delta) → silent-empty (the finding-#1 gap).
    // Blank-line-delimited SSE events (per the spec — parseSSEStream needs them).
    const multichunk = `${[
      'data: {"choices":[{"delta":{"role":"assistant"}}]}',
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
    ].join("\n\n")}\n\n`;
    mockFetch.mockResolvedValue(
      new Response(multichunk, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const client = createGatewayLLMClient(
      UPSTREAMS,
      (_sid, providerID) =>
        providerID === "google"
          ? { scheme: "bearer", value: "g_worker" }
          : null,
      { providerID: "google", modelID: "gemini-2.5-flash" },
    );

    const result = await client.prompt("system", "user", {
      sessionID: "sess-google-mc",
      workerID: "lore-distill",
      model: { providerID: "google", modelID: "gemini-2.5-flash" },
    });

    expect(result).toBe("Hello");
  });
});
