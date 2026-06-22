/**
 * AWS Bedrock event-stream decoder.
 *
 * Bedrock InvokeModelWithResponseStream returns a binary event-stream
 * (AWS event-stream framing) instead of SSE. Each frame contains a
 * `chunk` event with a `bytes` field holding base64-encoded JSON
 * that is the Anthropic SSE event payload.
 *
 * This decoder reads the binary stream and yields decoded Anthropic
 * SSE events ({ event, data } pairs) that can be fed directly into
 * the existing Anthropic stream accumulator.
 */
import { EventStreamCodec } from "@smithy/eventstream-codec";
import type { Message } from "@smithy/eventstream-codec";
import type { AvailableMessage } from "@smithy/types";
import { log } from "@loreai/core";

// ---------------------------------------------------------------------------
// UTF-8 helpers for the codec constructor
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Extract a `Message` from an `AvailableMessage` returned by the codec.
 * Returns null when the available message is empty or signals end-of-stream.
 */
function extractMessage(available: AvailableMessage): Message | null {
  if (available.isEndOfStream()) return null;
  return available.getMessage() ?? null;
}

// ---------------------------------------------------------------------------
// Event-stream decoding
// ---------------------------------------------------------------------------

/**
 * Decode an AWS Bedrock event-stream response body into Anthropic SSE events.
 *
 * Bedrock's InvokeModelWithResponseStream returns a binary event-stream.
 * Each frame is an AWS event-stream message with headers and a binary payload.
 * The payload contains a `chunk` event with:
 *   - `:content-type`: "application/json"
 *   - `:event-type`: "chunk"
 *   - `:message-type`: "event"
 *   - The body is a JSON object: { "bytes": "<base64-encoded Anthropic SSE event>" }
 *
 * We decode the base64 bytes, parse the JSON, and yield { event, data } pairs.
 *
 * @param reader - A ReadableStream reader yielding Uint8Array chunks
 * @yields { event: string; data: string } - Anthropic SSE events
 */
export async function* decodeBedrockEventStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  // EventStreamCodec constructor: (toUtf8: Encoder, fromUtf8: Decoder)
  // Encoder: (input: Uint8Array | string) => string  (bytes → string)
  // Decoder: (input: string) => Uint8Array            (string → bytes)
  const codec = new EventStreamCodec(
    (input: Uint8Array | string) =>
      typeof input === "string" ? input : decoder.decode(input),
    (input: string) => encoder.encode(input),
  );

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      codec.endOfStream();
      // Drain any remaining messages
      for (;;) {
        const available = codec.getMessage();
        const msg = extractMessage(available);
        if (!msg) break;
        const sseEvent = parseBedrockMessage(msg);
        if (sseEvent) yield sseEvent;
      }
      break;
    }

    if (value) {
      codec.feed(value);
      // Drain all available messages from the buffer
      for (;;) {
        const available = codec.getMessage();
        const msg = extractMessage(available);
        if (!msg) break;
        const sseEvent = parseBedrockMessage(msg);
        if (sseEvent) yield sseEvent;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Bedrock message → Anthropic SSE event conversion
// ---------------------------------------------------------------------------

/**
 * Parse a decoded Bedrock event-stream message into an Anthropic SSE event.
 *
 * The Bedrock message headers contain `:event-type` and `:message-type`.
 * For `chunk` events, the body is JSON: `{ "bytes": "<base64>" }`.
 * Decoding the base64 yields the Anthropic SSE event JSON.
 */
function parseBedrockMessage(
  msg: Message,
): { event: string; data: string } | null {
  try {
    // Check event type from headers
    const eventType = msg.headers?.[":event-type"]?.value;
    if (eventType !== "chunk") {
      // Skip non-chunk events (e.g. initial-response, metadata)
      return null;
    }

    // Parse the body as JSON: { bytes: "<base64>" }
    const bodyStr = decoder.decode(msg.body);
    const bodyJson = JSON.parse(bodyStr) as { bytes?: string };

    if (!bodyJson.bytes) {
      log.warn("bedrock event-stream: chunk missing bytes field");
      return null;
    }

    // Decode base64 → JSON (Anthropic SSE event payload)
    const decoded = atob(bodyJson.bytes);
    const payload = JSON.parse(decoded) as Record<string, unknown>;

    // The Anthropic SSE event type is in the `type` field
    const event = String(payload.type ?? "message");
    return { event, data: decoded };
  } catch (e) {
    log.warn(`bedrock event-stream: failed to parse message: ${e}`);
    return null;
  }
}

/**
 * Consume a full Bedrock event-stream response and return all events.
 */
export async function accumulateBedrockResponse(
  response: Response,
): Promise<{ event: string; data: string }[]> {
  if (!response.body) {
    throw new Error("Bedrock response has no body");
  }

  const reader = response.body.getReader();
  const events: { event: string; data: string }[] = [];

  for await (const evt of decodeBedrockEventStream(reader)) {
    events.push(evt);
  }

  return events;
}
