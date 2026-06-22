/**
 * Tests for the AWS Bedrock event-stream decoder (bedrock-stream.ts).
 *
 * Bedrock's InvokeModelWithResponseStream returns AWS binary event-stream
 * framing — NOT SSE. Each frame is an event-stream Message whose `chunk`
 * events carry a base64-encoded Anthropic SSE event in a `{ bytes }` JSON body.
 * These tests build REAL frames with the same EventStreamCodec the decoder
 * uses, then assert the decoder yields the correct { event, data } pairs.
 */
import { describe, test, expect } from "vitest";
import { EventStreamCodec } from "@smithy/eventstream-codec";
import type { Message } from "@smithy/eventstream-codec";
import {
  decodeBedrockEventStream,
  accumulateBedrockResponse,
} from "../src/bedrock-stream";

// ---------------------------------------------------------------------------
// Frame construction helpers (mirror the producer side: AWS Bedrock)
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();

const codec = new EventStreamCodec(
  (input: Uint8Array | string) =>
    typeof input === "string" ? input : dec.decode(input),
  (input: string) => enc.encode(input),
);

/** Build a binary `chunk` frame wrapping a decoded Anthropic event object. */
function chunkFrame(anthropicEvent: Record<string, unknown>): Uint8Array {
  const base64 = Buffer.from(JSON.stringify(anthropicEvent)).toString("base64");
  const message: Message = {
    headers: {
      ":event-type": { type: "string", value: "chunk" },
      ":content-type": { type: "string", value: "application/json" },
      ":message-type": { type: "string", value: "event" },
    },
    body: enc.encode(JSON.stringify({ bytes: base64 })),
  };
  return codec.encode(message);
}

/** Build a non-chunk frame (e.g. an AWS metadata/initial-response event). */
function nonChunkFrame(eventType: string): Uint8Array {
  const message: Message = {
    headers: {
      ":event-type": { type: "string", value: eventType },
      ":message-type": { type: "string", value: "event" },
    },
    body: enc.encode("{}"),
  };
  return codec.encode(message);
}

/** Build a malformed chunk frame whose `bytes` field is missing. */
function chunkFrameMissingBytes(): Uint8Array {
  const message: Message = {
    headers: {
      ":event-type": { type: "string", value: "chunk" },
      ":content-type": { type: "string", value: "application/json" },
    },
    body: enc.encode(JSON.stringify({ notBytes: "oops" })),
  };
  return codec.encode(message);
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** A ReadableStream reader that emits the given chunks in order. */
function readerFromChunks(
  chunks: Uint8Array[],
): ReadableStreamDefaultReader<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  }).getReader();
}

