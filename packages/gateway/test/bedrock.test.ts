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

  // Pin EVERY known mapping (table-driven). Without this, a mutant that blanks
  // any single map value (e.g. → "") survives — a wrong Bedrock model ID would
  // route to a non-existent model and fail every request for that alias.
  test.each([
    ["claude-3-5-sonnet-20241022", "anthropic.claude-3-5-sonnet-20241022-v2:0"],
    ["claude-3-5-sonnet-latest", "anthropic.claude-3-5-sonnet-20241022-v2:0"],
    ["claude-3-5-haiku-20241022", "anthropic.claude-3-5-haiku-20241022-v1:0"],
    ["claude-3-5-haiku-latest", "anthropic.claude-3-5-haiku-20241022-v1:0"],
    ["claude-3-opus-20240229", "anthropic.claude-3-opus-20240229-v1:0"],
    ["claude-3-sonnet-20240229", "anthropic.claude-3-sonnet-20240229-v1:0"],
    ["claude-3-haiku-20240307", "anthropic.claude-3-haiku-20240307-v1:0"],
    ["claude-sonnet-4-20250514", "anthropic.claude-sonnet-4-20250514-v1:0"],
    ["claude-opus-4-20250514", "anthropic.claude-opus-4-20250514-v1:0"],
    ["claude-opus-4-1-20250805", "anthropic.claude-opus-4-1-20250805-v1:0"],
  ])("maps %s → %s", (anthropic, bedrock) => {
    expect(resolveBedrockModelID(anthropic)).toBe(bedrock);
  });

  test("model IDs that collide with Object.prototype keys pass through (no prototype lookup)", () => {
    // Regression (found by property test): a plain bracket lookup
    // BEDROCK_MODEL_MAP[model] resolves inherited Object.prototype members,
    // so a model literally named "valueOf"/"toString"/"constructor"/"hasOwnProperty"
    // would return the prototype FUNCTION instead of undefined and corrupt the
    // result (and crash on the next .startsWith). Must use Object.hasOwn.
    for (const key of [
      "valueOf",
      "toString",
      "constructor",
      "hasOwnProperty",
      "__proto__",
      "isPrototypeOf",
    ]) {
      expect(resolveBedrockModelID(key)).toBe(key);
    }
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

  test("client-supplied accept header does NOT override the streaming Accept", () => {
    // Regression: `accept` is NOT in GATEWAY_MANAGED_HEADERS, so a forwarded
    // client `accept` would clobber the Bedrock-required event-stream Accept
    // unless the gateway sets it LAST. Undici's default is "*/*"; SDKs send
    // "application/json" — either would break streaming if it won.
    const headers = buildBedrockHeaders(
      makeReq({ stream: true, rawHeaders: { accept: "application/json" } }),
    );
    expect(headers.accept).toBe("application/vnd.amazon.eventstream");
  });

  test("client accept '*/*' does NOT override the non-streaming Accept", () => {
    const headers = buildBedrockHeaders(
      makeReq({ stream: false, rawHeaders: { accept: "*/*" } }),
    );
    expect(headers.accept).toBe("application/json");
  });

  test("client content-type does NOT override application/json", () => {
    const headers = buildBedrockHeaders(
      makeReq({ rawHeaders: { "content-type": "text/plain" } }),
    );
    expect(headers["content-type"]).toBe("application/json");
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

  test("concatenates LTM system blocks after the host system prompt", () => {
    const req = makeReq({ system: "HOST" });
    const body = buildBedrockRequestBody(req, {
      stableLtmSystem: "STABLE_LTM",
      ltmSystem: "CONTEXT_LTM",
    }) as Record<string, unknown>;
    expect(body.system).toBe("HOST\n\nSTABLE_LTM\n\nCONTEXT_LTM");
  });

  test("translates thinking, tool_use, tool_result, and opaque blocks", () => {
    const req = makeReq({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm", signature: "sig-1" },
            { type: "tool_use", id: "tu_1", name: "search", input: { q: "x" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "tu_1",
              isError: true,
              content: [{ type: "text", text: "boom" }],
            },
            { type: "opaque", raw: { type: "custom", foo: "bar" } },
          ],
        },
      ],
    });
    const body = buildBedrockRequestBody(req) as Record<string, unknown>;
    const messages = body.messages as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;
    // thinking block (with signature)
    expect(messages[0].content[0]).toEqual({
      type: "thinking",
      thinking: "hmm",
      signature: "sig-1",
    });
    // tool_use block
    expect(messages[0].content[1]).toEqual({
      type: "tool_use",
      id: "tu_1",
      name: "search",
      input: { q: "x" },
    });
    // tool_result block with is_error
    expect(messages[1].content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tu_1",
      is_error: true,
      content: [{ type: "text", text: "boom" }],
    });
    // opaque block passes its raw payload through unchanged
    expect(messages[1].content[1]).toEqual({ type: "custom", foo: "bar" });
  });

  test("includes tools when present", () => {
    const req = makeReq({
      tools: [
        {
          name: "search",
          description: "search the web",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
    const body = buildBedrockRequestBody(req) as Record<string, unknown>;
    expect(body.tools).toEqual([
      {
        name: "search",
        description: "search the web",
        input_schema: { type: "object", properties: {} },
      },
    ]);
  });

  test("restores metadata params (temperature, top_p, etc.)", () => {
    const req = makeReq({ metadata: { temperature: 0.7, top_p: 0.9 } });
    const body = buildBedrockRequestBody(req) as Record<string, unknown>;
    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBe(0.9);
  });

  test("metadata cannot override the Bedrock anthropic_version sentinel", () => {
    // Regression: anthropic_version is not a KNOWN_BODY_FIELD, so a client that
    // sends it in the body lands it in metadata. It must NOT overwrite the
    // Bedrock sentinel (the native value makes Bedrock reject the request).
    const req = makeReq({
      metadata: { anthropic_version: "2023-06-01", temperature: 0.5 },
    });
    const body = buildBedrockRequestBody(req) as Record<string, unknown>;
    expect(body.anthropic_version).toBe("bedrock-2023-05-31");
    expect(body.temperature).toBe(0.5);
  });

  test("omits the system key entirely when there is no system prompt AND no LTM", () => {
    const body = buildBedrockRequestBody(makeReq({ system: "" })) as Record<
      string,
      unknown
    >;
    expect("system" in body).toBe(false);
  });

  test("preserves LTM even when the host system prompt is empty (Seer finding)", () => {
    // Regression: an empty req.system must NOT discard LTM context. A client
    // that sends no system prompt still needs its long-term memory injected.
    const body = buildBedrockRequestBody(makeReq({ system: "" }), {
      stableLtmSystem: "STABLE_LTM",
      ltmSystem: "CONTEXT_LTM",
    }) as Record<string, unknown>;
    expect(body.system).toBe("STABLE_LTM\n\nCONTEXT_LTM");
  });

  test("includes only stableLtm when contextLtm is absent (empty system)", () => {
    const body = buildBedrockRequestBody(makeReq({ system: "" }), {
      stableLtmSystem: "STABLE_LTM",
    }) as Record<string, unknown>;
    expect(body.system).toBe("STABLE_LTM");
  });

  test("omits the tools key entirely when there are no tools", () => {
    const body = buildBedrockRequestBody(makeReq({ tools: [] })) as Record<
      string,
      unknown
    >;
    expect("tools" in body).toBe(false);
  });

  test("thinking block without a signature omits the signature key", () => {
    const req = makeReq({
      messages: [
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "no sig" }],
        },
      ],
    });
    const body = buildBedrockRequestBody(req) as Record<string, unknown>;
    const block = (
      body.messages as Array<{ content: Array<Record<string, unknown>> }>
    )[0].content[0];
    expect(block).toEqual({ type: "thinking", thinking: "no sig" });
    expect("signature" in block).toBe(false);
  });

  test("tool_result without isError omits the is_error key", () => {
    const req = makeReq({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "tu_x",
              content: [{ type: "text", text: "ok" }],
            },
          ],
        },
      ],
    });
    const body = buildBedrockRequestBody(req) as Record<string, unknown>;
    const block = (
      body.messages as Array<{ content: Array<Record<string, unknown>> }>
    )[0].content[0];
    expect("is_error" in block).toBe(false);
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

  test("parses thinking, tool_use, and unknown (opaque) content blocks", () => {
    const json = {
      id: "msg_03",
      model: "claude-3-5-sonnet-20241022",
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "let me think", signature: "sig" },
        { type: "tool_use", id: "tu_9", name: "calc", input: { a: 1 } },
        { type: "redacted_thinking", data: "opaque-blob" },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const resp = parseBedrockResponseJSON(json);
    expect(resp.content[0]).toEqual({
      type: "thinking",
      thinking: "let me think",
      signature: "sig",
    });
    expect(resp.content[1]).toEqual({
      type: "tool_use",
      id: "tu_9",
      name: "calc",
      input: { a: 1 },
    });
    // Unknown block types are preserved as opaque (round-trippable) blocks.
    expect(resp.content[2]).toEqual({
      type: "opaque",
      raw: { type: "redacted_thinking", data: "opaque-blob" },
    });
    expect(resp.stopReason).toBe("tool_use");
  });

  test("defaults stop_reason to end_turn and usage to zeros when absent", () => {
    const resp = parseBedrockResponseJSON({ content: [] });
    expect(resp.stopReason).toBe("end_turn");
    expect(resp.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: undefined,
      cacheCreationInputTokens: undefined,
    });
  });

  test("handles a response with no content field (content defaults to [])", () => {
    // Exercises the `if (rawContent)` guard: a missing content field must not
    // throw (iterating undefined) — content is simply empty.
    const resp = parseBedrockResponseJSON({ id: "m", model: "x" });
    expect(resp.content).toEqual([]);
    expect(resp.id).toBe("m");
  });

  test("fills empty-string defaults for missing block fields", () => {
    const resp = parseBedrockResponseJSON({
      content: [
        { type: "text" }, // no text → ""
        { type: "thinking" }, // no thinking → "", no signature
        { type: "tool_use" }, // no id/name → ""
      ],
    });
    expect(resp.content[0]).toEqual({ type: "text", text: "" });
    expect(resp.content[1]).toEqual({ type: "thinking", thinking: "" });
    expect(resp.content[2]).toMatchObject({
      type: "tool_use",
      id: "",
      name: "",
    });
  });

  test("defaults id and model to empty string when absent", () => {
    const resp = parseBedrockResponseJSON({ content: [] });
    expect(resp.id).toBe("");
    expect(resp.model).toBe("");
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

// ---------------------------------------------------------------------------
// Vertex AI — NOT yet implemented (part 2 of issue #870)
// ---------------------------------------------------------------------------

describe("Vertex AI routing (not yet implemented)", () => {
  test("vertex provider is NOT routable (Seer finding — HIGH)", async () => {
    // Seer found that X-Lore-Provider: vertex requests would fall through
    // to the default Anthropic handler (wrong auth: x-api-key vs Bearer,
    // wrong body format), silently breaking requests.
    //
    // Vertex support is part 2 of issue #870. Until the vertex handler lands,
    // vertex provider IDs MUST NOT resolve to a route. We test via the
    // public resolveProviderRoute() entry point.
    const { resolveProviderRoute } = await import("../src/config");
    expect(resolveProviderRoute("vertex")).toBeNull();
    expect(resolveProviderRoute("vertex-anthropic")).toBeNull();
    expect(resolveProviderRoute("google-vertex")).toBeNull();
    expect(resolveProviderRoute("google-vertex-anthropic")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SigV4 service name (Seer finding — CRITICAL)
// ---------------------------------------------------------------------------

describe("signBedrockRequest service name", () => {
  test("SigV4 uses service name 'bedrock-runtime' (NOT 'bedrock')", async () => {
    // Bedrock runtime endpoints (InvokeModel / InvokeModelWithResponseStream)
    // use service name "bedrock-runtime" in SigV4 signatures. The hostname
    // is bedrock-runtime.<region>.amazonaws.com. AWS validates the service
    // name against the request scope, so using "bedrock" causes auth
    // failures for ALL runtime requests.
    //
    // We test by calling signBedrockRequest with test credentials and
    // inspecting the signed Authorization header for the Credential scope.
    const { signBedrockRequest } = await import("../src/bedrock-auth");

    // Mock credentials — we just need to verify the service name in the
    // signed credential scope, not the actual signature.
    const creds = {
      accessKeyId: "AKIATEST",
      secretAccessKey: "test-secret",
    };

    // Set env vars for the credential provider
    process.env.AWS_ACCESS_KEY_ID = creds.accessKeyId;
    process.env.AWS_SECRET_ACCESS_KEY = creds.secretAccessKey;

    const url =
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet-20241022-v2%3A0/invoke";
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      host: "bedrock-runtime.us-east-1.amazonaws.com",
    };

    await signBedrockRequest(
      "POST",
      url,
      headers,
      '{"anthropic_version":"bedrock-2023-05-31"}',
      "us-east-1",
    );

    // The Authorization header MUST contain "bedrock-runtime" in the
    // Credential scope (not "bedrock"). AWS validates this against the
    // request scope and rejects mismatches.
    const authHeader = headers.authorization ?? headers.Authorization ?? "";
    expect(authHeader).toContain("bedrock-runtime");
    expect(authHeader).not.toMatch(/\/bedrock\/aws4_request/);

    // Cleanup
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
  });

  test("sets and signs the host header even when the caller omits it", async () => {
    // Regression (CRITICAL): production callers (buildBedrockHeaders + pipeline)
    // do NOT set `host`. SigV4 requires host in SignedHeaders and the wire
    // request carries a Host header AWS validates — @smithy/signature-v4 signs
    // ONLY headers present on the request, so signBedrockRequest must populate
    // host itself or every Bedrock request fails with SignatureDoesNotMatch.
    const { signBedrockRequest, _setTestCredentialProviders } = await import(
      "../src/bedrock-auth"
    );
    _setTestCredentialProviders([
      async () => ({ accessKeyId: "AKIATEST", secretAccessKey: "secret" }),
    ]);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      // NOTE: deliberately NO host — mirrors the real production call site.
    };
    await signBedrockRequest(
      "POST",
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/x/invoke",
      headers,
      "{}",
      "us-east-1",
    );
    // host populated for the wire request...
    expect(headers.host).toBe("bedrock-runtime.us-east-1.amazonaws.com");
    // ...and included in the signed-headers list.
    const auth = headers.authorization ?? headers.Authorization ?? "";
    expect(auth).toMatch(/SignedHeaders=[^,]*\bhost\b/);
    _setTestCredentialProviders(null);
  });

  test("signs query-string params into the canonical request", async () => {
    const { signBedrockRequest, _setTestCredentialProviders } = await import(
      "../src/bedrock-auth"
    );
    _setTestCredentialProviders([
      async () => ({
        accessKeyId: "AKIATEST",
        secretAccessKey: "test-secret",
      }),
    ]);
    // A URL with a query string exercises the searchParams → query mapping.
    const url =
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-haiku-20240307-v1%3A0/invoke?foo=bar&baz=qux";
    const headers: Record<string, string> = {
      "content-type": "application/json",
      host: "bedrock-runtime.us-east-1.amazonaws.com",
    };
    await signBedrockRequest("POST", url, headers, "{}", "us-east-1");
    const authHeader = headers.authorization ?? headers.Authorization ?? "";
    // Signed request includes the SignedHeaders + Signature components.
    expect(authHeader).toContain("AWS4-HMAC-SHA256");
    expect(authHeader).toContain("Signature=");
    _setTestCredentialProviders(null);
  });
});

// ---------------------------------------------------------------------------
// Credential provider chain (test seam)
// ---------------------------------------------------------------------------

describe("Bedrock credential provider chain", () => {
  test("falls back to the next provider when the first throws", async () => {
    const { signBedrockRequest, _setTestCredentialProviders } = await import(
      "../src/bedrock-auth"
    );
    let firstCalled = false;
    let secondCalled = false;
    _setTestCredentialProviders([
      async () => {
        firstCalled = true;
        throw new Error("no env credentials");
      },
      async () => {
        secondCalled = true;
        return { accessKeyId: "AKIA2", secretAccessKey: "secret2" };
      },
    ]);
    const headers: Record<string, string> = {
      host: "bedrock-runtime.us-east-1.amazonaws.com",
    };
    await signBedrockRequest(
      "POST",
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/x/invoke",
      headers,
      "{}",
      "us-east-1",
    );
    expect(firstCalled).toBe(true);
    expect(secondCalled).toBe(true);
    expect(headers.authorization ?? headers.Authorization).toContain(
      "AWS4-HMAC-SHA256",
    );
    _setTestCredentialProviders(null);
  });

  test("throws the last error when every provider fails", async () => {
    const { signBedrockRequest, _setTestCredentialProviders } = await import(
      "../src/bedrock-auth"
    );
    _setTestCredentialProviders([
      async () => {
        throw new Error("env failed");
      },
      async () => {
        throw new Error("ini failed");
      },
    ]);
    await expect(
      signBedrockRequest(
        "POST",
        "https://bedrock-runtime.us-east-1.amazonaws.com/model/x/invoke",
        { host: "bedrock-runtime.us-east-1.amazonaws.com" },
        "{}",
        "us-east-1",
      ),
    ).rejects.toThrow(/ini failed/);
    _setTestCredentialProviders(null);
  });

  test("_resetBedrockCredentials clears the cached chain (signing still works after)", async () => {
    const {
      signBedrockRequest,
      _setTestCredentialProviders,
      _resetBedrockCredentials,
    } = await import("../src/bedrock-auth");
    _setTestCredentialProviders([
      async () => ({ accessKeyId: "AKIA", secretAccessKey: "s" }),
    ]);
    const sign = () => {
      const headers: Record<string, string> = {
        host: "bedrock-runtime.us-east-1.amazonaws.com",
      };
      return signBedrockRequest(
        "POST",
        "https://bedrock-runtime.us-east-1.amazonaws.com/model/x/invoke",
        headers,
        "{}",
        "us-east-1",
      ).then(() => headers);
    };
    // Sign once to populate the cached chain.
    const first = await sign();
    expect(first.authorization ?? first.Authorization).toContain(
      "AWS4-HMAC-SHA256",
    );
    // Reset clears the cache; the next sign rebuilds and still succeeds.
    _resetBedrockCredentials();
    const second = await sign();
    expect(second.authorization ?? second.Authorization).toContain(
      "AWS4-HMAC-SHA256",
    );
    _setTestCredentialProviders(null);
  });
});
