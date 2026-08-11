/**
 * Tests for the pure Anthropic SSE helpers in `src/stream/anthropic.ts`:
 * formatSSEEvent, parseSSEStream, createStreamAccumulator,
 * buildSSEMessageStart, buildSSETextResponse, accumulateSSEResponse.
 *
 * (buildKeepaliveCompactionStream and createRecallAwareAccumulator are
 * covered by keepalive-compaction.test.ts / recall-stream.test.ts.)
 */
import { describe, test, expect, vi } from "vitest";
import {
  formatSSEEvent,
  parseSSEStream,
  createStreamAccumulator,
  scaleMessageDeltaUsage,
  buildSSEMessageStart,
  buildSSETextResponse,
  buildSSEResponse,
  accumulateSSEResponse,
} from "../src/stream/anthropic";
import {
  DEFAULT_MAX_REPORTED_USAGE,
  maxReportedUsageForModel,
} from "../src/compaction";
import type { GatewayResponse } from "../src/translate/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readerFromChunks(
  chunks: string[],
): ReadableStreamDefaultReader<Uint8Array> {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return stream.getReader();
}

function readerFromBytes(
  chunks: Uint8Array[],
): ReadableStreamDefaultReader<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }).getReader();
}

test("strict SSE decoding rejects malformed UTF-8, including split sequences", async () => {
  for (const chunks of [
    [new Uint8Array([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xff, 0x0a, 0x0a])],
    [
      new Uint8Array([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xe2]),
      new Uint8Array([0x28, 0xa1, 0x0a, 0x0a]),
    ],
  ]) {
    const consume = async () => {
      for await (const _event of parseSSEStream(readerFromBytes(chunks), {
        fatalUtf8: true,
      })) {
        // consume
      }
    };
    await expect(consume()).rejects.toThrow("malformed SSE UTF-8");
  }
});

