import { expect, test, vi } from "vitest";
import { log } from "@loreai/core";
import { streamResponsesRecallAware } from "../src/pipeline";
import { createHarness } from "./helpers/harness";
import { upstreamFetch } from "../src/fetch";
import {
  accumulateResponsesSSEStream,
  streamResponsesPassthrough,
} from "../src/stream/openai-responses";
import { setUpstreamInterceptor } from "../src/pipeline";

vi.mock("../src/fetch", () => ({ upstreamFetch: vi.fn() }));

const frame = (type: string, data: object) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

test.each(["call_id", "name", "arguments", "reserved alias", "generic"])(
  "rotating function item IDs preserve semantic guard: %s",
  async (change) => {
    const call = {
      type: "function_call",
      id: "tool_item",
      call_id: "semantic_call",
      name: "read",
      arguments: "{}",
      status: "completed",
    };
    const done = { ...call, id: "tool_done" };
    if (change === "call_id") done.call_id = "other_call";
    if (change === "name") done.name = "other_tool";
    if (change === "arguments") done.arguments = '{"changed":true}';
    const input: ReturnType<typeof events> = [
      [
        "response.created",
        { response: { id: "function_response", model: "copilot-model" } },
      ],
      [
        "response.output_item.added",
        {
          output_index: 0,
          item: { ...call, status: "in_progress", arguments: "" },
        },
      ],
      [
        "response.function_call_arguments.delta",
        {
          output_index: 0,
          item_id: change === "reserved alias" ? "semantic_call" : "tool_delta",
          delta: "{}",
        },
      ],
      [
        "response.function_call_arguments.done",
        { output_index: 0, item_id: "tool_args_done", arguments: "{}" },
      ],
      ["response.output_item.done", { output_index: 0, item: done }],
      [
        "response.completed",
        {
          response: {
            id: "function_response",
            model: "copilot-model",
            status: "completed",
            output: [{ ...done, id: "tool_terminal" }],
          },
        },
      ],
    ];
    const { text, onComplete } = await run(input, change !== "generic");
    expect(text).toContain("response.failed");
    expect(text).not.toContain("response.completed");
    expect(onComplete).toHaveBeenCalledWith(expect.anything(), false);
  },
);

