/**
 * Unit tests for `accumulateOpenAISSEStream` — the OpenAI Chat Completions SSE
 * reader used by the non-streaming conversation and worker paths when a provider
 * streams even for a stream:false request (the ChatGPT/Copilot backend,
 * DeepSeek). It must MERGE every chunk; a last-`data:`-line reader would drop all
 * but the final delta (the silent-empty bug this guards — LOREAI-GATEWAY finding).
 */
import { describe, test, expect } from "vitest";
import {
  accumulateOpenAISSEStream,
  translateAnthropicStreamToOpenAI,
} from "../src/stream/openai";
import { validateOpenAIUsage } from "../src/usage-validation";

/** Each entry is one SSE event; events are blank-line delimited per the spec. */
function sse(lines: string[]): Response {
  return new Response(`${lines.join("\n\n")}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

describe("accumulateOpenAISSEStream", () => {
  test("validates all choices while projecting only choice zero", async () => {
    const result = await accumulateOpenAISSEStream(
      sse([
        'data: {"choices":[{"index":0,"delta":{"content":"chosen","tool_calls":[{"index":0,"id":"call-zero","function":{"name":"zero","arguments":"{}"}}]},"finish_reason":"tool_calls"},{"index":1,"delta":{"content":"ignored","tool_calls":[{"index":0,"id":"call-one","function":{"name":"one","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}',
      ]),
      { strict: true, stopAtTerminal: true },
    );
    expect(result.content).toEqual([
      { type: "text", text: "chosen" },
      { type: "tool_use", id: "call-zero", name: "zero", input: {} },
    ]);
  });

  test("rejects duplicate tool identity in choice one", async () => {
    await expect(
      accumulateOpenAISSEStream(
        sse([
          'data: {"choices":[{"index":0,"delta":{"content":"chosen"},"finish_reason":"stop"},{"index":1,"delta":{"tool_calls":[{"index":0,"id":"duplicate","function":{"name":"one","arguments":"{}"}},{"index":1,"id":"duplicate","function":{"name":"two","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}',
        ]),
        { strict: true, stopAtTerminal: true },
      ),
    ).rejects.toThrow("malformed OpenAI stream event");
  });

  test("permits the same tool identity in independent choices", async () => {
    const result = await accumulateOpenAISSEStream(
      sse([
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"shared","function":{"name":"zero","arguments":"{}"}}]},"finish_reason":"tool_calls"},{"index":1,"delta":{"tool_calls":[{"index":0,"id":"shared","function":{"name":"one","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}',
      ]),
      { strict: true, stopAtTerminal: true },
    );
    expect(result.content).toEqual([
      { type: "tool_use", id: "shared", name: "zero", input: {} },
    ]);
  });

  test("retains trailing usage after finish_reason through [DONE]", async () => {
    const result = await accumulateOpenAISSEStream(
      sse([
        'data: {"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":null}]}',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}',
        "data: [DONE]",
      ]),
      { strict: true, stopAtTerminal: true, consumeUntilDone: true },
    );
    expect(result.content).toEqual([{ type: "text", text: "done" }]);
    expect(result.usage).toMatchObject({ inputTokens: 7, outputTokens: 2 });
  });

  test("consumeUntilDone rejects truncation after finish_reason", async () => {
    await expect(
      accumulateOpenAISSEStream(
        sse(['data: {"choices":[{"delta":{},"finish_reason":"stop"}]}']),
        { strict: true, stopAtTerminal: true, consumeUntilDone: true },
      ),
    ).rejects.toThrow("missing OpenAI [DONE] terminal");
  });
  test("stops at [DONE] without waiting for transport EOF", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"choices":[{"delta":{"content":"done"}}]}\n\n' +
                'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
                "data: [DONE]\n\n",
            ),
          );
        },
        cancel() {
          cancelled = true;
          return new Promise(() => {});
        },
      }),
    );

    const resp = await accumulateOpenAISSEStream(response, {
      stopAtTerminal: true,
      strict: true,
    });

    expect(resp.content).toEqual([{ type: "text", text: "done" }]);
    expect(cancelled).toBe(true);
    expect(response.body?.locked).toBe(false);
  });

  test("stops after finish_reason and preserves usage on its frame", async () => {
    let cancelled = false;
    const wire =
      'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\n';
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(wire));
        },
        cancel() {
          cancelled = true;
          return new Promise(() => {});
        },
      }),
    );

    const resp = await accumulateOpenAISSEStream(response, {
      stopAtTerminal: true,
      strict: true,
    });

    expect(resp.content).toEqual([{ type: "text", text: "done" }]);
    expect(resp.usage).toMatchObject({ inputTokens: 7, outputTokens: 2 });
    expect(cancelled).toBe(true);
  });

  test("rejects EOF before finish_reason in strict worker mode", async () => {
    await expect(
      accumulateOpenAISSEStream(
        sse(['data: {"choices":[{"delta":{"content":"partial"}}]}']),
        { stopAtTerminal: true, strict: true },
      ),
    ).rejects.toThrow("missing OpenAI finish_reason terminal");
  });

  test("rejects an unterminated terminal frame in strict worker mode", async () => {
    await expect(
      accumulateOpenAISSEStream(
        new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}'),
        { stopAtTerminal: true, strict: true },
      ),
    ).rejects.toThrow("unterminated SSE event at EOF");
  });

  test("rejects malformed JSON before a valid terminal", async () => {
    await expect(
      accumulateOpenAISSEStream(
        sse([
          "data: {not-json}",
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        ]),
        { stopAtTerminal: true, strict: true },
      ),
    ).rejects.toThrow("malformed OpenAI stream event");
  });

  test("rejects malformed consumed fields in strict worker mode", async () => {
    await expect(
      accumulateOpenAISSEStream(
        sse([
          'data: {"choices":[{"delta":{"content":42},"finish_reason":"stop"}]}',
        ]),
        { stopAtTerminal: true, strict: true },
      ),
    ).rejects.toThrow("malformed OpenAI stream event");
  });

  test("rejects cross-chunk response identity changes", async () => {
    await expect(
      accumulateOpenAISSEStream(
        sse([
          'data: {"id":"chat-a","model":"model-a","choices":[{"delta":{"content":"partial"}}]}',
          'data: {"id":"chat-b","model":"model-b","choices":[{"delta":{},"finish_reason":"stop"}]}',
        ]),
        { stopAtTerminal: true, strict: true },
      ),
    ).rejects.toThrow("malformed OpenAI stream event");
  });

  test.each([
    [
      "explicit to omitted",
      'data: {"choices":[{"index":1,"delta":{"content":"partial"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    ],
    [
      "omitted to a different explicit index",
      'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}',
      'data: {"choices":[{"index":1,"delta":{},"finish_reason":"stop"}]}',
    ],
  ])("rejects projected choice index transition: %s", async (_name, a, b) => {
    await expect(
      accumulateOpenAISSEStream(sse([a, b]), {
        strict: true,
        stopAtTerminal: true,
      }),
    ).rejects.toThrow("malformed OpenAI stream event");
  });

  test.each([
    [
      "omitted throughout",
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    ],
    [
      "same explicit index",
      'data: {"choices":[{"index":7,"delta":{"content":"ok"},"finish_reason":null}]}',
      'data: {"choices":[{"index":7,"delta":{},"finish_reason":"stop"}]}',
    ],
    [
      "omitted fallback then matching explicit zero",
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    ],
  ])("accepts stable projected choice index: %s", async (_name, a, b) => {
    const response = await accumulateOpenAISSEStream(sse([a, b]), {
      strict: true,
      stopAtTerminal: true,
    });
    expect(response.content).toEqual([{ type: "text", text: "ok" }]);
  });

  test("rejects negative tool indices and malformed usage", async () => {
    await expect(
      accumulateOpenAISSEStream(
        sse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":-1,"id":"call","function":{"name":"tool","arguments":"{}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":-5,"completion_tokens":1.5}}',
        ]),
        { stopAtTerminal: true, strict: true },
      ),
    ).rejects.toThrow("malformed OpenAI stream event");
  });

  test.each([
    [
      "cache sum overflow without prompt_tokens",
      {
        completion_tokens: 1,
        prompt_tokens_details: {
          cached_tokens: Number.MAX_SAFE_INTEGER,
          cache_write_tokens: 1,
        },
      },
    ],
    ["unsafe prompt usage", { prompt_tokens: Number.MAX_SAFE_INTEGER + 1 }],
    ["malformed detail container", { prompt_tokens_details: [] }],
  ])("rejects %s", async (_case, usage) => {
    await expect(
      accumulateOpenAISSEStream(
        sse([
          `data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage,
          })}`,
        ]),
        { stopAtTerminal: true, strict: true },
      ),
    ).rejects.toThrow("malformed OpenAI stream event");
  });

  test("rejects total_tokens that contradict prompt and completion totals", async () => {
    await expect(
      accumulateOpenAISSEStream(
        sse([
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":6}}',
        ]),
        { stopAtTerminal: true, strict: true },
      ),
    ).rejects.toThrow("malformed OpenAI stream event");
  });

  test("rejects total_tokens when a parent component is absent", async () => {
    await expect(
      accumulateOpenAISSEStream(
        sse([
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"total_tokens":2}}',
        ]),
        { stopAtTerminal: true, strict: true },
      ),
    ).rejects.toThrow("malformed OpenAI stream event");
  });

  test("validates every choice, not only choices[0]", async () => {
    await expect(
      accumulateOpenAISSEStream(
        sse([
          `data: ${JSON.stringify({
            choices: [
              { index: 0, delta: {}, finish_reason: "stop" },
              { index: 1, delta: { content: 42 }, finish_reason: null },
            ],
          })}`,
        ]),
        { stopAtTerminal: true, strict: true },
      ),
    ).rejects.toThrow("malformed OpenAI stream event");
  });

  test("accepts nullable optional usage detail containers", async () => {
    const result = await accumulateOpenAISSEStream(
      sse([
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"prompt_tokens_details":null,"completion_tokens_details":null}}',
      ]),
      { stopAtTerminal: true, strict: true },
    );
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
  });

  test("rejects tool identity changes across chunks", async () => {
    await expect(
      accumulateOpenAISSEStream(
        sse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-a","function":{"name":"tool-a","arguments":"{"}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-b","function":{"name":"tool-b","arguments":"}"}}]},"finish_reason":"tool_calls"}]}',
        ]),
        { stopAtTerminal: true, strict: true },
      ),
    ).rejects.toThrow("malformed OpenAI stream event");
  });

  test("rejects duplicate tool-call IDs across indices but permits repeated deltas", async () => {
    await expect(
      accumulateOpenAISSEStream(
        sse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-shared","function":{"name":"first","arguments":"{"}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-shared","function":{"arguments":"}"}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call-shared","function":{"name":"second","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}',
        ]),
        { stopAtTerminal: true, strict: true },
      ),
    ).rejects.toThrow("malformed OpenAI stream event");
  });

  test("permits repeated same-index tool identity deltas and accumulates arguments", async () => {
    const result = await accumulateOpenAISSEStream(
      sse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-repeat","function":{"name":"lookup","arguments":"{\\"a\\":"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-repeat","function":{"name":"lookup","arguments":"1}"}}]},"finish_reason":"tool_calls"}]}',
      ]),
      { stopAtTerminal: true, strict: true },
    );
    expect(result.content).toEqual([
      {
        type: "tool_use",
        id: "call-repeat",
        name: "lookup",
        input: { a: 1 },
      },
    ]);
  });

  test("rejects a terminal tool call without a non-empty ID", async () => {
    await expect(
      accumulateOpenAISSEStream(
        sse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"lookup","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}',
        ]),
        { stopAtTerminal: true, strict: true },
      ),
    ).rejects.toThrow("malformed OpenAI stream event");
  });

  test("rejects a stalled worker stream after its inactivity deadline", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
            ),
          );
        },
      }),
    );

    await expect(
      accumulateOpenAISSEStream(response, {
        stopAtTerminal: true,
        strict: true,
        inactivityMs: 10,
      }),
    ).rejects.toThrow("SSE stream inactivity deadline exceeded");
  });

  test("stops after finish_reason when no usage frame or EOF follows", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n',
            ),
          );
        },
        cancel() {
          cancelled = true;
          return new Promise(() => {});
        },
      }),
    );

    const resp = await accumulateOpenAISSEStream(response, {
      stopAtTerminal: true,
      strict: true,
    });

    expect(resp.content).toEqual([{ type: "text", text: "done" }]);
    expect(cancelled).toBe(true);
  });

  test("merges multi-chunk text deltas into the full string", async () => {
    const resp = await accumulateOpenAISSEStream(
      sse([
        'data: {"id":"c1","model":"gpt-4o-mini","choices":[{"delta":{"role":"assistant"}}]}',
        'data: {"id":"c1","choices":[{"delta":{"content":"Hel"}}]}',
        'data: {"id":"c1","choices":[{"delta":{"content":"lo"}}]}',
        'data: {"id":"c1","choices":[{"delta":{"content":", world"}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3}}',
        "data: [DONE]",
        "",
      ]),
    );
    expect(resp.content).toEqual([{ type: "text", text: "Hello, world" }]);
    expect(resp.stopReason).toBe("end_turn");
    expect(resp.model).toBe("gpt-4o-mini");
    expect(resp.usage?.inputTokens).toBe(7);
    expect(resp.usage?.outputTokens).toBe(3);
  });

  test("merges streamed tool-call argument fragments", async () => {
    const resp = await accumulateOpenAISSEStream(
      sse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":"{\\"ci"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\\":\\"Paris\\"}"}}]}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        "data: [DONE]",
        "",
      ]),
    );
    expect(resp.stopReason).toBe("tool_use");
    expect(resp.content).toEqual([
      {
        type: "tool_use",
        id: "call_1",
        name: "get_weather",
        input: { city: "Paris" },
      },
    ]);
  });

  test("skips the empty-choices content-filter preamble (Azure/Copilot)", async () => {
    // Copilot's first chunk is {"choices":[],"prompt_filter_results":[...]}.
    const resp = await accumulateOpenAISSEStream(
      sse([
        'data: {"choices":[],"prompt_filter_results":[{"prompt_index":0}]}',
        'data: {"choices":[{"delta":{"content":"ok"}}]}',
        "data: [DONE]",
        "",
      ]),
    );
    expect(resp.content).toEqual([{ type: "text", text: "ok" }]);
  });

  test("accumulates `reasoning` deltas into a thinking block when content is empty (#1334)", async () => {
    // MiniMax-M3 via OpenRouter streams its whole answer as `reasoning` deltas and
    // leaves `content` empty — previously dropped entirely → empty completion.
    const resp = await accumulateOpenAISSEStream(
      sse([
        'data: {"id":"c1","model":"minimax/minimax-m3","choices":[{"delta":{"reasoning":"the "}}]}',
        'data: {"choices":[{"delta":{"reasoning":"answer"}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        "data: [DONE]",
        "",
      ]),
    );
    expect(resp.content).toEqual([
      { type: "thinking", thinking: "the answer" },
    ]);
  });

  test("accumulates `reasoning_content` deltas (DeepSeek/Qwen shape)", async () => {
    const resp = await accumulateOpenAISSEStream(
      sse([
        'data: {"choices":[{"delta":{"reasoning_content":"deep "}}]}',
        'data: {"choices":[{"delta":{"reasoning_content":"seek"}}]}',
        "data: [DONE]",
        "",
      ]),
    );
    expect(resp.content).toEqual([{ type: "thinking", thinking: "deep seek" }]);
  });

  test("emits thinking BEFORE text when a model streams both", async () => {
    const resp = await accumulateOpenAISSEStream(
      sse([
        'data: {"choices":[{"delta":{"reasoning":"pondering"}}]}',
        'data: {"choices":[{"delta":{"content":"final answer"}}]}',
        "data: [DONE]",
        "",
      ]),
    );
    expect(resp.content).toEqual([
      { type: "thinking", thinking: "pondering" },
      { type: "text", text: "final answer" },
    ]);
  });

  test("no reasoning field → no thinking block (normal path unchanged)", async () => {
    const resp = await accumulateOpenAISSEStream(
      sse([
        'data: {"choices":[{"delta":{"content":"plain"}}]}',
        "data: [DONE]",
        "",
      ]),
    );
    expect(resp.content).toEqual([{ type: "text", text: "plain" }]);
  });
});

test("Anthropic translator completes at message_stop and cancels an open source", async () => {
  const event = (type: string, data: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const wire =
    event("message_start", {
      message: {
        id: "msg-open",
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }) +
    event("content_block_start", {
      index: 0,
      content_block: { type: "text", text: "" },
    }) +
    event("content_block_delta", {
      index: 0,
      delta: { type: "text_delta", text: "done" },
    }) +
    event("content_block_stop", { index: 0 }) +
    event("message_delta", {
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    }) +
    event("message_stop", {});
  let cancelled = false;
  const upstream = new Response(
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
  );
  const translated = translateAnthropicStreamToOpenAI(upstream);
  await new Promise((resolve) => setImmediate(resolve));
  const output = await translated.text();
  expect(output).toContain("done");
  expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
  expect(cancelled).toBe(true);
  expect(upstream.body?.locked).toBe(false);
});

test("Anthropic translator emits inclusive OpenAI cache usage", async () => {
  const event = (type: string, data: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const upstream = new Response(
    event("message_start", {
      message: {
        id: "msg_usage",
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 90,
          cache_creation_input_tokens: 20,
          output_tokens: 0,
        },
      },
    }) +
      event("message_delta", {
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      }) +
      event("message_stop", {}),
  );
  const output = await translateAnthropicStreamToOpenAI(upstream, {
    strict: true,
  }).text();
  const usage = output
    .split("\n")
    .filter((line) => line.startsWith("data: {") && line.includes('"usage"'))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
    .at(-1)?.usage as Record<string, unknown>;
  expect(usage).toEqual({
    prompt_tokens: 120,
    completion_tokens: 1,
    total_tokens: 121,
    prompt_tokens_details: { cached_tokens: 90, cache_write_tokens: 20 },
  });
  expect(() =>
    validateOpenAIUsage(usage, "invalid translated usage"),
  ).not.toThrow();
});
