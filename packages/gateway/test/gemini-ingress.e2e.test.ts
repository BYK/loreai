/**
 * End-to-end wiring guard for native Gemini support.
 *
 * Drives a real `POST /v1beta/models/{model}:generateContent` through the full
 * gateway pipeline (handleRequest → forwardToUpstream) and captures the exact
 * URL + body forwarded upstream, plus the client-facing response. Pins that:
 *   - the native Gemini ingress is routed as the `gemini` protocol (not hijacked
 *     to the OpenAI-compat layer by the `gemini-` model-prefix route);
 *   - the upstream URL is the native generativelanguage `:generateContent` path;
 *   - the upstream body is native Gemini (`contents`), and the client response
 *     is native Gemini (`candidates`).
 */
import { describe, test, expect, afterEach, vi } from "vitest";

vi.mock("../src/fetch", () => ({ upstreamFetch: vi.fn() }));

import { upstreamFetch } from "../src/fetch";
import type { Harness } from "./helpers/harness";
import { createHarness } from "./helpers/harness";

const mockFetch = vi.mocked(upstreamFetch);

function geminiUpstreamResponse(): Response {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: { role: "model", parts: [{ text: "ok" }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 1,
        candidatesTokenCount: 1,
        totalTokenCount: 2,
      },
      modelVersion: "gemini-2.5-pro",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function sendGemini(
  harness: Harness,
  path: string,
  extraHeaders: Record<string, string> = {},
): Promise<{
  upstreamUrl: string;
  upstreamBody: unknown;
  upstreamHeaders: Record<string, string> | undefined;
  clientJson: unknown;
}> {
  const { setUpstreamInterceptor } = await import("../src/pipeline");
  setUpstreamInterceptor(async (body, _model, _stream, makeReal) => {
    // capture the serialized upstream body via closure
    (sendGemini as unknown as { _body?: unknown })._body = body;
    return makeReal();
  });
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(geminiUpstreamResponse());

  const res = await fetch(`${harness.baseURL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": "test-key",
      "x-lore-project": "/tmp/gemini-e2e",
      ...extraHeaders,
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    }),
  });
  const clientJson = await res.json().catch(() => undefined);

  expect(mockFetch).toHaveBeenCalled();
  const call = mockFetch.mock.calls[0];
  return {
    upstreamUrl: String(call[0]),
    upstreamBody: (call[1] as { body?: unknown } | undefined)?.body,
    upstreamHeaders: (
      call[1] as { headers?: Record<string, string> } | undefined
    )?.headers,
    clientJson,
  };
}

describe("native Gemini ingress → generativelanguage upstream (full pipeline)", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.teardown();
    harness = undefined;
  });

  test("routes generateContent to the native Gemini upstream URL", async () => {
    harness = await createHarness({ fixtures: [] });
    const { upstreamUrl } = await sendGemini(
      harness,
      "/v1beta/models/gemini-2.5-pro:generateContent",
    );
    expect(upstreamUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
    );
    // NOT the OpenAI-compat path.
    expect(upstreamUrl).not.toContain("/openai/");
    expect(upstreamUrl).not.toContain("chat/completions");
  });

  test("forwards a native Gemini body and returns a native Gemini response", async () => {
    harness = await createHarness({ fixtures: [] });
    const { upstreamBody, clientJson } = await sendGemini(
      harness,
      "/v1beta/models/gemini-2.5-pro:generateContent",
    );
    // Upstream body is native Gemini (contents), not OpenAI messages.
    const ub = JSON.parse(String(upstreamBody)) as Record<string, unknown>;
    expect(ub.contents).toBeDefined();
    expect(ub.messages).toBeUndefined();
    // Client response is native Gemini (candidates).
    const cj = clientJson as Record<string, unknown>;
    expect(cj.candidates).toBeDefined();
    const candidates = cj.candidates as Array<Record<string, unknown>>;
    const content = candidates[0].content as Record<string, unknown>;
    expect(content.role).toBe("model");
  });

  test("stream verb routes to :streamGenerateContent", async () => {
    harness = await createHarness({ fixtures: [] });
    const { upstreamUrl } = await sendGemini(
      harness,
      "/v1beta/models/gemini-2.5-flash:streamGenerateContent",
    );
    expect(upstreamUrl).toContain(
      "/v1beta/models/gemini-2.5-flash:streamGenerateContent",
    );
  });

  test("version-prefix-agnostic: /v1/models/... (@ai-sdk/google shape) is matched", async () => {
    harness = await createHarness({ fixtures: [] });
    const { upstreamUrl } = await sendGemini(
      harness,
      "/v1/models/gemini-2.5-pro:generateContent",
    );
    // Full native path (not just the host — which the openai-compat URL shares).
    expect(upstreamUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
    );
  });

  test("?key= query auth is normalized to the x-goog-api-key upstream header", async () => {
    harness = await createHarness({ fixtures: [] });
    const { setUpstreamInterceptor } = await import("../src/pipeline");
    setUpstreamInterceptor(async (_b, _m, _s, makeReal) => makeReal());
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(geminiUpstreamResponse());

    // REST/google-generativeai style: key in the query, NO x-goog-api-key header.
    await fetch(
      `${harness.baseURL}/v1beta/models/gemini-2.5-pro:generateContent?key=qkey123`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-lore-project": "/tmp/gemini-e2e",
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
        }),
      },
    );

    expect(mockFetch).toHaveBeenCalled();
    const headers = (
      mockFetch.mock.calls[0][1] as
        | { headers?: Record<string, string> }
        | undefined
    )?.headers;
    expect(headers?.["x-goog-api-key"]).toBe("qkey123");
  });

  test("opencode/pi shape: X-Lore-Provider: google stays native gemini (not openai-compat)", async () => {
    // The @ai-sdk/google provider is tagged x-lore-provider: google by the
    // opencode/pi plugins. The google provider route is protocol "openai"
    // (compat layer) — but a native generateContent ingress must NOT be
    // downgraded to /v1beta/openai/chat/completions.
    harness = await createHarness({ fixtures: [] });
    const { upstreamUrl, upstreamBody } = await sendGemini(
      harness,
      "/v1/models/gemini-2.5-pro:generateContent",
      { "x-lore-provider": "google" },
    );
    expect(upstreamUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
    );
    expect(upstreamUrl).not.toContain("/openai/");
    const ub = JSON.parse(String(upstreamBody)) as Record<string, unknown>;
    expect(ub.contents).toBeDefined();
    expect(ub.messages).toBeUndefined();
  });
});