test.each([false, true])(
  "HTTP session completes hello, tool/result and final answer with Luna reasoning=%s",
  async (lunaReasoning) => {
    const harness = await createHarness({ fixtures: [] });
    try {
      setUpstreamInterceptor(async (_body, _model, _stream, makeReal) =>
        makeReal(),
      );
      const dispatched: Record<string, unknown>[] = [];
      const call = {
        type: "function_call",
        id: "function_added",
        call_id: "semantic_call",
        name: "read",
        arguments: '{"path":"example.txt"}',
        status: "completed",
      };
      const created = frame("response.created", {
        response: { id: "tool_response", model: "copilot-model" },
      });
      const toolStream =
        created +
        [
          frame("response.output_item.added", {
            output_index: 0,
            item: { ...call, status: "in_progress", arguments: "" },
          }),
          frame("response.function_call_arguments.delta", {
            output_index: 0,
            item_id: "function_delta",
            delta: call.arguments,
          }),
          frame("response.function_call_arguments.done", {
            output_index: 0,
            item_id: "function_args_done",
            arguments: call.arguments,
          }),
          frame("response.output_item.done", {
            output_index: 0,
            item: { ...call, id: "function_done" },
          }),
          frame("response.completed", {
            response: {
              id: "tool_response",
              model: "copilot-model",
              status: "completed",
              output: [{ ...call, id: "function_terminal" }],
            },
          }),
        ].join("");
      vi.mocked(upstreamFetch).mockReset();
      vi.mocked(upstreamFetch).mockImplementation(async (_url, init) => {
        if (typeof init?.body !== "string")
          throw new Error("expected serialized upstream body");
        dispatched.push(JSON.parse(init.body) as Record<string, unknown>);
        let text =
          dispatched.length === 2
            ? toolStream
            : events(false)
                .map(([type, data]) => frame(type, data))
                .join("");
        if (lunaReasoning && dispatched.length === 3) {
          const input = grokTerminalEvents();
          delete (input[6][1].item as Record<string, unknown>).status;
          const terminal = input[input.length - 1][1].response as {
            output: Record<string, unknown>[];
          };
          delete terminal.output[0].status;
          text = input.map(([type, data]) => frame(type, data)).join("");
        }
        return new Response(text, {
          headers: { "content-type": "text/event-stream" },
        });
      });
      const send = async (input: unknown[]) => {
        const response = await harness.request("/v1/responses", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer test-key",
            "x-lore-provider": "github-copilot",
            "x-lore-upstream-url": "https://api.githubcopilot.com",
            "x-lore-project": "/tmp/copilot-tool-roundtrip",
          },
          body: JSON.stringify({
            model: "copilot-model",
            stream: true,
            input,
            tools: [
              {
                type: "function",
                name: "read",
                parameters: {
                  type: "object",
                  properties: { path: { type: "string" } },
                  required: ["path"],
                  additionalProperties: false,
                },
              },
            ],
          }),
        });
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).not.toContain("response.failed");
        expect(text.match(/^event: response.completed$/gm)).toHaveLength(1);
        const terminal = text
          .split("\n\n")
          .find((part) => part.startsWith("event: response.completed\n"));
        if (!terminal) throw new Error("missing terminal");
        return JSON.parse(terminal.split("data: ")[1]).response
          .output as Record<string, unknown>[];
      };
      const history: unknown[] = [{ role: "user", content: "hello" }];
      history.push(...(await send(history)), {
        role: "user",
        content: "read example.txt",
      });
      const toolOutput = await send(history);
      expect(toolOutput).toEqual([
        expect.objectContaining({
          id: "function_added",
          call_id: "semantic_call",
          name: "read",
          arguments: call.arguments,
        }),
      ]);
      history.push(...toolOutput, {
        type: "function_call_output",
        call_id: "semantic_call",
        output: "file content",
      });
      const final = await send(history);
      expect(final).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "message", status: "completed" }),
        ]),
      );
      if (lunaReasoning) {
        expect(final[0]).toEqual(
          expect.objectContaining({
            type: "reasoning",
            id: "added_id",
            encrypted_content: "ciphertext",
          }),
        );
        expect(final[0]).not.toHaveProperty("status");
        expect(JSON.stringify(final)).not.toContain(
          "terminal_reencrypted_ciphertext",
        );
        history.push(...final, { role: "user", content: "thanks" });
        await send(history);
        expect(dispatched[3].input).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "reasoning",
              id: "added_id",
              encrypted_content: "ciphertext",
            }),
          ]),
        );
      }
      expect(dispatched).toHaveLength(lunaReasoning ? 4 : 3);
      expect(dispatched[2].input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "function_call",
            id: "function_added",
            call_id: "semantic_call",
            name: "read",
            arguments: call.arguments,
          }),
          expect.objectContaining({
            type: "function_call_output",
            call_id: "semantic_call",
            output: "file content",
          }),
        ]),
      );
    } finally {
      await harness.teardown();
    }
  },
);

function events(reasoning: boolean) {
  const kind = reasoning ? "reasoning" : "message";
  const initial = reasoning
    ? { type: kind, id: "added_id", summary: [] }
    : { type: kind, id: "added_id", role: "assistant", content: [] };
  const part = { type: reasoning ? "summary_text" : "output_text", text: "" };
  const coordinate = reasoning ? { summary_index: 0 } : { content_index: 0 };
  const prefix = reasoning ? "response.reasoning_summary" : "response";
  const final = reasoning
    ? {
        ...initial,
        id: "done_id",
        summary: [{ ...part, text: "hello" }],
        encrypted_content: "ciphertext",
        status: "completed",
      }
    : {
        ...initial,
        id: "done_id",
        content: [{ ...part, text: "hello" }],
        status: "completed",
      };
  return [
    [
      "response.created",
      { response: { id: "response_id", model: "copilot-model" } },
    ],
    ["response.output_item.added", { output_index: 0, item: initial }],
    [
      reasoning ? `${prefix}_part.added` : "response.content_part.added",
      { output_index: 0, item_id: "part_id", ...coordinate, part },
    ],
    [
      reasoning ? `${prefix}_text.delta` : "response.output_text.delta",
      { output_index: 0, item_id: "delta_id", ...coordinate, delta: "hello" },
    ],
    [
      reasoning ? `${prefix}_text.done` : "response.output_text.done",
      {
        output_index: 0,
        item_id: "text_done_id",
        ...coordinate,
        text: "hello",
      },
    ],
    [
      reasoning ? `${prefix}_part.done` : "response.content_part.done",
      {
        output_index: 0,
        item_id: "part_done_id",
        ...coordinate,
        part: { ...part, text: "hello" },
      },
    ],
    ["response.output_item.done", { output_index: 0, item: final }],
    [
      "response.completed",
      {
        response: {
          id: "response_id",
          model: "copilot-model",
          status: "completed",
          output: [final],
        },
      },
    ],
  ] as Array<[string, Record<string, unknown>]>;
}

