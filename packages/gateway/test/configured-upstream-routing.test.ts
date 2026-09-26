import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchArgUrl } from "./helpers/fetch-url";

vi.mock("../src/fetch", () => ({ upstreamFetch: vi.fn() }));

import { upstreamFetch } from "../src/fetch";
import type { Harness } from "./helpers/harness";
import { createHarness } from "./helpers/harness";

const mockFetch = vi.mocked(upstreamFetch);

function anthropicResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "msg-configured-upstream",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function openAIResponsesResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "resp-configured-upstream",
      object: "response",
      created_at: 1,
      status: "completed",
      model: "claude-opus-5-5",
      output: [
        {
          type: "message",
          id: "msg-configured-upstream",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "ok", annotations: [] }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("configured upstream routing", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    if (harness) await harness.teardown();
    harness = undefined;
  });

  test("uses the configured Anthropic upstream for claude models", async () => {
    harness = await createHarness({
      fixtures: [],
      configOverrides: {
        upstreamAnthropic: "http://127.0.0.1:3209",
      },
    });
    const { setUpstreamInterceptor } = await import("../src/pipeline");
    setUpstreamInterceptor(async (_body, _model, _stream, makeReal) =>
      makeReal(),
    );
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(anthropicResponse());

    const response = await harness.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": "test-key",
        "x-lore-project": "/tmp/configured-anthropic-upstream",
      },
      body: JSON.stringify({
        model: "claude-opus-5-5",
        max_tokens: 16,
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    await response.text();

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalled();
    expect(fetchArgUrl(mockFetch.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:3209/v1/messages",
    );
  });

  test("marks a configured Anthropic proxy as Anthropic for cache warming", async () => {
    const [
      { resolveProfile },
      { loadConfig },
      { resolveRequestUpstreamRouteForTest },
    ] = await Promise.all([
      import("../src/cache-warmer"),
      import("../src/config"),
      import("../src/pipeline"),
    ]);
    const proxy = "https://my-litellm-proxy.example.com";
    const route = resolveRequestUpstreamRouteForTest(
      { model: "claude-opus-5-5", protocol: "anthropic", rawHeaders: {} },
      { ...loadConfig(), upstreamAnthropic: proxy },
    );

    expect(route.providerID).toBe("anthropic");
    expect(
      resolveProfile(
        "claude-opus-5-5",
        route.effectiveProtocol,
        "5m",
        route.effectiveUpstreamBase,
        route.providerID,
      )?.upstreamUrl,
    ).toBe(`${proxy}/v1/messages`);
  });

  test("does not apply the Anthropic destination to Responses ingress", async () => {
    harness = await createHarness({
      fixtures: [],
      configOverrides: {
        upstreamAnthropic: "http://127.0.0.1:3209",
      },
    });
    const { setUpstreamInterceptor } = await import("../src/pipeline");
    setUpstreamInterceptor(async (_body, _model, _stream, makeReal) =>
      makeReal(),
    );
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(openAIResponsesResponse());

    const response = await harness.request("/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "x-lore-project": "/tmp/configured-anthropic-upstream",
      },
      body: JSON.stringify({
        model: "claude-opus-5-5",
        input: "hi",
        stream: false,
      }),
    });
    await response.text();

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalled();
    expect(fetchArgUrl(mockFetch.mock.calls[0]?.[0])).toBe(
      "https://api.anthropic.com/v1/responses",
    );
  });
});
