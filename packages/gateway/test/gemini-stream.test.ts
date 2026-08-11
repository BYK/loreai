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
  test("strict mode rejects ambiguous repeated same-name calls without IDs", async () => {
    await expect(
      accumulateGeminiSSEStream(
        sse([
          {
            candidates: [
              {
                content: {
                  parts: [
                    { functionCall: { name: "lookup", args: { a: 1 } } },
                    { functionCall: { name: "lookup", args: { a: 2 } } },
                  ],
                },
                finishReason: "STOP",
              },
            ],
          },
        ]),
        { strict: true, stopAtTerminal: true },
      ),
    ).rejects.toThrow("malformed Gemini stream event");
  });

  test("strict mode preserves independent same-name calls with distinct IDs", async () => {
    const response = await accumulateGeminiSSEStream(
      sse([
        {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      id: "call-a",
                      name: "lookup",
                      args: { a: 1 },
                    },
                  },
                  {
                    functionCall: {
                      id: "call-b",
                      name: "lookup",
                      args: { a: 2 },
                    },
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
        },
      ]),
      { strict: true, stopAtTerminal: true },
    );

    expect(response.content).toEqual([
      { type: "tool_use", id: "call-a", name: "lookup", input: { a: 1 } },
      { type: "tool_use", id: "call-b", name: "lookup", input: { a: 2 } },
    ]);
  });
  test("strict mode permits the same tool identity in independent candidates", async () => {
    const response = await accumulateGeminiSSEStream(
      sse([
        {
          candidates: [
            {
              index: 0,
              content: {
                parts: [
                  { functionCall: { id: "shared", name: "lookup", args: {} } },
                ],
              },
              finishReason: "STOP",
            },
            {
              index: 1,
              content: {
                parts: [
                  { functionCall: { id: "shared", name: "lookup", args: {} } },
                ],
              },
              finishReason: "STOP",
            },
          ],
        },
      ]),
      { strict: true, stopAtTerminal: true },
    );
    expect(response.content).toEqual([
      { type: "tool_use", id: "shared", name: "lookup", input: {} },
    ]);
  });
  test("stops at finishReason without waiting for transport EOF", async () => {
    let cancelled = false;
    const terminal = {
      candidates: [
        {
          content: { role: "model", parts: [{ text: "done" }] },
          finishReason: "STOP",
        },
      ],
    };
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(`data: ${JSON.stringify(terminal)}\n\n`),
          );
        },
        cancel() {
          cancelled = true;
          return new Promise(() => {});
        },
      }),
    );

    const resp = await accumulateGeminiSSEStream(response, {
      stopAtTerminal: true,
      strict: true,
    });

    expect(resp.content).toEqual([{ type: "text", text: "done" }]);
    expect(cancelled).toBe(true);
    expect(response.body?.locked).toBe(false);
  });

  test("takes cumulative usage from the finishReason frame and cancels transport tail", async () => {
    let cancelled = false;
    const terminal = {
      candidates: [
        {
          content: { parts: [{ text: "done" }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2 },
    };
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(`data: ${JSON.stringify(terminal)}\n\n`),
          );
        },
        pull() {
          return new Promise(() => {});
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    const result = await accumulateGeminiSSEStream(response, {
      strict: true,
      stopAtTerminal: true,
    });
    expect(result.usage).toMatchObject({ inputTokens: 7, outputTokens: 2 });
    expect(cancelled).toBe(true);
  });

  test("does not stop on FINISH_REASON_UNSPECIFIED", async () => {
    const res = sse([
      {
        candidates: [
          {
            content: { role: "model", parts: [{ text: "Hel" }] },
            finishReason: "FINISH_REASON_UNSPECIFIED",
          },
        ],
      },
      {
        candidates: [
          {
            content: { role: "model", parts: [{ text: "lo" }] },
            finishReason: "STOP",
          },
        ],
      },
    ]);

    const resp = await accumulateGeminiSSEStream(res, {
      stopAtTerminal: true,
      strict: true,
    });

    expect(resp.content).toEqual([{ type: "text", text: "Hello" }]);
  });

  test("rejects EOF before finishReason in strict worker mode", async () => {
    await expect(
      accumulateGeminiSSEStream(
        sse([{ candidates: [{ content: { parts: [{ text: "partial" }] } }] }]),
        { stopAtTerminal: true, strict: true },
      ),
    ).rejects.toThrow("missing Gemini finishReason terminal");
  });

  test("rejects an unterminated terminal frame in strict worker mode", async () => {
    const terminal = {
      candidates: [{ content: { parts: [] }, finishReason: "STOP" }],
    };
    await expect(
      accumulateGeminiSSEStream(
        new Response(`data: ${JSON.stringify(terminal)}`),
        { stopAtTerminal: true, strict: true },
      ),
    ).rejects.toThrow("unterminated SSE event at EOF");
  });

  test("rejects malformed JSON before a valid terminal", async () => {
    await expect(
      accumulateGeminiSSEStream(
        new Response(
          `data: {not-json}\n\ndata: ${JSON.stringify({
            candidates: [{ content: { parts: [] }, finishReason: "STOP" }],
          })}\n\n`,
        ),
        { stopAtTerminal: true, strict: true },
      ),
    ).rejects.toThrow("malformed Gemini stream event");
  });

  test("rejects malformed consumed part fields in strict worker mode", async () => {
    await expect(
      accumulateGeminiSSEStream(
        sse([
          {
            candidates: [
              { content: { parts: [{ text: 42 }] }, finishReason: "STOP" },
            ],
          },
        ]),
        { stopAtTerminal: true, strict: true },
      ),
    ).rejects.toThrow("malformed Gemini stream event");
  });

  test("rejects contradictory parts and malformed usage", async () => {
    await expect(
      accumulateGeminiSSEStream(
        sse([
          {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: "visible",
                      functionCall: { name: "tool", args: 7 },
                    },
                  ],
                },
                finishReason: "STOP",
              },
            ],
            usageMetadata: { promptTokenCount: -1 },
          },
        ]),
        { stopAtTerminal: true, strict: true },
      ),
    ).rejects.toThrow("malformed Gemini stream event");
  });

  test.each([
    [
      "candidates plus thoughts overflow",
      {
        promptTokenCount: 1,
        candidatesTokenCount: Number.MAX_SAFE_INTEGER,
        thoughtsTokenCount: 1,
      },
    ],
    [
      "cache exceeds prompt subset",
      { promptTokenCount: 1, cachedContentTokenCount: 2 },
    ],
    [
      "malformed modality details",
      { promptTokenCount: 1, promptTokensDetails: [null] },
    ],
  ])("rejects %s", async (_case, usageMetadata) => {
    await expect(
      accumulateGeminiSSEStream(
        sse([
          {
            candidates: [
              { content: { parts: [{ text: "x" }] }, finishReason: "STOP" },
            ],
            usageMetadata,
          },
        ]),
        { stopAtTerminal: true, strict: true },
      ),
    ).rejects.toThrow("malformed Gemini stream event");
  });

  test("validates every candidate while preserving first-candidate extraction", async () => {
    await expect(
      accumulateGeminiSSEStream(
        sse([
          {
            candidates: [
              { content: { parts: [{ text: "first" }] }, finishReason: "STOP" },
              { content: { parts: [null] }, index: 1 },
            ],
          },
        ]),
        { stopAtTerminal: true, strict: true },
      ),
    ).rejects.toThrow("malformed Gemini stream event");

    const result = await accumulateGeminiSSEStream(
      sse([
        {
          candidates: [
            { content: { parts: [{ text: "first" }] }, finishReason: "STOP" },
            { content: { parts: [{ text: "ignored" }] }, index: 1 },
          ],
        },
      ]),
      { stopAtTerminal: true, strict: true },
    );
    expect(result.content).toEqual([{ type: "text", text: "first" }]);
  });

  test("accepts nullable optional usage detail arrays", async () => {
    const result = await accumulateGeminiSSEStream(
      sse([
        {
          candidates: [
            { content: { parts: [{ text: "ok" }] }, finishReason: "STOP" },
          ],
          usageMetadata: {
            promptTokenCount: 1,
            candidatesTokenCount: 1,
            promptTokensDetails: null,
            candidatesTokensDetails: null,
          },
        },
      ]),
      { stopAtTerminal: true, strict: true },
    );
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
  });

  test("preserves a prompt-level native block reason", async () => {
    const result = await accumulateGeminiSSEStream(
      sse([{ promptFeedback: { blockReason: "SAFETY" } }]),
      { stopAtTerminal: true, strict: true },
    );

    expect(result.content).toEqual([]);
    expect(result.stopReason).toBe("SAFETY");
  });

  test("preserves a candidate-level native safety reason", async () => {
    const result = await accumulateGeminiSSEStream(
      sse([
        { candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }] },
      ]),
      { stopAtTerminal: true, strict: true },
    );

    expect(result.content).toEqual([]);
    expect(result.stopReason).toBe("SAFETY");
  });

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

  test("rejects totalTokenCount contradictory to prompt, candidates, thoughts, and tool tokens", async () => {
    await expect(
      accumulateGeminiSSEStream(
        sse([
          {
            candidates: [
              {
                content: { role: "model", parts: [{ text: "done" }] },
                finishReason: "STOP",
              },
            ],
            usageMetadata: {
              promptTokenCount: 2,
              candidatesTokenCount: 3,
              thoughtsTokenCount: 4,
              toolUsePromptTokenCount: 5,
              cachedContentTokenCount: 1,
              totalTokenCount: 15,
            },
          },
        ]),
        { strict: true, stopAtTerminal: true },
      ),
    ).rejects.toThrow("malformed Gemini stream event");
  });

  test("accepts exact Gemini totals without double-counting cached prompt tokens", async () => {
    const result = await accumulateGeminiSSEStream(
      sse([
        {
          candidates: [
            {
              content: { role: "model", parts: [{ text: "done" }] },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 100,
            cachedContentTokenCount: 80,
            candidatesTokenCount: 20,
            thoughtsTokenCount: 10,
            toolUsePromptTokenCount: 5,
            totalTokenCount: 135,
          },
        },
      ]),
      { strict: true, stopAtTerminal: true },
    );
    expect(result.usage).toMatchObject({
      inputTokens: 25,
      cacheReadInputTokens: 80,
      outputTokens: 30,
    });
  });

  test("counts no-cache Gemini tool-use prompt tokens exactly once", async () => {
    const result = await accumulateGeminiSSEStream(
      sse([
        {
          candidates: [
            { content: { parts: [{ text: "done" }] }, finishReason: "STOP" },
          ],
          usageMetadata: {
            promptTokenCount: 100,
            candidatesTokenCount: 20,
            toolUsePromptTokenCount: 5,
            totalTokenCount: 125,
          },
        },
      ]),
      { strict: true, stopAtTerminal: true },
    );
    expect(result.usage).toMatchObject({
      inputTokens: 105,
      outputTokens: 20,
    });
    expect(result.usage?.cacheReadInputTokens).toBeUndefined();
  });

  test("rejects totalTokenCount when a required parent count is absent", async () => {
    await expect(
      accumulateGeminiSSEStream(
        sse([
          {
            candidates: [{ content: { parts: [] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 2, totalTokenCount: 2 },
          },
        ]),
        { strict: true, stopAtTerminal: true },
      ),
    ).rejects.toThrow("malformed Gemini stream event");
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