async function run(input: ReturnType<typeof events>, enabled = true) {
  const onComplete = vi.fn();
  const onRecall = vi.fn();
  const response = streamResponsesRecallAware(
    new Response(input.map(([type, data]) => frame(type, data)).join("")),
    {
      pinOutputItemIds: enabled,
      onComplete,
      onRecall,
      runFollowUp: async () => {
        throw new Error("unexpected follow-up");
      },
    },
  );
  const text = await response.text();
  expect(onRecall).not.toHaveBeenCalled();
  return { text, onComplete };
}

function grokTerminalEvents() {
  const reasoning = events(true);
  const message = events(false);
  const finalReasoning = reasoning[6][1].item as Record<string, unknown>;
  const finalMessage = message[6][1].item as Record<string, unknown>;
  return [
    reasoning[0],
    ...reasoning.slice(1, 7),
    ...message.slice(1, 7).map(([type, payload]) => {
      const item = payload.item as Record<string, unknown> | undefined;
      return [
        type,
        {
          ...payload,
          output_index: 1,
          ...(typeof payload.item_id === "string"
            ? { item_id: `message_${payload.item_id}` }
            : {}),
          ...(item
            ? { item: { ...item, id: `message_${String(item.id)}` } }
            : {}),
        },
      ] as [string, Record<string, unknown>];
    }),
    [
      "response.completed",
      {
        response: {
          id: "response_id",
          model: "copilot-model",
          status: "completed",
          output: [
            {
              ...finalReasoning,
              id: "terminal_reasoning_id",
              encrypted_content: "terminal_reencrypted_ciphertext",
            },
            { ...finalMessage, id: "terminal_message_id" },
          ],
        },
      },
    ],
  ] as ReturnType<typeof events>;
}

test.each(["incomplete", "in_progress", "one omitted"])(
  "omitted-status compatibility rejects explicit status variation: %s",
  async (status) => {
    const input = grokTerminalEvents();
    const done = input[6][1].item as Record<string, unknown>;
    const terminal = (
      input[input.length - 1][1].response as {
        output: Record<string, unknown>[];
      }
    ).output[0];
    if (status === "one omitted") delete done.status;
    else {
      done.status = status;
      terminal.status = status;
    }
    const { text, onComplete } = await run(input);
    expect(text).toContain("response.failed");
    expect(text).not.toContain("response.completed");
    expect(onComplete).toHaveBeenCalledWith(expect.anything(), false);
  },
);

test("generic validation rejects completed reasoning ciphertext drift with stable IDs", async () => {
  const input = events(true);
  for (const [, payload] of input) {
    if (typeof payload.item_id === "string") payload.item_id = "added_id";
  }
  const done = input[6][1].item as Record<string, unknown>;
  done.id = "added_id";
  (input[7][1].response as { output: unknown[] }).output = [
    { ...done, encrypted_content: "different_ciphertext" },
  ];
  const upstream = new Response(
    input.map(([type, data]) => frame(type, data)).join(""),
  );
  await expect(
    accumulateResponsesSSEStream(upstream, { validation: "public" }),
  ).rejects.toThrow();
});

