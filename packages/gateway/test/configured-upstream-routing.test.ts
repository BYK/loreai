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

function openAIResponsesClientRecallStreamResponse(): Response {
  const event = (type: string, payload: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
  const args = JSON.stringify({ query: "client-owned" });
  return new Response(
    event("response.created", {
      response: { id: "resp-client-recall", model: "gpt-5.6-codex" },
    }) +
      event("response.output_item.added", {
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc-client-recall",
          call_id: "call-client-recall",
          name: "recall",
          arguments: "",
        },
      }) +
      event("response.function_call_arguments.done", {
        output_index: 0,
        item_id: "fc-client-recall",
        arguments: args,
      }) +
      event("response.output_item.done", {
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc-client-recall",
          call_id: "call-client-recall",
          name: "recall",
          arguments: args,
          status: "completed",
        },
      }) +
      event("response.completed", {
        response: {
          id: "resp-client-recall",
          model: "gpt-5.6-codex",
          status: "completed",
          output: [
            {
              type: "function_call",
              id: "fc-client-recall",
              call_id: "call-client-recall",
              name: "recall",
              arguments: args,
              status: "completed",
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      }) +
      "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } },
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

  test("preserves root tool combinators for compatible Anthropic providers", async () => {
    harness = await createHarness({ fixtures: [] });
    const { setUpstreamInterceptor } = await import("../src/pipeline");
    let capturedBody: Record<string, unknown> | undefined;
    setUpstreamInterceptor(async (body, _model, _stream, makeReal) => {
      capturedBody = body as Record<string, unknown>;
      return makeReal();
    });
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(anthropicResponse());

    const schema = {
      type: "object",
      properties: { value: { type: "string" } },
      oneOf: [{ required: ["value"] }, { additionalProperties: false }],
      not: { type: "null" },
    };
    const response = await harness.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": "test-key",
        "x-lore-provider": "minimax",
        "x-lore-upstream-url": "https://api.minimax.io/anthropic",
        "x-lore-upstream-path": "/anthropic/v1/messages",
        "x-lore-project": "/tmp/compatible-anthropic-provider",
      },
      body: JSON.stringify({
        model: "MiniMax-M2.7",
        max_tokens: 16,
        stream: false,
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "union", description: "union", input_schema: schema }],
      }),
    });
    await response.text();

    expect(response.status).toBe(200);
    if (!capturedBody || !Array.isArray(capturedBody.tools)) {
      throw new Error("upstream request did not contain tools");
    }
    const firstTool = capturedBody.tools[0] as
      | Record<string, unknown>
      | undefined;
    expect(firstTool?.input_schema).toEqual(schema);
  });

  test("does not weaken a client-owned recall tool", async () => {
    harness = await createHarness({ fixtures: [] });
    const { setUpstreamInterceptor } = await import("../src/pipeline");
    setUpstreamInterceptor(async (body, _model, _stream, makeReal) => {
      return makeReal();
    });
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(anthropicResponse());
    const schema = {
      type: "object",
      properties: { value: { type: "string" } },
      oneOf: [{ required: ["value"] }],
    };

    const response = await harness.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": "test-key",
        "x-lore-provider": "minimax",
        "x-lore-upstream-url": "https://api.anthropic.com",
        "x-lore-project": "/tmp/client-owned-recall",
      },
      body: JSON.stringify({
        model: "MiniMax-M2.7",
        max_tokens: 16,
        stream: false,
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            name: "recall",
            description: "client tool",
            input_schema: schema,
          },
        ],
      }),
    });
    const responseText = await response.text();

    expect(response.status, responseText).toBe(502);
  });

  test("trusts capability only for the final canonical endpoint", async () => {
    const [
      { loadConfig },
      {
        resolveRequestUpstreamRouteForTest,
        supportsEffectiveRootToolSchemaCombinatorsForTest,
      },
    ] = await Promise.all([import("../src/config"), import("../src/pipeline")]);
    const baseHeaders = {
      "x-api-key": "test-key",
      "x-lore-provider": "minimax",
      "x-lore-upstream-url": "https://api.minimax.io/anthropic",
    };
    const config = { ...loadConfig(), remoteGateway: false };
    const canonicalRoute = resolveRequestUpstreamRouteForTest(
      {
        model: "MiniMax-M2.7",
        protocol: "anthropic",
        rawHeaders: {
          ...baseHeaders,
          "x-lore-upstream-path": "/anthropic/v1/messages",
        },
      },
      config,
    );
    const noncanonicalRoute = resolveRequestUpstreamRouteForTest(
      {
        model: "MiniMax-M2.7",
        protocol: "anthropic",
        rawHeaders: {
          ...baseHeaders,
          "x-lore-upstream-path": "/anthropic/custom/messages",
        },
      },
      config,
    );
    const canonicalQueryRoute = resolveRequestUpstreamRouteForTest(
      {
        model: "MiniMax-M2.7",
        protocol: "anthropic",
        rawHeaders: {
          ...baseHeaders,
          "x-lore-upstream-path": "/anthropic/v1/messages?trace=1",
        },
      },
      config,
    );

    expect(
      supportsEffectiveRootToolSchemaCombinatorsForTest(canonicalRoute),
    ).toBe(true);
    expect(
      supportsEffectiveRootToolSchemaCombinatorsForTest(noncanonicalRoute),
    ).toBe(false);
    expect(
      supportsEffectiveRootToolSchemaCombinatorsForTest(canonicalQueryRoute),
    ).toBe(true);
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

  test("forwards a client-owned recall tool on Responses streaming ingress", async () => {
    harness = await createHarness({ fixtures: [] });
    const { setUpstreamInterceptor } = await import("../src/pipeline");
    setUpstreamInterceptor(async (_body, _model, _stream, makeReal) =>
      makeReal(),
    );
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(openAIResponsesClientRecallStreamResponse());

    const response = await harness.request("/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "x-lore-project": "/tmp/client-owned-responses-recall",
      },
      body: JSON.stringify({
        model: "gpt-5.6-codex",
        input: "hi",
        stream: true,
        tools: [
          {
            type: "function",
            name: "recall",
            description: "client tool",
            parameters: { type: "object", properties: {} },
          },
        ],
      }),
    });
    const responseText = await response.text();

    expect(response.status, responseText).toBe(200);
    expect(responseText).toContain('"name":"recall"');
    expect(responseText).toContain("client-owned");
  });
});
