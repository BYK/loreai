/**
 * AWS Bedrock ↔ Gateway translation layer.
 *
 * Converts between Anthropic's `/v1/messages` API format (what the client sends)
 * and AWS Bedrock's InvokeModelWithResponseStream endpoint. The gateway receives
 * plain Anthropic protocol requests from the client, translates to Bedrock's
 * format, signs with SigV4, decodes the AWS event-stream response back to SSE.
 *
 * Key differences from native Anthropic:
 *  - Auth: AWS SigV4 (not x-api-key or Bearer)
 *  - URL: model is in the URL path, not the body
 *  - Streaming: AWS binary event-stream framing, not SSE
 *  - anthropic_version: "bedrock-2023-05-31" (in body)
 *  - cch billing header: NOT applicable (Anthropic-first-party only)
 */
import type {
  GatewayContentBlock,
  GatewayMessage,
  GatewayRequest,
  GatewayResponse,
  GatewayTool,
} from "./types";
import { forwardClientHeaders, ZERO_USAGE } from "./types";

// ---------------------------------------------------------------------------
// Bedrock API version — used in the body for Bedrock-specific requests
// ---------------------------------------------------------------------------

const BEDROCK_ANTHROPIC_VERSION = "bedrock-2023-05-31";

// ---------------------------------------------------------------------------
// Bedrock model ID mapping
// ---------------------------------------------------------------------------

/**
 * Map Anthropic model IDs to Bedrock model IDs.
 *
 * Bedrock uses dot-separated IDs like `anthropic.claude-3-5-sonnet-20241022-v2:0`
 * while Anthropic native uses `claude-3-5-sonnet-20241022`. The mapping is
 * maintained for known models; unknown models pass through unchanged.
 */
const BEDROCK_MODEL_MAP: Record<string, string> = {
  "claude-3-5-sonnet-20241022": "anthropic.claude-3-5-sonnet-20241022-v2:0",
  "claude-3-5-sonnet-latest": "anthropic.claude-3-5-sonnet-20241022-v2:0",
  "claude-3-5-haiku-20241022": "anthropic.claude-3-5-haiku-20241022-v1:0",
  "claude-3-5-haiku-latest": "anthropic.claude-3-5-haiku-20241022-v1:0",
  "claude-3-opus-20240229": "anthropic.claude-3-opus-20240229-v1:0",
  "claude-3-sonnet-20240229": "anthropic.claude-3-sonnet-20240229-v1:0",
  "claude-3-haiku-20240307": "anthropic.claude-3-haiku-20240307-v1:0",
  "claude-sonnet-4-20250514": "anthropic.claude-sonnet-4-20250514-v1:0",
  "claude-opus-4-20250514": "anthropic.claude-opus-4-20250514-v1:0",
  "claude-opus-4-1-20250805": "anthropic.claude-opus-4-1-20250805-v1:0",
};

/**
 * Resolve a Bedrock model ID from an Anthropic model ID.
 * Passes through if already in Bedrock format or unknown.
 */
export function resolveBedrockModelID(model: string): string {
  // Use Object.hasOwn — a plain bracket lookup (BEDROCK_MODEL_MAP[model])
  // resolves inherited Object.prototype members, so a model literally named
  // "valueOf"/"toString"/"constructor" would return the prototype function
  // instead of undefined and corrupt the result. Guard against own keys only.
  if (Object.hasOwn(BEDROCK_MODEL_MAP, model)) return BEDROCK_MODEL_MAP[model];
  // Already in Bedrock format (starts with anthropic.)
  if (model.startsWith("anthropic.")) return model;
  // Unknown — return as-is (Bedrock may reject, but let it fail loudly)
  return model;
}

/**
 * Build the Bedrock InvokeModelWithResponseStream URL for a given model.
 *
 * URL format:
 *   https://bedrock-runtime.{region}.amazonaws.com/model/{modelId}/invoke-with-response-stream
 */
export function bedrockInvokeUrl(region: string, modelId: string): string {
  const encodedModel = encodeURIComponent(modelId);
  return `https://bedrock-runtime.${region}.amazonaws.com/model/${encodedModel}/invoke-with-response-stream`;
}

/**
 * Build the Bedrock InvokeModel (non-streaming) URL for a given model.
 */