test("known reasoning alias cannot cross terminal item order during re-encryption", async () => {
  const input = grokTerminalEvents();
  const output = (
    input[input.length - 1][1].response as { output: Record<string, unknown>[] }
  ).output;
  output[0].id = "message_delta_id";
  const { text, onComplete } = await run(input);
  expect(text).toContain("response.failed");
  expect(onComplete).toHaveBeenCalledWith(expect.anything(), false);
});

test.each(["buffered", "passthrough", "recall-aware"] as const)(
  "%s completes Grok reasoning re-encryption with consistent done ciphertext",
  async (mode) => {
    const input = grokTerminalEvents();
    const upstream = new Response(
      input.map(([type, data]) => frame(type, data)).join(""),
    );
    let accumulated: unknown;
    if (mode === "buffered") {
      const validated: string[] = [];
      const result = await accumulateResponsesSSEStream(upstream, {
        validation: "public",
        pinResponseId: true,
        onValidatedEvent: (_event, data) => {
          validated.push(data);
        },
      });
      expect(result.stopReason).toBe("end_turn");
      accumulated = result;
      const terminal = JSON.parse(validated[validated.length - 1]).response
        .output;
      expect(terminal[0]).toEqual(
        expect.objectContaining({
          id: "added_id",
          encrypted_content: "ciphertext",
        }),
      );
      expect(validated.join("\n")).not.toContain(
        "terminal_reencrypted_ciphertext",
      );
    } else {
      const onComplete = vi.fn();
      const response =
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
      const text = await response.text();
      expect(text.match(/^event: response.completed$/gm)).toHaveLength(1);
      expect(text).not.toContain("response.failed");
      expect(text).not.toContain("terminal_reencrypted_ciphertext");
      expect(text).not.toContain("terminal_reasoning_id");
      const frames = text
        .split("\n\n")
        .filter((chunk) => chunk.includes("data: "))
        .map((chunk) => JSON.parse(chunk.split("data: ")[1]));
      expect(
        frames.find((event) => event.type === "response.output_item.done").item
          .encrypted_content,
      ).toBe("ciphertext");
      expect(
        frames.find((event) => event.type === "response.completed").response
          .output[0].encrypted_content,
      ).toBe("ciphertext");
      expect(onComplete).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ stopReason: "end_turn" }),
        true,
      );
      accumulated = onComplete.mock.calls[0][0];
    }
    expect(JSON.stringify(accumulated)).toContain("ciphertext");
    expect(JSON.stringify(accumulated)).not.toContain(
      "terminal_reencrypted_ciphertext",
    );
  },
);

test.each([
  "summary",
  "content",
  "status",
  "extra envelope",
  "tool identity",
  "null ciphertext",
  "missing ciphertext",
  "nonstring ciphertext",
  "missing done ciphertext",
  "generic",
])("reasoning terminal re-encryption cannot hide %s", async (change) => {
  const input = grokTerminalEvents();
  const output = (
    input[input.length - 1][1].response as { output: Record<string, unknown>[] }
  ).output;
  const reasoning = output[0];
  if (change === "summary")
    reasoning.summary = [{ type: "summary_text", text: "changed" }];
  if (change === "content")
    reasoning.content = [{ type: "reasoning_text", text: "changed" }];
  if (change === "status") reasoning.status = "incomplete";
  if (change === "extra envelope") reasoning.extra = "unreviewed";
  if (change === "tool identity") reasoning.call_id = "unreviewed";
  if (change === "null ciphertext") reasoning.encrypted_content = null;
  if (change === "missing ciphertext") delete reasoning.encrypted_content;
  if (change === "nonstring ciphertext") reasoning.encrypted_content = {};
  if (change === "missing done ciphertext")
    delete (input[6][1].item as Record<string, unknown>).encrypted_content;
  const { text, onComplete } = await run(input, change !== "generic");
  expect(text).toContain("response.failed");
  expect(text).not.toContain("response.completed");
  expect(onComplete).toHaveBeenCalledWith(expect.anything(), false);
});

