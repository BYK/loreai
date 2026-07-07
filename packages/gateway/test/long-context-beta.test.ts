import { describe, test, expect } from "vitest";
import { requestEnablesLongContext } from "../src/compaction";
import type { GatewayRequest } from "../src/translate/types";

/**
 * `requestEnablesLongContext` gates the client-usage cap: only when the request
 * opts into the 1M window via the `context-1m` beta does the gateway report
 * usage against the model's real (1M) window instead of clamping to 200K. See
 * the #910 / MiniMax-M3 regression in compaction.test.ts.
 */
function makeRequest(rawHeaders: Record<string, string>): GatewayRequest {
  return {
    protocol: "anthropic",
    model: "MiniMax-M3",
    system: "",
    messages: [],
    tools: [],
    stream: true,
    maxTokens: 32_000,
    metadata: {},
    rawHeaders,
  };
}

describe("requestEnablesLongContext", () => {
  test("false when there is no anthropic-beta header (the MiniMax-M3 case)", () => {
    expect(requestEnablesLongContext(makeRequest({}))).toBe(false);
  });

  test("true when anthropic-beta carries a context-1m token", () => {
    expect(
      requestEnablesLongContext(
        makeRequest({ "anthropic-beta": "context-1m-2025-08-07" }),
      ),
    ).toBe(true);
  });

  test("true when context-1m sits alongside other betas", () => {
    expect(
      requestEnablesLongContext(
        makeRequest({
          "anthropic-beta":
            "oauth-2025-04-20,context-1m-2025-08-07,fine-grained-tool-streaming-2025-05-14",
        }),
      ),
    ).toBe(true);
  });

  test("header name match is case-insensitive", () => {
    expect(
      requestEnablesLongContext(
        makeRequest({ "Anthropic-Beta": "context-1m-2025-08-07" }),
      ),
    ).toBe(true);
  });

  test("false for an unrelated beta (must not over-enable the 1M window)", () => {
    expect(
      requestEnablesLongContext(
        makeRequest({ "anthropic-beta": "prompt-caching-2024-07-31" }),
      ),
    ).toBe(false);
  });
});
