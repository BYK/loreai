import { log } from "@loreai/core";
import { afterEach, expect, test, vi } from "vitest";
import { streamResponsesRecallAware } from "../src/pipeline";
import {
  accumulateResponsesSSEStream,
  streamResponsesPassthrough,
} from "../src/stream/openai-responses";
import { createCopilotItemIdentityNormalizer } from "../src/stream/copilot-item-identity";
import { makeResponsesAccState } from "../src/stream/openai-responses";
import { responsesValidationCheck } from "../src/provider-failure-diagnostics";

afterEach(() => vi.restoreAllMocks());

const message = {
  type: "message",
  id: "PRIVATE_ID",
  role: "assistant",
  content: [],
};

test.each([
  { mode: "recall-aware", reasoning: false },
  { mode: "recall-aware", reasoning: true },
  { mode: "passthrough", reasoning: false },
  { mode: "passthrough", reasoning: true },
  { mode: "buffered", reasoning: false },
  { mode: "buffered", reasoning: true },
])(
  "$mode diagnoses a colliding rotated alias (reasoning=$reasoning) without exposing provider values",
  async ({ mode, reasoning }) => {
    const diagnostics: string[] = [];
    vi.spyOn(log, "info").mockImplementation((value) => {
      diagnostics.push(String(value));
    });
    vi.spyOn(log, "error").mockImplementation(() => {});
    const frame = (type: string, data: object) =>
      `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    const upstream = new Response(
      [
        frame("response.created", {
          response: { id: "PRIVATE_RESPONSE", model: "PRIVATE_MODEL" },
        }),
        frame("response.output_item.added", {
          output_index: 0,
          item: reasoning
            ? { type: "reasoning", id: message.id, summary: [] }
            : message,
        }),
        frame(
          reasoning
            ? "response.reasoning_summary_part.added"
            : "response.content_part.added",
          {
            output_index: 0,
            item_id: "PRIVATE_PART",
            ...(reasoning ? { summary_index: 0 } : { content_index: 0 }),
            part: {
              type: reasoning ? "summary_text" : "output_text",
              text: "",
            },
          },
        ),
        frame("response.output_item.added", {
          output_index: 1,
          item: { ...message, id: "PRIVATE_DELTA" },
        }),
        frame(
          reasoning
            ? "response.reasoning_summary_text.delta"
            : "response.output_text.delta",
          {
            output_index: 0,
            item_id: "PRIVATE_DELTA",
            ...(reasoning ? { summary_index: 0 } : { content_index: 0 }),
            delta: "PRIVATE_TEXT",
          },
        ),
      ].join(""),
    );
    if (mode === "buffered") {
      await expect(
        accumulateResponsesSSEStream(upstream, {
          validation: "public",
          pinResponseId: true,
        }),
      ).rejects.toThrow();
    } else {
      const onComplete = vi.fn();
      const client =
        mode === "passthrough"
          ? streamResponsesPassthrough(
              upstream,
              onComplete,
              undefined,
              "public",
              { pinResponseId: true },
            )
          : streamResponsesRecallAware(upstream, {
              pinOutputItemIds: true,
              onComplete,
              onRecall: vi.fn(),
              runFollowUp: vi.fn(),
            });
      expect(await client.text()).toContain("response.failed");
      expect(onComplete).toHaveBeenCalledWith(expect.anything(), false);
    }
    expect(diagnostics).toContain(
      "responses-validation check=copilot_alias_reserved",
    );
    const structure = diagnostics.find((line) =>
      line.startsWith("responses-normalizer "),
    );
    expect(structure).toContain(
      reasoning
        ? "event=response.reasoning_summary_text.delta"
        : "event=response.output_text.delta",
    );
    expect(structure).toContain("alias_known=false");
    expect(structure).toContain("aliases=1");
    expect(structure?.length).toBeLessThan(1024);
    expect(diagnostics.join("\n")).not.toContain("PRIVATE");
  },
);

test.each(["alias_owner_conflict", "alias_reserved", "alias_limit"] as const)(
  "classifies every normalizer rejection: %s",
  (check) => {
    const state = makeResponsesAccState();
    state.rawItems.set(0, message);
    state.rawItems.set(1, { ...message, id: "PRIVATE_OTHER" });
    const normalize = createCopilotItemIdentityNormalizer(
      2,
      (_state, id) => id === "PRIVATE_RESERVED",
      () => {},
    );
    normalize(state, "response.output_text.delta", {
      output_index: 0,
      item_id: "PRIVATE_ALIAS",
      content_index: 0,
      delta: "PRIVATE_TEXT",
    });
    if (check === "alias_limit")
      normalize(state, "response.output_item.done", {
        output_index: 0,
        item: { ...message, id: "PRIVATE_DONE" },
      });
    const event =
      check === "alias_limit"
        ? "response.output_item.done"
        : "response.output_text.delta";
    const payload =
      check === "alias_limit"
        ? { output_index: 0, item: { ...message, id: "PRIVATE_THIRD" } }
        : {
            output_index: 1,
            item_id:
              check === "alias_reserved"
                ? "PRIVATE_RESERVED"
                : check === "alias_owner_conflict"
                  ? "PRIVATE_ALIAS"
                  : "PRIVATE_CHANGED",
            content_index: 0,
            delta: "PRIVATE_TEXT",
          };
    let caught: unknown;
    try {
      normalize(state, event, payload);
    } catch (error) {
      caught = error;
    }
    expect(responsesValidationCheck(caught)).toBe(`copilot_${check}`);
    expect(String(caught)).not.toContain("PRIVATE");
    const structure = (caught as { structure: string }).structure;
    expect(structure).toContain("index_valid=true");
    expect(structure).toContain("id=string");
    expect(structure.length).toBeLessThan(1024);
    expect(structure).not.toContain("PRIVATE");
  },
);

test("a failing diagnostic sink cannot replace the normalizer rejection", () => {
  const state = makeResponsesAccState();
  state.rawItems.set(0, message);
  const normalize = createCopilotItemIdentityNormalizer(
    2,
    () => true,
    () => {},
  );
  vi.spyOn(log, "info").mockImplementation(() => {
    throw new Error("PRIVATE_SINK");
  });
  expect(() =>
    normalize(state, "response.output_text.delta", {
      output_index: 0,
      item_id: "PRIVATE_ALIAS",
    }),
  ).toThrow("Copilot Responses identity alias_reserved");
});

test.each([
  {
    name: "function argument item ID",
    added: {
      type: "function_call",
      id: message.id,
      call_id: "PRIVATE_CALL",
      name: "read",
      arguments: "",
    },
    event: "response.function_call_arguments.delta",
    payload: { item_id: "PRIVATE_CHANGED_ID", delta: "PRIVATE_ARGUMENTS" },
    check: "event_item_id_changed",
  },
  {
    name: "reasoning ciphertext shape rather than identity",
    added: { type: "reasoning", id: message.id, summary: [] },
    event: "response.output_item.done",
    payload: {
      item: {
        type: "reasoning",
        id: message.id,
        summary: [],
        encrypted_content: {},
      },
    },
    check: "output_encrypted_content_invalid",
  },
  {
    name: "type rather than identity",
    added: message,
    event: "response.output_item.done",
    payload: { item: { type: "reasoning", id: message.id, summary: [] } },
    check: "output_type_changed",
  },
  {
    name: "status rather than identity",
    added: message,
    event: "response.output_item.done",
    payload: { item: { ...message, status: "PRIVATE_STATUS" } },
    check: "output_status_invalid",
  },
  {
    name: "envelope rather than identity",
    added: { ...message, phase: "PRIVATE_PHASE" },
    event: "response.output_item.done",
    payload: { item: { ...message, status: "completed" } },
    check: "output_envelope_changed",
  },
  {
    name: "content part item ID",
    added: message,
    event: "response.content_part.added",
    payload: {
      item_id: "PRIVATE_CHANGED_ID",
      content_index: 0,
      part: { type: "output_text", text: "PRIVATE_TEXT" },
    },
    check: "event_item_id_changed",
  },
  {
    name: "content part value shape",
    added: message,
    event: "response.content_part.added",
    payload: {
      item_id: message.id,
      content_index: 0,
      part: { type: "output_text", text: null },
    },
    check: "content_part_value_invalid",
  },
  {
    name: "reasoning extra fields",
    added: { type: "reasoning", id: message.id, summary: [] },
    event: "response.reasoning_summary_part.added",
    payload: {
      item_id: message.id,
      summary_index: 0,
      part: { type: "summary_text", text: "PRIVATE_TEXT", PRIVATE_KEY: true },
    },
    check: "reasoning_summary_shape_invalid",
  },
  {
    name: "reasoning item ID",
    added: { type: "reasoning", id: message.id, summary: [] },
    event: "response.reasoning_summary_text.delta",
    payload: {
      item_id: "PRIVATE_CHANGED_ID",
      summary_index: 0,
      delta: "PRIVATE_TEXT",
    },
    check: "event_item_id_changed",
  },
])(
  "diagnoses $name while rejecting the stream",
  async ({ added, event, payload, check }) => {
    const diagnostics: string[] = [];
    vi.spyOn(log, "info").mockImplementation((value) =>
      diagnostics.push(String(value)),
    );
    vi.spyOn(log, "error").mockImplementation(() => {});
    const frame = (type: string, data: unknown) =>
      `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
    const onComplete = vi.fn();
    const onRecall = vi.fn();
    const runFollowUp = vi.fn();
    const client = streamResponsesRecallAware(
      new Response(
        [
          frame("response.created", {
            response: { id: "PRIVATE_RESPONSE", model: "PRIVATE_MODEL" },
          }),
          frame("response.output_item.added", { output_index: 0, item: added }),
          frame(event, { output_index: 0, ...payload }),
        ].join(""),
      ),
      { onComplete, onRecall, runFollowUp },
    );
    const output = await client.text();
    expect(diagnostics).toContain(`responses-validation check=${check}`);
    expect(
      diagnostics.some((line) => line.startsWith("responses-structure ")),
    ).toBe(true);
    expect(diagnostics.join("\n")).not.toContain("PRIVATE");
    expect(
      diagnostics.find((line) => line.startsWith("responses-structure "))
        ?.length,
    ).toBeLessThan(1024);
    expect(output).toContain("Gateway request failed");
    expect(output).not.toContain("response.completed");
    expect(onRecall).not.toHaveBeenCalled();
    expect(runFollowUp).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith(expect.anything(), false);
  },
);