test("terminal mismatch diagnostics identify changed components without payloads", async () => {
  const messages: string[] = [];
  const spy = vi.spyOn(log, "info").mockImplementation((value) => {
    messages.push(String(value));
  });
  try {
    const input = events(false);
    (input[7][1].response as { output: unknown[] }).output = [
      {
        ...(input[6][1].item as object),
        id: "PRIVATE_TERMINAL_ID",
        content: [{ type: "output_text", text: "PRIVATE_TEXT" }],
        PRIVATE_FIELD: "PRIVATE_VALUE",
      },
    ];
    const { text } = await run(input);
    expect(text).toContain("response.failed");
    const diagnostic = messages.find((line) =>
      line.startsWith("responses-terminal "),
    );
    expect(diagnostic).toContain("id_equal=false");
    expect(diagnostic).toContain("content_equal=false");
    expect(diagnostic).toContain("content_text_equal=false");
    expect(diagnostic).toContain("status_equal=true");
    expect(diagnostic?.length).toBeLessThan(1536);
    expect(messages.join("\n")).not.toContain("PRIVATE");
  } finally {
    spy.mockRestore();
  }
});

test("terminal diagnostics distinguish ciphertext presence and completion statuses", async () => {
  const messages: string[] = [];
  const spy = vi.spyOn(log, "info").mockImplementation((value) => {
    messages.push(String(value));
  });
  try {
    const input = grokTerminalEvents();
    const response = input[input.length - 1][1].response as {
      output: Record<string, unknown>[];
    };
    response.output[0].encrypted_content = null;
    const { text } = await run(input);
    expect(text).toContain("response.failed");
    const diagnostic = messages.find((line) =>
      line.startsWith("responses-terminal "),
    );
    expect(diagnostic).toContain("actual_ciphertext=null");
    expect(diagnostic).toContain("done_ciphertext=string");
    expect(diagnostic).toContain("response_status=completed");
    expect(diagnostic).toContain("actual_status=completed");
    expect(diagnostic).toContain("done_status=completed");
    expect(diagnostic?.length).toBeLessThan(1536);
  } finally {
    spy.mockRestore();
  }
});

test.each(["buffered", "passthrough", "recall-aware"] as const)(
  "%s finishes once when the complete matching terminal snapshot rotates IDs again",
  async (mode) => {
    for (const reasoning of [false, true]) {
      const input = events(reasoning);
      const final = input[6][1].item as Record<string, unknown>;
      (input[7][1].response as { output: unknown[] }).output = [
        { ...final, id: "terminal_fresh_id" },
      ];
      const upstream = new Response(
        input.map(([type, data]) => frame(type, data)).join(""),
      );
      if (mode === "buffered") {
        const result = await accumulateResponsesSSEStream(upstream, {
          validation: "public",
          pinResponseId: true,
        });
        expect(result.stopReason).toBe("end_turn");
        expect(JSON.stringify(result)).not.toContain("terminal_fresh_id");
      } else {
        const onComplete = vi.fn();
        const response =
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
        const text = await response.text();
        expect(text.match(/^event: response.completed$/gm)).toHaveLength(1);
        expect(text).not.toContain("response.failed");
        expect(text).not.toContain("terminal_fresh_id");
        expect(onComplete).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ stopReason: "end_turn" }),
          true,
        );
      }
    }
  },
);

test.each([
  "content",
  "status",
  "role",
  "collision",
  "partial snapshot",
  "unfinished",
])("fresh terminal ID cannot hide %s", async (change) => {
  const input = events(false);
  const final: Record<string, unknown> = {
    ...(input[6][1].item as Record<string, unknown>),
    id: "terminal_fresh_id",
  };
  if (change === "content")
    final.content = [{ type: "output_text", text: "changed" }];
  if (change === "status") final.status = "incomplete";
  if (change === "role") final.role = "user";
  if (change === "collision") final.id = "delta_id";
  if (change === "collision")
    input.splice(6, 0, [
      "response.output_item.added",
      {
        output_index: 1,
        item: {
          type: "message",
          id: "other_item",
          role: "assistant",
          content: [],
        },
      },
    ]);
  const terminal = input[input.length - 1][1].response as { output: unknown[] };
  terminal.output = [final];
  if (change === "partial snapshot")
    input.splice(1, 0, [
      "response.output_item.added",
      {
        output_index: 1,
        item: {
          type: "message",
          id: "other_item",
          role: "assistant",
          content: [],
        },
      },
    ]);
  if (change === "unfinished") input.splice(6, 1);
  const { text, onComplete } = await run(input);
  expect(text).toContain("response.failed");
  expect(text).not.toContain("response.completed");
  expect(onComplete).toHaveBeenCalledWith(expect.anything(), false);
});

