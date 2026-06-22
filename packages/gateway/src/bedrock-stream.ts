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
import { log } from "@loreai/core";

// ---------------------------------------------------------------------------
// UTF-8 helpers for the codec constructor
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * AWS event-stream frame prelude: a 4-byte big-endian total-message-length
 * prefix is the first field of every frame. We use it to carve complete
 * frames out of the (arbitrarily-chunked) byte stream before decoding.
 */
const PRELUDE_TOTAL_LENGTH_BYTES = 4;

/**
 * AWS caps an event-stream message at 16 MiB. A length prefix beyond this is a
 * corrupt/garbled frame — reject it (fail fast) rather than buffering unbounded
 * bytes waiting for a frame that will never complete (DoS / OOM guard).
 */
const MAX_FRAME_LENGTH_BYTES = 16 * 1024 * 1024;

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
 * IMPORTANT: network reads do NOT align to event-stream frame boundaries — a
 * single read may contain a partial frame, exactly one frame, or several. The
 * @smithy `EventStreamCodec.decode()` decodes EXACTLY one complete frame and
 * throws if the buffer length doesn't match the frame's own length prefix
 * (it does no buffering of its own). So we buffer raw bytes here and carve out
 * complete frames using the 4-byte big-endian total-length prelude, decoding
 * one frame at a time.
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

  let buffer: Uint8Array = new Uint8Array(0);

  for (;;) {
    const { done, value } = await reader.read();

    if (value && value.length > 0) {
      buffer = concatBytes(buffer, value);
      // Carve out and emit every COMPLETE frame currently buffered. A frame is
      // complete once we have its full declared length (first 4 bytes, BE).
      for (;;) {
        const frame = takeCompleteFrame(buffer);
        if (!frame) break; // need more bytes
        buffer = frame.rest;
        const sseEvent = decodeFrame(codec, frame.frame);
        if (sseEvent) yield sseEvent;
      }
    }

    if (done) {
      // A well-formed stream ends on a frame boundary; any trailing bytes are a
      // truncated/partial frame we cannot decode. Surface it, don't crash.
      if (buffer.length > 0) {
        log.warn(
          `bedrock event-stream: ${buffer.length} trailing undecodable byte(s) at end of stream`,
        );
      }
      break;
    }
  }
}

/**
 * If `buffer` begins with a complete event-stream frame, split it off and
 * return `{ frame, rest }`; otherwise return null (need more bytes).
 *
 * The first 4 bytes are the total frame length (big-endian, inclusive of the
 * prelude and trailing CRC), per the AWS event-stream framing spec.
 */
function takeCompleteFrame(
  buffer: Uint8Array,
): { frame: Uint8Array<ArrayBuffer>; rest: Uint8Array<ArrayBuffer> } | null {
  if (buffer.length < PRELUDE_TOTAL_LENGTH_BYTES) return null;
  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );
  const totalLength = view.getUint32(0, false); // big-endian
  // Guard against a corrupt length that would wedge the loop (too small to make
  // progress) or buffer unbounded bytes (absurdly large — never completes).
  if (
    totalLength < PRELUDE_TOTAL_LENGTH_BYTES ||
    totalLength > MAX_FRAME_LENGTH_BYTES
  ) {
    throw new Error(
      `bedrock event-stream: invalid frame length ${totalLength}`,
    );
  }
  if (buffer.length < totalLength) return null; // frame not fully arrived yet
  return {
    frame: buffer.slice(0, totalLength),
    rest: buffer.slice(totalLength),
  };
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Decode one complete frame and convert it to an Anthropic SSE event. */
function decodeFrame(
  codec: EventStreamCodec,
  frame: Uint8Array,
): { event: string; data: string } | null {
  let message: Message;
  try {
    message = codec.decode(frame);
  } catch (e) {
    log.warn(`bedrock event-stream: failed to decode frame: ${e}`);
    return null;
  }
  return parseBedrockMessage(message);
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

    // Decode base64 → UTF-8 JSON (Anthropic SSE event payload).
    // NOTE: must decode base64 as UTF-8 bytes, NOT via atob(). atob() yields a
    // Latin-1 binary string (one char per byte), so any multi-byte UTF-8
    // sequence (accents, CJK, emoji, smart quotes) becomes mojibake — and that
    // corrupted string is what gets forwarded to the client AND stored in
    // memory. The bytes field is base64 of UTF-8 JSON, so decode accordingly.
    const decoded = Buffer.from(bodyJson.bytes, "base64").toString("utf8");
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