export function bedrockInvokeNoStreamUrl(
  region: string,
  modelId: string,
): string {
  const encodedModel = encodeURIComponent(modelId);
  return `https://bedrock-runtime.${region}.amazonaws.com/model/${encodedModel}/invoke`;
}

// ---------------------------------------------------------------------------
// Request body translation: Anthropic → Bedrock
// ---------------------------------------------------------------------------

/**
 * Build a Bedrock request body from a GatewayRequest.
 *
 * Bedrock accepts the Anthropic Messages API body format with two changes:
 *  1. `anthropic_version` must be set to "bedrock-2023-05-31"
 *  2. The `model` field is ignored (model is in the URL), but we keep it
 *     for compatibility — Bedrock validates the body, not the model field.
 *
 * The body is otherwise identical to the Anthropic Messages API format.
 * We reuse `buildAnthropicRequest` logic by constructing the body directly.
 */
export function buildBedrockRequestBody(
  req: GatewayRequest,
  cache?: {
    stableLtmSystem?: string;
    ltmSystem?: string;
  },
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    anthropic_version: BEDROCK_ANTHROPIC_VERSION,
    max_tokens: req.maxTokens,
    // NOTE: Bedrock does NOT accept a `stream` field in the body. Streaming
    // is controlled by the endpoint: `InvokeModel` (non-streaming) vs
    // `InvokeModelWithResponseStream` (streaming). The URL builder selects
    // the right endpoint based on req.stream. Adding `stream: true|false`
    // here causes Bedrock to reject the request with a validation error.
  };

  // System prompt — concatenate LTM into system (Bedrock doesn't support
  // multi-block system with cache_control the way native Anthropic does).
  // NOTE: filter the host prompt together with the LTM parts — an EMPTY
  // req.system must NOT discard LTM (a client sending no system prompt still
  // needs its long-term-memory context). Only omit `system` when there is
  // genuinely nothing to send.
  const systemParts = [
    req.system,
    cache?.stableLtmSystem,
    cache?.ltmSystem,
  ].filter(Boolean);
  if (systemParts.length > 0) {
    body.system = systemParts.join("\n\n");
  }

  // Messages
  body.messages = req.messages.map((msg) => ({
    role: msg.role,
    content: msg.content.map(toAnthropicBlock),
  }));

  // Tools — only include if present
  if (req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }

  // Restore metadata params (temperature, top_p, etc.). `anthropic_version` is
  // NOT a KNOWN_BODY_FIELD, so a client that puts it in the body lands it in
  // metadata — never let it override the Bedrock sentinel "bedrock-2023-05-31"
  // (the native Anthropic value would make Bedrock reject the request).
  for (const [key, value] of Object.entries(req.metadata)) {
    if (key === "anthropic_version") continue;
    body[key] = value;
  }

  return body;
}

// ---------------------------------------------------------------------------
// Block translation (shared with anthropic.ts — kept here for Bedrock-specific path)
// ---------------------------------------------------------------------------

function toAnthropicBlock(block: GatewayContentBlock): Record<string, unknown> {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "thinking":
      return {
        type: "thinking",
        thinking: block.thinking,
        ...(block.signature != null
          ? { signature: block.signature }
          : undefined),
      };
    case "tool_use":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      };
    case "tool_result": {
      const result: Record<string, unknown> = {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        content: block.content.map(toAnthropicBlock),
      };
      if (block.isError) result.is_error = true;
      return result;
    }
    case "opaque":
      return block.raw;
  }
}

// ---------------------------------------------------------------------------
// Response parsing: Bedrock non-streaming JSON → GatewayResponse
// ---------------------------------------------------------------------------

/**
 * Parse a Bedrock non-streaming response (InvokeModel) into a GatewayResponse.
 *
 * Bedrock returns the same JSON structure as Anthropic's non-streaming
 * /v1/messages endpoint, so parsing is identical to parseAnthropicResponseJSON.
 */
