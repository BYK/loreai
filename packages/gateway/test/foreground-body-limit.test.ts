import { describe, expect, test } from "vitest";
import {
  accumulateNonStreamResponse,
  readForegroundBody,
} from "../src/pipeline";

function chunkedResponse(chunks: number, chunkBytes: number): Response {
  const chunk = new Uint8Array(chunkBytes).fill(120);
  let sent = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < chunks) controller.enqueue(chunk);
        else controller.close();
      },
    }),
  );
}

describe("foreground response body limits", () => {
  test.each([
    [
      "anthropic",
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_stalled","type":"message","role":"assistant","model":"test","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
    ],
    [
      "openai",
      'data: {"id":"chatcmpl_stalled","model":"gpt-test","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
    ],
    [
      "openai-responses",
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_stalled","model":"gpt-test","status":"in_progress"}}\n\n',
    ],
    [
      "gemini",
      'data: {"responseId":"gemini-stalled","modelVersion":"gemini-test","candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"partial"}]}}]}\n\n',
    ],
  ] as const)(
    "aborts a stalled buffered %s body after a valid nonterminal event",
    async (protocol, wire) => {
      let cancelled = false;
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(wire));
          },
          pull() {
            return new Promise(() => {});
          },
          cancel() {
            cancelled = true;
            return new Promise<void>(() => {});
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
      const abort = new AbortController();
      const pending = accumulateNonStreamResponse(
        response,
        protocol,
        false,
        abort.signal,
      );
      await new Promise((resolve) => setImmediate(resolve));
      abort.abort(new DOMException("caller aborted", "AbortError"));
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(cancelled).toBe(true);
      expect(response.body?.locked).toBe(false);
    },
  );

  test("accepts the exact 4 MiB boundary", async () => {
    const body = await readForegroundBody(chunkedResponse(1024, 4096), false);
    expect(Buffer.byteLength(body)).toBe(4 * 1024 * 1024);
  });

  test("rejects the first byte beyond the 4 MiB boundary", async () => {
    const response = chunkedResponse(1024, 4096);
    const original = response.body;
    if (!original) throw new Error("test response has no body");
    const reader = original.getReader();
    let appended = false;
    const boundedPlusOne = new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (!done) controller.enqueue(value);
          else if (!appended) {
            appended = true;
            controller.enqueue(new Uint8Array([120]));
          } else controller.close();
        },
      }),
    );
    await expect(readForegroundBody(boundedPlusOne, false)).rejects.toThrow(
      "foreground response exceeded 4194304 byte limit",
    );
  });

  test("rejects invalid and split-invalid JSON UTF-8", async () => {
    for (const chunks of [
      [new Uint8Array([0xff])],
      [new Uint8Array([0xe2]), new Uint8Array([0x28, 0xa1])],
    ]) {
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
      );
      await expect(readForegroundBody(response, false)).rejects.toThrow(
        "malformed upstream response UTF-8",
      );
    }
  });

  test("caps diagnostic bodies instead of retaining the remainder", async () => {
    const body = await readForegroundBody(chunkedResponse(17, 4096), true);
    expect(Buffer.byteLength(body)).toBe(64 * 1024);
  });

  test("returns at the exact diagnostic cap without probing a stalled tail", async () => {
    let pulls = 0;
    let truncated = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(64 * 1024).fill(120));
        },
        pull() {
          pulls++;
          return new Promise(() => {});
        },
      }),
    );
    const body = await readForegroundBody(response, true, () => {
      truncated = true;
    });
    expect(Buffer.byteLength(body)).toBe(64 * 1024);
    expect(truncated).toBe(true);
    expect(pulls).toBeLessThanOrEqual(1);
    expect(response.body?.locked).toBe(false);
  });

  test("replacement-decodes malformed and boundary-split diagnostic UTF-8", async () => {
    expect(
      await readForegroundBody(new Response(new Uint8Array([0xff])), true),
    ).toBe("�");
    const bytes = new Uint8Array(64 * 1024 + 2).fill(120);
    bytes.set(new TextEncoder().encode("€"), 64 * 1024 - 1);
    const text = await readForegroundBody(new Response(bytes), true);
    expect(text.endsWith("�")).toBe(true);
  });

  test("buffered Codex accepts sparse events without output_index", async () => {
    const event = (type: string, data: Record<string, unknown>) =>
      `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    const response = new Response(
      event("response.output_item.added", {
        item: { type: "message", id: "msg-sparse" },
      }) +
        event("response.output_text.delta", {
          item_id: "msg-sparse",
          delta: "sparse",
        }) +
        event("response.completed", {
          response: { status: "completed" },
        }),
    );
    const result = await accumulateNonStreamResponse(
      response,
      "openai-responses",
      true,
    );
    expect(result.content).toEqual([{ type: "text", text: "sparse" }]);
  });

  test("buffered OpenAI retains usage-only frames after finish_reason", async () => {
    const response = new Response(
      'data: {"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":null}]}\n\n' +
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
        'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}\n\n' +
        "data: [DONE]\n\n",
    );
    const result = await accumulateNonStreamResponse(response, "openai");
    expect(result.usage).toMatchObject({ inputTokens: 7, outputTokens: 2 });
  });

  test("rejects malformed validated non-stream Responses incomplete details", async () => {
    const response = new Response(
      JSON.stringify({
        id: "resp_incomplete",
        model: "gpt-test",
        status: "incomplete",
        incomplete_details: { reason: 7 },
        output: [],
        usage: { input_tokens: 7, output_tokens: 2 },
      }),
      { headers: { "content-type": "application/json" } },
    );

    await expect(
      accumulateNonStreamResponse(
        response,
        "openai-responses",
        false,
        undefined,
        true,
      ),
    ).rejects.toThrow("upstream Responses request did not complete");
  });

  test("rejects provider-specific non-stream incomplete reasons for Codex", async () => {
    const response = new Response(
      JSON.stringify({
        id: "resp_codex_incomplete",
        model: "gpt-test",
        status: "incomplete",
        incomplete_details: { reason: "provider_specific" },
        output: [],
        usage: { input_tokens: 7, output_tokens: 2 },
      }),
      { headers: { "content-type": "application/json" } },
    );

    await expect(
      accumulateNonStreamResponse(
        response,
        "openai-responses",
        true,
        undefined,
        true,
      ),
    ).rejects.toThrow("upstream Responses request did not complete");
  });

  test("rejects in-progress items in a completed non-stream response", async () => {
    const response = new Response(
      JSON.stringify({
        id: "resp_in_progress_item",
        model: "gpt-test",
        status: "completed",
        output: [
          {
            type: "message",
            id: "msg_in_progress_item",
            role: "assistant",
            status: "in_progress",
            content: [{ type: "output_text", text: "partial" }],
          },
        ],
        usage: { input_tokens: 7, output_tokens: 2 },
      }),
      { headers: { "content-type": "application/json" } },
    );

    await expect(
      accumulateNonStreamResponse(response, "openai-responses"),
    ).rejects.toThrow("upstream Responses request did not complete");
  });

  test.each([
    {
      type: "reasoning",
      id: "rs_in_progress",
      status: "in_progress",
      summary: [],
    },
    {
      type: "item_reference",
      id: "ref_extra",
      content: [],
    },
    {
      type: "provider_specific_output",
      id: "unknown_output",
    },
  ])("rejects malformed non-stream output item $type", async (item) => {
    const response = new Response(
      JSON.stringify({
        id: "resp_malformed_item",
        model: "gpt-test",
        status: "completed",
        output: [item],
        usage: { input_tokens: 7, output_tokens: 2 },
      }),
      { headers: { "content-type": "application/json" } },
    );

    await expect(
      accumulateNonStreamResponse(response, "openai-responses"),
    ).rejects.toThrow("upstream Responses request did not complete");
  });

  test("rejects provider-specific incomplete reasons in sniffed Codex SSE", async () => {
    const wire =
      'event: response.incomplete\ndata: {"type":"response.incomplete","response":{"id":"resp_codex_sse_incomplete","status":"incomplete","incomplete_details":{"reason":"provider_specific"}}}\n\n';
    const response = new Response(wire, {
      headers: { "content-type": "text/event-stream" },
    });

    await expect(
      accumulateNonStreamResponse(response, "openai-responses", true),
    ).rejects.toThrow("malformed Responses terminal event");
  });
});
