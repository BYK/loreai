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
import { describe, test, expect, vi } from "vitest";
import {
  accumulateResponsesSSEStream,
  streamResponsesPassthrough,
  translateAnthropicStreamToResponses,
} from "../src/stream/openai-responses";
import type { GatewayResponse } from "../src/translate/types";
import { validateResponsesUsage } from "../src/usage-validation";

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

  test.each([
    ["max_output_tokens", "max_tokens"],
    ["content_filter", "content_filter"],
  ])(
    "strict empty incomplete response maps %s without requiring output items",
    async (reason, stopReason) => {
      const response = buildSSEResponse([
        {
          event: "response.incomplete",
          data: {
            type: "response.incomplete",
            response: {
              id: "resp_empty_incomplete",
              status: "incomplete",
              incomplete_details: { reason },
            },
          },
        },
      ]);

      const result = await accumulateResponsesSSEStream(response, {
        validation: "public",
        stopAtTerminal: true,
      });

      expect(result.content).toEqual([]);
      expect(result.stopReason).toBe(stopReason);
    },
  );

  test.each([
    ["negative tokens", { input_tokens: -1, output_tokens: 0 }],
    [
      "cache overflow without input_tokens",
      {
        output_tokens: 0,
        input_tokens_details: {
          cached_tokens: Number.MAX_SAFE_INTEGER,
          cache_write_tokens: 1,
        },
      },
    ],
    [
      "malformed detail container",
      { input_tokens: 1, output_tokens: 0, input_tokens_details: [] },
    ],
    [
      "output detail overflow",
      {
        input_tokens: 1,
        output_tokens: Number.MAX_SAFE_INTEGER,
        output_tokens_details: {
          reasoning_tokens: Number.MAX_SAFE_INTEGER,
          audio_tokens: 1,
        },
      },
    ],
  ])("strict validation rejects %s", async (_case, usage) => {
    await expect(
      accumulateResponsesSSEStream(
        buildSSEResponse([
          {
            event: "response.completed",
            data: { response: { status: "completed", usage } },
          },
        ]),
        { validation: "public", stopAtTerminal: true },
      ),
    ).rejects.toThrow("malformed Responses usage");
  });

  test("strict validation accepts nullable optional usage details", async () => {
    const result = await accumulateResponsesSSEStream(
      buildSSEResponse([
        {
          event: "response.completed",
          data: {
            response: {
              status: "completed",
              output: [],
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                input_tokens_details: null,
                output_tokens_details: null,
              },
            },
          },
        },
      ]),
      { validation: "public", stopAtTerminal: true },
    );
    expect(result.usage).toMatchObject({ inputTokens: 1, outputTokens: 1 });
  });

  test("strict validation rejects contradictory Responses total_tokens", async () => {
    await expect(
      accumulateResponsesSSEStream(
        buildSSEResponse([
          {
            event: "response.completed",
            data: {
              response: {
                status: "completed",
                usage: {
                  input_tokens: 2,
                  output_tokens: 3,
                  total_tokens: 6,
                },
              },
            },
          },
        ]),
        { validation: "public", stopAtTerminal: true },
      ),
    ).rejects.toThrow("malformed Responses usage");
  });

  test("strict validation rejects totals with absent parent components", async () => {
    await expect(
      accumulateResponsesSSEStream(
        buildSSEResponse([
          {
            event: "response.completed",
            data: {
              response: {
                status: "completed",
                usage: { input_tokens: 2, total_tokens: 2 },
              },
            },
          },
        ]),
        { validation: "public", stopAtTerminal: true },
      ),
    ).rejects.toThrow("malformed Responses usage");
  });

  test.each([
    [
      "done-only item",
      [
        {
          event: "response.output_item.done",
          data: {
            output_index: 0,
            item: {
              type: "message",
              id: "msg_done_only",
              content: [{ type: "output_text", text: "done" }],
            },
          },
        },
        {
          event: "response.completed",
          data: { response: { status: "completed" } },
        },
      ],
      "malformed Responses stream event",
    ],
    [
      "added item without done",
      [
        {
          event: "response.output_item.added",
          data: {
            output_index: 0,
            item: { type: "message", id: "msg_not_done" },
          },
        },
        {
          event: "response.completed",
          data: { response: { status: "completed" } },
        },
      ],
      "malformed Responses terminal event",
    ],
    [
      "response.done without status",
      [
        {
          event: "response.done",
          data: { response: {} },
        },
      ],
      "missing Responses compatibility terminal status",
    ],
    [
      "response.completed without status",
      [
        {
          event: "response.completed",
          data: { response: {} },
        },
      ],
      "missing Responses compatibility terminal status",
    ],
    [
      "response.completed with empty status",
      [
        {
          event: "response.completed",
          data: { response: { status: "" } },
        },
      ],
      "missing Responses compatibility terminal status",
    ],
    [
      "response.incomplete without status",
      [
        {
          event: "response.incomplete",
          data: { response: {} },
        },
      ],
      "missing Responses compatibility terminal status",
    ],
    [
      "response.completed with incomplete status",
      [
        {
          event: "response.completed",
          data: {
            response: {
              status: "incomplete",
              incomplete_details: { reason: "max_output_tokens" },
            },
          },
        },
      ],
      "Responses terminal event/status mismatch",
    ],
    [
      "unknown incomplete reason",
      [
        {
          event: "response.incomplete",
          data: {
            response: {
              status: "incomplete",
              incomplete_details: { reason: "provider_specific" },
            },
          },
        },
      ],
      "malformed Responses terminal event",
    ],
  ] as const)(
    "public validation still rejects %s",
    async (_case, events, diagnostic) => {
      await expect(
        accumulateResponsesSSEStream(buildSSEResponse([...events]), {
          validation: "public",
          stopAtTerminal: true,
        }),
      ).rejects.toThrow(diagnostic);
    },
  );

  test("public validation accepts null incomplete_details", async () => {
    const result = await accumulateResponsesSSEStream(
      buildSSEResponse([
        {
          event: "response.incomplete",
          data: {
            response: {
              status: "incomplete",
              incomplete_details: null,
            },
          },
        },
      ]),
      { validation: "public", stopAtTerminal: true },
    );

    expect(result.stopReason).toBe("max_tokens");
  });

  test.each([
    ["string details", "invalid"],
    ["numeric details", 1],
    ["array details", []],
    ["boolean details", true],
    ["non-string reason", { reason: 1 }],
  ])("public validation rejects %s", async (_case, incompleteDetails) => {
    await expect(
      accumulateResponsesSSEStream(
        buildSSEResponse([
          {
            event: "response.incomplete",
            data: {
              response: {
                status: "incomplete",
                incomplete_details: incompleteDetails,
              },
            },
          },
        ]),
        { validation: "public", stopAtTerminal: true },
      ),
    ).rejects.toThrow("malformed Responses terminal event");
  });

  test("public validation rejects duplicate item IDs across output indices", async () => {
    await expect(
      accumulateResponsesSSEStream(
        buildSSEResponse([
          {
            event: "response.output_item.added",
            data: {
              output_index: 0,
              item: { type: "message", id: "msg_duplicate_global" },
            },
          },
          {
            event: "response.output_item.added",
            data: {
              output_index: 1,
              item: { type: "message", id: "msg_duplicate_global" },
            },
          },
        ]),
        { validation: "public", stopAtTerminal: true },
      ),
    ).rejects.toThrow("malformed Responses stream event");
  });

  test("public validation rejects duplicate effective function call IDs", async () => {
    await expect(
      accumulateResponsesSSEStream(
        buildSSEResponse([
          {
            event: "response.output_item.added",
            data: {
              output_index: 0,
              item: {
                type: "function_call",
                id: "fc_first",
                call_id: "call_duplicate",
                name: "first",
                arguments: "",
              },
            },
          },
          {
            event: "response.output_item.added",
            data: {
              output_index: 1,
              item: {
                type: "function_call",
                id: "fc_second",
                call_id: "call_duplicate",
                name: "second",
                arguments: "",
              },
            },
          },
        ]),
        { validation: "public", stopAtTerminal: true },
      ),
    ).rejects.toThrow("malformed Responses stream event");
  });

  test("Codex rejects duplicate effective call IDs across distinct items", async () => {
    await expect(
      accumulateResponsesSSEStream(
        buildSSEResponse([
          {
            event: "response.output_item.added",
            data: {
              item: {
                type: "function_call",
                id: "fc_codex_first",
                call_id: "",
                name: "",
                arguments: "",
              },
            },
          },
          {
            event: "response.output_item.added",
            data: {
              item: {
                type: "function_call",
                id: "fc_codex_second",
                call_id: "",
                name: "",
                arguments: "",
              },
            },
          },
          {
            event: "response.output_item.done",
            data: {
              item: {
                type: "function_call",
                id: "fc_codex_first",
                call_id: "call_codex_shared",
                name: "first",
                arguments: "{}",
              },
            },
          },
          {
            event: "response.output_item.done",
            data: {
              item: {
                type: "function_call",
                id: "fc_codex_second",
                call_id: "call_codex_shared",
                name: "second",
                arguments: "{}",
              },
            },
          },
        ]),
        { validation: "codex", stopAtTerminal: true },
      ),
    ).rejects.toThrow("malformed Responses stream event");
  });

  test("Codex rejects fallback item-id/call-id collisions and missing effective IDs", async () => {
    await expect(
      accumulateResponsesSSEStream(
        buildSSEResponse([
          {
            event: "response.output_item.added",
            data: {
              item: {
                type: "function_call",
                id: "effective-shared",
                call_id: "",
                name: "fallback",
                arguments: "",
              },
            },
          },
          {
            event: "response.output_item.added",
            data: {
              item: {
                type: "function_call",
                id: "other-item",
                call_id: "effective-shared",
                name: "collision",
                arguments: "",
              },
            },
          },
        ]),
        { validation: "codex", stopAtTerminal: true },
      ),
    ).rejects.toThrow("malformed Responses stream event");

    await expect(
      accumulateResponsesSSEStream(
        buildSSEResponse([
          {
            event: "response.output_item.added",
            data: {
              item: {
                type: "function_call",
                call_id: "",
                name: "missing",
                arguments: "",
              },
            },
          },
          {
            event: "response.completed",
            data: { response: { status: "completed" } },
          },
        ]),
        { validation: "codex", stopAtTerminal: true },
      ),
    ).rejects.toThrow("malformed Responses stream event");
  });

  test("Codex permits repeated same-item call identity deltas", async () => {
    const result = await accumulateResponsesSSEStream(
      buildSSEResponse([
        {
          event: "response.output_item.added",
          data: {
            item: {
              type: "function_call",
              id: "fc-repeat",
              call_id: "call-repeat",
              name: "lookup",
              arguments: "",
            },
          },
        },
        {
          event: "response.function_call_arguments.delta",
          data: { item_id: "fc-repeat", delta: '{"a":' },
        },
        {
          event: "response.function_call_arguments.delta",
          data: { item_id: "fc-repeat", delta: "1}" },
        },
        {
          event: "response.function_call_arguments.done",
          data: { item_id: "fc-repeat", arguments: '{"a":1}' },
        },
        {
          event: "response.completed",
          data: { response: { status: "completed" } },
        },
      ]),
      { validation: "codex", stopAtTerminal: true },
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

  for (const validation of ["public", "codex"] as const) {
    test.each([
      ["delta after arguments.done", "response.function_call_arguments.delta"],
      ["duplicate arguments.done", "response.function_call_arguments.done"],
    ])(`${validation} rejects %s`, async (_case, lateEvent) => {
      const itemId = `fc-args-terminal-${validation}`;
      const item = {
        type: "function_call",
        id: itemId,
        call_id: `call-args-terminal-${validation}`,
        name: "lookup",
        arguments: "",
      };
      await expect(
        accumulateResponsesSSEStream(
          buildSSEResponse([
            {
              event: "response.output_item.added",
              data: {
                ...(validation === "public" ? { output_index: 0 } : {}),
                item,
              },
            },
            {
              event: "response.function_call_arguments.done",
              data: {
                ...(validation === "public"
                  ? { output_index: 0 }
                  : { item_id: itemId }),
                arguments: "{}",
              },
            },
            {
              event: lateEvent,
              data: {
                ...(validation === "public"
                  ? { output_index: 0 }
                  : { item_id: itemId }),
                ...(lateEvent.endsWith(".delta")
                  ? { delta: "late" }
                  : { arguments: "{}" }),
              },
            },
          ]),
          { validation, stopAtTerminal: true },
        ),
      ).rejects.toThrow("malformed Responses stream event");
    });

    test.each([
      ["text", "output_text", "response.output_text.delta"],
      ["refusal", "refusal", "response.refusal.delta"],
    ])(
      `${validation} rejects %s deltas after content_part.done`,
      async (_case, partType, lateEvent) => {
        const itemId = `msg-part-terminal-${validation}-${partType}`;
        const reference =
          validation === "public"
            ? { output_index: 0, item_id: itemId, content_index: 0 }
            : { item_id: itemId, content_index: 0 };
        const part =
          partType === "output_text"
            ? { type: partType, text: "done" }
            : { type: partType, refusal: "done" };
        const addedPart =
          partType === "output_text"
            ? { type: partType, text: "" }
            : { type: partType, refusal: "" };
        await expect(
          accumulateResponsesSSEStream(
            buildSSEResponse([
              {
                event: "response.output_item.added",
                data: {
                  ...(validation === "public" ? { output_index: 0 } : {}),
                  item: { type: "message", id: itemId },
                },
              },
              {
                event: "response.content_part.added",
                data: { ...reference, part: addedPart },
              },
              {
                event: "response.content_part.done",
                data: { ...reference, part },
              },
              {
                event: lateEvent,
                data: { ...reference, delta: "late" },
              },
            ]),
            { validation, stopAtTerminal: true },
          ),
        ).rejects.toThrow("malformed Responses stream event");
      },
    );
  }

  test.each(["public", "codex"] as const)(
    "%s rejects an EVIL final response.output snapshot",
    async (validation) => {
      const itemId = `msg-final-snapshot-${validation}`;
      await expect(
        accumulateResponsesSSEStream(
          buildSSEResponse([
            {
              event: "response.output_item.added",
              data: {
                ...(validation === "public" ? { output_index: 0 } : {}),
                item: { type: "message", id: itemId },
              },
            },
            {
              event: "response.output_item.done",
              data: {
                ...(validation === "public" ? { output_index: 0 } : {}),
                item: {
                  type: "message",
                  id: itemId,
                  content: [{ type: "output_text", text: "good" }],
                },
              },
            },
            {
              event: "response.completed",
              data: {
                response: {
                  status: "completed",
                  output: [
                    {
                      type: "message",
                      id: itemId,
                      content: [{ type: "output_text", text: "EVIL" }],
                    },
                  ],
                },
              },
            },
          ]),
          { validation, stopAtTerminal: true },
        ),
      ).rejects.toThrow("malformed Responses terminal event");
    },
  );

  test.each(["public", "codex"] as const)(
    "%s requires a present terminal output snapshot to be a one-to-one complete mapping",
    async (validation) => {
      const itemId = `snapshot-complete-${validation}`;
      const prefix = [
        {
          event: "response.output_item.added",
          data: {
            ...(validation === "public" ? { output_index: 0 } : {}),
            item: { type: "message", id: itemId },
          },
        },
        {
          event: "response.output_item.done",
          data: {
            ...(validation === "public" ? { output_index: 0 } : {}),
            item: { type: "message", id: itemId, content: [] },
          },
        },
      ];
      for (const output of [
        [],
        [{ type: "message", id: "", content: [] }],
        [{ type: "item_reference", id: "unknown-item" }],
        [
          { type: "item_reference", id: itemId },
          { type: "item_reference", id: itemId },
        ],
      ]) {
        await expect(
          accumulateResponsesSSEStream(
            buildSSEResponse([
              ...prefix,
              {
                event: "response.completed",
                data: { response: { status: "completed", output } },
              },
            ]),
            { validation, stopAtTerminal: true },
          ),
        ).rejects.toThrow("malformed Responses terminal event");
      }

      const omitted = accumulateResponsesSSEStream(
        buildSSEResponse([
          ...prefix,
          {
            event: "response.completed",
            data: { response: { status: "completed" } },
          },
        ]),
        { validation, stopAtTerminal: true },
      );
      if (validation === "public") {
        await expect(omitted).rejects.toThrow(
          "malformed Responses terminal event",
        );
      } else {
        await expect(omitted).resolves.toBeDefined();
      }
    },
  );

  for (const validation of ["public", "codex"] as const) {
    test(`${validation} rejects wrapper snapshots contradicting terminal arguments`, async () => {
      const itemId = `fc-snapshot-${validation}`;
      const reference =
        validation === "public" ? { output_index: 0 } : { item_id: itemId };
      await expect(
        accumulateResponsesSSEStream(
          buildSSEResponse([
            {
              event: "response.output_item.added",
              data: {
                ...(validation === "public" ? { output_index: 0 } : {}),
                item: {
                  type: "function_call",
                  id: itemId,
                  call_id: `call-${validation}`,
                  name: "lookup",
                  arguments: "",
                },
              },
            },
            {
              event: "response.function_call_arguments.done",
              data: { ...reference, arguments: '{"x":1}' },
            },
            {
              event: "response.output_item.done",
              data: {
                ...(validation === "public" ? { output_index: 0 } : {}),
                item: {
                  type: "function_call",
                  id: itemId,
                  call_id: `call-${validation}`,
                  name: "lookup",
                  arguments: '{"x":2}',
                },
              },
            },
          ]),
          { validation, stopAtTerminal: true },
        ),
      ).rejects.toThrow("malformed Responses stream event");
    });

    test(`${validation} accepts matching terminal wrapper snapshots`, async () => {
      const itemId = `msg-matching-${validation}`;
      const reference =
        validation === "public"
          ? { output_index: 0, item_id: itemId, content_index: 0 }
          : { item_id: itemId, content_index: 0 };
      const result = await accumulateResponsesSSEStream(
        buildSSEResponse([
          {
            event: "response.output_item.added",
            data: {
              ...(validation === "public" ? { output_index: 0 } : {}),
              item: { type: "message", id: itemId },
            },
          },
          {
            event: "response.output_text.done",
            data: { ...reference, text: "same" },
          },
          {
            event: "response.content_part.added",
            data: {
              ...reference,
              part: { type: "output_text", text: "" },
            },
          },
          {
            event: "response.content_part.done",
            data: {
              ...reference,
              part: { type: "output_text", text: "same" },
            },
          },
          {
            event: "response.output_item.done",
            data: {
              ...(validation === "public" ? { output_index: 0 } : {}),
              item: {
                type: "message",
                id: itemId,
                content: [{ type: "output_text", text: "same" }],
              },
            },
          },
          {
            event: "response.completed",
            data: {
              response: {
                status: "completed",
                output: [
                  {
                    type: "message",
                    id: itemId,
                    content: [{ type: "output_text", text: "same" }],
                  },
                ],
              },
            },
          },
        ]),
        { validation, stopAtTerminal: true },
      );
      expect(result.content).toEqual([{ type: "text", text: "same" }]);
    });

    test(`${validation} rejects content and item snapshots contradicting output_text.done`, async () => {
      const itemId = `msg-contradicting-${validation}`;
      const reference =
        validation === "public"
          ? { output_index: 0, item_id: itemId, content_index: 0 }
          : { item_id: itemId, content_index: 0 };
      await expect(
        accumulateResponsesSSEStream(
          buildSSEResponse([
            {
              event: "response.output_item.added",
              data: {
                ...(validation === "public" ? { output_index: 0 } : {}),
                item: { type: "message", id: itemId },
              },
            },
            {
              event: "response.content_part.added",
              data: {
                ...reference,
                part: { type: "output_text", text: "" },
              },
            },
            {
              event: "response.output_text.done",
              data: { ...reference, text: "one" },
            },
            {
              event: "response.content_part.done",
              data: {
                ...reference,
                part: { type: "output_text", text: "two" },
              },
            },
            {
              event: "response.output_item.done",
              data: {
                ...(validation === "public" ? { output_index: 0 } : {}),
                item: {
                  type: "message",
                  id: itemId,
                  content: [{ type: "output_text", text: "three" }],
                },
              },
            },
          ]),
          { validation, stopAtTerminal: true },
        ),
      ).rejects.toThrow("malformed Responses stream event");
    });
  }

  test.each(["public", "codex"] as const)(
    "%s validation handles high-cardinality indexed identities",
    async (validation) => {
      const count = 2_000;
      const events: Array<{
        event: string;
        data: Record<string, unknown>;
      }> = Array.from({ length: count }, (_, outputIndex) => ({
        event: "response.output_item.added",
        data: {
          ...(validation === "public" ? { output_index: outputIndex } : {}),
          item: { type: "message", id: `msg_${validation}_${outputIndex}` },
        },
      }));
      if (validation === "public") {
        events.push(
          ...Array.from({ length: count }, (_, outputIndex) => ({
            event: "response.output_item.done",
            data: {
              output_index: outputIndex,
              item: {
                type: "message",
                id: `msg_${validation}_${outputIndex}`,
                content: [],
              },
            },
          })),
        );
      }
      events.push({
        event: "response.completed",
        data: {
          response: {
            status: "completed",
            ...(validation === "public"
              ? {
                  output: Array.from({ length: count }, (_, outputIndex) => ({
                    type: "item_reference",
                    id: `msg_${validation}_${outputIndex}`,
                  })),
                }
              : {}),
          },
        },
      });

      const result = await accumulateResponsesSSEStream(
        buildSSEResponse(events),
        { validation, stopAtTerminal: true, maxFrames: events.length },
      );
      expect(result.rawOutputItems).toHaveLength(count);
    },
  );

  test.each(["public", "codex"] as const)(
    "%s rejects MAX_SAFE_INTEGER sparse output and content indices",
    async (validation) => {
      const indexed =
        validation === "public"
          ? { output_index: Number.MAX_SAFE_INTEGER }
          : { output_index: Number.MAX_SAFE_INTEGER };
      await expect(
        accumulateResponsesSSEStream(
          buildSSEResponse([
            {
              event: "response.output_item.added",
              data: { ...indexed, item: { type: "message", id: "too-large" } },
            },
          ]),
          { validation, stopAtTerminal: true, maxFrames: 4 },
        ),
      ).rejects.toThrow("malformed Responses stream event");

      await expect(
        accumulateResponsesSSEStream(
          buildSSEResponse([
            {
              event: "response.output_item.added",
              data: {
                ...(validation === "public" ? { output_index: 0 } : {}),
                item: { type: "message", id: "content-too-large" },
              },
            },
            {
              event: "response.output_text.delta",
              data: {
                ...(validation === "public"
                  ? { output_index: 0 }
                  : { item_id: "content-too-large" }),
                content_index: Number.MAX_SAFE_INTEGER,
                delta: "x",
              },
            },
          ]),
          { validation, stopAtTerminal: true, maxFrames: 4 },
        ),
      ).rejects.toThrow("malformed Responses stream event");
    },
  );

  test.each(["public", "codex"] as const)(
    "%s accepts the sparse-index boundary and rejects the first value beyond it",
    async (validation) => {
      const itemId = `boundary-${validation}`;
      const events = [
        {
          event: "response.output_item.added",
          data: { output_index: 3, item: { type: "message", id: itemId } },
        },
        {
          event: "response.output_item.done",
          data: {
            output_index: 3,
            item: { type: "message", id: itemId, content: [] },
          },
        },
        {
          event: "response.completed",
          data: {
            response: {
              status: "completed",
              ...(validation === "public"
                ? { output: [{ type: "item_reference", id: itemId }] }
                : {}),
            },
          },
        },
      ];
      await expect(
        accumulateResponsesSSEStream(buildSSEResponse(events), {
          validation,
          stopAtTerminal: true,
          maxFrames: 4,
        }),
      ).resolves.toBeDefined();
      events[0] = {
        event: "response.output_item.added",
        data: { output_index: 4, item: { type: "message", id: itemId } },
      };
      await expect(
        accumulateResponsesSSEStream(buildSSEResponse(events), {
          validation,
          stopAtTerminal: true,
          maxFrames: 4,
        }),
      ).rejects.toThrow("malformed Responses stream event");
    },
  );

  test.each(["public", "codex"] as const)(
    "%s bounds sparse content indices by the frame ceiling",
    async (validation) => {
      const itemId = `content-boundary-${validation}`;
      const makeEvents = (contentIndex: number) => [
        {
          event: "response.output_item.added",
          data: { output_index: 0, item: { type: "message", id: itemId } },
        },
        {
          event: "response.output_text.done",
          data: {
            output_index: 0,
            item_id: itemId,
            content_index: contentIndex,
            text: "ok",
          },
        },
        {
          event: "response.output_item.done",
          data: {
            output_index: 0,
            item: {
              type: "message",
              id: itemId,
              content: [{ type: "output_text", text: "ok" }],
            },
          },
        },
        {
          event: "response.completed",
          data: {
            response: {
              status: "completed",
              ...(validation === "public"
                ? { output: [{ type: "item_reference", id: itemId }] }
                : {}),
            },
          },
        },
      ];
      await expect(
        accumulateResponsesSSEStream(buildSSEResponse(makeEvents(3)), {
          validation,
          stopAtTerminal: true,
          maxFrames: 4,
        }),
      ).resolves.toBeDefined();
      await expect(
        accumulateResponsesSSEStream(buildSSEResponse(makeEvents(4)), {
          validation,
          stopAtTerminal: true,
          maxFrames: 4,
        }),
      ).rejects.toThrow("malformed Responses stream event");
    },
  );

  test("Codex sparse sole-active inference stays indexed at high cardinality", async () => {
    const count = 2_000;
    const events: Array<{
      event: string;
      data: Record<string, unknown>;
    }> = [];
    for (let index = 0; index < count; index++) {
      const itemId = `msg-sparse-${index}`;
      events.push(
        {
          event: "response.output_item.added",
          data: { item: { type: "message", id: itemId } },
        },
        {
          event: "response.output_text.delta",
          data: { delta: "x" },
        },
        {
          event: "response.output_item.done",
          data: {
            item: {
              type: "message",
              id: itemId,
              content: [{ type: "output_text", text: "x" }],
            },
          },
        },
      );
    }
    events.push({
      event: "response.completed",
      data: { response: { status: "completed" } },
    });
    const entries = vi.spyOn(Map.prototype, "entries");
    try {
      const result = await accumulateResponsesSSEStream(
        buildSSEResponse(events),
        { validation: "codex", stopAtTerminal: true },
      );
      expect(result.rawOutputItems).toHaveLength(count);
      // Finalization enumerates rawItems once. Sparse inference must not scan
      // the growing item registry for each omitted-index delta/done event.
      expect(entries).toHaveBeenCalledTimes(1);
    } finally {
      entries.mockRestore();
    }
  });

  const contentTerminalCases = [
    {
      name: "text delta after output_text.done",
      terminalEvent: "response.output_text.done",
      terminalData: { text: "done" },
      lateEvent: "response.output_text.delta",
      lateData: { delta: "late" },
    },
    {
      name: "refusal delta after refusal.done",
      terminalEvent: "response.refusal.done",
      terminalData: { refusal: "done" },
      lateEvent: "response.refusal.delta",
      lateData: { delta: "late" },
    },
    {
      name: "duplicate output_text.done",
      terminalEvent: "response.output_text.done",
      terminalData: { text: "done" },
      lateEvent: "response.output_text.done",
      lateData: { text: "done again" },
    },
    {
      name: "duplicate refusal.done",
      terminalEvent: "response.refusal.done",
      terminalData: { refusal: "done" },
      lateEvent: "response.refusal.done",
      lateData: { refusal: "done again" },
    },
    {
      name: "text after refusal.done",
      terminalEvent: "response.refusal.done",
      terminalData: { refusal: "done" },
      lateEvent: "response.output_text.done",
      lateData: { text: "late text" },
    },
    {
      name: "refusal after output_text.done",
      terminalEvent: "response.output_text.done",
      terminalData: { text: "done" },
      lateEvent: "response.refusal.done",
      lateData: { refusal: "late refusal" },
    },
  ] as const;

  for (const validation of ["public", "codex"] as const) {
    test.each(contentTerminalCases)(
      `${validation} validation rejects $name`,
      async ({ terminalEvent, terminalData, lateEvent, lateData }) => {
        const itemId = `msg_content_terminal_${validation}`;
        const contentReference =
          validation === "public"
            ? { output_index: 0, content_index: 0 }
            : { item_id: itemId };
        await expect(
          accumulateResponsesSSEStream(
            buildSSEResponse([
              {
                event: "response.output_item.added",
                data: {
                  ...(validation === "public" ? { output_index: 0 } : {}),
                  item: { type: "message", id: itemId },
                },
              },
              {
                event: terminalEvent,
                data: { ...contentReference, ...terminalData },
              },
              {
                event: lateEvent,
                data: { ...contentReference, ...lateData },
              },
            ]),
            { validation, stopAtTerminal: true },
          ),
        ).rejects.toThrow("malformed Responses stream event");
      },
    );

    test(`${validation} validation permits content_part.done after output_text.done`, async () => {
      const itemId = `msg_content_part_done_${validation}`;
      const contentReference =
        validation === "public"
          ? { output_index: 0, content_index: 0, item_id: itemId }
          : { item_id: itemId };
      const result = await accumulateResponsesSSEStream(
        buildSSEResponse([
          {
            event: "response.output_item.added",
            data: {
              ...(validation === "public" ? { output_index: 0 } : {}),
              item: { type: "message", id: itemId },
            },
          },
          {
            event: "response.content_part.added",
            data: {
              ...contentReference,
              part: { type: "output_text", text: "" },
            },
          },
          {
            event: "response.output_text.done",
            data: { ...contentReference, text: "complete" },
          },
          {
            event: "response.content_part.done",
            data: {
              ...contentReference,
              part: { type: "output_text", text: "complete" },
            },
          },
          {
            event: "response.output_item.done",
            data: {
              ...(validation === "public" ? { output_index: 0 } : {}),
              item: {
                type: "message",
                id: itemId,
                content: [{ type: "output_text", text: "complete" }],
              },
            },
          },
          {
            event: "response.completed",
            data: {
              response: {
                status: "completed",
                ...(validation === "public"
                  ? { output: [{ type: "item_reference", id: itemId }] }
                  : {}),
              },
            },
          },
        ]),
        { validation, stopAtTerminal: true },
      );

      expect(result.content).toEqual([{ type: "text", text: "complete" }]);
    });
  }

  test("Codex applies an omitted late content index to the terminal part", async () => {
    await expect(
      accumulateResponsesSSEStream(
        buildSSEResponse([
          {
            event: "response.output_item.added",
            data: { item: { type: "message", id: "msg_sparse_terminal" } },
          },
          {
            event: "response.output_text.done",
            data: {
              item_id: "msg_sparse_terminal",
              content_index: 7,
              text: "done",
            },
          },
          {
            event: "response.output_text.delta",
            data: { item_id: "msg_sparse_terminal", delta: "late" },
          },
        ]),
        { validation: "codex", stopAtTerminal: true },
      ),
    ).rejects.toThrow("malformed Responses stream event");
  });

  test("Codex reconciles sparse function-call fields from output_item.done", async () => {
    const result = await accumulateResponsesSSEStream(
      buildSSEResponse([
        {
          event: "response.output_item.added",
          data: {
            item: {
              type: "function_call",
              id: "fc_sparse_final",
              call_id: "",
              name: "",
              arguments: "",
            },
          },
        },
        {
          event: "response.function_call_arguments.delta",
          data: {
            item_id: "fc_sparse_final",
            delta: '{"partial":',
          },
        },
        {
          event: "response.output_item.done",
          data: {
            item: {
              type: "function_call",
              id: "fc_sparse_final",
              call_id: "call_final",
              name: "lookup",
              arguments: '{"final":true}',
            },
          },
        },
        {
          event: "response.completed",
          data: { response: { status: "completed" } },
        },
      ]),
      { validation: "codex", stopAtTerminal: true },
    );

    expect(result.content).toEqual([
      {
        type: "tool_use",
        id: "call_final",
        name: "lookup",
        input: { final: true },
      },
    ]);
  });

  test("Codex binds an omitted added function-call ID from output_item.done", async () => {
    const result = await accumulateResponsesSSEStream(
      buildSSEResponse([
        {
          event: "response.output_item.added",
          data: {
            item: {
              type: "function_call",
              call_id: "",
              name: "",
              arguments: "",
            },
          },
        },
        {
          event: "response.output_item.done",
          data: {
            item: {
              type: "function_call",
              id: "fc_bound_final",
              name: "bound_lookup",
              arguments: "{}",
            },
          },
        },
        {
          event: "response.completed",
          data: { response: { status: "completed" } },
        },
      ]),
      { validation: "codex", stopAtTerminal: true },
    );

    expect(result.content).toEqual([
      {
        type: "tool_use",
        id: "fc_bound_final",
        name: "bound_lookup",
        input: {},
      },
    ]);
  });

  test("Codex accepts a done-only function call", async () => {
    const result = await accumulateResponsesSSEStream(
      buildSSEResponse([
        {
          event: "response.output_item.done",
          data: {
            item: {
              type: "function_call",
              id: "fc_done_only",
              call_id: "call_done_only",
              name: "done_only",
              arguments: '{"value":1}',
            },
          },
        },
        {
          event: "response.completed",
          data: { response: { status: "completed" } },
        },
      ]),
      { validation: "codex", stopAtTerminal: true },
    );

    expect(result.content).toEqual([
      {
        type: "tool_use",
        id: "call_done_only",
        name: "done_only",
        input: { value: 1 },
      },
    ]);
  });

  test.each([
    ["item ID", { id: "fc_conflicting_final" }],
    ["call ID", { call_id: "call_conflicting_final" }],
    ["name", { name: "conflicting_final_name" }],
  ])(
    "Codex rejects a conflicting final function-call %s",
    async (_case, final) => {
      await expect(
        accumulateResponsesSSEStream(
          buildSSEResponse([
            {
              event: "response.output_item.added",
              data: {
                item: {
                  type: "function_call",
                  id: "fc_original",
                  call_id: "call_original",
                  name: "original_name",
                  arguments: "",
                },
              },
            },
            {
              event: "response.output_item.done",
              data: {
                item: {
                  type: "function_call",
                  id: "fc_original",
                  call_id: "call_original",
                  name: "original_name",
                  arguments: "{}",
                  ...final,
                },
              },
            },
          ]),
          { validation: "codex", stopAtTerminal: true },
        ),
      ).rejects.toThrow("malformed Responses stream event");
    },
  );

  test("Codex rejects contradictory output_index and item_id aliases", async () => {
    await expect(
      accumulateResponsesSSEStream(
        buildSSEResponse([
          {
            event: "response.output_item.added",
            data: { item: { type: "message", id: "msg_alias_zero" } },
          },
          {
            event: "response.output_item.added",
            data: { item: { type: "message", id: "msg_alias_one" } },
          },
          {
            event: "response.output_text.delta",
            data: {
              output_index: 0,
              item_id: "msg_alias_one",
              delta: "cross-wired",
            },
          },
        ]),
        { validation: "codex", stopAtTerminal: true },
      ),
    ).rejects.toThrow("malformed Responses stream event");
  });

  test("Codex validation infers omitted output/content indices and permits an added item without done", async () => {
    const response = buildSSEResponse([
      {
        event: "response.output_item.added",
        data: {
          item: { type: "message", id: "msg_minimal", role: "assistant" },
        },
      },
      {
        event: "response.output_text.delta",
        data: { item_id: "msg_minimal", delta: "minimal " },
      },
      {
        event: "response.output_text.delta",
        data: { item_id: "msg_minimal", delta: "Codex" },
      },
      {
        event: "response.done",
        data: { response: {} },
      },
    ]);

    const result = await accumulateResponsesSSEStream(response, {
      validation: "codex",
      stopAtTerminal: true,
    });

    expect(result.content).toEqual([{ type: "text", text: "minimal Codex" }]);
    expect(result.stopReason).toBe("end_turn");
  });

  test("Codex validation infers an item from item_id when lifecycle events are omitted", async () => {
    const response = buildSSEResponse([
      {
        event: "response.output_text.delta",
        data: { item_id: "msg_implicit", delta: "implicit item" },
      },
      {
        event: "response.completed",
        data: { response: { status: "completed" } },
      },
    ]);

    const result = await accumulateResponsesSSEStream(response, {
      validation: "codex",
      stopAtTerminal: true,
    });

    expect(result.content).toEqual([{ type: "text", text: "implicit item" }]);
  });

  test("Codex validation accepts a done-only message item and extracts its content", async () => {
    const response = buildSSEResponse([
      {
        event: "response.output_item.done",
        data: {
          item: {
            type: "message",
            id: "msg_done_only",
            content: [{ type: "output_text", text: "done-only text" }],
          },
        },
      },
      {
        event: "response.completed",
        data: { response: { status: "completed" } },
      },
    ]);

    const result = await accumulateResponsesSSEStream(response, {
      validation: "codex",
      stopAtTerminal: true,
    });

    expect(result.content).toEqual([{ type: "text", text: "done-only text" }]);
  });

  test("Codex validation accepts provider-specific incomplete reasons", async () => {
    const response = buildSSEResponse([
      {
        event: "response.incomplete",
        data: {
          response: {
            status: "incomplete",
            incomplete_details: { reason: "provider_specific" },
          },
        },
      },
    ]);

    const result = await accumulateResponsesSSEStream(response, {
      validation: "codex",
      stopAtTerminal: true,
    });

    expect(result.stopReason).toBe("max_tokens");
  });

  test.each([
    [
      "malformed output index",
      [
        {
          event: "response.output_item.added",
          data: {
            output_index: "0",
            item: { type: "message", id: "msg_bad_output" },
          },
        },
      ],
      "malformed Responses stream event",
    ],
    [
      "malformed content index",
      [
        {
          event: "response.output_text.delta",
          data: {
            item_id: "msg_bad_content",
            content_index: "0",
            delta: "text",
          },
        },
      ],
      "malformed Responses stream event",
    ],
    [
      "non-string incomplete reason",
      [
        {
          event: "response.incomplete",
          data: {
            response: {
              status: "incomplete",
              incomplete_details: { reason: 1 },
            },
          },
        },
      ],
      "malformed Responses terminal event",
    ],
    [
      "contradictory response.done status",
      [
        {
          event: "response.done",
          data: { response: { status: "in_progress" } },
        },
      ],
      "Responses terminal event/status mismatch",
    ],
  ] as const)(
    "Codex validation rejects %s when provided",
    async (_case, events, diagnostic) => {
      await expect(
        accumulateResponsesSSEStream(buildSSEResponse([...events]), {
          validation: "codex",
          stopAtTerminal: true,
        }),
      ).rejects.toThrow(diagnostic);
    },
  );
});

test("Anthropic translator emits inclusive Responses cache usage", async () => {
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
  const output = await translateAnthropicStreamToResponses(upstream, {
    strict: true,
  }).text();
  const completedLine = output
    .split("\n")
    .find(
      (line) =>
        line.startsWith("data: {") && line.includes("response.completed"),
    );
  const completed = JSON.parse(completedLine?.slice(6) ?? "null") as {
    response: { usage: Record<string, unknown> };
  };
  expect(completed.response.usage).toEqual({
    input_tokens: 120,
    output_tokens: 1,
    total_tokens: 121,
    input_tokens_details: { cached_tokens: 90, cache_write_tokens: 20 },
  });
  expect(() =>
    validateResponsesUsage(
      completed.response.usage,
      "invalid translated usage",
    ),
  ).not.toThrow();
});

test("Anthropic translator emits content_filter as response.incomplete", async () => {
  const event = (type: string, data: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const upstream = new Response(
    event("message_start", {
      message: {
        id: "msg_filtered",
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    }) +
      event("message_delta", {
        delta: { stop_reason: "refusal", stop_sequence: null },
        usage: { output_tokens: 1 },
      }) +
      event("message_stop", {}),
  );

  const output = await translateAnthropicStreamToResponses(upstream, {
    strict: true,
  }).text();
  expect(output).toContain("event: response.incomplete");
  expect(output).toContain('"status":"incomplete"');
  expect(output).toContain('"reason":"content_filter"');
  expect(output).not.toContain("event: response.completed");
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
  if (!resp.body) throw new Error("test response has no body");
  const reader = resp.body.getReader();
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
  test("drains a pre-buffered stream after a delayed first read", async () => {
    const downstream = streamResponsesPassthrough(
      buildSSEResponse([
        {
          event: "response.created",
          data: {
            type: "response.created",
            response: { id: "delayed", status: "in_progress" },
          },
        },
        {
          event: "response.completed",
          data: {
            type: "response.completed",
            response: { id: "delayed", status: "completed", output: [] },
          },
        },
      ]),
      () => {},
    );
    await new Promise((resolve) => setImmediate(resolve));
    const output = await downstream.text();
    expect(output).toContain("response.created");
    expect(output).toContain("response.completed");
  });

  test("an already-aborted external signal errors downstream and cancels upstream", async () => {
    let sourceCancelled = false;
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          return new Promise(() => {});
        },
        cancel() {
          sourceCancelled = true;
        },
      }),
    );
    const abort = new AbortController();
    abort.abort(new DOMException("deadline", "TimeoutError"));
    const removeAbortListener = vi.spyOn(abort.signal, "removeEventListener");
    const downstream = streamResponsesPassthrough(
      upstream,
      () => {},
      undefined,
      "public",
      abort.signal,
    );
    await expect(downstream.text()).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(sourceCancelled).toBe(true);
    expect(removeAbortListener).toHaveBeenCalledWith(
      "abort",
      expect.any(Function),
    );
  });

  test("external abort wakes a demand waiter and errors the reader", async () => {
    let sourceCancelled = false;
    const abort = new AbortController();
    const removeAbortListener = vi.spyOn(abort.signal, "removeEventListener");
    const event = (type: string, response: Record<string, unknown>) =>
      `event: ${type}\ndata: ${JSON.stringify({ type, response })}\n\n`;
    const wrapped = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              event("response.created", {
                id: "waiting",
                status: "in_progress",
              }) +
                event("response.completed", {
                  id: "waiting",
                  status: "completed",
                  output: [],
                }),
            ),
          );
        },
        pull() {
          return new Promise(() => {});
        },
        cancel() {
          sourceCancelled = true;
        },
      }),
    );
    const downstream = streamResponsesPassthrough(
      wrapped,
      () => {},
      undefined,
      "public",
      abort.signal,
    );
    await new Promise((resolve) => setImmediate(resolve));
    abort.abort(new DOMException("deadline", "TimeoutError"));
    await expect(downstream.text()).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(sourceCancelled).toBe(true);
    expect(removeAbortListener).toHaveBeenCalledWith(
      "abort",
      expect.any(Function),
    );
  });

  test("downstream cancel before reader acquisition is silent and cancels the source", async () => {
    let sourceCancelled = false;
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          sourceCancelled = true;
        },
      }),
    );
    const downstream = streamResponsesPassthrough(upstream, () => {});
    await downstream.body?.cancel();
    await new Promise((resolve) => setImmediate(resolve));
    expect(sourceCancelled).toBe(true);
  });

  test("downstream cancel does not await a hostile upstream cancel", async () => {
    let sourceCancelled = false;
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'event: response.created\ndata: {"type":"response.created","response":{"id":"hostile","status":"in_progress"}}\n\n',
            ),
          );
        },
        pull() {
          return new Promise(() => {});
        },
        cancel() {
          sourceCancelled = true;
          return new Promise<void>(() => {});
        },
      }),
    );
    const downstreamBody = streamResponsesPassthrough(upstream, () => {}).body;
    if (!downstreamBody) throw new Error("test stream has no body");
    const reader = downstreamBody.getReader();
    await reader.read();
    const outcome = await Promise.race([
      reader.cancel().then(() => "cancelled"),
      new Promise<string>((resolve) => setImmediate(() => resolve("hung"))),
    ]);
    expect(outcome).toBe("cancelled");
    expect(sourceCancelled).toBe(true);
    expect(upstream.body?.locked).toBe(false);
  });

  test("does not emit a second terminal when onComplete throws", async () => {
    const output = await streamResponsesPassthrough(
      buildSSEResponse([
        {
          event: "response.completed",
          data: {
            type: "response.completed",
            response: { status: "completed", output: [] },
          },
        },
      ]),
      () => {
        throw new Error("accounting failed");
      },
      undefined,
      "public",
    ).text();
    expect(output.match(/event: response\.completed/g)).toHaveLength(1);
    expect(output).not.toContain("event: response.failed");
  });

  test("does not forward malformed JSON", async () => {
    const outcomes: boolean[] = [];
    const output = await streamResponsesPassthrough(
      new Response("event: response.created\ndata: {bad}\n\n"),
      (_response, successful) => outcomes.push(successful),
      undefined,
      "public",
    ).text();
    expect(output).not.toContain("{bad}");
    expect(output).toContain("event: response.failed");
    expect(outcomes).toEqual([false]);
  });

  test("rejects duplicate call_id before forwarding the conflicting event", async () => {
    const first = {
      type: "function_call",
      id: "item-one",
      call_id: "duplicate-call",
      name: "one",
      arguments: "{}",
    };
    const second = { ...first, id: "item-two", name: "two" };
    const upstream = buildSSEResponse([
      {
        event: "response.output_item.added",
        data: { output_index: 0, item: first },
      },
      {
        event: "response.output_item.added",
        data: { output_index: 1, item: second },
      },
    ]);
    const output = await streamResponsesPassthrough(
      upstream,
      () => {},
      undefined,
      "public",
    ).text();
    expect(output).toContain("item-one");
    expect(output).not.toContain("item-two");
    expect(output).toContain("response.failed");
  });

  test("threads Codex sparse validation instead of public lifecycle rules", async () => {
    const events = [
      {
        event: "response.output_item.added",
        data: { item: { type: "message", id: "codex-sparse" } },
      },
      {
        event: "response.output_text.delta",
        data: { item_id: "codex-sparse", delta: "ok" },
      },
      {
        event: "response.completed",
        data: { response: { status: "completed" } },
      },
    ];
    const codex = await streamResponsesPassthrough(
      buildSSEResponse(events),
      () => {},
      undefined,
      "codex",
    ).text();
    expect(codex).toContain('"delta":"ok"');
    expect(codex).not.toContain("response.failed");

    const publicOutput = await streamResponsesPassthrough(
      buildSSEResponse(events),
      () => {},
      undefined,
      "public",
    ).text();
    expect(publicOutput).not.toContain('"delta":"ok"');
    expect(publicOutput).toContain("response.failed");
  });

  test("validates and forwards a provider failure terminal", async () => {
    const outcomes: boolean[] = [];
    const output = await streamResponsesPassthrough(
      buildSSEResponse([
        {
          event: "response.failed",
          data: {
            type: "response.failed",
            response: {
              status: "failed",
              error: { type: "server_error", message: "provider failed" },
            },
          },
        },
      ]),
      (_response, successful) => outcomes.push(successful),
      undefined,
      "public",
    ).text();
    expect(output.match(/event: response\.failed/g)).toHaveLength(1);
    expect(output).toContain("provider failed");
    expect(outcomes).toEqual([false]);
  });

  test("reports a missing terminal as unsuccessful", async () => {
    const outcomes: boolean[] = [];
    const output = await streamResponsesPassthrough(
      buildSSEResponse([
        {
          event: "response.created",
          data: {
            type: "response.created",
            response: { id: "missing-terminal", status: "in_progress" },
          },
        },
      ]),
      (_response, successful) => outcomes.push(successful),
      undefined,
      "public",
    ).text();
    expect(output).toContain("event: response.failed");
    expect(outcomes).toEqual([false]);
  });

  test("counts comment-only wire bytes toward the aggregate cap", async () => {
    const output = await streamResponsesPassthrough(
      new Response(`: ${"x".repeat(4 * 1024 * 1024)}\n\n`),
      () => {},
      undefined,
      "public",
    ).text();
    expect(output).toContain("Upstream response stream failed");
  });

  test("fails the stream when aggregate retained event data exceeds its cap", async () => {
    const payload = JSON.stringify({ padding: "x".repeat(1024 * 1024) });
    const frame = `event: response.unknown\ndata: ${payload}\n\n`;
    const upstream = new Response(frame.repeat(5), {
      headers: { "content-type": "text/event-stream" },
    });

    const output = await streamResponsesPassthrough(upstream, () => {}).text();

    expect(output).toContain("event: response.failed");
    expect(output).toContain("Upstream response stream failed");
  });

  test("stops pulling upstream while a downstream consumer is not reading", async () => {
    let pulls = 0;
    let cancelled = false;
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          controller.enqueue(
            new TextEncoder().encode(
              `event: response.in_progress\ndata: ${JSON.stringify({
                type: "response.in_progress",
                response: { id: "r", status: "in_progress" },
              })}\n\n`,
            ),
          );
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    const downstream = streamResponsesPassthrough(upstream, () => {});
    await new Promise((resolve) => setImmediate(resolve));
    expect(pulls).toBeLessThan(10);
    await downstream.body?.cancel();
    expect(cancelled).toBe(true);
  });
  test("forwards events to the client BEFORE the upstream completes (true streaming)", async () => {
    const upstream = controllableSSE();
    let completed: GatewayResponse | null = null;

    const clientResp = streamResponsesPassthrough(upstream.response, (r) => {
      completed = r;
    });
    if (!clientResp.body) throw new Error("test response has no body");
    const reader = clientResp.body.getReader();
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
        output: [],
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

  test("finalizes when the client cancels immediately after the terminal event", async () => {
    const upstream = controllableSSE();
    let completeCalls = 0;
    const client = streamResponsesPassthrough(upstream.response, () => {
      completeCalls++;
    });
    if (!client.body) throw new Error("test response has no body");
    const reader = client.body.getReader();
    const decoder = new TextDecoder();

    upstream.push("response.created", {
      type: "response.created",
      response: {
        id: "resp_cancel_after_terminal",
        model: "gpt-5.6-sol",
        status: "in_progress",
      },
    });
    upstream.push("response.completed", {
      type: "response.completed",
      response: {
        id: "resp_cancel_after_terminal",
        model: "gpt-5.6-sol",
        status: "completed",
        output: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    });

    let seen = "";
    while (!seen.includes("event: response.completed")) {
      const { done, value } = await reader.read();
      if (done) throw new Error("stream closed before terminal event");
      if (value) seen += decoder.decode(value, { stream: true });
    }
    await reader.cancel();

    expect(completeCalls).toBe(1);
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
        output: [],
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
                output: [],
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
    expect(out).not.toContain("upstream exploded");
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
    if (!clientResp.body) throw new Error("test response has no body");
    const reader = clientResp.body.getReader();
    await reader.read(); // pull the first event through
    await reader.cancel(); // client disconnects

    // Give the microtask queue a tick for the cancel to propagate.
    await new Promise((r) => setTimeout(r, 10));
    expect(upstreamCancelled).toBe(true);
  });
});
