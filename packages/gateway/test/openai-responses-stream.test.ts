/**
 * Tests for the OpenAI Responses API SSE stream accumulator.
 *
 * Covers:
 *  - Text output accumulation from delta events
 *  - Function call accumulation from arguments delta events
 *  - Usage extraction from response.completed
 *  - Stop reason mapping from status
 *  - Mixed text + function_call output
 */
import { describe, test, expect } from "vitest";
import {
  accumulateResponsesSSEStream,
  streamResponsesPassthrough,
} from "../src/stream/openai-responses";
import type { GatewayResponse } from "../src/translate/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake SSE Response from event/data pairs. */
function buildSSEResponse(
  events: Array<{ event: string; data: Record<string, unknown> }>,
): Response {
  const chunks = events.map(
    (e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`,
  );
  return new Response(chunks.join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

// ---------------------------------------------------------------------------
// accumulateResponsesSSEStream
// ---------------------------------------------------------------------------

describe("accumulateResponsesSSEStream", () => {
  test("accumulates text output from delta events", async () => {
    const response = buildSSEResponse([
      {
        event: "response.created",
        data: {
          type: "response.created",
          response: {
            id: "resp_abc",
            model: "gpt-4o",
            status: "in_progress",
          },
        },
      },
      {
        event: "response.output_item.added",
        data: {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", id: "msg_1", role: "assistant" },
        },
      },
      {
        event: "response.output_text.delta",
        data: {
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          delta: "Hello ",
        },
      },
      {
        event: "response.output_text.delta",
        data: {
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          delta: "world!",
        },
      },
      {
        event: "response.output_text.done",
        data: {
          type: "response.output_text.done",
          output_index: 0,
          content_index: 0,
          text: "Hello world!",
        },
      },
      {
        event: "response.completed",
        data: {
          type: "response.completed",
          response: {
            id: "resp_abc",
            model: "gpt-4o",
            status: "completed",
            usage: {
              input_tokens: 15,
              output_tokens: 5,
            },
          },
        },
      },
    ]);

    const result = await accumulateResponsesSSEStream(response);

    expect(result.id).toBe("resp_abc");
    expect(result.model).toBe("gpt-4o");
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0]).toEqual({ type: "text", text: "Hello world!" });
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage?.inputTokens).toBe(15);
    expect(result.usage?.outputTokens).toBe(5);
  });

  test("accumulates function call from arguments delta", async () => {
    const response = buildSSEResponse([
      {
        event: "response.created",
        data: {
          type: "response.created",
          response: { id: "resp_fc", model: "gpt-4o", status: "in_progress" },
        },
      },
      {
        event: "response.output_item.added",
        data: {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_1",
            call_id: "call_abc",
            name: "search",
            arguments: "",
          },
        },
      },
      {
        event: "response.function_call_arguments.delta",
        data: {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          delta: '{"query":',
        },
      },
      {
        event: "response.function_call_arguments.delta",
        data: {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          delta: '"cats"}',
        },
      },
      {
        event: "response.function_call_arguments.done",
        data: {
          type: "response.function_call_arguments.done",
          output_index: 0,
          arguments: '{"query":"cats"}',
        },
      },
      {
        event: "response.completed",
        data: {
          type: "response.completed",
          response: {
            id: "resp_fc",
            model: "gpt-4o",
            status: "completed",
            usage: { input_tokens: 20, output_tokens: 10 },
          },
        },
      },
    ]);

    const result = await accumulateResponsesSSEStream(response);

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("tool_use");
    const toolUse = result.content[0] as {
      type: "tool_use";
      id: string;
      name: string;
      input: unknown;
    };
    expect(toolUse.id).toBe("call_abc");
    expect(toolUse.name).toBe("search");
    expect(toolUse.input).toEqual({ query: "cats" });
    expect(result.stopReason).toBe("tool_use");
  });

  test("accumulates mixed text + function_call output", async () => {
    const response = buildSSEResponse([
      {
        event: "response.created",
        data: {
          type: "response.created",
          response: { id: "resp_mix", model: "gpt-4o", status: "in_progress" },
        },
      },
      {
        event: "response.output_item.added",
        data: {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", id: "msg_1", role: "assistant" },
        },
      },
      {
        event: "response.output_text.delta",
        data: {
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          delta: "Let me search.",
        },
      },
      {
        event: "response.output_text.done",
        data: {
          type: "response.output_text.done",
          output_index: 0,
          content_index: 0,
          text: "Let me search.",
        },
      },
      {
        event: "response.output_item.added",
        data: {
          type: "response.output_item.added",
          output_index: 1,
          item: {
            type: "function_call",
            id: "fc_2",
            call_id: "call_xyz",
            name: "web_search",
            arguments: "",
          },
        },
      },
      {
        event: "response.function_call_arguments.done",
        data: {
          type: "response.function_call_arguments.done",
          output_index: 1,
          arguments: '{"q":"test"}',
        },
      },
      {
        event: "response.completed",
        data: {
          type: "response.completed",
          response: {
            id: "resp_mix",
            model: "gpt-4o",
            status: "completed",
            usage: { input_tokens: 30, output_tokens: 15 },
          },
        },
      },
    ]);

    const result = await accumulateResponsesSSEStream(response);

    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual({
      type: "text",
      text: "Let me search.",
    });
    expect(result.content[1].type).toBe("tool_use");
    const toolUse = result.content[1] as {
      type: "tool_use";
      id: string;
      name: string;
      input: unknown;
    };
    expect(toolUse.id).toBe("call_xyz");
    expect(toolUse.name).toBe("web_search");
    expect(toolUse.input).toEqual({ q: "test" });
    expect(result.stopReason).toBe("tool_use");
  });

  test("maps incomplete status to max_tokens stop reason", async () => {
    const response = buildSSEResponse([
      {
        event: "response.created",
        data: {
          type: "response.created",
          response: { id: "resp_inc", model: "gpt-4o", status: "in_progress" },
        },
      },
      {
        event: "response.output_item.added",
        data: {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", id: "msg_1", role: "assistant" },
        },
      },
      {
        event: "response.output_text.done",
        data: {
          type: "response.output_text.done",
          output_index: 0,
          content_index: 0,
          text: "Truncated text...",
        },
      },
      {
        event: "response.completed",
        data: {
          type: "response.completed",
          response: {
            id: "resp_inc",
            model: "gpt-4o",
            status: "incomplete",
            usage: { input_tokens: 10, output_tokens: 4096 },
          },
        },
      },
    ]);

    const result = await accumulateResponsesSSEStream(response);

    expect(result.stopReason).toBe("max_tokens");
    expect(result.content[0]).toEqual({
      type: "text",
      text: "Truncated text...",
    });
  });

  test("handles empty stream gracefully", async () => {
    const response = new Response("", {
      headers: { "content-type": "text/event-stream" },
    });

    const result = await accumulateResponsesSSEStream(response);
    expect(result.content).toHaveLength(0);
    expect(result.id).toBe("");
    expect(result.model).toBe("");
  });

  test("handles [DONE] marker", async () => {
    const sse =
      `event: response.created\ndata: ${JSON.stringify({
        type: "response.created",
        response: { id: "resp_d", model: "gpt-4o", status: "in_progress" },
      })}\n\n` +
      `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_d",
          model: "gpt-4o",
          status: "completed",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      })}\n\n` +
      `data: [DONE]\n\n`;

    const response = new Response(sse, {
      headers: { "content-type": "text/event-stream" },
    });

    const result = await accumulateResponsesSSEStream(response);
    expect(result.id).toBe("resp_d");
    expect(result.model).toBe("gpt-4o");
  });

  test("prefers output_text.done over accumulated deltas", async () => {
    const response = buildSSEResponse([
      {
        event: "response.created",
        data: {
          type: "response.created",
          response: { id: "resp_t", model: "gpt-4o", status: "in_progress" },
        },
      },
      {
        event: "response.output_item.added",
        data: {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", id: "msg_1", role: "assistant" },
        },
      },
      {
        event: "response.output_text.delta",
        data: {
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          delta: "partial",
        },
      },
      {
        event: "response.output_text.done",
        data: {
          type: "response.output_text.done",
          output_index: 0,
          content_index: 0,
          text: "final complete text",
        },
      },
      {
        event: "response.completed",
        data: {
          type: "response.completed",
          response: {
            id: "resp_t",
            model: "gpt-4o",
            status: "completed",
            usage: { input_tokens: 5, output_tokens: 3 },
          },
        },
      },
    ]);

    const result = await accumulateResponsesSSEStream(response);
    expect(result.content[0]).toEqual({
      type: "text",
      text: "final complete text",
    });
  });

  test("captures prompt_tokens_details.cached_tokens as cacheReadInputTokens", async () => {
    const response = buildSSEResponse([
      {
        event: "response.created",
        data: {
          type: "response.created",
          response: {
            id: "resp_cache",
            model: "gpt-4o",
            status: "in_progress",
          },
        },
      },
      {
        event: "response.output_item.added",
        data: {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", id: "msg_1", role: "assistant" },
        },
      },
      {
        event: "response.output_text.done",
        data: {
          type: "response.output_text.done",
          output_index: 0,
          content_index: 0,
          text: "Hello",
        },
      },
      {
        event: "response.completed",
        data: {
          type: "response.completed",
          response: {
            id: "resp_cache",
            model: "gpt-4o",
            status: "completed",
            usage: {
              input_tokens: 100,
              output_tokens: 10,
              prompt_tokens_details: {
                cached_tokens: 80,
              },
            },
          },
        },
      },
    ]);

    const result = await accumulateResponsesSSEStream(response);
    // input_tokens (100) is inclusive of cached_tokens (80); the gateway's
    // disjoint convention subtracts it → 100 − 80 = 20.
    expect(result.usage?.inputTokens).toBe(20);
    expect(result.usage?.outputTokens).toBe(10);
    expect(result.usage?.cacheReadInputTokens).toBe(80);
  });

  test("cacheReadInputTokens is undefined when no cached_tokens in usage", async () => {
    const response = buildSSEResponse([
      {
        event: "response.created",
        data: {
          type: "response.created",
          response: { id: "resp_nc", model: "gpt-4o", status: "in_progress" },
        },
      },
      {
        event: "response.completed",
        data: {
          type: "response.completed",
          response: {
            id: "resp_nc",
            model: "gpt-4o",
            status: "completed",
            usage: { input_tokens: 50, output_tokens: 5 },
          },
        },
      },
    ]);

    const result = await accumulateResponsesSSEStream(response);
    expect(result.usage?.inputTokens).toBe(50);
    expect(result.usage?.cacheReadInputTokens).toBeUndefined();
  });

  test("finalizes on Codex `response.done` terminal event", async () => {
    const response = buildSSEResponse([
      {
        event: "response.output_text.delta",
        data: {
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          delta: "Hi",
        },
      },
      {
        // Codex (ChatGPT) emits `response.done` instead of `response.completed`.
        event: "response.done",
        data: {
          type: "response.done",
          response: {
            id: "resp_codex",
            model: "gpt-5.5",
            status: "completed",
            usage: { input_tokens: 30, output_tokens: 2 },
          },
        },
      },
    ]);

    const result = await accumulateResponsesSSEStream(response);
    expect(result.id).toBe("resp_codex");
    expect(result.model).toBe("gpt-5.5");
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage?.inputTokens).toBe(30);
    expect(result.usage?.outputTokens).toBe(2);
  });

  test("maps Codex `response.incomplete` to max_tokens stop reason", async () => {
    const response = buildSSEResponse([
      {
        event: "response.incomplete",
        data: {
          type: "response.incomplete",
          response: {
            id: "resp_inc",
            model: "gpt-5.5",
            status: "incomplete",
            usage: { input_tokens: 40, output_tokens: 100 },
          },
        },
      },
    ]);

    const result = await accumulateResponsesSSEStream(response);
    expect(result.stopReason).toBe("max_tokens");
    expect(result.usage?.outputTokens).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// streamResponsesPassthrough — true streaming (Responses → Responses client)
// ---------------------------------------------------------------------------

/**
 * Build a controllable upstream SSE Response whose events are released one at a
 * time via the returned `push`/`close` handles, so a test can assert that the
 * client sees early events BEFORE the upstream terminal event arrives.
 */
function controllableSSE(): {
  response: Response;
  push: (event: string, data: Record<string, unknown>) => void;
  close: () => void;
  error: (err: Error) => void;
} {
  const encoder = new TextEncoder();
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  return {
    response: new Response(body, {
      headers: { "content-type": "text/event-stream" },
    }),
    push: (event, data) =>
      ctrl.enqueue(
        encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
      ),
    close: () => ctrl.close(),
    error: (err) => ctrl.error(err),
  };
}

/** Read the client-facing SSE stream fully into a decoded string. */
async function drainToString(resp: Response): Promise<string> {
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (value) out += decoder.decode(value, { stream: true });
    if (done) break;
  }
  return out;
}

describe("streamResponsesPassthrough", () => {
  test("forwards events to the client BEFORE the upstream completes (true streaming)", async () => {
    const upstream = controllableSSE();
    let completed: GatewayResponse | null = null;

    const clientResp = streamResponsesPassthrough(upstream.response, (r) => {
      completed = r;
    });
    const reader = clientResp.body!.getReader();
    const decoder = new TextDecoder();

    // Push the opening events; the terminal event is deliberately withheld.
    upstream.push("response.created", {
      type: "response.created",
      response: {
        id: "resp_live",
        model: "gpt-5.6-sol",
        status: "in_progress",
      },
    });
    upstream.push("response.output_item.added", {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_1", role: "assistant" },
    });
    upstream.push("response.output_text.delta", {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: "streaming ",
    });

    // The client MUST be able to read those bytes now — while the upstream is
    // still open (no response.completed yet). This is the core anti-hang
    // property: a buffered accumulator would block here forever.
    const first = await reader.read();
    const firstText = decoder.decode(first.value);
    expect(firstText).toContain("response.created");
    expect(firstText).toContain("gpt-5.6-sol");

    // onComplete must NOT have fired yet — stream isn't done.
    expect(completed).toBeNull();

    // Now finish the upstream.
    upstream.push("response.output_text.done", {
      type: "response.output_text.done",
      output_index: 0,
      content_index: 0,
      text: "streaming done",
    });
    upstream.push("response.completed", {
      type: "response.completed",
      response: {
        id: "resp_live",
        model: "gpt-5.6-sol",
        status: "completed",
        usage: { input_tokens: 12, output_tokens: 3 },
      },
    });
    upstream.close();

    // Drain the rest.
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }

    // onComplete fired exactly once with the fully accumulated response.
    expect(completed).not.toBeNull();
    const done = completed as unknown as GatewayResponse;
    expect(done.id).toBe("resp_live");
    expect(done.model).toBe("gpt-5.6-sol");
    expect(done.content).toEqual([{ type: "text", text: "streaming done" }]);
    expect(done.usage?.inputTokens).toBe(12);
    expect(done.usage?.outputTokens).toBe(3);
    expect(done.stopReason).toBe("end_turn");
  });

  test("forwards every upstream event verbatim, preserving non-accumulated fields", async () => {
    const upstream = controllableSSE();
    const clientResp = streamResponsesPassthrough(upstream.response, () => {});

    // reasoning_summary events are not accumulated into GatewayResponse, but
    // MUST still reach the client byte-for-byte (a re-serialize from the
    // accumulator would drop them → codex reasoning UI breaks).
    upstream.push("response.reasoning_summary_text.delta", {
      type: "response.reasoning_summary_text.delta",
      output_index: 0,
      delta: "thinking about it",
    });
    upstream.push("response.completed", {
      type: "response.completed",
      response: {
        id: "resp_r",
        model: "gpt-5.6-sol",
        status: "completed",
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    });
    upstream.close();

    const out = await drainToString(clientResp);
    // Assert the WIRE FORM (named event line + data line), not just the string —
    // a bare `data:` (dropped `event:`) would still contain the type inside the
    // JSON payload, so `toContain("...delta")` alone is vacuous.
    expect(out).toContain(
      "event: response.reasoning_summary_text.delta\ndata:",
    );
    expect(out).toContain("thinking about it");
    expect(out).toContain("event: response.completed\ndata:");
  });

  test("does not forward untyped `message` frames or the [DONE] sentinel to the client", async () => {
    // Some Responses-compatible upstreams emit untyped `data:` lines (parsed as
    // event `message`) and a trailing `data: [DONE]`. Neither carries Responses
    // semantics; forwarding them would corrupt a genuine Responses wire stream.
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          encoder.encode(
            `event: response.created\ndata: ${JSON.stringify({
              type: "response.created",
              response: { id: "resp_u", model: "m", status: "in_progress" },
            })}\n\n`,
          ),
        );
        // Untyped data line → parsed as event "message".
        c.enqueue(encoder.encode(`data: {"stray":true}\n\n`));
        c.enqueue(
          encoder.encode(
            `event: response.completed\ndata: ${JSON.stringify({
              type: "response.completed",
              response: {
                id: "resp_u",
                model: "m",
                status: "completed",
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            })}\n\n`,
          ),
        );
        c.enqueue(encoder.encode(`data: [DONE]\n\n`));
        c.close();
      },
    });
    const upstreamResp = new Response(body, {
      headers: { "content-type": "text/event-stream" },
    });

    const clientResp = streamResponsesPassthrough(upstreamResp, () => {});
    const out = await drainToString(clientResp);

    expect(out).toContain("event: response.created");
    expect(out).toContain("event: response.completed");
    // The synthetic `message` frame and `[DONE]` must NOT be forwarded.
    expect(out).not.toContain("event: message");
    expect(out).not.toContain("[DONE]");
    expect(out).not.toContain("stray");
  });

  test("emits response.failed and still calls onComplete (exactly once) when the upstream errors mid-stream", async () => {
    const upstream = controllableSSE();
    let completed: GatewayResponse | null = null;
    let completeCalls = 0;
    const clientResp = streamResponsesPassthrough(upstream.response, (r) => {
      completeCalls++;
      completed = r;
    });

    upstream.push("response.created", {
      type: "response.created",
      response: { id: "resp_err", model: "gpt-5.6-sol", status: "in_progress" },
    });
    upstream.error(new Error("upstream exploded"));

    const out = await drainToString(clientResp);
    // Client is told the turn failed rather than hanging on a missing terminal.
    expect(out).toContain("response.failed");
    // onComplete still ran (so postResponse/cost tracking is not skipped)…
    expect(completed).not.toBeNull();
    // …and exactly once (the `completed` guard must not double-fire).
    expect(completeCalls).toBe(1);
  });

  test("cancels the upstream reader when the client disconnects", async () => {
    let upstreamCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        c.enqueue(
          enc.encode(
            `event: response.created\ndata: ${JSON.stringify({
              type: "response.created",
              response: { id: "r", model: "m", status: "in_progress" },
            })}\n\n`,
          ),
        );
        // never closes on its own
      },
      cancel() {
        upstreamCancelled = true;
      },
    });
    const upstreamResp = new Response(body, {
      headers: { "content-type": "text/event-stream" },
    });

    const clientResp = streamResponsesPassthrough(upstreamResp, () => {});
    const reader = clientResp.body!.getReader();
    await reader.read(); // pull the first event through
    await reader.cancel(); // client disconnects

    // Give the microtask queue a tick for the cancel to propagate.
    await new Promise((r) => setTimeout(r, 10));
    expect(upstreamCancelled).toBe(true);
  });
});
