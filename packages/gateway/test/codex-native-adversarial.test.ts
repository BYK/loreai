import { describe, expect, test, vi } from "vitest";
import { ensureProject } from "@loreai/core";
import {
  calibrate,
  deduplicateToolOutputs,
  resetCalibration,
  setForceMinLayer,
  setModelLimits,
  transform,
} from "../../core/src/gradient";
import {
  buildOpenAIResponsesResponse,
  buildOpenAIResponsesUpstreamRequest,
  parseOpenAIResponsesRequest,
} from "../src/translate/openai-responses";
import {
  deterministicID,
  gatewayMessagesToLore,
  resolveToolResults,
} from "../src/temporal-adapter";
import {
  accumulateResponsesNonStreamJSON,
  loreMessagesToGateway,
  streamResponsesRecallAware,
} from "../src/pipeline";
import { findRecallToolUse } from "../src/recall";

const tools = [
  {
    type: "namespace",
    name: "files",
    tools: [
      {
        type: "function",
        name: "read",
        description: "Read source files. ".repeat(40),
        parameters: { type: "object" },
      },
    ],
  },
];

function searchHistory(repetitions = 1) {
  const input: Record<string, unknown>[] = [
    { role: "user", content: "find file tools" },
  ];
  for (let index = 0; index < repetitions; index++) {
    input.push(
      {
        type: "tool_search_call",
        call_id: `search-${index}`,
        execution: "client",
        arguments: { query: "files" },
      },
      {
        type: "tool_search_output",
        call_id: `search-${index}`,
        execution: "client",
        tools,
      },
      { role: "assistant", content: "Found file tools." },
      { role: "user", content: `Next step ${index}` },
    );
  }
  for (let index = 0; index < 5; index++) {
    input.push(
      { role: "assistant", content: `Step ${index} finished.` },
      { role: "user", content: `Continue ${index}.` },
    );
  }
  const req = parseOpenAIResponsesRequest({ model: "gpt-test", input }, {});
  const stored = gatewayMessagesToLore(req.messages, "native-adversarial");
  resolveToolResults(stored);
  return { req, stored };
}

function rebuiltSearchOutputs(
  req: ReturnType<typeof parseOpenAIResponsesRequest>,
  stored: ReturnType<typeof gatewayMessagesToLore>,
) {
  const messages = loreMessagesToGateway(stored, new Map(), false);
  const { body } = buildOpenAIResponsesUpstreamRequest(
    { ...req, messages },
    "https://api.openai.com",
  );
  return (body as { input: Record<string, unknown>[] }).input.filter(
    (item) => item.type === "tool_search_output",
  );
}

