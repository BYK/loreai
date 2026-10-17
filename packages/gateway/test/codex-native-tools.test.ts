import { describe, expect, test } from "vitest";
import {
  parseOpenAIResponsesRequest,
  buildOpenAIResponsesUpstreamRequest,
} from "../src/translate/openai-responses";
import {
  gatewayMessagesToLore,
  resolveToolResults,
  deterministicID,
} from "../src/temporal-adapter";
import {
  accumulateResponsesNonStreamJSON,
  loreMessagesToGateway,
} from "../src/pipeline";
import { buildAnthropicRequest } from "../src/translate/anthropic";
import { buildOpenAIUpstreamRequest } from "../src/translate/openai";
import { buildGeminiUpstreamRequest } from "../src/translate/gemini";

const customCall = {
  type: "custom_tool_call",
  call_id: "patch",
  name: "apply_patch",
  input: '*** Begin Patch\n+"quoted"\n*** End Patch',
};
const customResult = {
  type: "custom_tool_call_output",
  call_id: "patch",
  output: "Patch applied",
};
const searchCall = {
  type: "tool_search_call",
  call_id: "search",
  execution: "client",
  arguments: { query: "read" },
};
const searchResult = {
  type: "tool_search_output",
  call_id: "search",
  execution: "client",
  tools: [
    {
      type: "namespace",
      name: "files",
      tools: [
        { type: "function", name: "read", parameters: { type: "object" } },
      ],
    },
  ],
};
const functionCall = {
  type: "function_call",
  call_id: "read",
  name: "read",
  namespace: "files",
  arguments: "{}",
};
const functionResult = {
  type: "function_call_output",
  call_id: "read",
  output: "contents",
};

describe("Codex native tool replay", () => {
  const hostedSearch = [
    {
      id: "tsc_hosted",
      type: "tool_search_call",
      execution: "server",
      call_id: null,
      status: "completed",
      arguments: { paths: ["files"] },
    },
    {
      id: "tso_hosted",
      type: "tool_search_output",
      execution: "server",
      call_id: null,
      status: "completed",
      tools: searchResult.tools,
    },
  ];
  test("keeps server-owned tool search opaque in native request history", () => {
    const items = [...hostedSearch, functionCall, functionResult];
    const req = parseOpenAIResponsesRequest({ input: items }, {});
    const { body } = buildOpenAIResponsesUpstreamRequest(
      req,
      "https://api.openai.com",
    );
    expect((body as { input: unknown[] }).input).toEqual(items);
  });
  test("does not turn hosted tool search into a client tool invocation", () => {
    const response = accumulateResponsesNonStreamJSON({
      id: "resp_hosted",
      model: "gpt-test",
      status: "completed",
      output: hostedSearch,
    });
    expect(response.content).toEqual([]);
    expect(response.rawOutputItems).toEqual(hostedSearch);
  });

  test.each(["developer", "system"])(
    "preserves Codex %s message identity on native routes",
    (role) => {
      const instruction = {
        type: "message",
        id: "msg_instruction",
        role,
        content: [{ type: "input_text", text: "Follow these rules" }],
      };
      const req = parseOpenAIResponsesRequest(
        {
          model: "gpt-test",
          input: [instruction, { role: "user", content: "hello" }],
        },
        {},
      );
      const { body } = buildOpenAIResponsesUpstreamRequest(
        req,
        "https://api.openai.com",
      );
      expect((body as { input: unknown[] }).input[0]).toEqual(instruction);
      expect(() => buildAnthropicRequest(req)).toThrow(
        "Unsupported cross-provider request",
      );
    },
  );

  test.each([
    { name: "custom", calls: [customCall, customResult] },
    {
      name: "search and namespace",
      calls: [searchCall, searchResult, functionCall, functionResult],
    },
  ])(
    "retains $name after temporal resolution and dropping provenance",
    ({ calls }) => {
      const req = parseOpenAIResponsesRequest(
        {
          model: "gpt-test",
          input: [
            { role: "user", content: "work" },
            ...calls,
            { role: "user", content: "continue" },
          ],
        },
        {},
      );
      const stored = gatewayMessagesToLore(req.messages, "native-test");
      resolveToolResults(stored);
      const messages = loreMessagesToGateway(stored, new Map(), false);
      const { body } = buildOpenAIResponsesUpstreamRequest(
        { ...req, messages },
        "https://api.openai.com",
      );
      expect((body as { input: unknown[] }).input).toEqual(
        expect.arrayContaining(calls as Record<string, unknown>[]),
      );
    },
  );

  test("namespace participates in deterministic tool identity", () => {
    const one = parseOpenAIResponsesRequest({ input: [functionCall] }, {})
      .messages[0];
    const two = parseOpenAIResponsesRequest(
      { input: [{ ...functionCall, namespace: "other" }] },
      {},
    ).messages[0];
    expect(deterministicID("session", "assistant", 0, one.content)).not.toBe(
      deterministicID("session", "assistant", 0, two.content),
    );
  });

  test.each([
    buildAnthropicRequest,
    (req: Parameters<typeof buildOpenAIUpstreamRequest>[0]) =>
      buildOpenAIUpstreamRequest(req, "https://api.example"),
    (req: Parameters<typeof buildGeminiUpstreamRequest>[0]) =>
      buildGeminiUpstreamRequest(req, "https://api.example"),
  ])("foreign builders reject native definitions", (build) => {
    const req = parseOpenAIResponsesRequest(
      {
        tools: [
          { type: "custom", name: "apply_patch", format: { type: "text" } },
        ],
        input: "work",
      },
      {},
    );
    expect(() => build(req)).toThrow("Unsupported cross-provider request");
  });
});
