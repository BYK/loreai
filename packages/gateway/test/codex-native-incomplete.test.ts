import { describe, expect, test, vi } from "vitest";
import { accumulateResponsesNonStreamJSON } from "../src/pipeline";
import {
  accumulateResponsesSSEStream,
  streamResponsesPassthrough,
} from "../src/stream/openai-responses";
import {
  buildOpenAIResponsesResponse,
  parseOpenAIResponsesRequest,
} from "../src/translate/openai-responses";
import type { GatewayResponse } from "../src/translate/types";

function responseBody(args: string) {
  return {
    id: "resp_truncated",
    model: "gpt-test",
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: [
      {
        id: "fc_truncated",
        type: "function_call",
        call_id: "call_truncated",
        namespace: "files",
        name: "read",
        arguments: args,
        status: "incomplete",
      },
    ],
    usage: { input_tokens: 11, output_tokens: 4 },
  };
}
function upstream(args: string): Response {
  const body = responseBody(args);
  const item = body.output[0];
  const events = [
    {
      type: "response.created",
      response: { ...body, status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", arguments: "" },
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: item.id,
      delta: args,
    },
    {
      type: "response.function_call_arguments.done",
      output_index: 0,
      item_id: item.id,
      arguments: args,
    },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.incomplete", response: body },
  ];
  return new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}
function verify(response: GatewayResponse, args: string) {
  expect(response.stopReason).toBe("max_tokens");
  expect(response.usage).toMatchObject({ inputTokens: 11, outputTokens: 4 });
  expect(response.content[0]).toMatchObject({
    type: "tool_use",
    input: args,
    responsesCall: { namespace: "files" },
  });
  expect(response.rawOutputItems).toEqual(responseBody(args).output);
}

describe.each(['{"path":', ""])("truncated namespaced arguments %j", (args) => {
  test("buffered output retains raw arguments and usage", async () => {
    const response = accumulateResponsesNonStreamJSON(responseBody(args));
    verify(response, args);
    // Losing the raw-item cache must not turn the partial JSON into a quoted string.
    const rebuilt = await buildOpenAIResponsesResponse(
      { ...response, rawOutputItems: undefined },
      false,
    ).json();
    expect(rebuilt.output[0]).toMatchObject({
      namespace: "files",
      arguments: args,
      status: "incomplete",
    });
  });
  test("streamed output retains raw arguments and usage", async () => {
    verify(
      await accumulateResponsesSSEStream(upstream(args), {
        validation: "public",
      }),
      args,
    );
  });
  test("passthrough calls persistence/accounting completion exactly once", async () => {
    const onComplete =
      vi.fn<(response: GatewayResponse, successful: boolean) => void>();
    const output = await streamResponsesPassthrough(
      upstream(args),
      onComplete,
    ).text();
    expect(output).toContain("event: response.incomplete");
    expect(output).not.toContain("event: response.failed");
    expect(onComplete).toHaveBeenCalledOnce();
    const completed = onComplete.mock.calls[0]?.[0];
    if (!completed) throw new Error("Missing completion callback");
    verify(completed, args);
  });
  test("incoming malformed call history is still rejected", () => {
    expect(() =>
      parseOpenAIResponsesRequest(
        {
          input: responseBody(args).output.map((item) => ({
            ...item,
            status: "completed",
          })),
        },
        {},
      ),
    ).toThrow("Unsupported cross-provider request");
  });
});
