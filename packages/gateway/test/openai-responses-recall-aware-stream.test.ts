/**
 * Unit tests for `streamResponsesRecallAware` — the true-streaming,
 * recall-aware OpenAI Responses (codex/ChatGPT) streamer.
 *
 * Regression for the "Provider response headers timed out after 10000ms" issue:
 * the buffered `accumulateResponsesSSEStream` path withholds ALL client bytes
 * until the entire (slow, reasoning-heavy) upstream completes, so opencode's
 * 10s `ProviderHeaderTimeoutError` fired on ChatGPT sessions. This streamer
 * forwards events live while transparently intercepting a `recall`
 * function_call (emit marker, run follow-up, rebuild the terminal
 * `response.completed`).
 */
import { describe, test, expect } from "vitest";
import { streamResponsesRecallAware } from "../src/pipeline";
import type { GatewayResponse } from "../src/translate/types";

function sseEvent(event: string, data: unknown): string {
  const payload =
    data && typeof data === "object" && !Array.isArray(data)
      ? { type: event, ...(data as Record<string, unknown>) }
      : data;
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** Build an upstream Responses SSE stream from ordered events. */
function streamFrom(events: string[]): Response {
  return new Response(events.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Drain a client-facing Response into the full SSE text. */
async function drain(resp: Response): Promise<string> {
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

const created = (id: string, model: string) =>
  sseEvent("response.created", { response: { id, model } });

const recallCall = (
  outputIndex: number,
  args: Record<string, unknown>,
  itemId = `fc_${outputIndex}`,
  callId = `call_${outputIndex}`,
) =>
  sseEvent("response.output_item.added", {
    output_index: outputIndex,
    item: {
      type: "function_call",
      id: itemId,
      call_id: callId,
      name: "recall",
    },
  }) +
  sseEvent("response.function_call_arguments.done", {
    output_index: outputIndex,
    item_id: itemId,
    arguments: JSON.stringify(args),
  }) +
  sseEvent("response.output_item.done", {
    output_index: outputIndex,
    item: {
      type: "function_call",
      id: itemId,
      call_id: callId,
      name: "recall",
      arguments: JSON.stringify(args),
      status: "completed",
    },
  });

const completed = (id: string, usage?: unknown) =>
  sseEvent("response.completed", {
    response: {
      id,
      model: "gpt-5.6-terra",
      status: "completed",
      ...(usage ? { usage } : {}),
    },
  });

const incomplete = (id: string) =>
  sseEvent("response.incomplete", {
    response: {
      id,
      model: "gpt-5.6-terra",
      status: "incomplete",
    },
  });

const doneIncomplete = (id: string) =>
  sseEvent("response.done", {
    response: {
      id,
      model: "gpt-5.6-terra",
      status: "incomplete",
    },
  });

const doneWithStatus = (id: string, status: string) =>
  sseEvent("response.done", {
    response: {
      id,
      model: "gpt-5.6-terra",
      status,
    },
  });

const PUBLIC_RECALL_ERROR = "Lore could not continue the response after recall";

const textItem = (
  outputIndex: number,
  text: string,
  itemId = `msg_${outputIndex}`,
) =>
  sseEvent("response.output_item.added", {
    output_index: outputIndex,
    item: { type: "message", id: itemId, role: "assistant" },
  }) +
  sseEvent("response.output_text.delta", {
    output_index: outputIndex,
    item_id: itemId,
    content_index: 0,
    delta: text,
  }) +
  sseEvent("response.output_text.done", {
    output_index: outputIndex,
    item_id: itemId,
    content_index: 0,
    text,
  }) +
  sseEvent("response.output_item.done", {
    output_index: outputIndex,
    item: {
      type: "message",
      id: itemId,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text }],
    },
  });

describe("streamResponsesRecallAware", () => {
  test("forwards events live with NO recall — no header hold-back", async () => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_plain", "gpt-5.6-terra"),
        textItem(0, "hello world"),
        completed("resp_plain", { input_tokens: 10, output_tokens: 3 }),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not be called");
        },
      },
    );
    const out = await drain(client);
    // The terminal event is forwarded verbatim with no marker or follow-up.
    expect(out).toContain("response.completed");
    expect(out).toContain("hello world");
    expect(out).not.toContain('"recall"');
    expect(out).not.toContain("lore_marker");
    expect(out).not.toContain("response.failed");
  });

  test("finalizes when the client cancels immediately after a no-recall terminal", async () => {
    let upstreamCancelled = false;
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              created("resp_cancel_terminal", "gpt-5.6-terra") +
                completed("resp_cancel_terminal", {
                  input_tokens: 1,
                  output_tokens: 0,
                }),
            ),
          );
        },
        pull() {
          return new Promise(() => {});
        },
        cancel() {
          upstreamCancelled = true;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    let completeCalls = 0;
    const client = streamResponsesRecallAware(upstream, {
      onComplete: () => completeCalls++,
      onRecall: async () => ({ anchorText: "", resultText: "" }),
      runFollowUp: async () => {
        throw new Error("should not be called");
      },
    });
    if (!client.body) throw new Error("test response has no body");
    const reader = client.body.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    while (!seen.includes("event: response.completed")) {
      const { done, value } = await reader.read();
      if (done) throw new Error("stream closed before terminal event");
      if (value) seen += decoder.decode(value, { stream: true });
    }
    await reader.cancel();

    expect(completeCalls).toBe(1);
    expect(upstreamCancelled).toBe(true);
  });

  test("forwards a principal response.failed exactly once when no recall occurs", async () => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_failed", "gpt-5.6-terra"),
        sseEvent("response.failed", {
          response: {
            id: "resp_failed",
            model: "gpt-5.6-terra",
            status: "failed",
            error: { message: "provider failed" },
          },
        }),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not be called");
        },
      },
    );

    const out = await drain(client);
    expect(out.match(/^event: response\.failed$/gm)).toHaveLength(1);
    expect(out).toContain("provider failed");
    expect(out).not.toContain("ended without a terminal event");
  });

  test("accepts an empty Codex terminal output after streamed items", async () => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_codex_empty_output", "gpt-5.6-terra"),
        textItem(0, "answer"),
        sseEvent("response.completed", {
          response: {
            id: "resp_codex_empty_output",
            model: "gpt-5.6-terra",
            status: "completed",
            output: [],
          },
        }),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not be called");
        },
      },
    );

    const out = await drain(client);
    expect(out).toContain("answer");
    expect(out.match(/^event: response\.completed$/gm)).toHaveLength(1);
    expect(out).not.toContain("response.failed");
  });

  test("accepts a partial Codex terminal output after streamed items", async () => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_codex_partial_output", "gpt-5.6-terra"),
        textItem(0, "omitted from terminal", "msg_omitted"),
        textItem(1, "answer", "msg_answer"),
        sseEvent("response.completed", {
          response: {
            id: "resp_codex_partial_output",
            model: "gpt-5.6-terra",
            status: "completed",
            output: [
              {
                type: "message",
                id: "msg_answer",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "answer" }],
              },
            ],
          },
        }),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not be called");
        },
      },
    );

    const out = await drain(client);
    expect(out).toContain("answer");
    expect(out.match(/^event: response\.completed$/gm)).toHaveLength(1);
    expect(out).not.toContain("response.failed");
  });

  test.each(["failed", "cancelled"])(
    "hides recall when the principal response.done status is %s",
    async (status) => {
      let completedResponse: unknown;
      const client = streamResponsesRecallAware(
        streamFrom([
          created("resp_principal_failure", "gpt-5.6-terra"),
          recallCall(0, { query: "architecture" }),
          doneWithStatus("resp_principal_failure", status),
        ]),
        {
          onComplete: (response) => {
            completedResponse = response;
          },
          onRecall: async () => {
            throw new Error("should not execute");
          },
          runFollowUp: async () => {
            throw new Error("should not run");
          },
        },
      );

      const out = await drain(client);
      expect(out.match(/^event: response\.failed$/gm)).toHaveLength(1);
      expect(out).not.toContain('"name":"recall"');
      expect(out).not.toContain("call_0");
      expect(JSON.stringify(completedResponse)).not.toContain("recall");
      expect(JSON.stringify(completedResponse)).not.toContain("call_0");
    },
  );

  test("suppresses a recall function_call and emits a marker (mixed tools)", async () => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_mixed", "gpt-5.6-terra"),
        // recall call at output_index 0
        recallCall(0, { query: "what is lore" }),
        // a real (non-recall) tool_call at output_index 1
        sseEvent("response.output_item.added", {
          output_index: 1,
          item: {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "read",
          },
        }),
        sseEvent("response.function_call_arguments.done", {
          output_index: 1,
          item_id: "fc_1",
          arguments: JSON.stringify({ file: "x" }),
        }),
        sseEvent("response.output_item.done", {
          output_index: 1,
          item: {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "read",
            arguments: JSON.stringify({ file: "x" }),
            status: "completed",
          },
        }),
        completed("resp_mixed"),
      ]),
      {
        onComplete: () => {},
        onRecall: async ({ query }) => ({
          anchorText: buildAnchor(query),
          resultText: "some results",
        }),
        runFollowUp: async () => {
          throw new Error("runFollowUp should not run for mixed tools");
        },
      },
    );
    const out = await drain(client);

    // The recall function_call must NOT leak to the client.
    expect(out).not.toMatch(/name":\s*"recall/);
    // The non-recall tool (read) must still be present.
    expect(out).toMatch(/name":\s*"read/);
    expect(out).toContain(buildAnchor("what is lore"));
    expect(out).not.toContain("Searching");
    // A rebuilt response.completed is emitted.
    expect(out).toContain("response.completed");
    expect(out.indexOf(buildAnchor("what is lore"))).toBeLessThan(
      out.indexOf('name":"read"'),
    );
    const terminal = JSON.parse(
      /event: response\.completed\ndata: (.+)/.exec(out)?.[1] ?? "{}",
    ) as { response?: { output?: Array<{ id?: string }> } };
    expect(terminal.response?.output?.map((item) => item.id)).toEqual([
      "msg_resp_mixed_0",
      "fc_1",
    ]);
  });

  test("binds parallel recalls to their own call IDs and fails before an invalid follow-up", async () => {
    const seen: string[] = [];
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_parallel", "gpt-5.6-terra"),
        recallCall(0, { query: "same" }),
        recallCall(1, { query: "same" }),
        completed("resp_parallel"),
      ]),
      {
        onComplete: () => {},
        onRecall: async ({ outputIndex, toolUseId }) => {
          seen.push(`${outputIndex}:${toolUseId}`);
          return {
            anchorText: buildAnchor(`${outputIndex}-${toolUseId}`),
            resultText: "results",
          };
        },
        runFollowUp: async () => {
          throw new Error("should not run for multiple recalls");
        },
      },
    );

    const out = await drain(client);
    expect(seen).toEqual([]);
    expect(out).toContain("response.failed");
    expect(out).toContain(PUBLIC_RECALL_ERROR);
  });

  test("rejects repeated call IDs before recall execution", async () => {
    const seen: Array<{ outputIndex: number; contentPosition: number }> = [];
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_duplicate", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_read",
            call_id: "call_reused",
            name: "read",
          },
        }),
        sseEvent("response.function_call_arguments.done", {
          output_index: 0,
          item_id: "fc_read",
          arguments: "{}",
        }),
        sseEvent("response.output_item.added", {
          output_index: 1,
          item: {
            type: "function_call",
            id: "fc_recall",
            call_id: "call_reused",
            name: "recall",
          },
        }),
        sseEvent("response.function_call_arguments.done", {
          output_index: 1,
          item_id: "fc_recall",
          arguments: JSON.stringify({ query: "same" }),
        }),
        completed("resp_duplicate"),
      ]),
      {
        onComplete: () => {},
        onRecall: async ({ outputIndex, contentPosition }) => {
          seen.push({ outputIndex, contentPosition });
          return { anchorText: buildAnchor("same"), resultText: "results" };
        },
        runFollowUp: async () => {
          throw new Error("should not run for mixed tools");
        },
      },
    );

    const out = await drain(client);
    expect(seen).toEqual([]);
    expect(out).toContain(PUBLIC_RECALL_ERROR);
    expect(out).not.toContain('name":"recall"');
  });

  test("rejects parallel recalls even when a non-recall tool is present", async () => {
    let executed = false;
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_parallel_mixed", "gpt-5.6-terra"),
        recallCall(0, { query: "one" }),
        recallCall(1, { query: "two" }),
        sseEvent("response.output_item.added", {
          output_index: 2,
          item: {
            type: "function_call",
            id: "fc_read",
            call_id: "call_read",
            name: "read",
          },
        }),
        sseEvent("response.function_call_arguments.done", {
          output_index: 2,
          item_id: "fc_read",
          arguments: "{}",
        }),
        sseEvent("response.output_item.done", {
          output_index: 2,
          item: {
            type: "function_call",
            id: "fc_read",
            call_id: "call_read",
            name: "read",
            arguments: "{}",
          },
        }),
        completed("resp_parallel_mixed"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => {
          executed = true;
          return { anchorText: "", resultText: "" };
        },
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    const out = await drain(client);
    expect(executed).toBe(false);
    expect(out).toContain(PUBLIC_RECALL_ERROR);
  });

  test("bounds deferred principal output after recall detection", async () => {
    const recall = recallCall(0, { query: "architecture" });
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_deferred", "gpt-5.6-terra"),
        recall,
        textItem(1, "too large"),
        completed("resp_deferred"),
      ]),
      {
        maxDeferredBytes: new TextEncoder().encode(recall).byteLength + 1,
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should fail before follow-up");
        },
      },
    );

    const out = await drain(client);
    expect(out).toContain(PUBLIC_RECALL_ERROR);
  });

  test("bounds suppressed recall argument events", async () => {
    const added = sseEvent("response.output_item.added", {
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_args",
        call_id: "call_args",
        name: "recall",
      },
    });
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_args", "gpt-5.6-terra"),
        added,
        sseEvent("response.function_call_arguments.done", {
          output_index: 0,
          item_id: "fc_args",
          arguments: JSON.stringify({ query: "architecture" }),
        }),
        completed("resp_args"),
      ]),
      {
        maxDeferredBytes: new TextEncoder().encode(added).byteLength + 1,
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should fail before follow-up");
        },
      },
    );

    const out = await drain(client);
    expect(out).toContain(PUBLIC_RECALL_ERROR);
  });

  test("bounds retained output before recall detection", async () => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_retained", "gpt-5.6-terra"),
        textItem(0, "large retained output"),
        completed("resp_retained"),
      ]),
      {
        maxRetainedStateBytes: 1,
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );
    expect(await drain(client)).toContain("response.failed");
  });

  test("rejects an SSE event name that disagrees with the payload type", async () => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_type_mismatch", "gpt-5.6-terra"),
        sseEvent("response.created", {
          type: "response.in_progress",
          response: { id: "resp_type_mismatch", model: "gpt-5.6-terra" },
        }),
        completed("resp_type_mismatch"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );
    expect(await drain(client)).toContain("response.failed");
  });

  test("rejects response.in_progress changing the created response identity", async () => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_identity_a", "gpt-5.6-terra"),
        sseEvent("response.in_progress", {
          response: { id: "resp_identity_b", model: "gpt-5.6-terra" },
        }),
        completed("resp_identity_b"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );
    expect(await drain(client)).toContain("response.failed");
  });

  test("rejects malformed named Responses events in a continuation", async () => {
    const followUp = streamFrom([
      created("resp_bad_continuation", "gpt-5.6-terra"),
      "event: response.completed\ndata: {not-json}\n\n",
      completed("resp_bad_continuation"),
    ]);
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_bad_principal", "gpt-5.6-terra"),
        recallCall(0, { query: "architecture" }),
        completed("resp_bad_principal"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({
          anchorText: buildAnchor("architecture"),
          resultText: "results",
        }),
        runFollowUp: async () => ({ reader: followUp.body!.getReader() }),
      },
    );
    const out = await drain(client);
    expect(out).toContain(PUBLIC_RECALL_ERROR);
    expect(out).not.toContain("{not-json}");
  });

  test("rejects one content index changing type", async () => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_content_type", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: { type: "message", id: "msg_content_type", role: "assistant" },
        }),
        sseEvent("response.output_text.done", {
          output_index: 0,
          item_id: "msg_content_type",
          content_index: 0,
          text: "text",
        }),
        sseEvent("response.refusal.done", {
          output_index: 0,
          item_id: "msg_content_type",
          content_index: 0,
          refusal: "no",
        }),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );
    expect(await drain(client)).toContain("response.failed");
  });

  test("rejects output_item.done changing finalized content", async () => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_content_done", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: { type: "message", id: "msg_content_done", role: "assistant" },
        }),
        sseEvent("response.output_text.done", {
          output_index: 0,
          item_id: "msg_content_done",
          content_index: 0,
          text: "original",
        }),
        sseEvent("response.output_item.done", {
          output_index: 0,
          item: {
            type: "message",
            id: "msg_content_done",
            role: "assistant",
            content: [{ type: "output_text", text: "changed" }],
          },
        }),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );
    expect(await drain(client)).toContain("response.failed");
  });

  test("rejects terminal output changing streamed identity", async () => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_terminal_identity", "gpt-5.6-terra"),
        textItem(0, "answer", "msg_streamed"),
        sseEvent("response.completed", {
          response: {
            id: "resp_terminal_identity",
            model: "gpt-5.6-terra",
            status: "completed",
            output: [
              {
                type: "message",
                id: "msg_changed",
                role: "assistant",
                content: [{ type: "output_text", text: "answer" }],
              },
            ],
          },
        }),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );
    expect(await drain(client)).toContain("response.failed");
  });

  test("rejects an unknown public incomplete reason", async () => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_unknown_incomplete", "gpt-5.6-terra"),
        sseEvent("response.incomplete", {
          response: {
            id: "resp_unknown_incomplete",
            model: "gpt-5.6-terra",
            status: "incomplete",
            incomplete_details: { reason: "provider_specific" },
            output: [],
          },
        }),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    const output = await drain(client);
    expect(output).toContain("response.failed");
    expect(output).not.toContain("provider_specific");
  });

  test("public validation rejects a terminal without an output snapshot", async () => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_missing_terminal_output", "gpt-5.6-terra"),
        sseEvent("response.completed", {
          response: {
            id: "resp_missing_terminal_output",
            model: "gpt-5.6-terra",
            status: "completed",
          },
        }),
      ]),
      {
        validation: "public",
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    expect(await drain(client)).toContain("response.failed");
  });

  test("rejects terminal function calls changing the streamed tool name", async () => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_terminal_name", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_terminal_name",
            call_id: "call_terminal_name",
            name: "read",
          },
        }),
        sseEvent("response.function_call_arguments.done", {
          output_index: 0,
          item_id: "fc_terminal_name",
          arguments: "{}",
        }),
        sseEvent("response.output_item.done", {
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_terminal_name",
            call_id: "call_terminal_name",
            name: "read",
            arguments: "{}",
            status: "completed",
          },
        }),
        sseEvent("response.completed", {
          response: {
            id: "resp_terminal_name",
            model: "gpt-5.6-terra",
            status: "completed",
            output: [
              {
                type: "function_call",
                id: "fc_terminal_name",
                call_id: "call_terminal_name",
                name: "recall",
                arguments: "{}",
                status: "completed",
              },
            ],
          },
        }),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    expect(await drain(client)).toContain("response.failed");
  });

  test("rejects malformed terminal output items", async () => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_terminal_malformed", "gpt-5.6-terra"),
        textItem(0, "answer", "msg_terminal_malformed"),
        sseEvent("response.completed", {
          response: {
            id: "resp_terminal_malformed",
            model: "gpt-5.6-terra",
            status: "completed",
            output: [null],
          },
        }),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    expect(await drain(client)).toContain("response.failed");
  });

  test("rejects terminal output reordering streamed items", async () => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_terminal_order", "gpt-5.6-terra"),
        textItem(0, "first", "msg_first"),
        textItem(1, "second", "msg_second"),
        sseEvent("response.completed", {
          response: {
            id: "resp_terminal_order",
            model: "gpt-5.6-terra",
            status: "completed",
            output: [
              {
                type: "item_reference",
                id: "msg_second",
              },
              {
                type: "message",
                id: "msg_first",
                role: "assistant",
                content: [{ type: "output_text", text: "first" }],
              },
            ],
          },
        }),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    expect(await drain(client)).toContain("response.failed");
  });

  test("accepts terminal items that add optional status metadata", async () => {
    const doneItem = {
      type: "function_call",
      id: "fc_terminal_status",
      call_id: "call_terminal_status",
      name: "read",
      arguments: "{}",
    };
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_terminal_status", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: doneItem,
        }),
        sseEvent("response.function_call_arguments.done", {
          output_index: 0,
          item_id: "fc_terminal_status",
          arguments: "{}",
        }),
        sseEvent("response.output_item.done", {
          output_index: 0,
          item: doneItem,
        }),
        sseEvent("response.completed", {
          response: {
            id: "resp_terminal_status",
            model: "gpt-5.6-terra",
            status: "completed",
            output: [{ ...doneItem, status: "completed" }],
          },
        }),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    expect(await drain(client)).not.toContain("response.failed");
  });

  test.each([
    {
      name: "message annotations",
      doneItem: {
        type: "message",
        id: "msg_terminal_metadata",
        role: "assistant",
        content: [{ type: "output_text", text: "answer" }],
      },
      terminalItem: {
        type: "message",
        id: "msg_terminal_metadata",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "answer", annotations: [] }],
      },
    },
    {
      name: "hosted-tool status",
      doneItem: {
        type: "web_search_call",
        id: "ws_terminal_metadata",
        action: { type: "search", query: "lore" },
      },
      terminalItem: {
        type: "web_search_call",
        id: "ws_terminal_metadata",
        status: "completed",
        action: { type: "search", query: "lore" },
      },
    },
  ])(
    "accepts terminal enrichment with optional $name",
    async ({ doneItem, terminalItem }) => {
      const client = streamResponsesRecallAware(
        streamFrom([
          created("resp_terminal_metadata", "gpt-5.6-terra"),
          sseEvent("response.output_item.added", {
            output_index: 0,
            item: doneItem,
          }),
          sseEvent("response.output_item.done", {
            output_index: 0,
            item: doneItem,
          }),
          sseEvent("response.completed", {
            response: {
              id: "resp_terminal_metadata",
              model: "gpt-5.6-terra",
              status: "completed",
              output: [terminalItem],
            },
          }),
        ]),
        {
          onComplete: () => {},
          onRecall: async () => ({ anchorText: "", resultText: "" }),
          runFollowUp: async () => {
            throw new Error("should not run");
          },
        },
      );

      expect(await drain(client)).not.toContain("response.failed");
    },
  );

  test("never forwards response-side item_reference lifecycle events", async () => {
    let completedResponse: GatewayResponse | undefined;
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_reference", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: {
            type: "item_reference",
            id: "msg_server_only",
          },
        }),
        sseEvent("response.output_item.done", {
          output_index: 0,
          item: {
            type: "item_reference",
            id: "msg_server_only",
          },
        }),
        sseEvent("response.completed", {
          response: {
            id: "resp_reference",
            model: "gpt-5.6-terra",
            status: "completed",
            output: [{ type: "item_reference", id: "msg_server_only" }],
          },
        }),
      ]),
      {
        onComplete: (response) => {
          completedResponse = response;
        },
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );
    const out = await drain(client);
    expect(out).not.toContain("item_reference");
    expect(out).not.toContain("response.failed");
    expect(JSON.stringify(completedResponse)).not.toContain("item_reference");
  });

  test("rejects an item_reference missing output_item.done", async () => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_reference_incomplete", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: { type: "item_reference", id: "msg_reference_incomplete" },
        }),
        completed("resp_reference_incomplete"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    expect(await drain(client)).toContain("response.failed");
  });

  test("accepts reasoning summaries with summary_index", async () => {
    let completedResponse: GatewayResponse | undefined;
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_summary", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: { type: "reasoning", id: "rs_summary" },
        }),
        sseEvent("response.reasoning_summary_text.delta", {
          output_index: 0,
          item_id: "rs_summary",
          summary_index: 0,
          delta: "summary",
        }),
        sseEvent("response.reasoning_summary_text.done", {
          output_index: 0,
          item_id: "rs_summary",
          summary_index: 0,
          text: "summary",
        }),
        sseEvent("response.output_item.done", {
          output_index: 0,
          item: { type: "reasoning", id: "rs_summary", summary: [] },
        }),
        completed("resp_summary"),
      ]),
      {
        onComplete: (response) => {
          completedResponse = response;
        },
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );
    const out = await drain(client);
    expect(out).toContain("response.reasoning_summary_text.delta");
    expect(out).not.toContain("response.failed");
    expect(completedResponse?.rawOutputItems).toContainEqual(
      expect.objectContaining({
        summary: [{ type: "summary_text", text: "summary" }],
      }),
    );
  });

  test("rejects unfinished reasoning omitted from output_item.done", async () => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_summary_unfinished", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: { type: "reasoning", id: "rs_summary_unfinished", summary: [] },
        }),
        sseEvent("response.reasoning_summary_text.delta", {
          output_index: 0,
          item_id: "rs_summary_unfinished",
          summary_index: 0,
          delta: "partial",
        }),
        sseEvent("response.output_item.done", {
          output_index: 0,
          item: { type: "reasoning", id: "rs_summary_unfinished", summary: [] },
        }),
        completed("resp_summary_unfinished"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    expect(await drain(client)).toContain("response.failed");
  });

  test("rejects unfinished reasoning when output_item.done omits summary", async () => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_summary_field_omitted", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: {
            type: "reasoning",
            id: "rs_summary_field_omitted",
            summary: [],
          },
        }),
        sseEvent("response.reasoning_summary_text.delta", {
          output_index: 0,
          item_id: "rs_summary_field_omitted",
          summary_index: 0,
          delta: "partial",
        }),
        sseEvent("response.output_item.done", {
          output_index: 0,
          item: { type: "reasoning", id: "rs_summary_field_omitted" },
        }),
        completed("resp_summary_field_omitted"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    expect(await drain(client)).toContain("response.failed");
  });

  test("rejects output text deltas that differ from the final text", async () => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_text_delta_mismatch", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: {
            type: "message",
            id: "msg_text_delta_mismatch",
            role: "assistant",
          },
        }),
        sseEvent("response.output_text.delta", {
          output_index: 0,
          item_id: "msg_text_delta_mismatch",
          content_index: 0,
          delta: "different",
        }),
        sseEvent("response.output_text.done", {
          output_index: 0,
          item_id: "msg_text_delta_mismatch",
          content_index: 0,
          text: "final",
        }),
        sseEvent("response.output_item.done", {
          output_index: 0,
          item: {
            type: "message",
            id: "msg_text_delta_mismatch",
            role: "assistant",
            content: [{ type: "output_text", text: "final" }],
          },
        }),
        completed("resp_text_delta_mismatch"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    expect(await drain(client)).toContain("response.failed");
  });

  test("rejects function argument deltas that differ from the final arguments", async () => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_argument_delta_mismatch", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_argument_delta_mismatch",
            call_id: "call_argument_delta_mismatch",
            name: "read",
          },
        }),
        sseEvent("response.function_call_arguments.delta", {
          output_index: 0,
          item_id: "fc_argument_delta_mismatch",
          delta: '{"path":"different"}',
        }),
        sseEvent("response.function_call_arguments.done", {
          output_index: 0,
          item_id: "fc_argument_delta_mismatch",
          arguments: "{}",
        }),
        sseEvent("response.output_item.done", {
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_argument_delta_mismatch",
            call_id: "call_argument_delta_mismatch",
            name: "read",
            arguments: "{}",
          },
        }),
        completed("resp_argument_delta_mismatch"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    expect(await drain(client)).toContain("response.failed");
  });

  test("accepts function argument deltas extending an initial snapshot", async () => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_argument_initial", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_argument_initial",
            call_id: "call_argument_initial",
            name: "read",
            arguments: '{"path":"',
          },
        }),
        sseEvent("response.function_call_arguments.delta", {
          output_index: 0,
          item_id: "fc_argument_initial",
          delta: 'file"}',
        }),
        sseEvent("response.function_call_arguments.done", {
          output_index: 0,
          item_id: "fc_argument_initial",
          arguments: '{"path":"file"}',
        }),
        sseEvent("response.output_item.done", {
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_argument_initial",
            call_id: "call_argument_initial",
            name: "read",
            arguments: '{"path":"file"}',
          },
        }),
        completed("resp_argument_initial"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    expect(await drain(client)).not.toContain("response.failed");
  });

  test("rejects output_item.done changing initial function arguments", async () => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_argument_initial_changed", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_argument_initial_changed",
            call_id: "call_argument_initial_changed",
            name: "read",
            arguments: '{"path":"secret"}',
          },
        }),
        sseEvent("response.function_call_arguments.done", {
          output_index: 0,
          item_id: "fc_argument_initial_changed",
          arguments: "{}",
        }),
        sseEvent("response.output_item.done", {
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_argument_initial_changed",
            call_id: "call_argument_initial_changed",
            name: "read",
            arguments: "{}",
          },
        }),
        completed("resp_argument_initial_changed"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    expect(await drain(client)).toContain("response.failed");
  });

  test("rejects output_item.done changing initial message content", async () => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_message_initial_changed", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: {
            type: "message",
            id: "msg_initial_changed",
            role: "assistant",
            content: [{ type: "output_text", text: "secret" }],
          },
        }),
        sseEvent("response.output_item.done", {
          output_index: 0,
          item: {
            type: "message",
            id: "msg_initial_changed",
            role: "assistant",
            content: [{ type: "output_text", text: "safe" }],
          },
        }),
        completed("resp_message_initial_changed"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    expect(await drain(client)).toContain("response.failed");
  });

  test("rejects content_part.done changing initial part content", async () => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_part_initial_changed", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: {
            type: "message",
            id: "msg_part_initial_changed",
            role: "assistant",
          },
        }),
        sseEvent("response.content_part.added", {
          output_index: 0,
          item_id: "msg_part_initial_changed",
          content_index: 0,
          part: { type: "output_text", text: "secret" },
        }),
        sseEvent("response.output_text.done", {
          output_index: 0,
          item_id: "msg_part_initial_changed",
          content_index: 0,
          text: "safe",
        }),
        sseEvent("response.content_part.done", {
          output_index: 0,
          item_id: "msg_part_initial_changed",
          content_index: 0,
          part: { type: "output_text", text: "safe" },
        }),
        sseEvent("response.output_item.done", {
          output_index: 0,
          item: {
            type: "message",
            id: "msg_part_initial_changed",
            role: "assistant",
            content: [{ type: "output_text", text: "safe" }],
          },
        }),
        completed("resp_part_initial_changed"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    expect(await drain(client)).toContain("response.failed");
  });

  test("rejects finalized reasoning that contradicts summary deltas", async () => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_reasoning_changed", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: { type: "reasoning", id: "rs_changed", summary: [] },
        }),
        sseEvent("response.reasoning_summary_part.added", {
          output_index: 0,
          item_id: "rs_changed",
          summary_index: 0,
        }),
        sseEvent("response.reasoning_summary_text.delta", {
          output_index: 0,
          item_id: "rs_changed",
          summary_index: 0,
          delta: "secret",
        }),
        sseEvent("response.reasoning_summary_text.done", {
          output_index: 0,
          item_id: "rs_changed",
          summary_index: 0,
          text: "secret",
        }),
        sseEvent("response.reasoning_summary_part.done", {
          output_index: 0,
          item_id: "rs_changed",
          summary_index: 0,
        }),
        sseEvent("response.output_item.done", {
          output_index: 0,
          item: {
            type: "reasoning",
            id: "rs_changed",
            summary: [{ type: "summary_text", text: "safe" }],
          },
        }),
        completed("resp_reasoning_changed"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    expect(await drain(client)).toContain("response.failed");
  });

  test("rejects reuse of an item_reference output index", async () => {
    let recalled = 0;
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_reference_reuse", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: { type: "item_reference", id: "msg_server_only" },
        }),
        sseEvent("response.output_item.done", {
          output_index: 0,
          item: { type: "item_reference", id: "msg_server_only" },
        }),
        recallCall(0, { query: "hidden" }),
        completed("resp_reference_reuse"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => {
          recalled++;
          return { anchorText: "", resultText: "" };
        },
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    expect(await drain(client)).toContain("response.failed");
    expect(recalled).toBe(0);
  });

  test("accepts unchanged non-empty initial message content", async () => {
    const item = {
      type: "message",
      id: "msg_initial_unchanged",
      role: "assistant",
      content: [{ type: "output_text", text: "already complete" }],
    };
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_message_initial_unchanged", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", { output_index: 0, item }),
        sseEvent("response.output_item.done", { output_index: 0, item }),
        completed("resp_message_initial_unchanged"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    expect(await drain(client)).not.toContain("response.failed");
  });

  test("rejects output_item.done changing a message role", async () => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_message_role_changed", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: {
            type: "message",
            id: "msg_role_changed",
            role: "assistant",
            content: [],
          },
        }),
        sseEvent("response.output_item.done", {
          output_index: 0,
          item: {
            type: "message",
            id: "msg_role_changed",
            role: "user",
            content: [],
          },
        }),
        completed("resp_message_role_changed"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    expect(await drain(client)).toContain("response.failed");
  });

  test("accepts content-part prefixes extended by deltas", async () => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_part_prefix", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: { type: "message", id: "msg_part_prefix", role: "assistant" },
        }),
        sseEvent("response.content_part.added", {
          output_index: 0,
          item_id: "msg_part_prefix",
          content_index: 0,
          part: { type: "output_text", text: "pre" },
        }),
        sseEvent("response.output_text.delta", {
          output_index: 0,
          item_id: "msg_part_prefix",
          content_index: 0,
          delta: "fix",
        }),
        sseEvent("response.output_text.done", {
          output_index: 0,
          item_id: "msg_part_prefix",
          content_index: 0,
          text: "prefix",
        }),
        sseEvent("response.content_part.done", {
          output_index: 0,
          item_id: "msg_part_prefix",
          content_index: 0,
          part: { type: "output_text", text: "prefix" },
        }),
        sseEvent("response.output_item.done", {
          output_index: 0,
          item: {
            type: "message",
            id: "msg_part_prefix",
            role: "assistant",
            content: [{ type: "output_text", text: "prefix" }],
          },
        }),
        completed("resp_part_prefix"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    expect(await drain(client)).not.toContain("response.failed");
  });

  test.each([
    {
      name: "part completion changing initial content",
      events:
        sseEvent("response.content_part.added", {
          output_index: 0,
          item_id: "msg_part_order",
          content_index: 0,
          part: { type: "output_text", text: "secret" },
        }) +
        sseEvent("response.content_part.done", {
          output_index: 0,
          item_id: "msg_part_order",
          content_index: 0,
          part: { type: "output_text", text: "safe" },
        }),
    },
    {
      name: "part added after text completion",
      events:
        sseEvent("response.output_text.done", {
          output_index: 0,
          item_id: "msg_part_order",
          content_index: 0,
          text: "safe",
        }) +
        sseEvent("response.content_part.added", {
          output_index: 0,
          item_id: "msg_part_order",
          content_index: 0,
          part: { type: "output_text", text: "evil" },
        }) +
        sseEvent("response.content_part.done", {
          output_index: 0,
          item_id: "msg_part_order",
          content_index: 0,
          part: { type: "output_text", text: "safe" },
        }),
    },
  ])("rejects $name", async ({ events }) => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_part_order", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: { type: "message", id: "msg_part_order", role: "assistant" },
        }),
        events,
        sseEvent("response.output_item.done", {
          output_index: 0,
          item: {
            type: "message",
            id: "msg_part_order",
            role: "assistant",
            content: [{ type: "output_text", text: "safe" }],
          },
        }),
        completed("resp_part_order"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    expect(await drain(client)).toContain("response.failed");
  });

  test("accepts reasoning summary prefixes extended by deltas", async () => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_summary_prefix", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: {
            type: "reasoning",
            id: "rs_summary_prefix",
            summary: [{ type: "summary_text", text: "pre" }],
          },
        }),
        sseEvent("response.reasoning_summary_part.added", {
          output_index: 0,
          item_id: "rs_summary_prefix",
          summary_index: 0,
          part: { type: "summary_text", text: "pre" },
        }),
        sseEvent("response.reasoning_summary_text.delta", {
          output_index: 0,
          item_id: "rs_summary_prefix",
          summary_index: 0,
          delta: "fix",
        }),
        sseEvent("response.reasoning_summary_text.done", {
          output_index: 0,
          item_id: "rs_summary_prefix",
          summary_index: 0,
          text: "prefix",
        }),
        sseEvent("response.reasoning_summary_part.done", {
          output_index: 0,
          item_id: "rs_summary_prefix",
          summary_index: 0,
          part: { type: "summary_text", text: "prefix" },
        }),
        sseEvent("response.output_item.done", {
          output_index: 0,
          item: {
            type: "reasoning",
            id: "rs_summary_prefix",
            summary: [{ type: "summary_text", text: "prefix" }],
          },
        }),
        completed("resp_summary_prefix"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    expect(await drain(client)).not.toContain("response.failed");
  });

  test("accepts indexed reasoning-text content lifecycles", async () => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_reasoning_text", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: { type: "reasoning", id: "rs_text", content: [] },
        }),
        sseEvent("response.content_part.added", {
          output_index: 0,
          item_id: "rs_text",
          content_index: 0,
          part: { type: "reasoning_text", text: "pre" },
        }),
        sseEvent("response.reasoning_text.delta", {
          output_index: 0,
          item_id: "rs_text",
          content_index: 0,
          delta: "fix",
        }),
        sseEvent("response.reasoning_text.done", {
          output_index: 0,
          item_id: "rs_text",
          content_index: 0,
          text: "prefix",
        }),
        sseEvent("response.content_part.done", {
          output_index: 0,
          item_id: "rs_text",
          content_index: 0,
          part: { type: "reasoning_text", text: "prefix" },
        }),
        sseEvent("response.output_item.done", {
          output_index: 0,
          item: {
            type: "reasoning",
            id: "rs_text",
            content: [{ type: "reasoning_text", text: "prefix" }],
          },
        }),
        completed("resp_reasoning_text"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    expect(await drain(client)).not.toContain("response.failed");
  });

  test("rejects reasoning deltas after text completion", async () => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_reasoning_late_delta", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: { type: "reasoning", id: "rs_late_delta", summary: [] },
        }),
        sseEvent("response.reasoning_summary_text.done", {
          output_index: 0,
          item_id: "rs_late_delta",
          summary_index: 0,
          text: "safe",
        }),
        sseEvent("response.reasoning_summary_text.delta", {
          output_index: 0,
          item_id: "rs_late_delta",
          summary_index: 0,
          delta: "evil",
        }),
        sseEvent("response.output_item.done", {
          output_index: 0,
          item: {
            type: "reasoning",
            id: "rs_late_delta",
            summary: [{ type: "summary_text", text: "safe" }],
          },
        }),
        completed("resp_reasoning_late_delta"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    expect(await drain(client)).toContain("response.failed");
  });

  test("rejects output_item.done changing reasoning text", async () => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_reasoning_text_changed", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: { type: "reasoning", id: "rs_text_changed", content: [] },
        }),
        sseEvent("response.reasoning_text.done", {
          output_index: 0,
          item_id: "rs_text_changed",
          content_index: 0,
          text: "secret",
        }),
        sseEvent("response.output_item.done", {
          output_index: 0,
          item: {
            type: "reasoning",
            id: "rs_text_changed",
            content: [{ type: "reasoning_text", text: "safe" }],
          },
        }),
        completed("resp_reasoning_text_changed"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    expect(await drain(client)).toContain("response.failed");
  });

  test("rejects reuse of an item_reference index in a continuation", async () => {
    const followUp = streamFrom([
      created("resp_reference_reuse_followup", "gpt-5.6-terra"),
      sseEvent("response.output_item.added", {
        output_index: 0,
        item: { type: "item_reference", id: "msg_server_followup" },
      }),
      sseEvent("response.output_item.done", {
        output_index: 0,
        item: { type: "item_reference", id: "msg_server_followup" },
      }),
      recallCall(0, { query: "hidden followup" }),
      completed("resp_reference_reuse_followup"),
    ]);
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_reference_reuse_principal", "gpt-5.6-terra"),
        recallCall(0, { query: "start" }),
        completed("resp_reference_reuse_principal"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({
          anchorText: "recalled",
          resultText: "result",
        }),
        runFollowUp: async () => ({ reader: followUp.body!.getReader() }),
      },
    );

    expect(await drain(client)).toContain(PUBLIC_RECALL_ERROR);
  });

  test("rejects content-part declarations after value deltas", async () => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_late_part", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: { type: "message", id: "msg_late_part", role: "assistant" },
        }),
        sseEvent("response.output_text.delta", {
          output_index: 0,
          item_id: "msg_late_part",
          content_index: 0,
          delta: "text",
        }),
        sseEvent("response.content_part.added", {
          output_index: 0,
          item_id: "msg_late_part",
          content_index: 0,
          part: { type: "output_text", text: "text" },
        }),
        sseEvent("response.output_text.done", {
          output_index: 0,
          item_id: "msg_late_part",
          content_index: 0,
          text: "text",
        }),
        sseEvent("response.content_part.done", {
          output_index: 0,
          item_id: "msg_late_part",
          content_index: 0,
          part: { type: "output_text", text: "text" },
        }),
        sseEvent("response.output_item.done", {
          output_index: 0,
          item: {
            type: "message",
            id: "msg_late_part",
            role: "assistant",
            content: [{ type: "output_text", text: "text" }],
          },
        }),
        completed("resp_late_part"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    expect(await drain(client)).toContain("response.failed");
  });

  test("uses the finalized content position for interleaved recall items", async () => {
    let observedPosition = -1;
    const followUp = streamFrom([
      created("resp_interleaved_followup", "gpt-5.6-terra"),
      textItem(0, "answer", "msg_interleaved_answer"),
      completed("resp_interleaved_followup"),
    ]);
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_interleaved", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: { type: "message", id: "msg_interleaved", role: "assistant" },
        }),
        recallCall(1, { query: "position" }),
        sseEvent("response.output_text.done", {
          output_index: 0,
          item_id: "msg_interleaved",
          content_index: 0,
          text: "earlier",
        }),
        sseEvent("response.output_item.done", {
          output_index: 0,
          item: {
            type: "message",
            id: "msg_interleaved",
            role: "assistant",
            content: [{ type: "output_text", text: "earlier" }],
          },
        }),
        completed("resp_interleaved"),
      ]),
      {
        onComplete: () => {},
        onRecall: async ({ contentPosition }) => {
          observedPosition = contentPosition;
          return { anchorText: "recalled", resultText: "result" };
        },
        runFollowUp: async () => ({ reader: followUp.body!.getReader() }),
      },
    );

    expect(await drain(client)).not.toContain(PUBLIC_RECALL_ERROR);
    expect(observedPosition).toBe(1);
  });

  test("rejects non-completed recall output items without executing them", async () => {
    let recalled = 0;
    const args = JSON.stringify({ query: "must not execute" });
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_failed_recall_item", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_failed_recall",
            call_id: "call_failed_recall",
            name: "recall",
          },
        }),
        sseEvent("response.function_call_arguments.done", {
          output_index: 0,
          item_id: "fc_failed_recall",
          arguments: args,
        }),
        sseEvent("response.output_item.done", {
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_failed_recall",
            call_id: "call_failed_recall",
            name: "recall",
            arguments: args,
            status: "failed",
          },
        }),
        completed("resp_failed_recall_item"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => {
          recalled++;
          return { anchorText: "", resultText: "" };
        },
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    expect(await drain(client)).toContain(PUBLIC_RECALL_ERROR);
    expect(recalled).toBe(0);
  });

  test("rejects terminal-only failed recall status without executing it", async () => {
    let recalled = 0;
    const args = JSON.stringify({ query: "terminal failure" });
    const streamedItem = {
      type: "function_call",
      id: "fc_terminal_failed_recall",
      call_id: "call_terminal_failed_recall",
      name: "recall",
      arguments: args,
    };
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_terminal_failed_recall", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: streamedItem,
        }),
        sseEvent("response.function_call_arguments.done", {
          output_index: 0,
          item_id: "fc_terminal_failed_recall",
          arguments: args,
        }),
        sseEvent("response.output_item.done", {
          output_index: 0,
          item: streamedItem,
        }),
        sseEvent("response.completed", {
          response: {
            id: "resp_terminal_failed_recall",
            model: "gpt-5.6-terra",
            status: "completed",
            output: [{ ...streamedItem, status: "failed" }],
          },
        }),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => {
          recalled++;
          return { anchorText: "", resultText: "" };
        },
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    expect(await drain(client)).toContain(PUBLIC_RECALL_ERROR);
    expect(recalled).toBe(0);
  });

  test("rejects nonterminal response.done status without executing recall", async () => {
    let recalled = 0;
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_nonterminal_done", "gpt-5.6-terra"),
        recallCall(0, { query: "not terminal" }),
        doneWithStatus("resp_nonterminal_done", "in_progress"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => {
          recalled++;
          return { anchorText: "", resultText: "" };
        },
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    expect(await drain(client)).toContain(PUBLIC_RECALL_ERROR);
    expect(recalled).toBe(0);
  });

  test.each(["response.created", "response.in_progress"])(
    "rejects hidden output in %s snapshots",
    async (event) => {
      let recalled = 0;
      const snapshot = sseEvent(event, {
        response: {
          id: "resp_snapshot_output",
          model: "gpt-5.6-terra",
          status: "in_progress",
          output: [
            {
              type: "function_call",
              id: "fc_snapshot_recall",
              call_id: "call_snapshot_recall",
              name: "recall",
              arguments: '{"query":"leaked"}',
            },
          ],
        },
      });
      const events =
        event === "response.created"
          ? [snapshot]
          : [created("resp_snapshot_output", "gpt-5.6-terra"), snapshot];
      const client = streamResponsesRecallAware(streamFrom(events), {
        onComplete: () => {},
        onRecall: async () => {
          recalled++;
          return { anchorText: "", resultText: "" };
        },
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      });

      const output = await drain(client);
      expect(output).toContain("response.failed");
      expect(output).not.toContain("fc_snapshot_recall");
      expect(recalled).toBe(0);
    },
  );

  test.each(["response.created", "response.in_progress"])(
    "rejects contradictory status in %s snapshots",
    async (event) => {
      const snapshot = sseEvent(event, {
        response: {
          id: "resp_snapshot_status",
          model: "gpt-5.6-terra",
          status: "failed",
          output: [],
        },
      });
      const events =
        event === "response.created"
          ? [snapshot]
          : [created("resp_snapshot_status", "gpt-5.6-terra"), snapshot];
      const client = streamResponsesRecallAware(streamFrom(events), {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      });

      expect(await drain(client)).toContain("response.failed");
    },
  );

  test("preserves failed companion-tool status in rebuilt terminals", async () => {
    const companionArgs = "{}";
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_failed_companion", "gpt-5.6-terra"),
        recallCall(0, { query: "companion" }),
        sseEvent("response.output_item.added", {
          output_index: 1,
          item: {
            type: "function_call",
            id: "fc_failed_companion",
            call_id: "call_failed_companion",
            name: "read",
            status: "in_progress",
          },
        }),
        sseEvent("response.function_call_arguments.done", {
          output_index: 1,
          item_id: "fc_failed_companion",
          arguments: companionArgs,
        }),
        sseEvent("response.output_item.done", {
          output_index: 1,
          item: {
            type: "function_call",
            id: "fc_failed_companion",
            call_id: "call_failed_companion",
            name: "read",
            arguments: companionArgs,
          },
        }),
        sseEvent("response.completed", {
          response: {
            id: "resp_failed_companion",
            model: "gpt-5.6-terra",
            status: "completed",
            output: [
              {
                type: "function_call",
                id: "fc_failed_companion",
                call_id: "call_failed_companion",
                name: "read",
                arguments: companionArgs,
                status: "failed",
              },
            ],
          },
        }),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({
          anchorText: "recalled",
          resultText: "result",
        }),
        runFollowUp: async () => {
          throw new Error("mixed tools should not run a follow-up");
        },
      },
    );

    const output = await drain(client);
    expect(output).not.toContain(PUBLIC_RECALL_ERROR);
    expect(output).toContain(
      '"id":"fc_failed_companion","call_id":"call_failed_companion","name":"read","arguments":"{}","status":"failed"',
    );
    expect(output).not.toContain(
      '"id":"fc_failed_companion","call_id":"call_failed_companion","name":"read","arguments":"{}","status":"completed"',
    );
  });

  test("rejects reference identities reused by later output items", async () => {
    let recalled = 0;
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_reference_identity", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: { type: "item_reference", id: "call_shared_reference" },
        }),
        sseEvent("response.output_item.done", {
          output_index: 0,
          item: { type: "item_reference", id: "call_shared_reference" },
        }),
        recallCall(
          1,
          { query: "identity" },
          "fc_reference_identity",
          "call_shared_reference",
        ),
        completed("resp_reference_identity"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => {
          recalled++;
          return { anchorText: "", resultText: "" };
        },
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    expect(await drain(client)).toContain(PUBLIC_RECALL_ERROR);
    expect(recalled).toBe(0);
  });

  test("rejects reference identities colliding with synthetic markers", async () => {
    let recalled = 0;
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_reference_marker", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: {
            type: "item_reference",
            id: "msg_resp_reference_marker_1",
          },
        }),
        sseEvent("response.output_item.done", {
          output_index: 0,
          item: {
            type: "item_reference",
            id: "msg_resp_reference_marker_1",
          },
        }),
        recallCall(1, { query: "marker identity" }),
        completed("resp_reference_marker"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => {
          recalled++;
          return { anchorText: "", resultText: "" };
        },
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    expect(await drain(client)).toContain(PUBLIC_RECALL_ERROR);
    expect(recalled).toBe(0);
  });

  test("rejects reasoning-part declarations after summary deltas", async () => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_late_summary_part", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: { type: "reasoning", id: "rs_late_part", summary: [] },
        }),
        sseEvent("response.reasoning_summary_text.delta", {
          output_index: 0,
          item_id: "rs_late_part",
          summary_index: 0,
          delta: "summary",
        }),
        sseEvent("response.reasoning_summary_part.added", {
          output_index: 0,
          item_id: "rs_late_part",
          summary_index: 0,
          part: { type: "summary_text", text: "summary" },
        }),
        sseEvent("response.reasoning_summary_text.done", {
          output_index: 0,
          item_id: "rs_late_part",
          summary_index: 0,
          text: "summary",
        }),
        sseEvent("response.reasoning_summary_part.done", {
          output_index: 0,
          item_id: "rs_late_part",
          summary_index: 0,
          part: { type: "summary_text", text: "summary" },
        }),
        sseEvent("response.output_item.done", {
          output_index: 0,
          item: {
            type: "reasoning",
            id: "rs_late_part",
            summary: [{ type: "summary_text", text: "summary" }],
          },
        }),
        completed("resp_late_summary_part"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    expect(await drain(client)).toContain("response.failed");
  });

  test("rejects continuation index arithmetic beyond safe integers", async () => {
    const followUp = streamFrom([
      created("resp_index_overflow_followup", "gpt-5.6-terra"),
      textItem(0, "first", "msg_index_overflow_first"),
      textItem(1, "second", "msg_index_overflow_second"),
      completed("resp_index_overflow_followup"),
    ]);
    const maxIndex = Number.MAX_SAFE_INTEGER;
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_index_overflow", "gpt-5.6-terra"),
        recallCall(maxIndex, { query: "overflow" }),
        completed("resp_index_overflow"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({
          anchorText: "recalled",
          resultText: "result",
        }),
        runFollowUp: async () => ({ reader: followUp.body!.getReader() }),
      },
    );

    const output = await drain(client);
    expect(output).toContain(PUBLIC_RECALL_ERROR);
    expect(output).not.toContain('"output_index":9007199254740992');
  });

  test("rejects usage overflow while merging a continuation", async () => {
    const followUp = streamFrom([
      created("resp_usage_overflow_followup", "gpt-5.6-terra"),
      textItem(0, "answer", "msg_usage_overflow"),
      completed("resp_usage_overflow_followup", {
        input_tokens: 1,
        output_tokens: 0,
      }),
    ]);
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_usage_overflow", "gpt-5.6-terra"),
        recallCall(0, { query: "usage" }),
        completed("resp_usage_overflow", {
          input_tokens: Number.MAX_SAFE_INTEGER,
          output_tokens: 0,
        }),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({
          anchorText: "recalled",
          resultText: "result",
        }),
        runFollowUp: async () => ({ reader: followUp.body!.getReader() }),
      },
    );

    const output = await drain(client);
    expect(output).toContain(PUBLIC_RECALL_ERROR);
    expect(output).not.toContain('"input_tokens":null');
  });

  test("rejects per-response usage overflow before recall side effects", async () => {
    let recalled = 0;
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_usage_total_overflow", "gpt-5.6-terra"),
        recallCall(0, { query: "usage" }),
        completed("resp_usage_total_overflow", {
          input_tokens: Number.MAX_SAFE_INTEGER,
          output_tokens: 1,
        }),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => {
          recalled++;
          return { anchorText: "", resultText: "" };
        },
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    expect(await drain(client)).toContain(PUBLIC_RECALL_ERROR);
    expect(recalled).toBe(0);
  });

  test("rejects impossible cache usage before recall side effects", async () => {
    let recalled = 0;
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_cache_usage_overflow", "gpt-5.6-terra"),
        recallCall(0, { query: "usage" }),
        completed("resp_cache_usage_overflow", {
          input_tokens: 0,
          output_tokens: 1,
          input_tokens_details: {
            cached_tokens: Number.MAX_SAFE_INTEGER,
          },
        }),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => {
          recalled++;
          return { anchorText: "", resultText: "" };
        },
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    expect(await drain(client)).toContain(PUBLIC_RECALL_ERROR);
    expect(recalled).toBe(0);
  });

  test("rejects cache usage without input_tokens before recall", async () => {
    let recalled = 0;
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_cache_without_input", "gpt-5.6-terra"),
        recallCall(0, { query: "usage" }),
        completed("resp_cache_without_input", {
          output_tokens: 1,
          input_tokens_details: {
            cached_tokens: Number.MAX_SAFE_INTEGER,
          },
        }),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => {
          recalled++;
          return { anchorText: "", resultText: "" };
        },
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    expect(await drain(client)).toContain(PUBLIC_RECALL_ERROR);
    expect(recalled).toBe(0);
  });

  test("rejects cross-phase usage overflow before chained recall", async () => {
    let recalled = 0;
    const followUp = streamFrom([
      created("resp_chained_usage_overflow", "gpt-5.6-terra"),
      recallCall(0, { query: "second" }),
      completed("resp_chained_usage_overflow", {
        input_tokens: 0,
        output_tokens: 1,
      }),
    ]);
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_chained_usage_principal", "gpt-5.6-terra"),
        recallCall(0, { query: "first" }),
        completed("resp_chained_usage_principal", {
          input_tokens: Number.MAX_SAFE_INTEGER,
          output_tokens: 0,
        }),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => {
          recalled++;
          return { anchorText: "recalled", resultText: "result" };
        },
        runFollowUp: async () => ({ reader: followUp.body!.getReader() }),
      },
    );

    expect(await drain(client)).toContain(PUBLIC_RECALL_ERROR);
    expect(recalled).toBe(1);
  });

  test("preserves content_filter continuation terminal and item metadata", async () => {
    const citation = {
      type: "url_citation",
      start_index: 0,
      end_index: 6,
      url: "https://example.com/lore",
      title: "Lore",
    };
    const followUp = streamFrom([
      created("resp_terminal_metadata_followup", "gpt-5.6-terra"),
      textItem(0, "answer", "msg_terminal_metadata_followup"),
      sseEvent("response.incomplete", {
        response: {
          id: "resp_terminal_metadata_followup",
          model: "gpt-5.6-terra",
          status: "incomplete",
          incomplete_details: { reason: "content_filter" },
          output: [
            {
              type: "message",
              id: "msg_terminal_metadata_followup",
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: "answer",
                  annotations: [citation],
                },
              ],
            },
          ],
        },
      }),
    ]);
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_terminal_metadata_principal", "gpt-5.6-terra"),
        recallCall(0, { query: "metadata" }),
        completed("resp_terminal_metadata_principal"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({
          anchorText: "recalled",
          resultText: "result",
        }),
        runFollowUp: async () => ({ reader: followUp.body!.getReader() }),
      },
    );

    const output = await drain(client);
    expect(output).toContain('"reason":"content_filter"');
    expect(output).toContain('"status":"incomplete"');
    expect(output).toContain("https://example.com/lore");
    expect(output).not.toContain(PUBLIC_RECALL_ERROR);
  });

  test("rejects continuation references colliding with principal identities", async () => {
    const followUp = streamFrom([
      created("resp_reference_collision_followup", "gpt-5.6-terra"),
      sseEvent("response.output_item.added", {
        output_index: 0,
        item: { type: "item_reference", id: "call_principal_recall" },
      }),
      sseEvent("response.output_item.done", {
        output_index: 0,
        item: { type: "item_reference", id: "call_principal_recall" },
      }),
      textItem(1, "answer", "msg_reference_collision_answer"),
      completed("resp_reference_collision_followup"),
    ]);
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_reference_collision_principal", "gpt-5.6-terra"),
        recallCall(
          0,
          { query: "collision" },
          "fc_principal_recall",
          "call_principal_recall",
        ),
        completed("resp_reference_collision_principal"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({
          anchorText: "recalled",
          resultText: "result",
        }),
        runFollowUp: async () => ({ reader: followUp.body!.getReader() }),
      },
    );

    expect(await drain(client)).toContain(PUBLIC_RECALL_ERROR);
  });

  test("accepts reasoning-only recall continuations", async () => {
    const followUp = streamFrom([
      created("resp_reasoning_only_followup", "gpt-5.6-terra"),
      sseEvent("response.output_item.added", {
        output_index: 0,
        item: { type: "reasoning", id: "rs_only", summary: [] },
      }),
      sseEvent("response.output_item.done", {
        output_index: 0,
        item: { type: "reasoning", id: "rs_only", summary: [] },
      }),
      completed("resp_reasoning_only_followup"),
    ]);
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_reasoning_only_principal", "gpt-5.6-terra"),
        recallCall(0, { query: "reason" }),
        completed("resp_reasoning_only_principal"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({
          anchorText: "recalled",
          resultText: "result",
        }),
        runFollowUp: async () => ({ reader: followUp.body!.getReader() }),
      },
    );

    const output = await drain(client);
    expect(output).toContain('"id":"rs_only"');
    expect(output).not.toContain(PUBLIC_RECALL_ERROR);
  });

  test.each([
    {
      name: "duplicate argument completion",
      extra: sseEvent("response.function_call_arguments.done", {
        output_index: 0,
        item_id: "fc_0",
        arguments: JSON.stringify({ query: "changed" }),
      }),
    },
    {
      name: "argument delta after completion",
      extra: sseEvent("response.function_call_arguments.delta", {
        output_index: 0,
        item_id: "fc_0",
        delta: "changed",
      }),
    },
  ])("rejects $name", async ({ extra }) => {
    let recalled = 0;
    const callWithoutItemDone =
      sseEvent("response.output_item.added", {
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_0",
          call_id: "call_0",
          name: "recall",
        },
      }) +
      sseEvent("response.function_call_arguments.done", {
        output_index: 0,
        item_id: "fc_0",
        arguments: JSON.stringify({ query: "original" }),
      });
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_lifecycle", "gpt-5.6-terra"),
        callWithoutItemDone,
        extra,
        completed("resp_lifecycle"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => {
          recalled++;
          return { anchorText: "", resultText: "" };
        },
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );
    expect(await drain(client)).toContain(PUBLIC_RECALL_ERROR);
    expect(recalled).toBe(0);
  });

  test("rejects output_item.done arguments that differ from completed arguments", async () => {
    let recalled = 0;
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_argument_toctou", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_toctou",
            call_id: "call_toctou",
            name: "recall",
          },
        }),
        sseEvent("response.function_call_arguments.done", {
          output_index: 0,
          item_id: "fc_toctou",
          arguments: JSON.stringify({ query: "original" }),
        }),
        sseEvent("response.output_item.done", {
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_toctou",
            call_id: "call_toctou",
            name: "recall",
            arguments: JSON.stringify({ query: "changed" }),
          },
        }),
        completed("resp_argument_toctou"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => {
          recalled++;
          return { anchorText: "", resultText: "" };
        },
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );
    expect(await drain(client)).toContain(PUBLIC_RECALL_ERROR);
    expect(recalled).toBe(0);
  });

  test.each([
    {
      name: "refusal on a function call",
      item: {
        type: "function_call",
        id: "fc_wrong_refusal",
        call_id: "call_wrong_refusal",
        name: "read",
      },
      event: sseEvent("response.refusal.delta", {
        output_index: 0,
        item_id: "fc_wrong_refusal",
        content_index: 0,
        delta: "cannot",
      }),
    },
    {
      name: "reasoning summary on a message",
      item: { type: "message", id: "msg_wrong_reasoning", role: "assistant" },
      event: sseEvent("response.reasoning_summary_text.delta", {
        output_index: 0,
        item_id: "msg_wrong_reasoning",
        summary_index: 0,
        delta: "summary",
      }),
    },
  ])("rejects $name", async ({ item, event }) => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_wrong_item_type", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", { output_index: 0, item }),
        event,
        completed("resp_wrong_item_type"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );
    expect(await drain(client)).toContain("response.failed");
  });

  test("rejects a recall item missing output_item.done", async () => {
    const incompleteCall =
      sseEvent("response.output_item.added", {
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_incomplete",
          call_id: "call_incomplete",
          name: "recall",
        },
      }) +
      sseEvent("response.function_call_arguments.done", {
        output_index: 0,
        item_id: "fc_incomplete",
        arguments: JSON.stringify({ query: "architecture" }),
      });
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_incomplete_call", "gpt-5.6-terra"),
        incompleteCall,
        completed("resp_incomplete_call"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );
    expect(await drain(client)).toContain(PUBLIC_RECALL_ERROR);
  });

  test("caps chained recall depth", async () => {
    const chained = streamFrom([
      created("resp_chained", "gpt-5.6-terra"),
      recallCall(0, { query: "detail" }),
      completed("resp_chained"),
    ]);
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_first", "gpt-5.6-terra"),
        recallCall(0, { query: "architecture" }),
        completed("resp_first"),
      ]),
      {
        maxRecallDepth: 0,
        onComplete: () => {},
        onRecall: async ({ query }) => ({
          anchorText: buildAnchor(query),
          resultText: "results",
        }),
        runFollowUp: async () => ({ reader: chained.body!.getReader() }),
      },
    );

    const out = await drain(client);
    expect(out).toContain(PUBLIC_RECALL_ERROR);
  });

  test("allows the final answer after one recall at depth one", async () => {
    const final = streamFrom([
      created("resp_final", "gpt-5.6-terra"),
      textItem(0, "final answer"),
      completed("resp_final"),
    ]);
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_first", "gpt-5.6-terra"),
        recallCall(0, { query: "architecture" }),
        completed("resp_first"),
      ]),
      {
        maxRecallDepth: 1,
        onComplete: () => {},
        onRecall: async () => ({
          anchorText: buildAnchor("architecture"),
          resultText: "results",
        }),
        runFollowUp: async () => ({ reader: final.body!.getReader() }),
      },
    );

    const out = await drain(client);
    expect(out).toContain("final answer");
    expect(out).not.toContain("depth exhausted");
    expect(out.match(/^event: response\.completed$/gm)).toHaveLength(1);
  });

  test("recall-only: emits marker, pipes the continuation inline, rebuilds completed", async () => {
    // The follow-up stream includes its OWN lifecycle/terminal events
    // (response.created, response.in_progress, response.completed). These must
    // NEVER reach the client — the principal stream already emitted
    // response.created and we rebuild response.completed ourselves. Forwarding
    // them would duplicate init/terminal events and violate the SSE protocol.
    const followUpStream = streamFrom([
      created("resp_followup", "gpt-5.6-terra"),
      sseEvent("response.in_progress", {}),
      textItem(0, "Here is the answer from the continuation."),
      completed("resp_followup", { input_tokens: 5, output_tokens: 9 }),
    ]);

    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_first", "gpt-5.6-terra"),
        recallCall(0, { query: "architecture" }),
        completed("resp_first"),
      ]),
      {
        onComplete: (r) => {
          // The completed response has no recall tool_use and includes the
          // continuation text (merged) + hidden replay anchor.
          expect(r.content.some((b) => b.type === "tool_use")).toBe(false);
          const text = r.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("");
          expect(text).toContain("Here is the answer from the continuation.");
          expect(text).toContain(buildAnchor("architecture"));
        },
        onRecall: async ({ query }) => ({
          anchorText: buildAnchor(query),
          resultText: "architecture results",
        }),
        runFollowUp: async ({ acc, resultText }) => {
          expect(resultText).toBe("architecture results");
          expect(acc.content.length).toBeGreaterThan(0);
          return { reader: followUpStream.body!.getReader() };
        },
      },
    );
    const out = await drain(client);

    expect(out).toContain(buildAnchor("architecture"));
    expect(out).not.toContain("Searching");
    // Continuation text streamed inline.
    expect(out).toContain("Here is the answer from the continuation.");
    // Rebuilt terminal event.
    expect(out).toContain("response.completed");
    // No raw recall function_call leaked.
    expect(out).not.toMatch(/name":\s*"recall/);
    // The follow-up's OWN lifecycle/terminal events are suppressed — the
    // client sees exactly ONE response.created and ONE response.completed
    // (as `event:` boundaries; the rebuilt completed also carries
    // "type":"response.completed" in its payload, which is expected).
    expect(out.match(/^event: response\.created$/gm)).toHaveLength(1);
    expect(out.match(/^event: response\.completed$/gm)).toHaveLength(1);
    expect(out.match(/^event: response\.in_progress$/gm) ?? []).toHaveLength(0);
    const sequenceNumbers = [...out.matchAll(/"sequence_number":(\d+)/g)].map(
      (match) => Number(match[1]),
    );
    expect(sequenceNumbers).toEqual(sequenceNumbers.map((_, index) => index));
  });

  test("places continuation after deferred principal output without index collisions", async () => {
    const followUp = streamFrom([
      created("resp_followup", "gpt-5.6-terra"),
      textItem(0, "continuation"),
      completed("resp_followup"),
    ]);
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_collision", "gpt-5.6-terra"),
        recallCall(0, { query: "architecture" }),
        textItem(1, "principal"),
        completed("resp_collision"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({
          anchorText: buildAnchor("architecture"),
          resultText: "results",
        }),
        runFollowUp: async () => ({ reader: followUp.body!.getReader() }),
      },
    );

    const out = await drain(client);
    const terminal = JSON.parse(
      /event: response\.completed\ndata: (.+)/.exec(out)?.[1] ?? "{}",
    ) as { response?: { output?: Array<{ content?: unknown }> } };
    expect(out).toContain('"output_index":1');
    expect(out).toContain('"output_index":2');
    expect(JSON.stringify(terminal.response?.output)).toContain("principal");
    expect(JSON.stringify(terminal.response?.output)).toContain("continuation");
  });

  test("rejects continuation identities that collide with principal output", async () => {
    const followUp = streamFrom([
      created("resp_followup", "gpt-5.6-terra"),
      sseEvent("response.output_item.added", {
        output_index: 0,
        item: { type: "message", id: "fc_0", role: "assistant" },
      }),
      sseEvent("response.output_item.done", {
        output_index: 0,
        item: {
          type: "message",
          id: "fc_0",
          role: "assistant",
          status: "completed",
          content: [],
        },
      }),
      completed("resp_followup"),
    ]);
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_first", "gpt-5.6-terra"),
        recallCall(0, { query: "architecture" }),
        completed("resp_first"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({
          anchorText: buildAnchor("architecture"),
          resultText: "results",
        }),
        runFollowUp: async () => ({ reader: followUp.body!.getReader() }),
      },
    );

    const out = await drain(client);
    expect(out).toContain(PUBLIC_RECALL_ERROR);
    expect(out).not.toContain("lore-recall");
  });

  test("caps frames across the principal and chained continuations", async () => {
    const second = streamFrom([
      created("resp_frame_second", "gpt-5.6-terra"),
      recallCall(0, { query: "detail" }),
      completed("resp_frame_second"),
    ]);
    let recalls = 0;
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_frame_first", "gpt-5.6-terra"),
        recallCall(0, { query: "architecture" }),
        completed("resp_frame_first"),
      ]),
      {
        maxSSEFrames: 8,
        onComplete: () => {},
        onRecall: async ({ query }) => {
          recalls++;
          return {
            anchorText: buildAnchor(query),
            resultText: "results",
          };
        },
        runFollowUp: async () => ({ reader: second.body!.getReader() }),
      },
    );
    expect(await drain(client)).toContain(PUBLIC_RECALL_ERROR);
    expect(recalls).toBe(1);
  });

  test("caps hidden recall bytes across chained continuations", async () => {
    const firstRecall = recallCall(0, { query: "architecture" });
    const secondRecall = recallCall(0, { query: "detail" });
    const second = streamFrom([
      created("resp_bytes_second", "gpt-5.6-terra"),
      secondRecall,
      completed("resp_bytes_second"),
    ]);
    const oneRecallBytes = new TextEncoder().encode(firstRecall).byteLength;
    let recalls = 0;
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_bytes_first", "gpt-5.6-terra"),
        firstRecall,
        completed("resp_bytes_first"),
      ]),
      {
        maxDeferredBytes: 1024 * 1024,
        maxHiddenRecallBytes: oneRecallBytes + 32,
        onComplete: () => {},
        onRecall: async ({ query }) => {
          recalls++;
          return {
            anchorText: buildAnchor(query),
            resultText: "results",
          };
        },
        runFollowUp: async () => ({ reader: second.body!.getReader() }),
      },
    );
    expect(await drain(client)).toContain(PUBLIC_RECALL_ERROR);
    expect(recalls).toBe(1);
  });

  test("stops reading upstream while the client applies backpressure", async () => {
    const encoder = new TextEncoder();
    const events = [
      created("resp_backpressure", "gpt-5.6-terra"),
      sseEvent("response.in_progress", { type: "response.in_progress" }),
      completed("resp_backpressure"),
    ];
    let pulls = 0;
    const thirdPull = Promise.withResolvers<void>();
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          if (pulls === 3) thirdPull.resolve();
          const event = events.shift();
          if (event) controller.enqueue(encoder.encode(event));
          else controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    const client = streamResponsesRecallAware(upstream, {
      onComplete: () => {},
      onRecall: async () => ({ anchorText: "", resultText: "" }),
      runFollowUp: async () => {
        throw new Error("should not run");
      },
    });
    await thirdPull.promise;
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(pulls).toBe(3);
    const reader = client.body!.getReader();
    await reader.cancel();
  });

  test("bounds request-wide no-index stream bytes", async () => {
    const lifecycle = created("resp_stream_bytes", "gpt-5.6-terra");
    const client = streamResponsesRecallAware(
      streamFrom([
        lifecycle,
        sseEvent("response.in_progress", { padding: "x".repeat(128) }),
        completed("resp_stream_bytes"),
      ]),
      {
        maxStreamBytes: new TextEncoder().encode(lifecycle).byteLength + 1,
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );
    expect(await drain(client)).toContain("response.failed");
  });

  test("caps raw stream bytes across a continuation", async () => {
    const principal = [
      created("resp_stream_chain", "gpt-5.6-terra"),
      recallCall(0, { query: "architecture" }),
      completed("resp_stream_chain"),
    ];
    const continuationCreated = created(
      "resp_stream_chain_followup",
      "gpt-5.6-terra",
    );
    const followUp = streamFrom([
      continuationCreated,
      textItem(0, "answer"),
      completed("resp_stream_chain_followup"),
    ]);
    const client = streamResponsesRecallAware(streamFrom(principal), {
      maxStreamBytes:
        new TextEncoder().encode(principal.join("") + continuationCreated)
          .byteLength + 1,
      onComplete: () => {},
      onRecall: async () => ({
        anchorText: buildAnchor("architecture"),
        resultText: "results",
      }),
      runFollowUp: async () => ({ reader: followUp.body!.getReader() }),
    });
    expect(await drain(client)).toContain(PUBLIC_RECALL_ERROR);
  });

  test("caps retained indexed state across a continuation", async () => {
    const principal = [
      created("resp_retained_chain", "gpt-5.6-terra"),
      recallCall(0, { query: "architecture" }),
      completed("resp_retained_chain"),
    ];
    const retainedPrincipalBytes = principal
      .join("")
      .matchAll(/data: (.+)\n\n/g)
      .reduce((sum, match) => {
        const parsed = JSON.parse(match[1]) as Record<string, unknown>;
        return Object.hasOwn(parsed, "output_index")
          ? sum + new TextEncoder().encode(match[1]).byteLength
          : sum;
      }, 0);
    const followUp = streamFrom([
      created("resp_retained_followup", "gpt-5.6-terra"),
      textItem(0, "answer"),
      completed("resp_retained_followup"),
    ]);
    const client = streamResponsesRecallAware(streamFrom(principal), {
      maxRetainedStateBytes: retainedPrincipalBytes + 1,
      onComplete: () => {},
      onRecall: async () => ({
        anchorText: buildAnchor("architecture"),
        resultText: "results",
      }),
      runFollowUp: async () => ({ reader: followUp.body!.getReader() }),
    });
    expect(await drain(client)).toContain(PUBLIC_RECALL_ERROR);
  });

  test("shifts refusal event coordinates in a continuation", async () => {
    const followUp = streamFrom([
      created("resp_followup", "gpt-5.6-terra"),
      sseEvent("response.output_item.added", {
        output_index: 0,
        item: { type: "message", id: "msg_refusal", role: "assistant" },
      }),
      sseEvent("response.refusal.delta", {
        output_index: 0,
        item_id: "msg_refusal",
        content_index: 0,
        delta: "no",
      }),
      sseEvent("response.refusal.done", {
        output_index: 0,
        item_id: "msg_refusal",
        content_index: 0,
        refusal: "no",
      }),
      sseEvent("response.output_item.done", {
        output_index: 0,
        item: {
          type: "message",
          id: "msg_refusal",
          role: "assistant",
          status: "completed",
          content: [{ type: "refusal", refusal: "no" }],
        },
      }),
      completed("resp_followup"),
    ]);
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_first", "gpt-5.6-terra"),
        recallCall(0, { query: "architecture" }),
        completed("resp_first"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({
          anchorText: buildAnchor("architecture"),
          resultText: "results",
        }),
        runFollowUp: async () => ({ reader: followUp.body!.getReader() }),
      },
    );

    const out = await drain(client);
    expect(out).toContain("event: response.refusal.delta");
    expect(out).toContain('"output_index":1');
    expect(out).not.toContain(PUBLIC_RECALL_ERROR);
    const terminal = JSON.parse(
      /event: response\.completed\ndata: (.+)/.exec(out)?.[1] ?? "{}",
    ) as { response?: { output?: Array<Record<string, unknown>> } };
    expect(terminal.response?.output).toContainEqual(
      expect.objectContaining({
        id: "msg_refusal",
        content: [{ type: "refusal", refusal: "no" }],
      }),
    );
  });

  test("preserves refusal supplied only by output_item.done", async () => {
    let completedResponse: GatewayResponse | undefined;
    const followUp = streamFrom([
      created("resp_refusal_done", "gpt-5.6-terra"),
      sseEvent("response.output_item.added", {
        output_index: 0,
        item: { type: "message", id: "msg_refusal_done", role: "assistant" },
      }),
      sseEvent("response.output_item.done", {
        output_index: 0,
        item: {
          type: "message",
          id: "msg_refusal_done",
          role: "assistant",
          status: "completed",
          content: [{ type: "refusal", refusal: "cannot comply" }],
        },
      }),
      completed("resp_refusal_done"),
    ]);
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_first", "gpt-5.6-terra"),
        recallCall(0, { query: "architecture" }),
        completed("resp_first"),
      ]),
      {
        onComplete: (response) => {
          completedResponse = response;
        },
        onRecall: async () => ({
          anchorText: buildAnchor("architecture"),
          resultText: "results",
        }),
        runFollowUp: async () => ({ reader: followUp.body!.getReader() }),
      },
    );

    const out = await drain(client);
    expect(out).toContain('"type":"refusal"');
    expect(out).toContain("cannot comply");
    expect(JSON.stringify(completedResponse)).toContain("cannot comply");
  });

  test("rejects an upstream item that collides with the synthetic anchor ID", async () => {
    let recalled = 0;
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_collision", "gpt-5.6-terra"),
        recallCall(0, { query: "architecture" }),
        sseEvent("response.output_item.added", {
          output_index: 1,
          item: {
            type: "function_call",
            id: "msg_resp_collision_0",
            call_id: "call_read",
            name: "read",
          },
        }),
        sseEvent("response.function_call_arguments.done", {
          output_index: 1,
          item_id: "msg_resp_collision_0",
          arguments: "{}",
        }),
        sseEvent("response.output_item.done", {
          output_index: 1,
          item: {
            type: "function_call",
            id: "msg_resp_collision_0",
            call_id: "call_read",
            name: "read",
            arguments: "{}",
          },
        }),
        completed("resp_collision"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => {
          recalled++;
          return {
            anchorText: buildAnchor("architecture"),
            resultText: "results",
          };
        },
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    const out = await drain(client);
    expect(out).toContain(PUBLIC_RECALL_ERROR);
    expect(out).not.toContain("lore-recall");
    expect(recalled).toBe(0);
  });

  test("rejects continuation output using the reserved principal anchor ID", async () => {
    const continuation = streamFrom([
      created("resp_continuation_collision", "gpt-5.6-terra"),
      textItem(0, "collision", "msg_resp_principal_collision_0"),
      completed("resp_continuation_collision"),
    ]);
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_principal_collision", "gpt-5.6-terra"),
        recallCall(0, { query: "architecture" }),
        completed("resp_principal_collision"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({
          anchorText: buildAnchor("architecture"),
          resultText: "results",
        }),
        runFollowUp: async () => ({ reader: continuation.body!.getReader() }),
      },
    );
    expect(await drain(client)).toContain(PUBLIC_RECALL_ERROR);
  });

  test("counts refusal content before a recall position", async () => {
    let seenPosition = -1;
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_refusal_position", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: { type: "message", id: "msg_refusal", role: "assistant" },
        }),
        sseEvent("response.output_item.done", {
          output_index: 0,
          item: {
            type: "message",
            id: "msg_refusal",
            role: "assistant",
            status: "completed",
            content: [{ type: "refusal", refusal: "cannot" }],
          },
        }),
        recallCall(1, { query: "architecture" }),
        completed("resp_refusal_position"),
      ]),
      {
        onComplete: () => {},
        onRecall: async ({ contentPosition }) => {
          seenPosition = contentPosition;
          return {
            anchorText: buildAnchor("architecture"),
            resultText: "results",
          };
        },
        runFollowUp: async () => ({
          reader: streamFrom([
            created("resp_answer", "gpt-5.6-terra"),
            textItem(0, "answer"),
            completed("resp_answer"),
          ]).body!.getReader(),
        }),
      },
    );
    const out = await drain(client);
    expect(seenPosition).toBe(1);
    expect(out).not.toContain(PUBLIC_RECALL_ERROR);
  });

  test("counts every part in a multi-part message before recall", async () => {
    let seenPosition = -1;
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_multipart_position", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: { type: "message", id: "msg_multipart", role: "assistant" },
        }),
        sseEvent("response.output_text.done", {
          output_index: 0,
          item_id: "msg_multipart",
          content_index: 0,
          text: "preamble",
        }),
        sseEvent("response.refusal.done", {
          output_index: 0,
          item_id: "msg_multipart",
          content_index: 1,
          refusal: "cannot",
        }),
        sseEvent("response.output_item.done", {
          output_index: 0,
          item: {
            type: "message",
            id: "msg_multipart",
            role: "assistant",
            status: "completed",
            content: [
              { type: "output_text", text: "preamble" },
              { type: "refusal", refusal: "cannot" },
            ],
          },
        }),
        recallCall(1, { query: "architecture" }),
        completed("resp_multipart_position"),
      ]),
      {
        onComplete: () => {},
        onRecall: async ({ contentPosition }) => {
          seenPosition = contentPosition;
          return {
            anchorText: buildAnchor("architecture"),
            resultText: "results",
          };
        },
        runFollowUp: async () => ({
          reader: streamFrom([
            created("resp_multipart_answer", "gpt-5.6-terra"),
            textItem(0, "answer"),
            completed("resp_multipart_answer"),
          ]).body!.getReader(),
        }),
      },
    );
    const out = await drain(client);
    expect(seenPosition).toBe(2);
    expect(out).not.toContain(PUBLIC_RECALL_ERROR);
    const terminal = JSON.parse(
      /event: response\.completed\ndata: (.+)/.exec(out)?.[1] ?? "{}",
    ) as { response?: { output?: Array<Record<string, unknown>> } };
    expect(terminal.response?.output?.[0]).toMatchObject({
      id: "msg_multipart",
      content: [
        { type: "output_text", text: "preamble" },
        { type: "refusal", refusal: "cannot" },
      ],
    });
  });

  test("rejects a call_id that collides with the synthetic anchor ID", async () => {
    let recalled = 0;
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_cross_collision", "gpt-5.6-terra"),
        recallCall(0, { query: "architecture" }),
        sseEvent("response.output_item.added", {
          output_index: 1,
          item: {
            type: "function_call",
            id: "fc_read",
            call_id: "msg_resp_cross_collision_0",
            name: "read",
          },
        }),
        sseEvent("response.function_call_arguments.done", {
          output_index: 1,
          item_id: "fc_read",
          arguments: "{}",
        }),
        sseEvent("response.output_item.done", {
          output_index: 1,
          item: {
            type: "function_call",
            id: "fc_read",
            call_id: "msg_resp_cross_collision_0",
            name: "read",
            arguments: "{}",
          },
        }),
        completed("resp_cross_collision"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => {
          recalled++;
          return {
            anchorText: buildAnchor("architecture"),
            resultText: "results",
          };
        },
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );
    expect(await drain(client)).toContain(PUBLIC_RECALL_ERROR);
    expect(recalled).toBe(0);
  });

  test("rejects a chained recall call_id matching its future marker ID", async () => {
    const second = streamFrom([
      created("resp_second_collision", "gpt-5.6-terra"),
      recallCall(
        0,
        { query: "detail" },
        "fc_second_collision",
        "msg_resp_first_collision_1",
      ),
      completed("resp_second_collision"),
    ]);
    let recalls = 0;
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_first_collision", "gpt-5.6-terra"),
        recallCall(0, { query: "architecture" }),
        completed("resp_first_collision"),
      ]),
      {
        onComplete: () => {},
        onRecall: async ({ query }) => {
          recalls++;
          return {
            anchorText: buildAnchor(query),
            resultText: "results",
          };
        },
        runFollowUp: async () => ({ reader: second.body!.getReader() }),
      },
    );
    expect(await drain(client)).toContain(PUBLIC_RECALL_ERROR);
    expect(recalls).toBe(1);
  });

  test("rejects cross-field identity reuse between upstream items", async () => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_cross_fields", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_first",
            call_id: "call_shared",
            name: "read",
          },
        }),
        sseEvent("response.output_item.added", {
          output_index: 1,
          item: { type: "message", id: "call_shared", role: "assistant" },
        }),
        completed("resp_cross_fields"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );
    expect(await drain(client)).toContain(PUBLIC_RECALL_ERROR);
  });

  test("intercepts a chained recall before streaming its final continuation", async () => {
    const second = streamFrom([
      created("resp_second", "gpt-5.6-terra"),
      recallCall(0, { query: "detail" }, "fc_second", "call_second"),
      completed("resp_second"),
    ]);
    const final = streamFrom([
      created("resp_final", "gpt-5.6-terra"),
      textItem(0, "final answer", "msg_final"),
      completed("resp_final"),
    ]);
    const seen: string[] = [];
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_first", "gpt-5.6-terra"),
        recallCall(0, { query: "architecture" }),
        completed("resp_first"),
      ]),
      {
        onComplete: () => {},
        onRecall: async ({ query }) => {
          seen.push(query);
          return {
            anchorText: buildAnchor(query),
            resultText: `${query} results`,
          };
        },
        runFollowUp: async () => ({
          reader: (seen.length === 1 ? second : final).body!.getReader(),
        }),
      },
    );

    const out = await drain(client);
    expect(seen).toEqual(["architecture", "detail"]);
    expect(out).toContain("final answer");
    expect(out).not.toMatch(/name":\s*"recall/);
    expect(out.match(/^event: response\.completed$/gm)).toHaveLength(1);
  });

  test("rolls back intermediate continuation state when a later chain fails", async () => {
    const second = streamFrom([
      created("resp_second", "gpt-5.6-terra"),
      textItem(0, "intermediate", "msg_second"),
      recallCall(1, { query: "detail" }, "fc_second", "call_second"),
      completed("resp_second"),
    ]);
    let completedResponse: GatewayResponse | undefined;
    let followUps = 0;
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_first", "gpt-5.6-terra"),
        recallCall(0, { query: "architecture" }),
        completed("resp_first"),
      ]),
      {
        onComplete: (response) => {
          completedResponse = response;
        },
        onRecall: async ({ query }) => ({
          anchorText: buildAnchor(query),
          resultText: `${query} results`,
        }),
        runFollowUp: async () => {
          followUps++;
          if (followUps === 1) return { reader: second.body!.getReader() };
          throw new Error("later continuation failed");
        },
      },
    );

    const out = await drain(client);
    expect(out).toContain(PUBLIC_RECALL_ERROR);
    expect(out).not.toContain("intermediate");
    expect(out).not.toContain('"name":"recall"');
    expect(out).not.toContain("detail");
    expect(out).not.toContain("call_second");
    expect(JSON.stringify(completedResponse)).not.toContain("intermediate");
    expect(JSON.stringify(completedResponse)).not.toContain("lore-recall");
  });

  test("commits deferred recall persistence after a successful continuation", async () => {
    let committed = 0;
    let rolledBack = 0;
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_commit_success", "gpt-5.6-terra"),
        recallCall(0, { query: "architecture" }),
        completed("resp_commit_success"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({
          anchorText: buildAnchor("architecture"),
          resultText: "results",
          commit: () => committed++,
          rollback: () => rolledBack++,
        }),
        runFollowUp: async () => {
          const body = streamFrom([
            created("resp_commit_followup", "gpt-5.6-terra"),
            textItem(0, "answer", "msg_commit_answer"),
            completed("resp_commit_followup"),
          ]).body;
          if (!body) throw new Error("expected continuation body");
          return { reader: body.getReader() };
        },
      },
    );

    const out = await drain(client);
    expect(out).toContain("answer");
    expect(out.match(/^event: response\.completed$/gm)).toHaveLength(1);
    expect(committed).toBe(1);
    expect(rolledBack).toBe(0);
  });

  test("rolls back deferred persistence when a recall-only continuation fails", async () => {
    let committed = 0;
    let rolledBack = 0;
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_persist", "gpt-5.6-terra"),
        recallCall(0, { query: "architecture" }),
        completed("resp_persist"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({
          anchorText: buildAnchor("architecture"),
          resultText: "results",
          commit: () => committed++,
          rollback: () => rolledBack++,
        }),
        runFollowUp: async () => {
          throw new Error("follow-up failed");
        },
      },
    );

    const out = await drain(client);
    expect(out).toContain(PUBLIC_RECALL_ERROR);
    expect(committed).toBe(0);
    expect(rolledBack).toBe(1);
  });

  test("rolls back persistence without contradicting an already delivered terminal", async () => {
    let completedCalls = 0;
    let committed = 0;
    let rolledBack = 0;
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_complete_failure", "gpt-5.6-terra"),
        recallCall(0, { query: "architecture" }),
        completed("resp_complete_failure"),
      ]),
      {
        onComplete: () => {
          completedCalls++;
          throw new Error("postResponse failed");
        },
        onRecall: async () => ({
          anchorText: buildAnchor("architecture"),
          resultText: "results",
          commit: () => committed++,
          rollback: () => rolledBack++,
        }),
        runFollowUp: async () => ({
          reader: streamFrom([
            created("resp_followup", "gpt-5.6-terra"),
            textItem(0, "answer", "msg_answer"),
            completed("resp_followup"),
          ]).body!.getReader(),
        }),
      },
    );

    const out = await drain(client);
    expect(out).toContain("lore-recall");
    expect(out).toContain("answer");
    expect(out).not.toContain(PUBLIC_RECALL_ERROR);
    expect(out.match(/^event: response\.completed$/gm)).toHaveLength(1);
    expect(out).not.toContain("event: response.failed");
    expect(committed).toBe(0);
    expect(rolledBack).toBe(1);
    expect(completedCalls).toBe(1);
  });

  test("never commits when an abort-ignoring recall callback resolves late", async () => {
    let markRecallStarted: (() => void) | undefined;
    const recallStarted = new Promise<void>((resolve) => {
      markRecallStarted = resolve;
    });
    let resolveRecall: (() => void) | undefined;
    const recallReady = new Promise<void>((resolve) => {
      resolveRecall = resolve;
    });
    let committed = 0;
    let rolledBack = 0;
    const rollbackObserved = Promise.withResolvers<void>();
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_abort_commit", "gpt-5.6-terra"),
        recallCall(0, { query: "architecture" }),
        completed("resp_abort_commit"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => {
          markRecallStarted?.();
          await recallReady;
          return {
            anchorText: buildAnchor("architecture"),
            resultText: "results",
            commit: () => committed++,
            rollback: () => {
              rolledBack++;
              rollbackObserved.resolve();
            },
          };
        },
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );
    const reader = client.body!.getReader();
    await recallStarted;
    const cancelled = reader.cancel();
    resolveRecall?.();
    await cancelled;
    await rollbackObserved.promise;
    expect(committed).toBe(0);
    expect(rolledBack).toBe(1);
  });

  test("rolls back when the client disconnects after continuation delivery starts", async () => {
    let committed = 0;
    let completedCalls = 0;
    const rollbackObserved = Promise.withResolvers<void>();
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_mid_delivery_abort", "gpt-5.6-terra"),
        recallCall(0, { query: "architecture" }),
        completed("resp_mid_delivery_abort"),
      ]),
      {
        onComplete: () => completedCalls++,
        onRecall: async () => ({
          anchorText: buildAnchor("architecture"),
          resultText: "results",
          commit: () => committed++,
          rollback: () => rollbackObserved.resolve(),
        }),
        runFollowUp: async () => ({
          reader: streamFrom([
            created("resp_mid_delivery_followup", "gpt-5.6-terra"),
            textItem(0, "answer", "msg_mid_delivery_answer"),
            completed("resp_mid_delivery_followup"),
          ]).body!.getReader(),
        }),
      },
    );

    const reader = client.body!.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      expect(done).toBe(false);
      if (value && decoder.decode(value).includes("lore-recall")) break;
    }
    await reader.cancel();
    await rollbackObserved.promise;
    expect(committed).toBe(0);
    expect(completedCalls).toBe(0);
  });

  test("cancellation never waits for a non-settling recall callback", async () => {
    const recallStarted = Promise.withResolvers<void>();
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_pending_recall", "gpt-5.6-terra"),
        recallCall(0, { query: "architecture" }),
        completed("resp_pending_recall"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => {
          recallStarted.resolve();
          return new Promise<never>(() => {});
        },
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );
    const reader = client.body!.getReader();
    await recallStarted.promise;
    await expect(
      Promise.race([
        reader.cancel().then(() => "cancelled"),
        new Promise<string>((resolve) =>
          setImmediate(() => resolve("still pending")),
        ),
      ]),
    ).resolves.toBe("cancelled");
  });

  test("cancels a reader returned late by an abort-ignoring follow-up setup", async () => {
    const followUpStarted = Promise.withResolvers<void>();
    const releaseFollowUp = Promise.withResolvers<void>();
    const followUpCancelled = Promise.withResolvers<void>();
    let cancelCalls = 0;
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_abort_late_followup", "gpt-5.6-terra"),
        recallCall(0, { query: "architecture" }),
        completed("resp_abort_late_followup"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({
          anchorText: buildAnchor("architecture"),
          resultText: "results",
        }),
        runFollowUp: async () => {
          followUpStarted.resolve();
          await releaseFollowUp.promise;
          const stream = new ReadableStream<Uint8Array>({
            cancel() {
              cancelCalls++;
              followUpCancelled.resolve();
            },
          });
          return { reader: stream.getReader() };
        },
      },
    );
    const reader = client.body!.getReader();
    await followUpStarted.promise;
    const cancelled = reader.cancel();
    releaseFollowUp.resolve();
    await cancelled;
    await followUpCancelled.promise;
    expect(cancelCalls).toBe(1);
  });

  test("cancellation never waits for non-settling follow-up setup", async () => {
    const followUpStarted = Promise.withResolvers<void>();
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_pending_followup", "gpt-5.6-terra"),
        recallCall(0, { query: "architecture" }),
        completed("resp_pending_followup"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({
          anchorText: buildAnchor("architecture"),
          resultText: "results",
        }),
        runFollowUp: async () => {
          followUpStarted.resolve();
          return new Promise<never>(() => {});
        },
      },
    );
    const reader = client.body!.getReader();
    await followUpStarted.promise;
    await expect(
      Promise.race([
        reader.cancel().then(() => "cancelled"),
        new Promise<string>((resolve) =>
          setImmediate(() => resolve("still pending")),
        ),
      ]),
    ).resolves.toBe("cancelled");
  });

  test("foreground timeout settles a non-settling follow-up setup", async () => {
    const followUpStarted = Promise.withResolvers<void>();
    const foreground = new AbortController();
    let callbackSignal: AbortSignal | undefined;
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_timeout_followup", "gpt-5.6-terra"),
        recallCall(0, { query: "architecture" }),
        completed("resp_timeout_followup"),
      ]),
      {
        signal: foreground.signal,
        onComplete: () => {},
        onRecall: async () => ({
          anchorText: buildAnchor("architecture"),
          resultText: "results",
        }),
        runFollowUp: async ({ signal }) => {
          callbackSignal = signal;
          followUpStarted.resolve();
          return new Promise<never>(() => {});
        },
      },
    );
    const pending = drain(client);
    await followUpStarted.promise;
    foreground.abort(new DOMException("foreground timed out", "TimeoutError"));
    await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    expect(callbackSignal?.aborted).toBe(true);
  });

  test("foreground abort cancels and unlocks a hostile continuation reader", async () => {
    const foreground = new AbortController();
    const continuationStarted = Promise.withResolvers<void>();
    let cancelled = false;
    const continuation = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              created("resp_hostile_continuation", "gpt-5.6-terra"),
            ),
          );
        },
        pull() {
          continuationStarted.resolve();
          return new Promise(() => {});
        },
        cancel() {
          cancelled = true;
          return new Promise<void>(() => {});
        },
      }),
    );
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_hostile_principal", "gpt-5.6-terra"),
        recallCall(0, { query: "architecture" }),
        completed("resp_hostile_principal"),
      ]),
      {
        signal: foreground.signal,
        onComplete: () => {},
        onRecall: async () => ({
          anchorText: buildAnchor("architecture"),
          resultText: "results",
        }),
        runFollowUp: async () => ({ reader: continuation.body!.getReader() }),
      },
    );
    const pending = drain(client);
    await continuationStarted.promise;
    foreground.abort(new DOMException("caller aborted", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
    expect(continuation.body?.locked).toBe(false);
  });

  test("rejects a chained recall whose arguments never complete", async () => {
    const malformed = streamFrom([
      created("resp_malformed", "gpt-5.6-terra"),
      sseEvent("response.output_item.added", {
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_malformed",
          call_id: "call_malformed",
          name: "recall",
        },
      }),
      completed("resp_malformed"),
    ]);
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_first", "gpt-5.6-terra"),
        recallCall(0, { query: "architecture" }),
        completed("resp_first"),
      ]),
      {
        onComplete: () => {},
        onRecall: async ({ query }) => ({
          anchorText: buildAnchor(query),
          resultText: "results",
        }),
        runFollowUp: async () => ({ reader: malformed.body!.getReader() }),
      },
    );

    const out = await drain(client);
    expect(out).toContain(PUBLIC_RECALL_ERROR);
    expect(out).not.toContain("call_malformed");
    expect(out).not.toContain("response.completed");
  });

  test("rejects malformed completed recall arguments before execution", async () => {
    let executed = false;
    let completedResponse: unknown;
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_malformed_args", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_malformed",
            call_id: "call_malformed",
            name: "recall",
          },
        }),
        sseEvent("response.function_call_arguments.done", {
          output_index: 0,
          item_id: "fc_malformed",
          arguments: "{not json",
        }),
        completed("resp_malformed_args"),
      ]),
      {
        onComplete: (response) => {
          completedResponse = response;
        },
        onRecall: async () => {
          executed = true;
          return { anchorText: "", resultText: "" };
        },
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    const out = await drain(client);
    expect(executed).toBe(false);
    expect(out).toContain(PUBLIC_RECALL_ERROR);
    expect(out).toContain("response.failed");
    expect(out).not.toContain('"name":"recall"');
    expect(out).not.toContain("call_malformed");
    expect(JSON.stringify(completedResponse)).not.toContain("recall");
    expect(JSON.stringify(completedResponse)).not.toContain("call_malformed");
  });

  test.each([
    [
      "arguments before item declaration",
      sseEvent("response.function_call_arguments.done", {
        output_index: 0,
        arguments: '{"query":"secret"}',
      }),
    ],
    [
      "recall only revealed by item.done",
      sseEvent("response.output_item.done", {
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_late",
          call_id: "call_late",
          name: "recall",
          arguments: '{"query":"secret"}',
          status: "completed",
        },
      }),
    ],
    [
      "recall item without output index",
      sseEvent("response.output_item.added", {
        item: {
          type: "function_call",
          id: "fc_no_index",
          call_id: "call_no_index",
          name: "recall",
        },
      }),
    ],
    [
      "item identity changes at done",
      sseEvent("response.output_item.added", {
        output_index: 0,
        item: { type: "message", id: "msg_changed", role: "assistant" },
      }) +
        sseEvent("response.output_item.done", {
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_changed",
            call_id: "call_changed",
            name: "recall",
            arguments: '{"query":"secret"}',
          },
        }),
    ],
    [
      "function call omits its name at declaration",
      sseEvent("response.output_item.added", {
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_hidden",
          call_id: "call_hidden",
        },
      }) +
        sseEvent("response.output_item.done", {
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_hidden",
            call_id: "call_hidden",
            name: "recall",
          },
        }),
    ],
  ])("fails closed for malformed event ordering: %s", async (_name, event) => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_order", "gpt-5.6-terra"),
        event,
        completed("resp_order"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => {
          throw new Error("should not execute");
        },
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    const out = await drain(client);
    expect(out).toContain("response.failed");
    expect(out).not.toContain('"name":"recall"');
    expect(out).not.toContain("secret");
  });

  test("aborts an in-flight recall callback when the client disconnects", async () => {
    let callbackSignal: AbortSignal | undefined;
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    let settledResolve: (() => void) | undefined;
    const settled = new Promise<void>((resolve) => {
      settledResolve = resolve;
    });
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_abort_recall", "gpt-5.6-terra"),
        recallCall(0, { query: "architecture" }),
        completed("resp_abort_recall"),
      ]),
      {
        onComplete: () => {},
        onRecall: ({ signal }) => {
          callbackSignal = signal;
          startedResolve?.();
          return new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                settledResolve?.();
                reject(signal.reason);
              },
              { once: true },
            );
          });
        },
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    const reader = client.body!.getReader();
    await started;
    await reader.cancel();
    await settled;
    expect(callbackSignal?.aborted).toBe(true);
  });

  test("aborts in-flight follow-up setup when the client disconnects", async () => {
    let callbackSignal: AbortSignal | undefined;
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    let settledResolve: (() => void) | undefined;
    const settled = new Promise<void>((resolve) => {
      settledResolve = resolve;
    });
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_abort_followup", "gpt-5.6-terra"),
        recallCall(0, { query: "architecture" }),
        completed("resp_abort_followup"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({
          anchorText: buildAnchor("architecture"),
          resultText: "results",
        }),
        runFollowUp: ({ signal }) => {
          callbackSignal = signal;
          startedResolve?.();
          return new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                settledResolve?.();
                reject(signal.reason);
              },
              { once: true },
            );
          });
        },
      },
    );

    const reader = client.body!.getReader();
    await started;
    await reader.cancel();
    await settled;
    expect(callbackSignal?.aborted).toBe(true);
  });

  test.each([
    ['{"query":"x","scope":42}', "scope must be a string"],
    ['{"query":"x","extra":true}', "unknown property"],
    ['{"query":42}', "query must be a string"],
    ['{"query":"x","id":42}', "id must be a string"],
  ])("rejects strict recall arguments %s", async (argumentsJSON, message) => {
    let executed = false;
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_strict_args", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_strict",
            call_id: "call_strict",
            name: "recall",
          },
        }),
        sseEvent("response.function_call_arguments.done", {
          output_index: 0,
          item_id: "fc_strict",
          arguments: argumentsJSON,
        }),
        completed("resp_strict_args"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => {
          executed = true;
          return { anchorText: "", resultText: "" };
        },
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );

    const out = await drain(client);
    expect(executed).toBe(false);
    expect(out).not.toContain(message);
    expect(out).toContain(PUBLIC_RECALL_ERROR);
    expect(out).not.toContain('"name":"recall"');
  });

  test("accepts nullable strict optional recall arguments", async () => {
    let seen: { scope?: string; id?: string } | undefined;
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_nullable_args", "gpt-5.6-terra"),
        recallCall(0, { query: "architecture", scope: null, id: null }),
        completed("resp_nullable_args"),
      ]),
      {
        onComplete: () => {},
        onRecall: async ({ scope, id }) => {
          seen = { scope, id };
          return {
            anchorText: buildAnchor("architecture"),
            resultText: "results",
          };
        },
        runFollowUp: async () => ({
          reader: streamFrom([
            created("resp_nullable_followup", "gpt-5.6-terra"),
            textItem(0, "answer"),
            completed("resp_nullable_followup"),
          ]).body!.getReader(),
        }),
      },
    );

    const out = await drain(client);
    expect(seen).toEqual({ scope: undefined, id: undefined });
    expect(out).toContain("answer");
  });

  test("holds no-index continuation events after chained recall detection", async () => {
    const malformed = streamFrom([
      created("resp_malformed", "gpt-5.6-terra"),
      sseEvent("response.output_item.added", {
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_malformed",
          call_id: "call_malformed",
          name: "recall",
        },
      }),
      sseEvent("response.custom", { secret: "must-not-leak" }),
      completed("resp_malformed"),
    ]);
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_first", "gpt-5.6-terra"),
        recallCall(0, { query: "architecture" }),
        completed("resp_first"),
      ]),
      {
        onComplete: () => {},
        onRecall: async ({ query }) => ({
          anchorText: buildAnchor(query),
          resultText: "results",
        }),
        runFollowUp: async () => ({ reader: malformed.body!.getReader() }),
      },
    );

    const out = await drain(client);
    expect(out).not.toContain("must-not-leak");
    expect(out).toContain(PUBLIC_RECALL_ERROR);
  });

  test("recall-only: fails the response when the continuation fails", async () => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_failure", "gpt-5.6-terra"),
        recallCall(0, { query: "architecture" }),
        completed("resp_failure"),
      ]),
      {
        onComplete: () => {},
        onRecall: async ({ query }) => ({
          anchorText: buildAnchor(query),
          resultText: "architecture results",
        }),
        runFollowUp: async () => {
          throw new Error("follow-up unavailable");
        },
      },
    );

    const out = await drain(client);
    expect(out).toContain("response.failed");
    expect(out).toContain(PUBLIC_RECALL_ERROR);
    expect(out).not.toContain("follow-up unavailable");
    expect(out).not.toContain("lore-recall");
    expect(out).not.toContain("Searching");
    expect(out).not.toContain("response.completed");
  });

  test("recall-only: never converts a failed continuation into completed", async () => {
    const failedFollowUp = streamFrom([
      created("resp_followup_failure", "gpt-5.6-terra"),
      textItem(0, "partial answer"),
      sseEvent("response.failed", {
        response: {
          id: "resp_followup_failure",
          status: "failed",
          usage: { input_tokens: 1_000, output_tokens: 100 },
          error: { message: "provider failed" },
        },
      }),
    ]);
    let completedResponse: GatewayResponse | undefined;
    let successful: boolean | undefined;
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_failure", "gpt-5.6-terra"),
        recallCall(0, { query: "architecture" }),
        completed("resp_failure"),
      ]),
      {
        onComplete: (response, didSucceed) => {
          completedResponse = response;
          successful = didSucceed;
        },
        onRecall: async ({ query }) => ({
          anchorText: buildAnchor(query),
          resultText: "architecture results",
        }),
        runFollowUp: async () => ({
          reader: failedFollowUp.body!.getReader(),
        }),
      },
    );

    const out = await drain(client);
    expect(out).toContain("response.failed");
    expect(out).toContain(PUBLIC_RECALL_ERROR);
    expect(out).not.toContain("recall follow-up returned response.failed");
    expect(out).not.toContain("lore-recall");
    expect(out).not.toContain("partial answer");
    expect(JSON.stringify(completedResponse)).not.toContain("partial answer");
    expect(completedResponse?.usage).toMatchObject({
      inputTokens: 1_000,
      outputTokens: 100,
    });
    expect(successful).toBe(false);
    expect(out).not.toContain("response.completed");
  });

  test.each(["failed", "cancelled"])(
    "treats response.done with %s status as a failed continuation",
    async (status) => {
      const followUp = streamFrom([
        created("resp_followup", "gpt-5.6-terra"),
        textItem(0, "partial"),
        doneWithStatus("resp_followup", status),
      ]);
      const client = streamResponsesRecallAware(
        streamFrom([
          created("resp_first", "gpt-5.6-terra"),
          recallCall(0, { query: "architecture" }),
          completed("resp_first"),
        ]),
        {
          onComplete: () => {},
          onRecall: async () => ({
            anchorText: buildAnchor("architecture"),
            resultText: "results",
          }),
          runFollowUp: async () => ({ reader: followUp.body!.getReader() }),
        },
      );

      const out = await drain(client);
      expect(out.match(/^event: response\.failed$/gm)).toHaveLength(1);
      expect(out).not.toContain('"type":"response.completed"');
    },
  );

  test("merges continuation cache usage into onComplete", async () => {
    let usage: unknown;
    const followUp = streamFrom([
      created("resp_followup", "gpt-5.6-terra"),
      textItem(0, "answer"),
      completed("resp_followup", {
        input_tokens: 20,
        output_tokens: 5,
        input_tokens_details: {
          cached_tokens: 7,
          cache_write_tokens: 3,
        },
      }),
    ]);
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_first", "gpt-5.6-terra"),
        recallCall(0, { query: "architecture" }),
        completed("resp_first"),
      ]),
      {
        onComplete: (response) => {
          usage = response.usage;
        },
        onRecall: async () => ({
          anchorText: buildAnchor("architecture"),
          resultText: "results",
        }),
        runFollowUp: async () => ({ reader: followUp.body!.getReader() }),
      },
    );

    const out = await drain(client);
    expect(usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 7,
      cacheCreationInputTokens: 3,
    });
    const terminal = JSON.parse(
      /event: response\.completed\ndata: (.+)/.exec(out)?.[1] ?? "{}",
    ) as { response?: { usage?: Record<string, unknown> } };
    expect(terminal.response?.usage).toEqual({
      input_tokens: 20,
      output_tokens: 5,
      total_tokens: 25,
      input_tokens_details: {
        cached_tokens: 7,
        cache_write_tokens: 3,
      },
    });
  });

  test("preserves response.incomplete from the continuation", async () => {
    const outcomes: boolean[] = [];
    let commits = 0;
    let rollbacks = 0;
    const followUp = streamFrom([
      created("resp_followup", "gpt-5.6-terra"),
      textItem(0, "partial"),
      incomplete("resp_followup"),
    ]);
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_first", "gpt-5.6-terra"),
        recallCall(0, { query: "architecture" }),
        completed("resp_first"),
      ]),
      {
        onComplete: (_response, successful) => outcomes.push(successful),
        onRecall: async () => ({
          anchorText: buildAnchor("architecture"),
          resultText: "results",
          commit: () => commits++,
          rollback: () => rollbacks++,
        }),
        runFollowUp: async () => ({ reader: followUp.body!.getReader() }),
      },
    );

    const out = await drain(client);
    expect(out.match(/^event: response\.incomplete$/gm)).toHaveLength(1);
    expect(out.match(/^event: response\.completed$/gm) ?? []).toHaveLength(0);
    expect(outcomes).toEqual([false]);
    expect(commits).toBe(0);
    expect(rollbacks).toBe(1);
  });

  test("never executes recall from an incomplete principal", async () => {
    let recalls = 0;
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_incomplete_principal_recall", "gpt-5.6-terra"),
        recallCall(0, { query: "architecture" }),
        incomplete("resp_incomplete_principal_recall"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => {
          recalls++;
          return {
            anchorText: buildAnchor("architecture"),
            resultText: "results",
          };
        },
        runFollowUp: async () => {
          throw new Error("should not run");
        },
      },
    );
    expect(await drain(client)).toContain(PUBLIC_RECALL_ERROR);
    expect(recalls).toBe(0);
  });

  test("never executes a chained recall from an incomplete continuation", async () => {
    const followUp = streamFrom([
      created("resp_incomplete_recall", "gpt-5.6-terra"),
      recallCall(0, { query: "detail" }),
      incomplete("resp_incomplete_recall"),
    ]);
    let recalls = 0;
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_incomplete_principal", "gpt-5.6-terra"),
        recallCall(0, { query: "architecture" }),
        completed("resp_incomplete_principal"),
      ]),
      {
        onComplete: () => {},
        onRecall: async ({ query }) => {
          recalls++;
          return {
            anchorText: buildAnchor(query),
            resultText: "results",
          };
        },
        runFollowUp: async () => ({ reader: followUp.body!.getReader() }),
      },
    );
    expect(await drain(client)).toContain(PUBLIC_RECALL_ERROR);
    expect(recalls).toBe(1);
  });

  test("maps response.done with incomplete status to response.incomplete", async () => {
    const outcomes: boolean[] = [];
    const followUp = streamFrom([
      created("resp_followup", "gpt-5.6-terra"),
      textItem(0, "partial"),
      doneIncomplete("resp_followup"),
    ]);
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_first", "gpt-5.6-terra"),
        recallCall(0, { query: "architecture" }),
        completed("resp_first"),
      ]),
      {
        onComplete: (_response, successful) => outcomes.push(successful),
        onRecall: async () => ({
          anchorText: buildAnchor("architecture"),
          resultText: "results",
        }),
        runFollowUp: async () => ({ reader: followUp.body!.getReader() }),
      },
    );

    const out = await drain(client);
    expect(out.match(/^event: response\.incomplete$/gm)).toHaveLength(1);
    expect(out).not.toContain('"type":"response.completed"');
    expect(outcomes).toEqual([false]);
  });

  test("retains reasoning items in the rebuilt terminal", async () => {
    const followUp = streamFrom([
      created("resp_followup", "gpt-5.6-terra"),
      textItem(0, "answer"),
      completed("resp_followup"),
    ]);
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_reasoning", "gpt-5.6-terra"),
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: { type: "reasoning", id: "rs_0", summary: [] },
        }),
        recallCall(1, { query: "architecture" }),
        sseEvent("response.output_item.done", {
          output_index: 0,
          item: {
            type: "reasoning",
            id: "rs_0",
            summary: [{ type: "summary_text", text: "reasoned" }],
          },
        }),
        completed("resp_reasoning"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({
          anchorText: buildAnchor("architecture"),
          resultText: "results",
        }),
        runFollowUp: async ({ acc }) => {
          expect(acc.rawOutputItems).toContainEqual(
            expect.objectContaining({
              id: "rs_0",
              type: "reasoning",
            }),
          );
          return { reader: followUp.body!.getReader() };
        },
      },
    );

    const out = await drain(client);
    const terminal = JSON.parse(
      /event: response\.completed\ndata: (.+)/.exec(out)?.[1] ?? "{}",
    ) as { response?: { output?: Array<{ id?: string; type?: string }> } };
    expect(terminal.response?.output).toContainEqual(
      expect.objectContaining({ id: "rs_0", type: "reasoning" }),
    );
  });

  test("emits response.failed when upstream closes without a terminal event", async () => {
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_eof", "gpt-5.6-terra"),
        textItem(0, "partial"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not be called");
        },
      },
    );

    const out = await drain(client);
    expect(out).toContain("response.failed");
    expect(out).toContain(PUBLIC_RECALL_ERROR);
    expect(out).not.toContain("ended without a terminal event");
  });

  test("does NOT emit a second response.completed when the follow-up has none and no recall", async () => {
    // A normal turn with no recall should pass through untouched.
    const client = streamResponsesRecallAware(
      streamFrom([
        created("resp_none", "gpt-5.6-terra"),
        textItem(0, "plain response"),
        completed("resp_none"),
      ]),
      {
        onComplete: () => {},
        onRecall: async () => ({ anchorText: "", resultText: "" }),
        runFollowUp: async () => {
          throw new Error("should not be called");
        },
      },
    );
    const out = await drain(client);
    expect(out.match(/^event: response\.completed$/gm)).toHaveLength(1);
    expect(out).not.toContain("response.failed");
    expect(out).not.toContain("lore_marker");
  });
});

/** Minimal marker builder (mirrors buildRecallMarker's shape). */
function buildAnchor(query: string): string {
  return `<!-- lore-recall:${query.replaceAll(" ", "-")} -->`;
}