test.each(["buffered", "passthrough", "recall-aware"] as const)(
  "%s canonicalizes known terminal reference aliases and rejects malformed references",
  async (mode) => {
    for (const reasoning of [false, true]) {
      for (const malformed of [false, true]) {
        const input = events(reasoning);
        const done = input[6][1].item as Record<string, unknown>;
        done.id = "done_id";
        (input[7][1].response as { output: unknown[] }).output = [
          {
            type: "item_reference",
            id: "done_id",
            ...(malformed ? { extra: "must not be stripped" } : {}),
          },
        ];
        const upstream = () =>
          new Response(input.map(([type, data]) => frame(type, data)).join(""));
        if (mode === "buffered") {
          const validated: string[] = [];
          const result = accumulateResponsesSSEStream(upstream(), {
            validation: "public",
            pinResponseId: true,
            onValidatedEvent: (_event, data) => {
              validated.push(data);
            },
          });
          if (malformed) await expect(result).rejects.toThrow();
          else {
            const response = await result;
            expect(JSON.stringify(response)).not.toContain("done_id");
            expect(validated.join("\n")).not.toContain("done_id");
            expect(
              JSON.parse(validated[validated.length - 1]).response.output,
            ).toEqual([{ type: "item_reference", id: "added_id" }]);
          }
        } else {
          const onComplete = vi.fn();
          const response =
            mode === "passthrough"
              ? streamResponsesPassthrough(
                  upstream(),
                  onComplete,
                  undefined,
                  "public",
                  { pinResponseId: true },
                )
              : streamResponsesRecallAware(upstream(), {
                  pinOutputItemIds: true,
                  onComplete,
                  onRecall: async () => {
                    throw new Error("unexpected recall");
                  },
                  runFollowUp: async () => {
                    throw new Error("unexpected follow-up");
                  },
                });
          const text = await response.text();
          expect(text.includes("response.completed")).toBe(!malformed);
          expect(text.includes("response.failed")).toBe(malformed);
          expect(text).not.toContain("done_id");
          expect(onComplete).toHaveBeenCalledWith(
            expect.anything(),
            !malformed,
          );
        }
      }
    }
  },
);

test.each([
  {
    name: "canonical Copilot",
    provider: "github-copilot",
    url: "https://api.githubcopilot.com",
    path: "/responses",
    success: true,
  },
  {
    name: "foreign destination",
    provider: "github-copilot",
    url: "https://example.com",
    path: "/responses",
    success: false,
  },
  {
    name: "custom provider",
    provider: "custom-provider",
    url: "https://api.githubcopilot.com",
    path: "/responses",
    success: false,
  },
  {
    name: "noncanonical path",
    provider: "github-copilot",
    url: "https://api.githubcopilot.com",
    path: "/custom/responses",
    success: false,
  },
])(
  "real ingress scopes item normalization to $name",
  async ({ provider, url, path, success }) => {
    const harness = await createHarness({ fixtures: [] });
    try {
      setUpstreamInterceptor(async (_body, _model, _stream, makeReal) =>
        makeReal(),
      );
      vi.mocked(upstreamFetch).mockReset();
      vi.mocked(upstreamFetch).mockImplementation(
        async () =>
          new Response(
            events(true)
              .map(([type, data]) => frame(type, data))
              .join(""),
            { headers: { "content-type": "text/event-stream" } },
          ),
      );
      const response = await harness.request("/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-key",
          "x-lore-provider": provider,
          "x-lore-upstream-url": url,
          "x-lore-upstream-path": path,
          "x-lore-project": "/tmp/copilot-item-identity",
        },
        body: JSON.stringify({
          model: "copilot-model",
          stream: true,
          input: "hi",
        }),
      });
      const text = await response.text();
      expect(text.includes("response.completed")).toBe(success);
      expect(text.includes("response.failed")).toBe(!success);
      if (success) expect(text).not.toContain("done_id");
    } finally {
      await harness.teardown();
    }
  },
);

