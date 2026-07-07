/**
 * Tests for the pure Anthropic SSE helpers in `src/stream/anthropic.ts`:
 * formatSSEEvent, parseSSEStream, createStreamAccumulator,
 * buildSSEMessageStart, buildSSETextResponse, accumulateSSEResponse.
 *
 * (buildKeepaliveCompactionStream and createRecallAwareAccumulator are
 * covered by keepalive-compaction.test.ts / recall-stream.test.ts.)
 */
import { describe, test, expect } from "vitest";
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

  test("flushes a trailing block that lacks a final blank line", async () => {
    const events = await collect(
      readerFromChunks(["event: message_stop\ndata: {}"]),
    );
    expect(events).toEqual([{ event: "message_stop", data: "{}" }]);
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
});