describe("Codex native tool adversarial correctness", () => {
  test.each([
    {
      name: "custom",
      item: {
        type: "custom_tool_call",
        id: "ctc_patch",
        call_id: "patch",
        name: "apply_patch",
        input: "raw patch\n+line",
        status: "completed",
      },
    },
    {
      name: "tool search",
      item: {
        type: "tool_search_call",
        id: "tsc_search",
        call_id: "search",
        execution: "client",
        arguments: { query: "files" },
        status: "completed",
      },
    },
    {
      name: "namespace",
      item: {
        type: "function_call",
        id: "fc_files",
        call_id: "read",
        name: "read",
        namespace: "files",
        arguments: "{}",
        status: "completed",
      },
    },
  ])(
    "rebuilds $name response kind without raw output items",
    async ({ item }) => {
      const response = accumulateResponsesNonStreamJSON({
        id: "resp_fallback",
        model: "gpt-test",
        status: "completed",
        output: [item],
      });
      const { rawOutputItems: _raw, ...normalized } = response;
      const buffered = (await buildOpenAIResponsesResponse(
        normalized,
        false,
      ).json()) as { output: unknown[] };
      expect(buffered.output).toContainEqual(item);
      const streamed = await buildOpenAIResponsesResponse(
        normalized,
        true,
      ).text();
      const completed = streamed
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map(
          (line) =>
            JSON.parse(line.slice(6)) as {
              type: string;
              response?: { output: unknown[] };
            },
        )
        .find((event) => event.type === "response.completed");
      expect(completed?.response?.output).toContainEqual(item);
      const finished = streamed
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map(
          (line) =>
            JSON.parse(line.slice(6)) as { type: string; item?: unknown },
        )
        .find((event) => event.type === "response.output_item.done");
      expect(finished?.item).toEqual(item);
    },
  );

  test("real Layer 2 compression preserves tool-search registry output", () => {
    const project = "/test/codex-native-adversarial";
    const sessionID = "native-adversarial";
    ensureProject(project);
    resetCalibration(sessionID);
    setModelLimits({ context: 100_000, output: 2_000 });
    calibrate(0);
    const { req, stored } = searchHistory();
    setForceMinLayer(2, sessionID);
    const result = transform({
      messages: stored,
      projectPath: project,
      sessionID,
    });
    expect(result.layer).toBe(2);
    const outputs = rebuiltSearchOutputs(req, result.messages);
    expect(outputs).toHaveLength(1);
    expect(outputs[0].tools).toEqual(tools);
  });

  test("real duplicate-output compression preserves each tool-search registry", () => {
    const { req, stored } = searchHistory(2);
    const compressed = deduplicateToolOutputs(stored, stored.length);
    const outputs = rebuiltSearchOutputs(req, compressed);
    expect(outputs).toHaveLength(2);
    expect(outputs.map((item) => item.tools)).toEqual([tools, tools]);
  });

  test("custom kind, namespace, and raw grammar input participate in identity", () => {
    const call = {
      type: "custom_tool_call",
      call_id: "same",
      name: "patch",
      input: "raw grammar",
    };
    const identities = [
      call,
      { ...call, namespace: "other" },
      { ...call, input: "other grammar" },
      {
        type: "function_call",
        call_id: "same",
        name: "patch",
        arguments: "{}",
      },
    ].map((item) => {
      const message = parseOpenAIResponsesRequest({ input: [item] }, {})
        .messages[0];
      return deterministicID("session", "assistant", 0, message.content);
    });
    expect(new Set(identities).size).toBe(identities.length);
  });

  test("rejects a function result masquerading as a custom-call result", () => {
    const req = parseOpenAIResponsesRequest(
      {
        input: [
          {
            type: "custom_tool_call",
            call_id: "same",
            name: "patch",
            input: "grammar",
          },
          {
            type: "function_call_output",
            call_id: "same",
            output: "wrong wire kind",
          },
        ],
      },
      {},
    );
    const stored = gatewayMessagesToLore(req.messages, "wire-mismatch");
    expect(() => resolveToolResults(stored)).toThrow(
      "Unsupported cross-provider request",
    );
  });

  test.each(["function", "custom"])(
    "rejects losing annotated %s output when native provenance is dropped",
    (kind) => {
      const call =
        kind === "custom"
          ? {
              type: "custom_tool_call",
              call_id: "annotated",
              name: "patch",
              input: "grammar",
            }
          : {
              type: "function_call",
              call_id: "annotated",
              name: "read",
              arguments: "{}",
            };
      const req = parseOpenAIResponsesRequest(
        {
          input: [
            call,
            {
              type: `${kind === "custom" ? "custom_tool" : "function"}_call_output`,
              call_id: "annotated",
              output: [
                {
                  type: "output_text",
                  text: "claim",
                  annotations: [
                    {
                      type: "url_citation",
                      url: "https://example.test/source",
                    },
                  ],
                },
              ],
            },
            { role: "user", content: "continue" },
          ],
        },
        {},
      );
      const stored = gatewayMessagesToLore(req.messages, `annotated-${kind}`);
      const provenance = new Map(
        stored.map((message, index) => [message.info.id, req.messages[index]]),
      );
      resolveToolResults(stored);
      expect(() =>
        loreMessagesToGateway(
          stored,
          provenance,
          false,
          false,
          false,
          false,
          true,
        ),
      ).toThrow("Unsupported cross-provider request");
    },
  );

  test("buffered namespaced recall remains a client tool", () => {
    const response = accumulateResponsesNonStreamJSON({
      id: "resp_client",
      model: "gpt-test",
      status: "completed",
      output: [
        {
          type: "function_call",
          id: "fc_client",
          call_id: "client",
          namespace: "files",
          name: "recall",
          arguments: "{}",
          status: "completed",
        },
      ],
    });
    expect(response.content[0]).toMatchObject({
      type: "tool_use",
      responsesCall: { namespace: "files" },
    });
    expect(findRecallToolUse(response)).toBeUndefined();
  });

  test("streamed namespaced recall is delivered without executing Lore recall", async () => {
    const item = {
      type: "function_call",
      id: "fc_client",
      call_id: "client",
      namespace: "files",
      name: "recall",
      arguments: "{}",
      status: "completed",
    };
    const event = (type: string, payload: Record<string, unknown>) =>
      `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
    const upstream = new Response(
      [
        event("response.created", {
          response: {
            id: "resp_client",
            model: "gpt-test",
            status: "in_progress",
            output: [],
          },
        }),
        event("response.output_item.added", {
          output_index: 0,
          item: { ...item, status: "in_progress", arguments: "" },
        }),
        event("response.function_call_arguments.delta", {
          output_index: 0,
          item_id: item.id,
          delta: "{}",
        }),
        event("response.function_call_arguments.done", {
          output_index: 0,
          item_id: item.id,
          arguments: "{}",
        }),
        event("response.output_item.done", { output_index: 0, item }),
        event("response.completed", {
          response: {
            id: "resp_client",
            model: "gpt-test",
            status: "completed",
            output: [item],
            usage: { input_tokens: 10, output_tokens: 3 },
          },
        }),
      ].join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
    const onRecall = vi.fn(async () => ({ anchorText: "", resultText: "" }));
    const client = streamResponsesRecallAware(upstream, {
      onComplete: () => {},
      onRecall,
      runFollowUp: async () => {
        throw new Error("Unexpected Lore recall continuation");
      },
    });
    const output = await client.text();
    expect(onRecall).not.toHaveBeenCalled();
    expect(output).toContain('"namespace":"files"');
    expect(output).toContain("response.completed");
    expect(output).not.toContain("response.failed");
  });
});
