/**
 * Unit tests for `accumulateOpenAISSEStream` — the OpenAI Chat Completions SSE
 * reader used by the non-streaming conversation and worker paths when a provider
 * streams even for a stream:false request (the ChatGPT/Copilot backend,
 * DeepSeek). It must MERGE every chunk; a last-`data:`-line reader would drop all
 * but the final delta (the silent-empty bug this guards — LOREAI-GATEWAY finding).
 */
import { describe, test, expect } from "vitest";
import { accumulateOpenAISSEStream } from "../src/stream/openai";

/** Each entry is one SSE event; events are blank-line delimited per the spec. */
function sse(lines: string[]): Response {
  return new Response(`${lines.join("\n\n")}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

describe("accumulateOpenAISSEStream", () => {
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
});
