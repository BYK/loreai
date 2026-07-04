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

vi.mock("../src/fetch", () => ({ upstreamFetch: vi.fn() }));

import { createGatewayLLMClient } from "../src/llm-adapter";
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
    url: String(call?.[0]),
    headers: (call?.[1] as { headers?: Record<string, string> } | undefined)
      ?.headers,
    body: JSON.parse(
      String((call?.[1] as { body?: unknown } | undefined)?.body ?? "{}"),
    ) as Record<string, unknown>,
  };
}

describe("worker gemini native path", () => {
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
});
