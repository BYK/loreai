/**
 * End-to-end routing guard for GitHub Copilot CLI interception.
 *
 * The Copilot CLI's default (GitHub-hosted) mode is redirected at lore via the
 * `COPILOT_API_URL` env var. Copilot then sends OpenAI-format requests carrying
 * its own exchanged Copilot bearer token and a `Copilot-Integration-Id` header,
 * but it has NO way to set `X-Lore-Provider`. Its model ids (`gpt-5.4`,
 * `claude-sonnet-4.6`, …) would otherwise route via model-prefix to the WRONG
 * upstream (api.openai.com / api.anthropic.com). This test pins the behavior:
 * when a `Copilot-Integration-Id` header is present and there is no explicit
 * provider / upstream override, the gateway forwards to the `github-copilot`
 * upstream (api.githubcopilot.com). Explicit `X-Lore-Provider` /
 * `X-Lore-Upstream-URL` (BYOK) still win.
 *
 * Mechanism mirrors github-copilot-url.e2e.test.ts: `upstreamFetch` is mocked to
 * capture the resolved upstream URL, and the pipeline's upstream interceptor is
 * overridden to invoke the real (mocked) request so the URL flows into the mock.
 */
import { describe, test, expect, afterEach, vi } from "vitest";
import { fetchArgUrl } from "./helpers/fetch-url";

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
      model: "gpt-5.4",
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

