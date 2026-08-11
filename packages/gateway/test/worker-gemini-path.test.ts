/**
 * Background worker requests for a native Gemini session must target Google's
 * native generateContent endpoint
 * `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`,
 * authenticate with `x-goog-api-key` (API key) or `Authorization: Bearer`
 * (OAuth), and send a native Gemini body (`systemInstruction` + `contents`) —
 * NOT the OpenAI-compat chat/completions shape.
 *
 * Guards the worker builder/parser (llm-adapter buildGeminiWorkerRequest /
 * parseGeminiWorkerResponse), which were previously untested: a broken auth
 * header, URL, or body shape would have silently disabled all distillation /
 * curation for gemini sessions with zero test failure.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { fetchArgUrl } from "./helpers/fetch-url";

vi.mock("../src/fetch", () => ({ upstreamFetch: vi.fn() }));

import {
  createGatewayLLMClient,
  parseGeminiWorkerResponse,
} from "../src/llm-adapter";
import { upstreamFetch } from "../src/fetch";
import { clearAllCosts } from "../src/cost-tracker";
import { resetBackgroundLimiter } from "../src/background-limiter";
import type { AuthCredential } from "../src/auth";

const mockFetch = vi.mocked(upstreamFetch);

const UPSTREAMS = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
};

function geminiOkResponse() {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: { role: "model", parts: [{ text: "worker ok" }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      modelVersion: "gemini-2.5-flash",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function runWorker(cred: AuthCredential | null) {
  const client = createGatewayLLMClient(
    UPSTREAMS,
    (_sid, providerID) => (providerID === "google" ? cred : null),
    { providerID: "google", modelID: "gemini-2.5-flash" },
  );
  const result = await client.prompt("system-prompt", "user-prompt", {
    sessionID: "sess-gemini",
    workerID: "lore-distill",
    model: { providerID: "google", modelID: "gemini-2.5-flash" },
    // Explicit protocol hint from the session snapshot (native gemini ingress).
    protocol: "gemini",
    upstreamProviderID: "google",
  });
  const call = mockFetch.mock.calls[0];
  return {
    result,
    url: fetchArgUrl(call?.[0]),
    headers: (call?.[1] as { headers?: Record<string, string> } | undefined)
      ?.headers,
    body: JSON.parse(
      String((call?.[1] as { body?: string } | undefined)?.body ?? "{}"),
    ) as Record<string, unknown>,
  };
}

describe("worker gemini native path", () => {
  test("uses disjoint cached/tool/thought accounting in worker JSON", () => {
    const parsed = parseGeminiWorkerResponse({
      candidates: [{ content: { parts: [{ text: "ok" }] } }],
      usageMetadata: {
        promptTokenCount: 100,
        cachedContentTokenCount: 80,
        candidatesTokenCount: 20,
        thoughtsTokenCount: 10,
        toolUsePromptTokenCount: 5,
        totalTokenCount: 135,
      },
    });
    expect(parsed.usage).toMatchObject({
      input_tokens: 25,
      cache_read_input_tokens: 80,
      output_tokens: 30,
    });
  });

  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(geminiOkResponse());
  });
  afterEach(() => {
    mockFetch.mockReset();
    clearAllCosts();
    resetBackgroundLimiter();
  });

  test("API-key cred → native :generateContent URL + x-goog-api-key + native body", async () => {
    const { result, url, headers, body } = await runWorker({
      scheme: "api-key",
      value: "g_key",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );
    expect(url).not.toContain("/openai/");
    expect(url).not.toContain("chat/completions");
    // API-key auth via x-goog-api-key (not Authorization).
    expect(headers?.["x-goog-api-key"]).toBe("g_key");
    expect(headers?.Authorization).toBeUndefined();
    // Native Gemini body shape.
    expect(body.contents).toBeDefined();
    expect(body.messages).toBeUndefined();
    expect(body.systemInstruction).toEqual({
      parts: [{ text: "system-prompt" }],
    });
    // Response parsed back from native gemini candidates.
    expect(result).toContain("worker ok");
  });

  test("bearer (OAuth) cred → Authorization: Bearer, NOT x-goog-api-key", async () => {
    const { headers } = await runWorker({
      scheme: "bearer",
      value: "oauth_tok",
    });
    expect(headers?.Authorization).toBe("Bearer oauth_tok");
    expect(headers?.["x-goog-api-key"]).toBeUndefined();
  });

  test("non-stream worker validates later candidates and permits same-name calls with distinct IDs", async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: "worker ok" }] },
              finishReason: "STOP",
            },
            {
              content: {
                parts: [
                  { functionCall: { id: "one", name: "lookup", args: {} } },
                  { functionCall: { id: "two", name: "lookup", args: {} } },
                ],
              },
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    const { result } = await runWorker({ scheme: "api-key", value: "g_key" });
    expect(result).toContain("worker ok");
  });

  test("non-stream worker permits the same tool identity in independent candidates", async () => {
    expect(
      parseGeminiWorkerResponse({
        candidates: [
          {
            content: {
              parts: [
                { text: "worker ok" },
                { functionCall: { id: "shared", name: "lookup", args: {} } },
              ],
            },
          },
          {
            content: {
              parts: [
                { functionCall: { id: "shared", name: "lookup", args: {} } },
              ],
            },
          },
        ],
      }).text,
    ).toBe("worker ok");
  });

  test("non-stream worker rejects duplicate effective IDs in a later candidate", async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: "must not escape" }] } },
            {
              content: {
                parts: [
                  { functionCall: { id: "duplicate", name: "one" } },
                  { functionCall: { id: "duplicate", name: "two" } },
                ],
              },
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    const { result } = await runWorker({ scheme: "api-key", value: "g_key" });
    expect(result).toBeNull();
  });

  test("SSE worker preserves valid provider IDs and rejects ambiguous legacy calls", async () => {
    const frame = (parts: unknown[]) =>
      `data: ${JSON.stringify({ candidates: [{ content: { parts }, finishReason: "STOP" }] })}\n\n`;
    mockFetch.mockResolvedValueOnce(
      new Response(
        frame([
          { text: "worker ok" },
          { functionCall: { id: "one", name: "lookup", args: {} } },
          { functionCall: { id: "two", name: "lookup", args: {} } },
        ]),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
    const valid = await runWorker({ scheme: "api-key", value: "g_key" });
    expect(valid.result).not.toBeNull();

    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(
      new Response(
        frame([
          { functionCall: { name: "lookup", args: {} } },
          { functionCall: { name: "lookup", args: {} } },
        ]),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
    const invalid = await runWorker({ scheme: "api-key", value: "g_key" });
    expect(invalid.result).toBeNull();
  });

  test("worker success-body inspection rejects invalid and split-invalid JSON UTF-8", async () => {
    for (const chunks of [
      [new Uint8Array([0xff])],
      [new Uint8Array([0xe2]), new Uint8Array([0x28, 0xa1])],
    ]) {
      mockFetch.mockReset();
      mockFetch.mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(chunk);
              controller.close();
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
      const { result } = await runWorker({ scheme: "api-key", value: "g_key" });
      expect(result).toBeNull();
      // Partial malformed bodies are authoritative upstream responses, not
      // zero-byte transport failures eligible for an automatic retry.
      expect(mockFetch).toHaveBeenCalledTimes(1);
    }
  });
});