async function collect(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Array<{ event: string; data: string }>> {
  const out: Array<{ event: string; data: string }> = [];
  for await (const evt of decodeBedrockEventStream(reader)) out.push(evt);
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("decodeBedrockEventStream", () => {
  test("decodes a single chunk frame into an Anthropic SSE event", async () => {
    const event = {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hi" },
    };
    const events = await collect(readerFromChunks([chunkFrame(event)]));
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("content_block_delta");
    expect(JSON.parse(events[0].data)).toEqual(event);
  });

  test("decodes non-ASCII (UTF-8) content without corruption", async () => {
    // Regression: the decoder must base64-decode as UTF-8, NOT via atob()
    // (which yields a Latin-1 binary string and mojibakes multi-byte chars).
    const event = {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "café ☕ 你好 — “smart” — 🚀" },
    };
    const events = await collect(readerFromChunks([chunkFrame(event)]));
    expect(events).toHaveLength(1);
    // Exact round-trip — on the buggy atob() path this would be mojibake.
    expect(JSON.parse(events[0].data)).toEqual(event);
    expect(events[0].data).toContain("café ☕ 你好 — “smart” — 🚀");
  });

  test("decodes a full multi-frame conversation in order", async () => {
    const frames = [
      chunkFrame({ type: "message_start", message: { id: "m1" } }),
      chunkFrame({ type: "content_block_start", index: 0 }),
      chunkFrame({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      }),
      chunkFrame({ type: "content_block_stop", index: 0 }),
      chunkFrame({ type: "message_stop" }),
    ];
    const events = await collect(readerFromChunks(frames));
    expect(events.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_stop",
    ]);
  });

  test("handles multiple frames packed into a single read", async () => {
    // The codec must buffer + split multiple messages from one Uint8Array.
    const packed = concat(
      chunkFrame({ type: "message_start" }),
      chunkFrame({ type: "message_stop" }),
    );
    const events = await collect(readerFromChunks([packed]));
    expect(events.map((e) => e.event)).toEqual([
      "message_start",
      "message_stop",
    ]);
  });

  test("handles a frame split across two reads (codec buffering)", async () => {
    const frame = chunkFrame({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "split" },
    });
    const mid = Math.floor(frame.length / 2);
    const events = await collect(
      readerFromChunks([frame.slice(0, mid), frame.slice(mid)]),
    );
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("content_block_delta");
  });

  test("skips non-chunk events (metadata / initial-response)", async () => {
    const events = await collect(
      readerFromChunks([
        nonChunkFrame("initial-response"),
        chunkFrame({ type: "message_start" }),
        nonChunkFrame("metadata"),
      ]),
    );
    expect(events.map((e) => e.event)).toEqual(["message_start"]);
  });

  test("skips chunk frames missing the bytes field (does not throw)", async () => {
    const events = await collect(
      readerFromChunks([
        chunkFrameMissingBytes(),
        chunkFrame({ type: "message_stop" }),
      ]),
    );
    expect(events.map((e) => e.event)).toEqual(["message_stop"]);
  });

  test("empty stream yields no events", async () => {
    const events = await collect(readerFromChunks([]));
    expect(events).toEqual([]);
  });

  test("skips a chunk frame whose body is not valid JSON (does not throw)", async () => {
    // Body is raw non-JSON bytes → parseBedrockMessage's JSON.parse throws and
    // is swallowed; the malformed frame is skipped, the good one still emits.
    const badBody: Message = {
      headers: { ":event-type": { type: "string", value: "chunk" } },
      body: enc.encode("this is not json{"),
    };
    const events = await collect(
      readerFromChunks([
        codec.encode(badBody),
        chunkFrame({ type: "message_stop" }),
      ]),
    );
    expect(events.map((e) => e.event)).toEqual(["message_stop"]);
  });

  test("skips a chunk frame whose bytes decode to invalid JSON (does not throw)", async () => {
    const badInner: Message = {
      headers: { ":event-type": { type: "string", value: "chunk" } },
      body: enc.encode(
        JSON.stringify({ bytes: Buffer.from("{not json").toString("base64") }),
      ),
    };
    const events = await collect(
      readerFromChunks([
        codec.encode(badInner),
        chunkFrame({ type: "message_stop" }),
      ]),
    );
    expect(events.map((e) => e.event)).toEqual(["message_stop"]);
  });

  test("warns and stops on trailing partial frame at end of stream (no throw)", async () => {
    // Deliver only the first half of a frame, then close. The frame never
    // completes → no event, leftover bytes are reported, generator ends cleanly.
    const frame = chunkFrame({ type: "message_start" });
    const events = await collect(
      readerFromChunks([frame.slice(0, frame.length - 3)]),
    );
    expect(events).toEqual([]);
  });

  test("skips a frame whose length prefix matches but content is corrupt (CRC fail)", async () => {
    // A 16-byte buffer with a self-consistent length prefix but garbage body.
    // takeCompleteFrame hands it to codec.decode(), which throws on the CRC /
    // header check; decodeFrame swallows it and continues with the next frame.
    const corrupt = new Uint8Array(16);
    new DataView(corrupt.buffer).setUint32(0, 16, false); // totalLength = 16
    const events = await collect(
      readerFromChunks([corrupt, chunkFrame({ type: "message_stop" })]),
    );
    expect(events.map((e) => e.event)).toEqual(["message_stop"]);
  });

  test("throws on an impossible frame length prefix (< 4 bytes total)", async () => {
    // A length prefix smaller than the prelude itself is unrecoverable — we
    // must fail loudly rather than spin forever on a zero-advance buffer.
    const bogus = new Uint8Array([0, 0, 0, 2]); // totalLength = 2
    await expect(collect(readerFromChunks([bogus]))).rejects.toThrow(
      /invalid frame length/i,
    );
  });

  test("throws on an absurdly large frame length (>16 MiB DoS guard)", async () => {
    // A garbled prelude declaring a huge length must fail fast rather than
    // buffering unbounded bytes waiting for a frame that never completes.
    const bogus = new Uint8Array(8);
    new DataView(bogus.buffer).setUint32(0, 0x7fffffff, false); // ~2 GiB
    await expect(collect(readerFromChunks([bogus]))).rejects.toThrow(
      /invalid frame length/i,
    );
  });
});

describe("accumulateBedrockResponse", () => {
  test("collects all events from a Response body", async () => {
    const body = concat(
      chunkFrame({ type: "message_start" }),
      chunkFrame({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "x" },
      }),
      chunkFrame({ type: "message_stop" }),
    );
    const response = new Response(body);
    const events = await accumulateBedrockResponse(response);
    expect(events.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_delta",
      "message_stop",
    ]);
  });

  test("throws when the response has no body", async () => {
    // A 204 response has a null body.
    const response = new Response(null, { status: 204 });
    await expect(accumulateBedrockResponse(response)).rejects.toThrow(
      /no body/i,
    );
  });
});