function copilotResponsesStream(contentType = "text/event-stream"): Response {
  const event = (type: string, data: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  return new Response(
    event("response.created", {
      response: {
        id: "resp_copilot_created",
        model: "gpt-6-sol",
        status: "in_progress",
        output: [],
      },
    }) +
      event("response.in_progress", {
        response: {
          id: "resp_copilot_in_progress",
          model: "gpt-6-sol",
          status: "in_progress",
          output: [],
        },
      }) +
      event("response.output_item.added", {
        output_index: 0,
        item: {
          type: "message",
          id: "msg_copilot",
          role: "assistant",
        },
      }) +
      event("response.output_text.delta", {
        output_index: 0,
        item_id: "msg_copilot",
        content_index: 0,
        delta: "copilot reply",
      }) +
      event("response.output_text.done", {
        output_index: 0,
        item_id: "msg_copilot",
        content_index: 0,
        text: "copilot reply",
      }) +
      event("response.output_item.done", {
        output_index: 0,
        item: {
          type: "message",
          id: "msg_copilot",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "copilot reply" }],
        },
      }) +
      event("response.completed", {
        response: {
          id: "resp_copilot_completed",
          model: "gpt-6-sol",
          status: "completed",
          output: [
            {
              type: "message",
              id: "msg_copilot",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "copilot reply" }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      }),
    { status: 200, headers: { "content-type": contentType } },
  );
}

/**
 * Send an OpenAI chat-completions request with the given model + headers and
 * return the captured upstream URL the gateway forwarded to.
 */
async function captureUpstreamUrl(
  harness: Harness,
  model: string,
  headers: Record<string, string>,
  ingressPath = "/v1/chat/completions",
): Promise<string> {
  const { setUpstreamInterceptor } = await import("../src/pipeline");
  setUpstreamInterceptor(async (_body, _model, _stream, makeReal) =>
    makeReal(),
  );
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(openAIResponse());

  const res = await harness.request(ingressPath, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer tid=copilot-token",
      "x-lore-project": "/tmp/copilot-routing-e2e",
      ...headers,
    },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  await res.text().catch(() => undefined);

  expect(mockFetch).toHaveBeenCalled();
  return fetchArgUrl(mockFetch.mock.calls[0][0]);
}

describe("Copilot-Integration-Id → github-copilot upstream routing", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    if (harness) await harness.teardown();
    harness = undefined;
  });

  test("routes a gpt- model to api.githubcopilot.com (not api.openai.com)", async () => {
    harness = await createHarness({ fixtures: [] });
    const url = await captureUpstreamUrl(harness, "gpt-5.4", {
      "copilot-integration-id": "copilot-cli",
    });
    expect(url).toContain("api.githubcopilot.com");
    expect(url).not.toContain("api.openai.com");
  });

  test("routes a claude- model to api.githubcopilot.com (beats model-prefix anthropic route)", async () => {
    harness = await createHarness({ fixtures: [] });
    const url = await captureUpstreamUrl(harness, "claude-sonnet-4.6", {
      "copilot-integration-id": "copilot-cli",
    });
    expect(url).toContain("api.githubcopilot.com");
    expect(url).not.toContain("api.anthropic.com");
  });

  test("explicit X-Lore-Provider wins over the integration-id signal (BYOK/other)", async () => {
    harness = await createHarness({ fixtures: [] });
    const url = await captureUpstreamUrl(harness, "gpt-5.4", {
      "copilot-integration-id": "copilot-cli",
      "x-lore-provider": "openai",
    });
    // Explicit provider override must not be hijacked to github-copilot.
    expect(url).not.toContain("api.githubcopilot.com");
  });

  test("explicit X-Lore-Upstream-URL (BYOK) wins over the integration-id signal", async () => {
    harness = await createHarness({ fixtures: [] });
    const url = await captureUpstreamUrl(harness, "gpt-5.4", {
      "copilot-integration-id": "copilot-cli",
      "x-lore-upstream-url": "https://api.openai.com",
    });
    expect(url).not.toContain("api.githubcopilot.com");
    expect(url).toContain("api.openai.com");
  });

  test("keeps an explicit custom provider at the Copilot endpoint and rejects rotating IDs", async () => {
    harness = await createHarness({ fixtures: [] });
    const { setUpstreamInterceptor, resolveRequestUpstreamRouteForTest } =
      await import("../src/pipeline");
    const { loadConfig } = await import("../src/config");
    const headers = {
      "copilot-integration-id": "copilot-cli",
      "x-lore-provider": "custom-provider",
      "x-lore-upstream-url": "https://api.githubcopilot.com",
      "x-lore-upstream-path": "/responses?opaque=true",
    };
    const route = resolveRequestUpstreamRouteForTest(
      {
        protocol: "openai-responses",
        model: "gpt-6-sol",
        rawHeaders: {
          ...headers,
          authorization: "Bearer tid=copilot-token",
        },
      },
      { ...loadConfig(), remoteGateway: false, hostedMode: false },
    );
    expect(route.providerID).toBe("custom-provider");
    setUpstreamInterceptor(async (_body, _model, _stream, makeReal) =>
      makeReal(),
    );
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(copilotResponsesStream());
    const response = await harness.request("/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer tid=copilot-token",
        "x-lore-project": "/tmp/copilot-custom-provider-e2e",
        ...headers,
      },
      body: JSON.stringify({ model: "gpt-6-sol", stream: true, input: "hi" }),
    });
    const body = await response.text();
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(fetchArgUrl(mockFetch.mock.calls[0][0])).toBe(
      "https://api.githubcopilot.com/responses?opaque=true",
    );
    expect(body).toContain("event: response.failed");
    expect(body).not.toContain("copilot reply");
  });

  test("without the integration-id header, model-prefix routing is unchanged", async () => {
    harness = await createHarness({ fixtures: [] });
    const url = await captureUpstreamUrl(harness, "gpt-5.4", {});
    expect(url).toContain("api.openai.com");
    expect(url).not.toContain("api.githubcopilot.com");
  });

  test("pins intercepted Copilot Responses lifecycle IDs without an explicit provider", async () => {
    harness = await createHarness({ fixtures: [] });
    const { setUpstreamInterceptor } = await import("../src/pipeline");
    setUpstreamInterceptor(async (_body, _model, _stream, makeReal) =>
      makeReal(),
    );
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(copilotResponsesStream());

    const response = await harness.request("/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer tid=copilot-token",
        "copilot-integration-id": "copilot-cli",
        "x-lore-project": "/tmp/copilot-responses-e2e",
        "x-lore-upstream-url": "https://api.githubcopilot.com",
        "x-lore-upstream-path": "/responses?opaque=true",
      },
      body: JSON.stringify({
        model: "gpt-6-sol",
        stream: true,
        input: "hi",
      }),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(fetchArgUrl(mockFetch.mock.calls[0][0])).toBe(
      "https://api.githubcopilot.com/responses?opaque=true",
    );
    expect(body).toContain("copilot reply");
    expect(body).not.toContain("response.failed");
    expect(body).toContain('"id":"resp_copilot_created"');
    expect(body).not.toContain("resp_copilot_in_progress");
    expect(body).not.toContain("resp_copilot_completed");
  });

  test("dispatches a direct Copilot Responses request to the canonical endpoint", async () => {
    harness = await createHarness({ fixtures: [] });
    const { setUpstreamInterceptor } = await import("../src/pipeline");
    setUpstreamInterceptor(async (_body, _model, _stream, makeReal) =>
      makeReal(),
    );
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(copilotResponsesStream());

    const response = await harness.request("/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer tid=copilot-token",
        "copilot-integration-id": "copilot-cli",
        "x-lore-project": "/tmp/copilot-responses-direct-e2e",
      },
      body: JSON.stringify({
        model: "gpt-6-sol",
        stream: true,
        input: "hi",
      }),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(fetchArgUrl(mockFetch.mock.calls[0][0])).toBe(
      "https://api.githubcopilot.com/responses",
    );
    expect(body).toContain("copilot reply");
    expect(body).not.toContain("response.failed");
  });

  test("keeps rotating Copilot IDs strict on the Codex endpoint", async () => {
    harness = await createHarness({ fixtures: [] });
    const { setUpstreamInterceptor } = await import("../src/pipeline");
    setUpstreamInterceptor(async (_body, _model, _stream, makeReal) =>
      makeReal(),
    );
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(copilotResponsesStream());

    const response = await harness.request("/v1/codex/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer tid=copilot-token",
        "copilot-integration-id": "copilot-cli",
        "x-lore-agent": "title",
        "x-lore-project": "/tmp/copilot-codex-strict-e2e",
      },
      body: JSON.stringify({ model: "gpt-6-sol", stream: true, input: "hi" }),
    });
    const body = await response.text();

    expect(fetchArgUrl(mockFetch.mock.calls[0][0])).toBe(
      "https://api.githubcopilot.com/codex/responses",
    );
    expect(body).toContain("response.failed");
    expect(body).not.toContain("copilot reply");
  });

  test("pins Codex ingress when the final endpoint is verbatim /responses", async () => {
    harness = await createHarness({ fixtures: [] });
    const { setUpstreamInterceptor } = await import("../src/pipeline");
    setUpstreamInterceptor(async (_body, _model, _stream, makeReal) =>
      makeReal(),
    );
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(copilotResponsesStream());

    const response = await harness.request("/v1/codex/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer tid=copilot-token",
        "copilot-integration-id": "copilot-cli",
        "x-lore-agent": "title",
        "x-lore-project": "/tmp/copilot-codex-verbatim-e2e",
        "x-lore-upstream-url": "https://api.githubcopilot.com",
        "x-lore-upstream-path": "/responses?opaque=true",
      },
      body: JSON.stringify({ model: "gpt-6-sol", stream: true, input: "hi" }),
    });
    const body = await response.text();

    expect(fetchArgUrl(mockFetch.mock.calls[0][0])).toBe(
      "https://api.githubcopilot.com/responses?opaque=true",
    );
    expect(body).toContain("copilot reply");
    expect(body).not.toContain("response.failed");
  });

  test.each(["text/event-stream", "application/json"])(
    "accumulates rotating Copilot SSE for a non-stream passthrough labeled %s",
    async (contentType) => {
      harness = await createHarness({ fixtures: [] });
      const { setUpstreamInterceptor } = await import("../src/pipeline");
      setUpstreamInterceptor(async (_body, _model, _stream, makeReal) =>
        makeReal(),
      );
      mockFetch.mockReset();
      mockFetch.mockResolvedValue(copilotResponsesStream(contentType));

      const response = await harness.request("/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer tid=copilot-token",
          "copilot-integration-id": "copilot-cli",
          "x-lore-agent": "title",
          "x-lore-project": "/tmp/copilot-responses-meta-e2e",
        },
        body: JSON.stringify({
          model: "gpt-6-sol",
          stream: false,
          input: "write a title",
          max_output_tokens: 100,
        }),
      });
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      expect(fetchArgUrl(mockFetch.mock.calls[0][0])).toBe(
        "https://api.githubcopilot.com/responses",
      );
      expect(body).toContain("copilot reply");
      expect(body).toContain("resp_copilot_created");
      expect(body).not.toContain("resp_copilot_in_progress");
      expect(body).not.toContain("resp_copilot_completed");
    },
  );

  test("preserves genuine non-stream Responses JSON bytes", async () => {
    harness = await createHarness({ fixtures: [] });
    const { setUpstreamInterceptor } = await import("../src/pipeline");
    setUpstreamInterceptor(async (_body, _model, _stream, makeReal) =>
      makeReal(),
    );
    const rawBody = JSON.stringify({
      id: "resp_exact_json",
      object: "response",
      created_at: 1,
      model: "gpt-6-sol",
      status: "completed",
      output: [],
      usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
    });
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(
      new Response(rawBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await harness.request("/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer tid=copilot-token",
        "copilot-integration-id": "copilot-cli",
        "x-lore-agent": "title",
        "x-lore-project": "/tmp/copilot-responses-json-e2e",
      },
      body: JSON.stringify({
        model: "gpt-6-sol",
        stream: false,
        input: "write a title",
        max_output_tokens: 100,
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(rawBody);
  });
});

describe("Copilot bare (no /v1) ingress paths", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    if (harness) await harness.teardown();
    harness = undefined;
  });

  test("POST /chat/completions (no /v1) is accepted and routed", async () => {
    // Copilot CLI redirected via COPILOT_API_URL hits the origin's bare
    // /chat/completions (no /v1 segment). It must reach the OpenAI handler and,
    // with the integration-id header, forward to github-copilot.
    harness = await createHarness({ fixtures: [] });
    const url = await captureUpstreamUrl(
      harness,
      "gpt-5.4",
      { "copilot-integration-id": "copilot-cli" },
      "/chat/completions",
    );
    expect(url).toContain("api.githubcopilot.com");
  });
});