async function collect(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{ event: string; data: string }[]> {
  const out: { event: string; data: string }[] = [];
  for await (const ev of parseSSEStream(reader)) out.push(ev);
  return out;
}

/** Parse the JSON payload out of a single `event: <t>\ndata: <json>\n\n` block. */
function parseEventData(
  sse: string,
  eventType: string,
): Record<string, unknown> {
  const prefix = `event: ${eventType}\ndata: `;
  const idx = sse.indexOf(prefix);
  if (idx === -1) throw new Error(`event ${eventType} not found in: ${sse}`);
  const rest = sse.slice(idx + prefix.length);
  const end = rest.indexOf("\n\n");
  return JSON.parse(rest.slice(0, end === -1 ? undefined : end));
}

// ---------------------------------------------------------------------------
// formatSSEEvent
// ---------------------------------------------------------------------------

describe("formatSSEEvent", () => {
  test("formats a named SSE event", () => {
    expect(formatSSEEvent("ping", "{}")).toBe("event: ping\ndata: {}\n\n");
  });
});

// ---------------------------------------------------------------------------
// parseSSEStream
// ---------------------------------------------------------------------------

describe("parseSSEStream", () => {
  test("supports lone-CR separators and split UTF-8 code points", async () => {
    const encoded = new TextEncoder().encode("\uFEFFdata: café\r\r");
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const split = encoded.indexOf(0xc3) + 1;
          controller.enqueue(encoded.subarray(0, split));
          controller.enqueue(encoded.subarray(split));
          controller.close();
        },
      }),
    );
    if (!response.body) throw new Error("test response has no body");
    const events = [];
    for await (const event of parseSSEStream(response.body.getReader(), {
      fatalUtf8: true,
    })) {
      events.push(event);
    }
    expect(events).toEqual([{ event: "message", data: "café" }]);
  });
  test("bounds aggregate bytes across many individually-small frames", async () => {
    const response = new Response("data: 1\n\ndata: 2\n\ndata: 3\n\n");
    const body = response.body;
    if (!body) throw new Error("test response has no body");
    await expect(async () => {
      for await (const _event of parseSSEStream(body.getReader(), {
        maxTotalBytes: 16,
      })) {
        // consume
      }
    }).rejects.toThrow("SSE stream exceeded aggregate byte limit");
  });
  test("does not remeasure the whole remaining buffer for each frame", async () => {
    const frameCount = 2_000;
    const wire = Array.from(
      { length: frameCount },
      (_, index) => `data: ${index}\r\n\r\n`,
    ).join("");
    const response = new Response(wire);
    if (!response.body) throw new Error("test response has no body");
    const reader = response.body.getReader();
    const byteLength = vi.spyOn(Buffer, "byteLength");
    try {
      let seen = 0;
      for await (const event of parseSSEStream(reader)) {
        expect(event.data).toBe(String(seen));
        seen++;
      }
      expect(seen).toBe(frameCount);
      const measuredStrings = byteLength.mock.calls
        .map(([value]) => value)
        .filter((value): value is string => typeof value === "string");
      expect(
        Math.max(...measuredStrings.map((value) => value.length)),
      ).toBeLessThan(32);
    } finally {
      byteLength.mockRestore();
    }
  });
  test("parses named events, multi-data lines, comments, and the default event", async () => {
    const sse =
      'event: message_start\ndata: {"a":1}\n\n' +
      // No `event:` line → default "message"; comment line ignored; data joined.
      ": this is a comment\ndata: line1\ndata: line2\n\n" +
      "event: message_stop\ndata: {}\n\n";

    const events = await collect(readerFromChunks([sse]));
    expect(events).toEqual([
      { event: "message_start", data: '{"a":1}' },
      { event: "message", data: "line1\nline2" },
      { event: "message_stop", data: "{}" },
    ]);
  });

  test("handles events split across chunk boundaries", async () => {
    const events = await collect(
      readerFromChunks(["event: message_start\nda", 'ta: {"x":1}\n\n']),
    );
    expect(events).toEqual([{ event: "message_start", data: '{"x":1}' }]);
  });

  test("bounds a byte-fragmented unterminated event without prefix rescans", async () => {
    const wire = `data: ${"x".repeat(64 * 1024)}`;
    const reader = readerFromChunks(Array.from(wire));
    await expect(async () => {
      for await (const _event of parseSSEStream(reader, {
        maxEventBytes: 32 * 1024,
      })) {
        // No complete event should be yielded.
      }
    }).rejects.toThrow("SSE event exceeded 32768 byte limit");
  });

  test.each([1, 2, 3])(
    "handles a CRLF delimiter split after byte %i",
    async (split) => {
      const prefix = 'event: message_start\r\ndata: {"x":1}';
      const delimiter = "\r\n\r\n";
      const events = await collect(
        readerFromChunks([
          prefix + delimiter.slice(0, split),
          delimiter.slice(split),
        ]),
      );
      expect(events).toEqual([{ event: "message_start", data: '{"x":1}' }]);
    },
  );

  test("flushes a trailing CRLF block without a final blank line", async () => {
    const events = await collect(
      readerFromChunks(["event: message_stop\r\ndata: {}"]),
    );
    expect(events).toEqual([{ event: "message_stop", data: "{}" }]);
  });

  test("flushes a trailing block that lacks a final blank line", async () => {
    const events = await collect(
      readerFromChunks(["event: message_stop\ndata: {}"]),
    );
    expect(events).toEqual([{ event: "message_stop", data: "{}" }]);
  });

  test("rejects an oversized event before a blank-line delimiter arrives", async () => {
    const reader = readerFromChunks([
      "event: response.output_item.added\ndata: ",
      "x".repeat(64),
    ]);
    const collectBounded = async (): Promise<void> => {
      for await (const _event of parseSSEStream(reader, {
        maxEventBytes: 32,
      })) {
        // No complete event should be yielded.
      }
    };

    await expect(collectBounded()).rejects.toThrow(
      "SSE event exceeded 32 byte limit",
    );
  });

  test("accepts exact event/comment byte boundaries and rejects the first extra byte", async () => {
    const consume = async (wire: string, maxEventBytes: number) => {
      const events = [];
      for await (const event of parseSSEStream(readerFromChunks([wire]), {
        maxEventBytes,
      })) {
        events.push(event);
      }
      return events;
    };
    await expect(consume("data: x\n\n", 7)).resolves.toHaveLength(1);
    await expect(consume("data: x\n\n", 6)).rejects.toThrow(
      "SSE event exceeded 6 byte limit",
    );
    await expect(consume(": abc\n\n", 5)).resolves.toHaveLength(0);
    await expect(consume(": abc\n\n", 4)).rejects.toThrow(
      "SSE event exceeded 4 byte limit",
    );
  });

  test("accepts exact aggregate/frame boundaries and rejects first illegal byte/frame", async () => {
    const consume = async (
      wire: string,
      opts: Parameters<typeof parseSSEStream>[1],
    ) => {
      for await (const _event of parseSSEStream(
        readerFromChunks([wire]),
        opts,
      )) {
        // consume
      }
    };
    await expect(
      consume("data: x\n\n", { maxTotalBytes: 9, maxFrames: 1 }),
    ).resolves.toBeUndefined();
    await expect(consume("data: x\n\n", { maxTotalBytes: 8 })).rejects.toThrow(
      "SSE stream exceeded aggregate byte limit",
    );
    await expect(
      consume("data: x\n\ndata: y\n\n", { maxFrames: 1 }),
    ).rejects.toThrow("SSE stream exceeded 1 frame limit");
  });

  test("excludes one split UTF-8 BOM from event and aggregate byte limits", async () => {
    const bom = [
      new Uint8Array([0xef]),
      new Uint8Array([0xbb]),
      new Uint8Array([0xbf]),
    ];
    const wire = new TextEncoder().encode("data: x\n\n");
    const consume = async (payload: Uint8Array, maxEventBytes: number) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array());
          for (const chunk of bom) controller.enqueue(chunk);
          controller.enqueue(payload);
          controller.close();
        },
      });
      const events = [];
      for await (const event of parseSSEStream(stream.getReader(), {
        maxEventBytes,
        maxTotalBytes: payload.byteLength,
        fatalUtf8: true,
      })) {
        events.push(event);
      }
      return events;
    };
    await expect(consume(wire, 7)).resolves.toEqual([
      { event: "message", data: "x" },
    ]);
    await expect(
      consume(new TextEncoder().encode("data: xx\n\n"), 7),
    ).rejects.toThrow("SSE event exceeded 7 byte limit");
  });

  test("applies the event limit per frame, independent of transport chunking", async () => {
    const wire = Array.from({ length: 10 }, (_, i) => `data: ${i}\n\n`).join(
      "",
    );
    const read = async (chunks: string[]) => {
      const events: string[] = [];
      for await (const event of parseSSEStream(readerFromChunks(chunks), {
        maxEventBytes: 16,
      })) {
        events.push(event.data);
      }
      return events;
    };

    await expect(read([wire])).resolves.toEqual(
      Array.from({ length: 10 }, (_, i) => String(i)),
    );
    await expect(read(Array.from(wire))).resolves.toEqual(
      Array.from({ length: 10 }, (_, i) => String(i)),
    );
  });

  test("rejects an unlimited sequence of small frames", async () => {
    const reader = readerFromChunks([
      "data: one\n\ndata: two\n\ndata: three\n\n",
    ]);
    const collectBounded = async (): Promise<void> => {
      for await (const _event of parseSSEStream(reader, { maxFrames: 2 })) {
        // Consume until the frame cap rejects.
      }
    };
    await expect(collectBounded()).rejects.toThrow(
      "SSE stream exceeded 2 frame limit",
    );
  });

  test("counts blank, comment-only, and yielded event frames toward the limit", async () => {
    const reader = readerFromChunks([
      "\n\n" +
        ": heartbeat\n\n" +
        'event: ping\ndata: {"type":"ping"}\n\n' +
        "\n\n",
    ]);
    const consume = async (): Promise<void> => {
      for await (const _event of parseSSEStream(reader, { maxFrames: 3 })) {
        // The fourth delimiter is blank but must still consume frame budget.
      }
    };

    await expect(consume()).rejects.toThrow(
      "SSE stream exceeded 3 frame limit",
    );
  });

  test("rejects a stalled stream after its inactivity deadline", async () => {
    vi.useFakeTimers();
    const reader = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => {});
      },
    }).getReader();
    const collectBounded = async (): Promise<void> => {
      for await (const _event of parseSSEStream(reader, {
        inactivityMs: 100,
      })) {
        // No frames arrive.
      }
    };
    try {
      const pending = collectBounded();
      const assertion = expect(pending).rejects.toThrow(
        "SSE stream inactivity deadline exceeded",
      );
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
    } finally {
      vi.useRealTimers();
      void reader.cancel();
    }
  });
});