test.each([false, true])(
  "pins observed Copilot message/reasoning aliases (reasoning=%s)",
  async (reasoning) => {
    const { text, onComplete } = await run(events(reasoning));
    expect(text).toContain("response.completed");
    expect(text).not.toContain("Gateway request failed");
    expect(text).not.toContain("part_id");
    expect(text).not.toContain("done_id");
    expect(text).not.toContain("delta_id");
    expect(text).not.toContain("text_done_id");
    expect(text).not.toContain("part_done_id");
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.any(Array) }),
      true,
    );
    expect(JSON.stringify(onComplete.mock.calls)).not.toContain("done_id");
  },
);

test("normalizes the observed Grok done-only reasoning ID drift", async () => {
  const input = events(true);
  input.splice(2, 4);
  const final = input[2][1].item as Record<string, unknown>;
  final.summary = [];
  const first = await run(input);
  const second = await run(input);
  expect(first.text).toContain("response.completed");
  expect(first.text).not.toContain("done_id");
  expect(second.text).toBe(first.text);
});

test("normalizes recall continuation aliases without changing recall identity", async () => {
  const call = {
    type: "function_call",
    id: "recall_item",
    call_id: "recall_call",
    name: "recall",
    arguments: '{"query":"hello"}',
  };
  const principal = [
    frame("response.created", {
      response: { id: "principal", model: "copilot-model" },
    }),
    frame("response.output_item.added", {
      output_index: 0,
      item: { ...call, arguments: "" },
    }),
    frame("response.function_call_arguments.done", {
      output_index: 0,
      item_id: "recall_args_alias",
      arguments: call.arguments,
    }),
    frame("response.output_item.done", {
      output_index: 0,
      item: { ...call, id: "recall_done_alias", status: "completed" },
    }),
    frame("response.completed", {
      response: {
        id: "principal",
        model: "copilot-model",
        status: "completed",
        output: [{ ...call, id: "recall_terminal_alias", status: "completed" }],
      },
    }),
  ].join("");
  const onRecall = vi.fn(async () => ({
    anchorText: "memory",
    resultText: "memory",
  }));
  const onComplete = vi.fn();
  const response = streamResponsesRecallAware(new Response(principal), {
    pinOutputItemIds: true,
    onComplete,
    onRecall,
    runFollowUp: async () => {
      const follow = new Response(
        events(false)
          .map(([type, data]) => frame(type, data))
          .join(""),
      );
      if (!follow.body) throw new Error("missing fixture body");
      return { reader: follow.body.getReader() };
    },
  });
  const text = await response.text();
  expect(onRecall).toHaveBeenCalledWith(
    expect.objectContaining({ toolUseId: "recall_call" }),
  );
  expect(onRecall).toHaveBeenCalledTimes(1);
  expect(text).toContain("response.completed");
  expect(text).not.toContain("response.failed");
  expect(text).not.toContain("part_id");
  expect(onComplete).toHaveBeenCalledWith(expect.anything(), true);
});

test.each([false, true])(
  "buffered accumulator normalizes aliases (reasoning=%s)",
  async (reasoning) => {
    const response = await accumulateResponsesSSEStream(
      new Response(
        events(reasoning)
          .map(([type, data]) => frame(type, data))
          .join(""),
      ),
      { validation: "public", pinResponseId: true },
    );
    expect(response.stopReason).not.toBe("error");
    expect(JSON.stringify(response)).not.toContain("done_id");
  },
);

