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

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
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

const recallCall = (outputIndex: number, args: Record<string, unknown>) =>
  sseEvent("response.output_item.added", {
    output_index: outputIndex,
    item: {
      type: "function_call",
      id: `fc_${outputIndex}`,
      call_id: `call_${outputIndex}`,
      name: "recall",
    },
  }) +
  sseEvent("response.function_call_arguments.done", {
    output_index: outputIndex,
    arguments: JSON.stringify(args),
  }) +
  sseEvent("response.output_item.done", {
    output_index: outputIndex,
    item: {
      type: "function_call",
      id: `fc_${outputIndex}`,
      call_id: `call_${outputIndex}`,
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

const textItem = (outputIndex: number, text: string) =>
  sseEvent("response.output_item.added", {
    output_index: outputIndex,
    item: { type: "message", id: `msg_${outputIndex}`, role: "assistant" },
  }) +
  sseEvent("response.output_text.delta", {
    output_index: outputIndex,
    content_index: 0,
    delta: text,
  }) +
  sseEvent("response.output_text.done", {
    output_index: outputIndex,
    text,
  }) +
  sseEvent("response.output_item.done", {
    output_index: outputIndex,
    item: {
      type: "message",
      id: `msg_${outputIndex}`,
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
        onRecall: async () => null,
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
  });

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
          arguments: JSON.stringify({ file: "x" }),
        }),
        completed("resp_mixed"),
      ]),
      {
        onComplete: () => {},
        onRecall: async ({ query }) => ({
          markerText: buildMarker(query),
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
    // A synthetic marker text item must be emitted.
    expect(out).toContain("🧠 marker: what is lore");
    // A rebuilt response.completed is emitted.
    expect(out).toContain("response.completed");
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
          // continuation text (merged) + marker.
          expect(r.content.some((b) => b.type === "tool_use")).toBe(false);
          const text = r.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("");
          expect(text).toContain("Here is the answer from the continuation.");
          expect(text).toContain("🧠 marker: architecture");
        },
        onRecall: async ({ query }) => ({
          markerText: buildMarker(query),
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

    // Marker emitted.
    expect(out).toContain("🧠 marker: architecture");
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
        onRecall: async () => null,
        runFollowUp: async () => {
          throw new Error("should not be called");
        },
      },
    );
    const out = await drain(client);
    expect(out.match(/response\.completed/g)).toHaveLength(1);
    expect(out).not.toContain("lore_marker");
  });
});

/** Minimal marker builder (mirrors buildRecallMarker's shape). */
function buildMarker(query: string): string {
  return `🧠 marker: ${query}`;
}
