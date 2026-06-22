/**
 * Tests for AWS Bedrock translation layer.
 *
 * Covers the bugs Seer found in PR #898:
 *  1. Accept header MUST be application/vnd.amazon.eventstream for streaming
 *     (NOT text/event-stream — Bedrock returns binary event-stream framing,
 *     decoded by @smithy/eventstream-codec in bedrock-stream.ts).
 *  2. Vertex AI route is intentionally absent from UPSTREAM_ROUTES because
 *     claude- collides with Anthropic — Vertex is reachable only via
 *     PROVIDER_ROUTES + X-Lore-Provider header.
 *  3. Bedrock model ID mapping, URL construction, and response parsing.
 */
import { describe, test, expect } from "vitest";
import {
  resolveBedrockModelID,
  bedrockInvokeUrl,
  bedrockInvokeNoStreamUrl,
  buildBedrockHeaders,
  buildBedrockRequestBody,
  parseBedrockResponseJSON,
  bedrockChunkToSSEEvents,
} from "../src/translate/bedrock";
import { resolveUpstreamRoute } from "../src/config";
import type { GatewayRequest } from "../src/translate/types";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<GatewayRequest> = {}): GatewayRequest {
  return {
    model: "claude-3-5-sonnet-20241022",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    system: "",
    stream: false,
    maxTokens: 1024,
    protocol: "anthropic",
    tools: [],
    rawHeaders: {},
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Model ID mapping
// ---------------------------------------------------------------------------

describe("resolveBedrockModelID", () => {
  test("maps known Anthropic Sonnet model to Bedrock ID", () => {
    expect(resolveBedrockModelID("claude-3-5-sonnet-20241022")).toBe(
      "anthropic.claude-3-5-sonnet-20241022-v2:0",
    );
  });

  test("maps -latest alias to pinned Bedrock ID", () => {
    expect(resolveBedrockModelID("claude-3-5-sonnet-latest")).toBe(
      "anthropic.claude-3-5-sonnet-20241022-v2:0",
    );
  });

  test("maps Claude 4 Sonnet", () => {
    expect(resolveBedrockModelID("claude-sonnet-4-20250514")).toBe(
      "anthropic.claude-sonnet-4-20250514-v1:0",
    );
  });

  test("maps Claude 4 Opus", () => {
    expect(resolveBedrockModelID("claude-opus-4-20250514")).toBe(
      "anthropic.claude-opus-4-20250514-v1:0",
    );
  });

  test("passes through already-formatted Bedrock IDs unchanged", () => {
    const bedrockId = "anthropic.claude-3-5-sonnet-20241022-v2:0";
    expect(resolveBedrockModelID(bedrockId)).toBe(bedrockId);
  });

  test("passes through unknown models unchanged (fail loud at Bedrock)", () => {
    expect(resolveBedrockModelID("claude-unknown-future-2099")).toBe(
      "claude-unknown-future-2099",
    );
  });
});

// ---------------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------------

describe("bedrockInvokeUrl (streaming)", () => {
  test("builds streaming URL with model in path (colon URL-encoded)", () => {
    const url = bedrockInvokeUrl(
      "us-east-1",
      "anthropic.claude-3-5-sonnet-20241022-v2:0",
    );
    expect(url).toBe(
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet-20241022-v2%3A0/invoke-with-response-stream",
    );
  });

  test("URL-encodes model ID with colon (RFC 3986)", () => {
    // Colons in model IDs MUST be encoded or the URL is invalid.
    // Bedrock accepts both encoded and decoded forms, but encodeURIComponent
    // is the canonical escaping for path segments.
    const url = bedrockInvokeUrl(
      "us-west-2",
      "anthropic.claude-3-5-sonnet-20241022-v2:0",
    );
    expect(url).toContain("%3A0");
    expect(decodeURIComponent(url)).toContain(":0");
  });

  test("uses different region than default", () => {
    const url = bedrockInvokeUrl(
      "eu-central-1",
      "anthropic.claude-3-haiku-20240307-v1:0",
    );
    expect(url).toContain("eu-central-1");
  });
});

describe("bedrockInvokeNoStreamUrl (non-streaming)", () => {
  test("builds non-streaming URL with model in path", () => {
    const url = bedrockInvokeNoStreamUrl(
      "us-east-1",
      "anthropic.claude-3-5-sonnet-20241022-v2:0",
    );
    expect(url).toBe(
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet-20241022-v2%3A0/invoke",
    );
  });

  test("non-streaming URL has different path than streaming", () => {
    const stream = bedrockInvokeUrl(
      "us-east-1",
      "anthropic.claude-3-5-sonnet-20241022-v2:0",
    );
    const nonStream = bedrockInvokeNoStreamUrl(
      "us-east-1",
      "anthropic.claude-3-5-sonnet-20241022-v2:0",
    );
    expect(stream).not.toBe(nonStream);
    expect(stream).toContain("invoke-with-response-stream");
    expect(nonStream).toMatch(/\/invoke$/);
  });
});

// ---------------------------------------------------------------------------
// Accept header (Seer finding #1 — CRITICAL)
// ---------------------------------------------------------------------------

describe("buildBedrockHeaders — Accept header", () => {
  test("streaming requests MUST use application/vnd.amazon.eventstream", () => {
    // Bedrock returns binary event-stream framing for streaming responses,
    // not SSE. The Accept header MUST match the response format or Bedrock
    // will reject the request. See bedrock-stream.ts for the decoder.
    const req = makeReq({ stream: true });
    const headers = buildBedrockHeaders(req);
    expect(headers.accept).toBe("application/vnd.amazon.eventstream");
  });

  test("non-streaming requests use application/json", () => {
    const req = makeReq({ stream: false });
    const headers = buildBedrockHeaders(req);
    expect(headers.accept).toBe("application/json");
  });

  test("content-type is always application/json", () => {
    const streaming = buildBedrockHeaders(makeReq({ stream: true }));
    const nonStreaming = buildBedrockHeaders(makeReq({ stream: false }));
    expect(streaming["content-type"]).toBe("application/json");
    expect(nonStreaming["content-type"]).toBe("application/json");
  });

  test("strips Anthropic-specific headers Bedrock doesn't understand", () => {
    const req = makeReq({
      rawHeaders: {
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-31",
        "x-anthropic-billing-header": "cch=12345",
        "user-agent": "claude-code/1.0",
      },
    });
    const headers = buildBedrockHeaders(req);
    expect(headers["anthropic-version"]).toBeUndefined();
    expect(headers["anthropic-beta"]).toBeUndefined();
    expect(headers["x-anthropic-billing-header"]).toBeUndefined();
    // user-agent should be forwarded
    expect(headers["user-agent"]).toBe("claude-code/1.0");
  });
});

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

describe("buildBedrockRequestBody", () => {
  test("sets anthropic_version to Bedrock-specific value", () => {
    const req = makeReq();
    const body = buildBedrockRequestBody(req) as Record<string, unknown>;
    expect(body.anthropic_version).toBe("bedrock-2023-05-31");
  });

  test("preserves messages, system, max_tokens", () => {
    const req = makeReq({
      system: "You are helpful",
      maxTokens: 2048,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    const body = buildBedrockRequestBody(req) as Record<string, unknown>;
    expect(body.system).toBe("You are helpful");
    expect(body.max_tokens).toBe(2048);
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
  });

  test("does NOT include stream field (controlled by endpoint, not body)", () => {
    // Bedrock determines streaming via the endpoint URL, not a body field.
    // Adding `stream: true|false` to the body causes Bedrock to reject the
    // request with a validation error. The URL builder selects the right
    // endpoint (InvokeModel vs InvokeModelWithResponseStream) based on req.stream.
    const streamingReq = makeReq({ stream: true });
    const streamingBody = buildBedrockRequestBody(streamingReq) as Record<
      string,
      unknown
    >;
    expect(streamingBody.stream).toBeUndefined();

    const nonStreamingReq = makeReq({ stream: false });
    const nonStreamingBody = buildBedrockRequestBody(nonStreamingReq) as Record<
      string,
      unknown
    >;
    expect(nonStreamingBody.stream).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Non-streaming response parsing
// ---------------------------------------------------------------------------

describe("parseBedrockResponseJSON", () => {
  test("parses Bedrock non-streaming JSON response", () => {
    const json = {
      id: "msg_01",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Hello back" }],
      model: "claude-3-5-sonnet-20241022",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const resp = parseBedrockResponseJSON(json);
    expect(resp.id).toBe("msg_01");
    expect(resp.model).toBe("claude-3-5-sonnet-20241022");
    expect(resp.stopReason).toBe("end_turn");
    expect(resp.content).toEqual([{ type: "text", text: "Hello back" }]);
  });

  test("extracts cache usage fields when present", () => {
    const json = {
      id: "msg_02",
      type: "message",
      role: "assistant",
      content: [],
      model: "claude-3-5-sonnet-20241022",
      stop_reason: "end_turn",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 20,
      },
    };
    const resp = parseBedrockResponseJSON(json);
    expect(resp.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 80,
      cacheCreationInputTokens: 20,
    });
  });
});

// ---------------------------------------------------------------------------
// Event-stream chunk → SSE event conversion
// ---------------------------------------------------------------------------

describe("bedrockChunkToSSEEvents", () => {
  // This function takes the DECODED Anthropic SSE event JSON (after base64
  // decoding the Bedrock `bytes` field). It wraps it as an SSE event pair.
  test("extracts event type from Anthropic SSE event JSON", () => {
    const anthropicEvent = {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hi" },
    };
    const events = bedrockChunkToSSEEvents(anthropicEvent);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("content_block_delta");
    expect(events[0].data).toBe(JSON.stringify(anthropicEvent));
  });

  test("handles message_start event", () => {
    const anthropicEvent = {
      type: "message_start",
      message: { id: "msg_01", role: "assistant" },
    };
    const events = bedrockChunkToSSEEvents(anthropicEvent);
    expect(events[0].event).toBe("message_start");
  });

  test("defaults to 'message' event when type is missing", () => {
    const events = bedrockChunkToSSEEvents({});
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("message");
  });
});

// ---------------------------------------------------------------------------
// UPSTREAM_ROUTES — Seer finding #2 (Vertex prefix collision)
// ---------------------------------------------------------------------------

describe("resolveUpstreamRoute — Vertex route is intentionally absent", () => {
  test("claude- prefix routes to Anthropic (not Vertex)", () => {
    const route = resolveUpstreamRoute("claude-3-5-sonnet-20241022");
    expect(route?.url).toBe("https://api.anthropic.com");
    expect(route?.protocol).toBe("anthropic");
  });

  test("claude-3-5-sonnet@20241022 (Vertex-style ID) also routes to Anthropic", () => {
    // Vertex uses the same claude- prefix as Anthropic, so prefix routing
    // CANNOT distinguish them. Vertex is reachable only via X-Lore-Provider.
    // This test documents the intentional design: prefix routing is for
    // bare agents (no X-Lore-Provider header), and those go to Anthropic.
    const route = resolveUpstreamRoute("claude-3-5-sonnet@20241022");
    expect(route?.protocol).toBe("anthropic");
  });

  test("anthropic.claude- prefix routes to Bedrock (more specific wins)", () => {
    const route = resolveUpstreamRoute(
      "anthropic.claude-3-5-sonnet-20241022-v2:0",
    );
    expect(route?.protocol).toBe("bedrock");
  });

  test("no Vertex route exists in UPSTREAM_ROUTES (collision with claude-)", () => {
    // Defensive: ensures the Seer fix (removing unreachable claude- vertex
    // route) is not accidentally re-introduced. If a Vertex prefix route is
    // re-added, it must be more specific than the Anthropic claude- route.
    const vertexRoute = resolveUpstreamRoute("claude-3-5-sonnet-vertex");
    expect(vertexRoute?.protocol).toBe("anthropic");
    expect(vertexRoute?.protocol).not.toBe("vertex");
  });
});
