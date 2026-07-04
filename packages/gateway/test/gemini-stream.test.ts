import { describe, test, expect } from "vitest";
import {
  accumulateGeminiSSEStream,
  translateAnthropicStreamToGemini,
} from "../src/stream/gemini";

function sse(frames: unknown[]): Response {
  const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Read the single aggregated `data:` JSON frame from a Gemini SSE Response. */
async function readGeminiSSEFrame(
  res: Response,
): Promise<Record<string, unknown>> {
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  if (!line) throw new Error(`no data frame in: ${text}`);
  return JSON.parse(line.slice(6)) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// accumulateGeminiSSEStream
// ---------------------------------------------------------------------------

describe("accumulateGeminiSSEStream", () => {
  test("concatenates text deltas across frames + final usage/finishReason", async () => {
    const res = sse([
      {
        candidates: [{ content: { role: "model", parts: [{ text: "Hel" }] } }],
      },
      { candidates: [{ content: { role: "model", parts: [{ text: "lo" }] } }] },
      {
        candidates: [
          { content: { role: "model", parts: [] }, finishReason: "STOP" },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
        modelVersion: "gemini-2.5-pro",
      },
    ]);
    const resp = await accumulateGeminiSSEStream(res);
    expect(resp.content).toEqual([{ type: "text", text: "Hello" }]);
    expect(resp.stopReason).toBe("end_turn");
    expect(resp.model).toBe("gemini-2.5-pro");
    expect(resp.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
  });

  test("functionCall frame → tool_use block + stopReason tool_use", async () => {
    const res = sse([
      {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ functionCall: { name: "f", args: { a: 1 } } }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      },
    ]);
    const resp = await accumulateGeminiSSEStream(res);
    expect(resp.content).toEqual([
      { type: "tool_use", id: "f", name: "f", input: { a: 1 } },
    ]);
    expect(resp.stopReason).toBe("tool_use");
  });

  test("cachedContentTokenCount → cacheReadInputTokens", async () => {
    const res = sse([
      {
        candidates: [
          { content: { parts: [{ text: "x" }] }, finishReason: "STOP" },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 1,
          cachedContentTokenCount: 6,
        },
      },
    ]);
    const resp = await accumulateGeminiSSEStream(res);
    expect(resp.usage?.cacheReadInputTokens).toBe(6);
  });

  test("thought deltas stay out of visible text (separate thinking block)", async () => {
    const res = sse([
      {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "reasoning", thought: true }],
            },
          },
        ],
      },
      {
        candidates: [
          { content: { role: "model", parts: [{ text: "answer" }] } },
        ],
      },
      {
        candidates: [
          { content: { role: "model", parts: [] }, finishReason: "STOP" },
        ],
      },
    ]);
    const resp = await accumulateGeminiSSEStream(res);
    expect(resp.content).toEqual([
      { type: "thinking", thinking: "reasoning" },
      { type: "text", text: "answer" },
    ]);
  });

  test("thoughtsTokenCount folded into outputTokens", async () => {
    const res = sse([
      {
        candidates: [
          { content: { parts: [{ text: "x" }] }, finishReason: "STOP" },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 2,
          thoughtsTokenCount: 40,
        },
      },
    ]);
    const resp = await accumulateGeminiSSEStream(res);
    expect(resp.usage).toEqual({ inputTokens: 10, outputTokens: 42 });
  });

  test("SAFETY finishReason preserved verbatim", async () => {
    const res = sse([
      {
        candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }],
      },
    ]);
    const resp = await accumulateGeminiSSEStream(res);
    expect(resp.stopReason).toBe("SAFETY");
  });
});

// ---------------------------------------------------------------------------
// translateAnthropicStreamToGemini
// ---------------------------------------------------------------------------

describe("translateAnthropicStreamToGemini", () => {
  function anthropicSSE(): Response {
    const events = [
      [
        "message_start",
        {
          type: "message_start",
          message: {
            id: "msg_1",
            model: "claude-x",
            role: "assistant",
            content: [],
            usage: { input_tokens: 3, output_tokens: 0 },
          },
        },
      ],
      [
        "content_block_start",
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hi there" },
        },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      [
        "message_delta",
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 2 },
        },
      ],
      ["message_stop", { type: "message_stop" }],
    ] as const;
    const body = events
      .map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`)
      .join("");
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  test("emits a Gemini SSE frame with the accumulated model-role content", async () => {
    const res = translateAnthropicStreamToGemini(anthropicSSE());
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const frame = await readGeminiSSEFrame(res);
    const candidates = frame.candidates as Array<Record<string, unknown>>;
    const content = candidates[0].content as Record<string, unknown>;
    expect(content.role).toBe("model");
    expect(content.parts).toEqual([{ text: "Hi there" }]);
    expect(candidates[0].finishReason).toBe("STOP");
    const um = frame.usageMetadata as Record<string, number>;
    expect(um.promptTokenCount).toBe(3);
    expect(um.candidatesTokenCount).toBe(2);
  });
});