export function parseBedrockResponseJSON(
  json: Record<string, unknown>,
): GatewayResponse {
  const content: GatewayContentBlock[] = [];
  const rawContent = json.content as Array<Record<string, unknown>> | undefined;
  if (rawContent) {
    for (const block of rawContent) {
      switch (block.type) {
        case "text":
          content.push({ type: "text", text: String(block.text ?? "") });
          break;
        case "thinking":
          content.push({
            type: "thinking",
            thinking: String(block.thinking ?? ""),
            ...(block.signature
              ? { signature: String(block.signature) }
              : undefined),
          });
          break;
        case "tool_use":
          content.push({
            type: "tool_use",
            id: String(block.id ?? ""),
            name: String(block.name ?? ""),
            input: block.input,
          });
          break;
        default:
          content.push({ type: "opaque", raw: block });
          break;
      }
    }
  }

  const usage = json.usage as Record<string, number> | undefined;

  return {
    id: String(json.id ?? ""),
    model: String(json.model ?? ""),
    content,
    stopReason: String((json.stop_reason as string) ?? "end_turn"),
    usage: {
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      cacheReadInputTokens: usage?.cache_read_input_tokens,
      cacheCreationInputTokens: usage?.cache_creation_input_tokens,
    },
  };
}

// ---------------------------------------------------------------------------
// Event-stream → SSE conversion
// ---------------------------------------------------------------------------

/**
 * Convert a parsed Bedrock event-stream chunk into Anthropic SSE events.
 *
 * Bedrock InvokeModelWithResponseStream emits events with a `chunk` field
 * containing `bytes` (a base64-encoded Uint8Array). Decoding those bytes
 * yields an Anthropic SSE event payload (JSON object with a `type` field).
 *
 * This function takes the decoded JSON chunk and produces the corresponding
 * SSE event string(s) for the client-facing stream.
 *
 * @param chunkJson - The decoded JSON from a Bedrock event-stream chunk
 * @returns Array of { event, data } pairs to emit as SSE
 */
export function bedrockChunkToSSEEvents(
  chunkJson: Record<string, unknown>,
): Array<{ event: string; data: string }> {
  // Bedrock wraps Anthropic events in a `bytes` field. After decoding,
  // the JSON has the same shape as an Anthropic SSE event payload.
  // The `type` field tells us the event type.
  const type = String(chunkJson.type ?? "message");

  // Map Anthropic event types to SSE event names
  const sseEventName = type;

  return [{ event: sseEventName, data: JSON.stringify(chunkJson) }];
}

// ---------------------------------------------------------------------------
// Headers for Bedrock requests
// ---------------------------------------------------------------------------

/**
 * Build the base headers for a Bedrock request (before SigV4 signing).
 *
 * Bedrock requires:
 *  - Content-Type: application/json
 *  - No x-api-key or Authorization (SigV4 provides auth)
 *  - No anthropic-version header (version is in the body)
 *  - No cch billing header (Anthropic-first-party only)
 *
 * Client-forwarded headers that are not Anthropic-specific (e.g. user-agent)
 * are preserved. Anthropic-specific headers (x-api-key, anthropic-version,
 * x-anthropic-billing-header) are stripped.
 */
export function buildBedrockHeaders(
  req: GatewayRequest,
): Record<string, string> {
  const headers: Record<string, string> = {};

  // Forward non-managed, non-Anthropic-specific client headers FIRST, so the
  // gateway-managed content-type/accept set below always win. `accept` is NOT
  // in GATEWAY_MANAGED_HEADERS, so a client `accept` (e.g. undici's default
  // "*/*" or an SDK's "application/json") would otherwise clobber the
  // Bedrock-required Accept and break streaming — set our values LAST.
  const forwarded = forwardClientHeaders(req.rawHeaders);
  for (const [key, value] of Object.entries(forwarded)) {
    // Skip Anthropic-specific headers that Bedrock doesn't understand
    if (key === "anthropic-version") continue;
    if (key === "anthropic-beta") continue;
    if (key === "x-anthropic-billing-header") continue;
    headers[key] = value;
  }

  // Gateway-managed framing headers — set LAST so they override any forwarded
  // client values. Bedrock InvokeModelWithResponseStream returns AWS binary
  // event-stream framing (NOT SSE): the Accept header MUST be
  // application/vnd.amazon.eventstream or Bedrock rejects/mis-formats the
  // response. Non-streaming InvokeModel returns plain JSON. Symmetric with
  // bedrock-stream.ts decodeBedrockEventStream.
  headers["content-type"] = "application/json";
  headers.accept = req.stream
    ? "application/vnd.amazon.eventstream"
    : "application/json";

  return headers;
}