// ---------------------------------------------------------------------------
// createStreamAccumulator
// ---------------------------------------------------------------------------

describe("createStreamAccumulator", () => {
  test("accumulates a text response across the full lifecycle", () => {
    const acc = createStreamAccumulator();
    expect(acc.isDone()).toBe(false);

    acc.processEvent(
      "message_start",
      JSON.stringify({
        type: "message_start",
        message: {
          id: "msg_1",
          model: "claude-x",
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      }),
    );
    acc.processEvent(
      "content_block_start",
      JSON.stringify({ index: 0, content_block: { type: "text", text: "" } }),
    );
    acc.processEvent(
      "content_block_delta",
      JSON.stringify({
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      }),
    );
    acc.processEvent(
      "content_block_delta",
      JSON.stringify({
        index: 0,
        delta: { type: "text_delta", text: " world" },
      }),
    );
    acc.processEvent("content_block_stop", JSON.stringify({ index: 0 }));
    acc.processEvent(
      "message_delta",
      JSON.stringify({
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 5 },
      }),
    );
    const forwarded = acc.processEvent(
      "message_stop",
      JSON.stringify({ type: "message_stop" }),
    );

    expect(forwarded).toBe(
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
    expect(acc.isDone()).toBe(true);

    const resp = acc.getResponse();
    expect(resp.id).toBe("msg_1");
    expect(resp.model).toBe("claude-x");
    expect(resp.stopReason).toBe("end_turn");
    expect(resp.content).toEqual([{ type: "text", text: "Hello world" }]);
    expect(resp.usage?.inputTokens).toBe(10);
    expect(resp.usage?.outputTokens).toBe(5);
  });

  test("accumulates a tool_use block with parsed input JSON", () => {
    const acc = createStreamAccumulator();
    acc.processEvent(
      "message_start",
      JSON.stringify({
        message: {
          id: "m",
          model: "x",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
    );
    acc.processEvent(
      "content_block_start",
      JSON.stringify({
        index: 0,
        content_block: { type: "tool_use", id: "tool_1", name: "bash" },
      }),
    );
    acc.processEvent(
      "content_block_delta",
      JSON.stringify({
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"cmd":' },
      }),
    );
    acc.processEvent(
      "content_block_delta",
      JSON.stringify({
        index: 0,
        delta: { type: "input_json_delta", partial_json: '"ls"}' },
      }),
    );
    acc.processEvent("content_block_stop", JSON.stringify({ index: 0 }));

    const resp = acc.getResponse();
    expect(resp.content).toEqual([
      { type: "tool_use", id: "tool_1", name: "bash", input: { cmd: "ls" } },
    ]);
  });

  test("forwards events with invalid JSON verbatim", () => {
    const acc = createStreamAccumulator();
    expect(acc.processEvent("ping", "not json")).toBe(
      "event: ping\ndata: not json\n\n",
    );
  });

  test("scaleClientUsage scales forwarded usage but not internal accumulation", () => {
    const acc = createStreamAccumulator({ scaleClientUsage: true });
    const bigInput = 10_000_000;
    const forwarded = acc.processEvent(
      "message_start",
      JSON.stringify({
        type: "message_start",
        message: {
          id: "m",
          model: "x",
          usage: { input_tokens: bigInput, output_tokens: 1 },
        },
      }),
    );

    // Forwarded (client-facing) usage is scaled down below the real value.
    const data = parseEventData(forwarded, "message_start");
    const msg = data.message as { usage: { input_tokens: number } };
    expect(msg.usage.input_tokens).toBeLessThan(bigInput);

    // Internal accumulation keeps the real (unscaled) token count.
    expect(acc.getResponse().usage?.inputTokens).toBe(bigInput);
  });

  test("scaleClientUsage scales ALL fields in the terminal message_delta", () => {
    // Anthropic's terminal message_delta carries the full cumulative usage
    // (input + cache), not just output_tokens. If only output_tokens is scaled,
    // the client's last-write-wins usage is overwritten with the real total and
    // the meter spoof is defeated. (Regression guard for the message_delta leak.)
    const acc = createStreamAccumulator({ scaleClientUsage: true });
    const bigCacheRead = 10_000_000;

    acc.processEvent(
      "message_start",
      JSON.stringify({
        type: "message_start",
        message: {
          id: "m",
          model: "x",
          usage: {
            input_tokens: 5,
            output_tokens: 1,
            cache_read_input_tokens: bigCacheRead,
            cache_creation_input_tokens: 0,
          },
        },
      }),
    );

    const forwarded = acc.processEvent(
      "message_delta",
      JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: {
          input_tokens: 5,
          output_tokens: 500,
          cache_read_input_tokens: bigCacheRead,
          cache_creation_input_tokens: 0,
        },
      }),
    );

    const usage = parseEventData(forwarded, "message_delta").usage as Record<
      string,
      number
    >;
    // The leaked field must be scaled down, not passed through unchanged.
    expect(usage.cache_read_input_tokens).toBeLessThan(bigCacheRead);
    const clientTotal =
      usage.input_tokens +
      usage.output_tokens +
      usage.cache_read_input_tokens +
      usage.cache_creation_input_tokens;
    expect(clientTotal).toBeLessThanOrEqual(DEFAULT_MAX_REPORTED_USAGE);

    // Internal accumulation still reflects the real (unscaled) cache read.
    expect(acc.getResponse().usage?.cacheReadInputTokens).toBe(bigCacheRead);
  });

  test("maxReportedUsage cap is per-model (1M not throttled to 200K)", () => {
    const cap1M = maxReportedUsageForModel(1_000_000, 64_000); // 870_300
    const acc = createStreamAccumulator({
      scaleClientUsage: true,
      maxReportedUsage: cap1M,
    });
    const forwarded = acc.processEvent(
      "message_start",
      JSON.stringify({
        type: "message_start",
        message: {
          id: "m",
          model: "x",
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_read_input_tokens: 1_000_000,
            cache_creation_input_tokens: 0,
          },
        },
      }),
    );
    const usage = parseEventData(forwarded, "message_start").message as {
      usage: Record<string, number>;
    };
    // ~1M total scaled to the 1M cap (870_300), NOT the 200K cap (150_300).
    expect(usage.usage.cache_read_input_tokens).toBeGreaterThan(
      DEFAULT_MAX_REPORTED_USAGE,
    );
  });
});

// ---------------------------------------------------------------------------
// scaleMessageDeltaUsage
// ---------------------------------------------------------------------------

describe("scaleMessageDeltaUsage", () => {
  test("scales all cumulative fields the delta carries; total ≤ cap", () => {
    const out = scaleMessageDeltaUsage(
      {
        input_tokens: 5,
        output_tokens: 500,
        cache_read_input_tokens: 900_000,
        cache_creation_input_tokens: 100_000,
      },
      {
        inputTokens: 5,
        cacheReadInputTokens: 900_000,
        cacheCreationInputTokens: 100_000,
      },
      150_300,
    );
    const total =
      out.input_tokens +
      out.output_tokens +
      out.cache_read_input_tokens +
      out.cache_creation_input_tokens;
    expect(total).toBeLessThanOrEqual(150_300);
    expect(out.cache_read_input_tokens).toBeLessThan(900_000);
  });

  test("only scales output_tokens when the delta carries nothing else", () => {
    const out = scaleMessageDeltaUsage(
      { output_tokens: 500 },
      { inputTokens: 1_000_000, cacheReadInputTokens: 0 },
      150_300,
    );
    // input/cache keys must NOT be invented when the delta omits them.
    expect("input_tokens" in out).toBe(false);
    expect("cache_read_input_tokens" in out).toBe(false);
    expect(out.output_tokens).toBeLessThan(500);
  });

  test("no re-leak when message_start omitted a cache field the delta carries", () => {
    // The asymmetric case: the accumulated basis (from message_start) lacks
    // cache_read, but the terminal delta reports a huge cache_read. The delta's
    // own value must drive the scale basis — never fall back to the raw value.
    const out = scaleMessageDeltaUsage(
      {
        input_tokens: 5,
        output_tokens: 10,
        cache_read_input_tokens: 10_000_000,
      },
      { inputTokens: 5 }, // no cacheReadInputTokens — message_start didn't report it
      150_300,
    );
    const total =
      out.input_tokens + out.output_tokens + out.cache_read_input_tokens;
    expect(total).toBeLessThanOrEqual(150_300);
    expect(out.cache_read_input_tokens).toBeLessThan(10_000_000);
  });
});

// ---------------------------------------------------------------------------
// buildSSEMessageStart
// ---------------------------------------------------------------------------

describe("buildSSEMessageStart", () => {
  test("emits message_start with usage; output_tokens is forced to 1", () => {
    const resp: GatewayResponse = {
      id: "m",
      model: "x",
      content: [],
      stopReason: "end_turn",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 10,
        cacheCreationInputTokens: 20,
      },
    };
    const sse = buildSSEMessageStart(resp);
    expect(sse.startsWith("event: message_start\ndata: ")).toBe(true);

    const parsed = parseEventData(sse, "message_start");
    const message = parsed.message as { usage: Record<string, number> };
    expect(parsed.type).toBe("message_start");
    expect(message.usage.input_tokens).toBe(100);
    expect(message.usage.output_tokens).toBe(1);
    expect(message.usage.cache_read_input_tokens).toBe(10);
    expect(message.usage.cache_creation_input_tokens).toBe(20);
  });

  test("omits cache fields when absent from usage", () => {
    const resp: GatewayResponse = {
      id: "m",
      model: "x",
      content: [],
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 50 },
    };
    const message = parseEventData(buildSSEMessageStart(resp), "message_start")
      .message as { usage: Record<string, number> };
    expect("cache_read_input_tokens" in message.usage).toBe(false);
    expect("cache_creation_input_tokens" in message.usage).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildSSETextResponse + accumulateSSEResponse (round trip)
// ---------------------------------------------------------------------------

describe("buildSSETextResponse", () => {
  test("emits the full Anthropic lifecycle in order", () => {
    const sse = buildSSETextResponse("id_1", "claude-x", "Hi there", {
      inputTokens: 7,
      outputTokens: 3,
    });

    const order = [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ];
    let prev = -1;
    for (const ev of order) {
      const at = sse.indexOf(`event: ${ev}\n`);
      expect(at).toBeGreaterThan(prev);
      prev = at;
    }
    expect(sse).toContain('"text":"Hi there"');
    expect(sse).toContain('"output_tokens":3');
  });
});

describe("accumulateSSEResponse", () => {
  test("stops at message_stop without waiting for transport EOF", async () => {
    let cancelled = false;
    const sse = buildSSETextResponse("id_terminal", "claude-x", "done", {
      inputTokens: 1,
      outputTokens: 1,
    });
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse));
        },
        cancel() {
          cancelled = true;
          return new Promise(() => {});
        },
      }),
    );

    const resp = await accumulateSSEResponse(response, {
      stopAtTerminal: true,
      strict: true,
    });

    expect(resp.content).toEqual([{ type: "text", text: "done" }]);
    expect(cancelled).toBe(true);
    expect(response.body?.locked).toBe(false);
  });

  test("rejects EOF before message_stop in strict worker mode", async () => {
    const truncated = buildSSETextResponse(
      "id_truncated",
      "claude-x",
      "partial",
      { inputTokens: 1, outputTokens: 1 },
    ).replace('event: message_stop\ndata: {"type":"message_stop"}\n\n', "");

    await expect(
      accumulateSSEResponse(new Response(truncated), {
        stopAtTerminal: true,
        strict: true,
      }),
    ).rejects.toThrow("missing Anthropic message_stop terminal");
  });

  test("rejects an unterminated terminal frame in strict worker mode", async () => {
    await expect(
      accumulateSSEResponse(
        new Response('event: message_stop\ndata: {"type":"message_stop"}'),
        { stopAtTerminal: true, strict: true },
      ),
    ).rejects.toThrow("unterminated SSE event at EOF");
  });

  test("rejects malformed JSON before a valid terminal", async () => {
    await expect(
      accumulateSSEResponse(
        new Response(
          "event: content_block_delta\ndata: {not-json}\n\n" +
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ),
        { stopAtTerminal: true, strict: true },
      ),
    ).rejects.toThrow("malformed Anthropic stream event");
  });

  test("rejects orphan lifecycle events in strict worker mode", async () => {
    await expect(
      accumulateSSEResponse(
        new Response(
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"orphan"}}\n\n' +
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ),
        { stopAtTerminal: true, strict: true },
      ),
    ).rejects.toThrow("malformed Anthropic stream event");
  });

  test("rejects explicit upstream error events in strict worker mode", async () => {
    await expect(
      accumulateSSEResponse(
        new Response(
          'event: error\ndata: {"type":"error","error":{"message":"failed"}}\n\n',
        ),
        { stopAtTerminal: true, strict: true },
      ),
    ).rejects.toThrow("Anthropic stream error event");
  });

  test("rejects reused block indices and blocks after message_delta", async () => {
    const messageStart =
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"claude","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n';
    const block =
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n';
    const messageDelta =
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}\n\n';

    await expect(
      accumulateSSEResponse(
        new Response(messageStart + block + block + messageDelta),
        { stopAtTerminal: true, strict: true },
      ),
    ).rejects.toThrow("malformed Anthropic stream event");
    await expect(
      accumulateSSEResponse(new Response(messageStart + messageDelta + block), {
        stopAtTerminal: true,
        strict: true,
      }),
    ).rejects.toThrow("malformed Anthropic stream event");
  });

  test("rejects duplicate tool_use IDs across block indices", async () => {
    const event = (type: string, data: Record<string, unknown>) =>
      formatSSEEvent(type, JSON.stringify({ type, ...data }));
    const wire =
      buildSSEMessageStart({
        id: "duplicate-tool-id",
        model: "claude-x",
        content: [],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 0 },
      }) +
      event("content_block_start", {
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_shared",
          name: "a",
          input: {},
        },
      }) +
      event("content_block_stop", { index: 0 }) +
      event("content_block_start", {
        index: 1,
        content_block: {
          type: "tool_use",
          id: "toolu_shared",
          name: "b",
          input: {},
        },
      });

    await expect(
      accumulateSSEResponse(new Response(wire), {
        stopAtTerminal: true,
        strict: true,
      }),
    ).rejects.toThrow("malformed Anthropic stream event");
  });

  test("rejects empty and cross-type duplicate server tool identities", async () => {
    const event = (type: string, data: Record<string, unknown>) =>
      formatSSEEvent(type, JSON.stringify({ type, ...data }));
    const start = buildSSEMessageStart({
      id: "server-tool-identities",
      model: "claude-x",
      content: [],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 0 },
    });
    const serverTool = (index: number, id: string) =>
      event("content_block_start", {
        index,
        content_block: {
          type: "server_tool_use",
          id,
          name: "web_search",
          input: {},
        },
      });

    await expect(
      accumulateSSEResponse(new Response(start + serverTool(0, "")), {
        stopAtTerminal: true,
        strict: true,
      }),
    ).rejects.toThrow("malformed Anthropic stream event");

    const duplicate =
      start +
      event("content_block_start", {
        index: 0,
        content_block: {
          type: "tool_use",
          id: "tool-shared",
          name: "client_tool",
          input: {},
        },
      }) +
      event("content_block_stop", { index: 0 }) +
      serverTool(1, "tool-shared");
    await expect(
      accumulateSSEResponse(new Response(duplicate), {
        stopAtTerminal: true,
        strict: true,
      }),
    ).rejects.toThrow("malformed Anthropic stream event");
  });

  test("permits repeated deltas for one tool identity", async () => {
    const event = (type: string, data: Record<string, unknown>) =>
      formatSSEEvent(type, JSON.stringify({ type, ...data }));
    const wire =
      buildSSEMessageStart({
        id: "repeated-tool-deltas",
        model: "claude-x",
        content: [],
        stopReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 0 },
      }) +
      event("content_block_start", {
        index: 0,
        content_block: {
          type: "tool_use",
          id: "tool-repeat",
          name: "lookup",
          input: {},
        },
      }) +
      event("content_block_delta", {
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"a":' },
      }) +
      event("content_block_delta", {
        index: 0,
        delta: { type: "input_json_delta", partial_json: "1}" },
      }) +
      event("content_block_stop", { index: 0 }) +
      event("message_delta", {
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 1 },
      }) +
      event("message_stop", {});

    const result = await accumulateSSEResponse(new Response(wire), {
      stopAtTerminal: true,
      strict: true,
    });
    expect(result.content).toEqual([
      {
        type: "tool_use",
        id: "tool-repeat",
        name: "lookup",
        input: { a: 1 },
      },
    ]);
  });

  test.each([
    [
      "unknown event name",
      (wire: string) =>
        wire.replace(
          "event: message_start",
          'event: future_event\ndata: {"type":"future_event"}\n\nevent: message_start',
        ),
    ],
    [
      "unknown content block type",
      (wire: string) =>
        wire.replace(
          '"content_block":{"type":"text"',
          '"content_block":{"type":"future_block"',
        ),
    ],
    [
      "unknown delta type",
      (wire: string) =>
        wire.replace(
          '"delta":{"type":"text_delta","text":"done"}',
          '"delta":{"type":"future_delta","text":"done"}',
        ),
    ],
    [
      "incompatible delta type",
      (wire: string) =>
        wire.replace(
          '"delta":{"type":"text_delta","text":"done"}',
          '"delta":{"type":"input_json_delta","partial_json":"{}"}',
        ),
    ],
    [
      "malformed message id",
      (wire: string) => wire.replace('"id":"strict"', '"id":1'),
    ],
    [
      "malformed message content",
      (wire: string) => wire.replace('"content":[]', '"content":null'),
    ],
    [
      "negative message-start usage",
      (wire: string) => wire.replace('"input_tokens":1', '"input_tokens":-1'),
    ],
    [
      "infinite message-start usage",
      (wire: string) =>
        wire.replace('"input_tokens":1', '"input_tokens":1e309'),
    ],
    [
      "malformed message delta",
      (wire: string) =>
        wire.replace(
          '"delta":{"stop_reason":"end_turn","stop_sequence":null}',
          '"delta":null',
        ),
    ],
    [
      "negative message-delta usage",
      (wire: string) =>
        wire.replace(
          '"usage":{"output_tokens":1}}',
          '"usage":{"output_tokens":-1}}',
        ),
    ],
    [
      "invalid stop reason",
      (wire: string) =>
        wire.replace(
          '"stop_reason":"end_turn"',
          '"stop_reason":"future_reason"',
        ),
    ],
  ] as const)("rejects %s", async (_case, mutate) => {
    const valid = buildSSETextResponse("strict", "claude-x", "done", {
      inputTokens: 1,
      outputTokens: 1,
    });
    await expect(
      accumulateSSEResponse(new Response(mutate(valid)), {
        stopAtTerminal: true,
        strict: true,
      }),
    ).rejects.toThrow("malformed Anthropic stream event");
  });

  test("accepts official citation/server-tool/result/fallback block variants", async () => {
    const event = (type: string, data: Record<string, unknown>) =>
      formatSSEEvent(type, JSON.stringify({ type, ...data }));
    const start = buildSSEMessageStart({
      id: "official-variants",
      model: "claude-x",
      content: [],
      stopReason: "end_turn",
      usage: { inputTokens: 2, outputTokens: 0 },
    });
    const wire =
      start +
      event("content_block_start", {
        index: 0,
        content_block: { type: "text", text: "", citations: [] },
      }) +
      event("content_block_delta", {
        index: 0,
        delta: { type: "citations_delta", citation: { type: "page_location" } },
      }) +
      event("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text: "answer" },
      }) +
      event("content_block_stop", { index: 0 }) +
      event("content_block_start", {
        index: 1,
        content_block: {
          type: "server_tool_use",
          id: "srvtoolu_1",
          name: "web_search",
          input: {},
        },
      }) +
      event("content_block_delta", {
        index: 1,
        delta: { type: "input_json_delta", partial_json: "{}" },
      }) +
      event("content_block_stop", { index: 1 }) +
      event("content_block_start", {
        index: 2,
        content_block: {
          type: "web_search_tool_result",
          tool_use_id: "srvtoolu_1",
          content: [],
        },
      }) +
      event("content_block_stop", { index: 2 }) +
      event("content_block_start", {
        index: 3,
        content_block: { type: "fallback" },
      }) +
      event("content_block_stop", { index: 3 }) +
      event("message_delta", {
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 1,
          output_tokens_details: { thinking_tokens: 0 },
          server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 },
        },
      }) +
      event("message_stop", {});

    const result = await accumulateSSEResponse(new Response(wire), {
      stopAtTerminal: true,
      strict: true,
    });
    expect(result.content).toEqual([{ type: "text", text: "answer" }]);
  });

  test("normalizes Anthropic refusal to content_filter", async () => {
    const wire = buildSSETextResponse("refusal", "claude-x", "", {
      inputTokens: 1,
      outputTokens: 0,
    }).replace('"stop_reason":"end_turn"', '"stop_reason":"refusal"');

    const result = await accumulateSSEResponse(new Response(wire), {
      stopAtTerminal: true,
      strict: true,
    });
    expect(result.stopReason).toBe("content_filter");
  });

  test("accepts official nullable cumulative usage fields", async () => {
    const wire = buildSSETextResponse("nullable", "claude-x", "ok", {
      inputTokens: 1,
      outputTokens: 1,
    })
      .replace(
        '"input_tokens":1,"output_tokens":1',
        '"input_tokens":1,"output_tokens":1,"cache_read_input_tokens":null,"cache_creation_input_tokens":null',
      )
      .replace(
        '"usage":{"output_tokens":1}',
        '"usage":{"input_tokens":null,"cache_read_input_tokens":null,"cache_creation_input_tokens":null,"output_tokens":1,"output_tokens_details":null,"server_tool_use":null}',
      );

    await expect(
      accumulateSSEResponse(new Response(wire), {
        stopAtTerminal: true,
        strict: true,
      }),
    ).resolves.toMatchObject({ stopReason: "end_turn" });
  });

  test("accepts multiple cumulative message_delta events", async () => {
    const first = buildSSETextResponse("id_multi_delta", "claude-x", "done", {
      inputTokens: 1,
      outputTokens: 1,
    });
    const extraDelta =
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n';
    const stream = first.replace(
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      `${extraDelta}event: message_stop\ndata: {"type":"message_stop"}\n\n`,
    );
    expect(stream.match(/event: message_delta/g)).toHaveLength(2);

    const result = await accumulateSSEResponse(new Response(stream), {
      stopAtTerminal: true,
      strict: true,
    });
    expect(result.content).toEqual([{ type: "text", text: "done" }]);
  });

  test("round-trips a synthetic text response back into a GatewayResponse", async () => {
    const sse = buildSSETextResponse("id_1", "claude-x", "Round trip", {
      inputTokens: 7,
      outputTokens: 3,
    });
    const resp = await accumulateSSEResponse(new Response(sse));
    expect(resp.id).toBe("id_1");
    expect(resp.model).toBe("claude-x");
    expect(resp.content).toEqual([{ type: "text", text: "Round trip" }]);
    expect(resp.stopReason).toBe("end_turn");
    expect(resp.usage?.inputTokens).toBe(7);
    expect(resp.usage?.outputTokens).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// buildSSEResponse — full multi-block synthesis (text + tool_use)
// ---------------------------------------------------------------------------

describe("buildSSEResponse", () => {
  test("round-trips a text + tool_use response, preserving the tool call", async () => {
    const resp: GatewayResponse = {
      id: "msg_multi",
      model: "claude-x",
      content: [
        { type: "text", text: "Reading the file." },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "read",
          input: { path: "a.txt" },
        },
      ],
      stopReason: "tool_use",
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    };

    const sse = buildSSEResponse(resp);
    // Well-formed lifecycle.
    expect(sse).toContain("event: message_start");
    expect(sse).toContain("event: message_stop");

    const round = await accumulateSSEResponse(new Response(sse));
    expect(round.id).toBe("msg_multi");
    expect(round.stopReason).toBe("tool_use");
    // BOTH blocks survive — a text-only synthesis would have dropped the tool.
    expect(round.content).toEqual([
      { type: "text", text: "Reading the file." },
      {
        type: "tool_use",
        id: "toolu_1",
        name: "read",
        input: { path: "a.txt" },
      },
    ]);
  });

  test("emits a valid empty-content stream (no blocks)", async () => {
    const resp: GatewayResponse = {
      id: "msg_empty",
      model: "claude-x",
      content: [],
      stopReason: "end_turn",
      usage: {
        inputTokens: 3,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    };
    const round = await accumulateSSEResponse(
      new Response(buildSSEResponse(resp)),
    );
    expect(round.content).toEqual([]);
    expect(round.stopReason).toBe("end_turn");
  });

  test("maps internal content_filter back to Anthropic refusal on the wire", async () => {
    const sse = buildSSEResponse({
      id: "msg_refusal",
      model: "claude-x",
      content: [],
      stopReason: "content_filter",
      usage: { inputTokens: 1, outputTokens: 0 },
    });
    expect(sse).toContain('"stop_reason":"refusal"');
    const round = await accumulateSSEResponse(new Response(sse), {
      stopAtTerminal: true,
      strict: true,
    });
    expect(round.stopReason).toBe("content_filter");
  });
});
