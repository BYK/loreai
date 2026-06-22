/**
 * Integration test: executeWarmup for a Bedrock session SigV4-signs a
 * non-streaming InvokeModel warmup and never sends the client credential.
 *
 * Isolated from cache-warmer.test.ts because it mocks `upstreamFetch` (that
 * file drives real unit logic and must not mock the fetch wrapper).
 */
import { describe, test, expect, afterEach, vi } from "vitest";

vi.mock("../src/fetch", () => ({ upstreamFetch: vi.fn() }));

import { buildBedrockProfile, executeWarmup } from "../src/cache-warmer";
import { upstreamFetch } from "../src/fetch";
import { compressBody } from "../src/cache-analytics";
import { _setTestCredentialProviders } from "../src/bedrock-auth";
import type { SessionState } from "../src/translate/types";

const mockFetch = vi.mocked(upstreamFetch);

function bedrockWarmupResponse(): Response {
  return new Response(
    JSON.stringify({
      usage: {
        input_tokens: 2,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 0,
      },
      stop_reason: "end_turn",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function bedrockSession(): SessionState {
  const storedBody = JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 4096,
    system: "SYS",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "hello", cache_control: { type: "ephemeral" } },
        ],
      },
    ],
  });
  return {
    sessionID: "sess-bedrock-warm",
    projectPath: "/tmp/p",
    fingerprint: "fp",
    lastRequestTime: Date.now(),
    lastUserTurnTime: Date.now(),
    messageCount: 4,
    turnsSinceCuration: 0,
    consecutiveTextOnlyTurns: 0,
    recallStore: new Map(),
    upstreamByProvider: new Map(),
    cacheAnalytics: {
      lastRequestBody: compressBody(storedBody),
      lastRequestBodyLength: storedBody.length,
      lastCacheRead: 0,
      lastCacheCreation: 0,
      turnCount: 1,
      bustCount: 0,
    },
    lastUpstream: {
      url: "https://bedrock-runtime.us-east-1.amazonaws.com",
      protocol: "bedrock",
      providerID: "bedrock",
      model: "claude-3-5-sonnet-20241022",
      headers: {},
    },
  } as SessionState;
}

afterEach(() => {
  mockFetch.mockReset();
  _setTestCredentialProviders(null);
});

describe("executeWarmup — Bedrock SigV4", () => {
  test("signs the InvokeModel warmup; no client credential sent", async () => {
    mockFetch.mockResolvedValue(bedrockWarmupResponse());
    _setTestCredentialProviders([
      async () => ({ accessKeyId: "AKIATEST", secretAccessKey: "secret" }),
    ]);

    const profile = buildBedrockProfile(
      "claude-3-5-sonnet-20241022",
      "5m",
      "us-east-1",
      undefined,
      "https://bedrock-runtime.us-east-1.amazonaws.com",
    );

    const result = await executeWarmup(bedrockSession(), profile);

    expect(result.ok).toBe(true);
    expect(result.cacheReadTokens).toBe(1000);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, init] = mockFetch.mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe(
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet-20241022-v2%3A0/invoke",
    );
    const auth = init.headers.authorization ?? init.headers.Authorization ?? "";
    expect(auth).toContain("AWS4-HMAC-SHA256");
    expect(auth).toContain("bedrock-runtime");
    // No cch / x-api-key / anthropic-version on the Bedrock warmup.
    expect(init.headers["x-api-key"]).toBeUndefined();
    expect(init.headers["anthropic-version"]).toBeUndefined();
    // Warmup body: max_tokens forced to 1, no stream field, sentinel intact.
    const body = JSON.parse(init.body);
    expect(body.max_tokens).toBe(1);
    expect("stream" in body).toBe(false);
    expect(body.anthropic_version).toBe("bedrock-2023-05-31");
  });
});