test.each([
  "existing item",
  "future call_id",
  "unknown terminal",
  "function ID",
  "function call_id",
  "rotated delta call_id",
])("buffered accumulator rejects %s", async (name) => {
  const input = events(false);
  if (name === "existing item")
    input.splice(2, 0, [
      "response.output_item.added",
      {
        output_index: 1,
        item: {
          type: "message",
          id: "part_id",
          role: "assistant",
          content: [],
        },
      },
    ]);
  if (name === "future call_id")
    input.splice(4, 0, [
      "response.output_item.added",
      {
        output_index: 1,
        item: {
          type: "function_call",
          id: "function_id",
          call_id: "part_id",
          name: "read",
          arguments: "",
        },
      },
    ]);
  if (name === "unknown terminal")
    (input[7][1].response as { output: unknown[] }).output = [
      { type: "message", id: "unknown_id", role: "assistant", content: [] },
    ];
  if (name === "function ID" || name === "function call_id") {
    const added = {
      type: "function_call",
      id: "function_id",
      call_id: "call_id",
      name: "recall",
      arguments: "{}",
    };
    input.splice(
      1,
      6,
      ["response.output_item.added", { output_index: 0, item: added }],
      [
        "response.output_item.done",
        {
          output_index: 0,
          item: {
            ...added,
            ...(name === "function ID"
              ? { id: "changed" }
              : { call_id: "changed" }),
            status: "completed",
          },
        },
      ],
    );
  }
  if (name === "rotated delta call_id")
    input.splice(4, 0, [
      "response.output_item.added",
      {
        output_index: 1,
        item: {
          type: "function_call",
          id: "function_id",
          call_id: "delta_id",
          name: "recall",
          arguments: "",
        },
      },
    ]);
  await expect(
    accumulateResponsesSSEStream(
      new Response(input.map(([type, data]) => frame(type, data)).join("")),
      { validation: "public", pinResponseId: true },
    ),
  ).rejects.toThrow();
});

test.each([false, true])(
  "generic streams still reject changed IDs (reasoning=%s)",
  async (reasoning) => {
    const { text } = await run(events(reasoning), false);
    expect(text).toContain("Gateway request failed");
    expect(text).not.toContain("response.completed");
  },
);

test.each([
  "existing item",
  "future item",
  "unknown terminal",
  "function call",
  "content contradiction",
  "invalid rotated part coordinate",
  "rotated cross-item alias",
  "rotated terminal unknown alias",
])("rejects %s despite Copilot normalization", async (name) => {
  const input = events(false);
  if (name === "existing item")
    input.splice(2, 0, [
      "response.output_item.added",
      {
        output_index: 1,
        item: {
          type: "message",
          id: "part_id",
          role: "assistant",
          content: [],
        },
      },
    ]);
  if (name === "future item")
    input.splice(4, 0, [
      "response.output_item.added",
      {
        output_index: 1,
        item: {
          type: "message",
          id: "part_id",
          role: "assistant",
          content: [],
        },
      },
    ]);
  if (name === "unknown terminal")
    (input[7][1].response as { output: unknown[] }).output = [
      {
        type: "message",
        id: "unknown_id",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "changed terminal content" }],
      },
    ];
  if (name === "function call") {
    input[1][1].item = {
      type: "function_call",
      id: "added_id",
      call_id: "call_id",
      name: "recall",
      arguments: "",
    };
  }
  if (name === "content contradiction") input[4][1].text = "changed";
  if (name === "invalid rotated part coordinate")
    input[3][1].content_index = -1;
  if (name === "rotated cross-item alias")
    input.splice(
      4,
      0,
      [
        "response.output_item.added",
        {
          output_index: 1,
          item: {
            type: "message",
            id: "second_id",
            role: "assistant",
            content: [],
          },
        },
      ],
      [
        "response.content_part.added",
        {
          output_index: 1,
          item_id: "delta_id",
          content_index: 0,
          part: { type: "output_text", text: "" },
        },
      ],
    );
  if (name === "rotated terminal unknown alias")
    (input[7][1].response as { output: unknown[] }).output = [
      { type: "item_reference", id: "unknown_id" },
    ];
  const { text, onComplete } = await run(input);
  expect(text).toContain("response.failed");
  expect(text).not.toContain("response.completed");
  expect(onComplete).toHaveBeenCalledWith(expect.anything(), false);
});
