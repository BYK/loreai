import { describe, expect, test } from "vitest";
import {
  buildOpenAIResponsesUpstreamRequest,
  parseOpenAIResponsesRequest,
} from "../src/translate/openai-responses";
import {
  buildAnthropicRequest,
  buildAnthropicNonStreamResponse,
} from "../src/translate/anthropic";
import {
  buildOpenAIUpstreamRequest,
  buildOpenAIResponse,
} from "../src/translate/openai";
import {
  buildGeminiUpstreamRequest,
  buildGeminiResponseBody,
  buildGeminiResponse,
} from "../src/translate/gemini";
import { gatewayMessagesToLore } from "../src/temporal-adapter";
import { findRecallToolUse, hasOtherToolUse } from "../src/recall";
import { ZERO_USAGE } from "../src/translate/types";
import { accumulateResponsesNonStreamJSON } from "../src/pipeline";
import { buildSSEResponse } from "../src/stream/anthropic";

const customCall = {
  type: "custom_tool_call",
  call_id: "patch-call",
  name: "apply_patch",
  input: "*** Begin Patch\n*** End Patch",
};
const searchCall = {
  type: "tool_search_call",
  call_id: "search-call",
  execution: "client",
  arguments: { query: "files" },
};
const nativeItems = [
  customCall,
  searchCall,
  {
    type: "function_call",
    call_id: "files-call",
    name: "read",
    namespace: "files",
    arguments: "{}",
  },
  {
    type: "custom_tool_call_output",
    call_id: "patch-call",
    output: "done",
  },
  {
    type: "tool_search_output",
    call_id: "search-call",
    tools: [],
  },
];

describe("Codex native tool security boundaries", () => {
  test.each([
    { name: "Anthropic", build: buildAnthropicNonStreamResponse },
    { name: "Anthropic streaming", build: buildSSEResponse },
    {
      name: "Chat Completions",
      build: (response: Parameters<typeof buildOpenAIResponse>[0]) =>
        buildOpenAIResponse(response, false),
    },
    {
      name: "Chat Completions streaming",
      build: (response: Parameters<typeof buildOpenAIResponse>[0]) =>
        buildOpenAIResponse(response, true),
    },
    { name: "Gemini", build: buildGeminiResponseBody },
    {
      name: "Gemini HTTP response",
      build: (response: Parameters<typeof buildGeminiResponse>[0]) =>
        buildGeminiResponse(response, false),
    },
    {
      name: "Gemini streaming",
      build: (response: Parameters<typeof buildGeminiResponse>[0]) =>
        buildGeminiResponse(response, true),
    },
  ])(
    "$name rejects unexpected native upstream calls instead of dropping their kind or namespace",
    ({ build }) => {
      for (const item of nativeItems.slice(0, 3)) {
        const response = accumulateResponsesNonStreamJSON({
          id: "response",
          model: "gpt-test",
          status: "completed",
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          output: [{ ...item, id: "native-item" }],
        });
        expect(() => build(response)).toThrow(
          "Unsupported cross-provider request",
        );
      }
    },
  );

  test.each([
    { ...customCall, name: "recall" },
    {
      type: "function_call",
      call_id: "client-recall",
      name: "recall",
      namespace: "client",
      arguments: "{}",
    },
  ])(
    "distinguishes client-owned native recall from gateway recall in mixed responses: %j",
    (native) => {
      const req = parseOpenAIResponsesRequest(
        {
          input: [
            {
              type: "function_call",
              call_id: "gateway-recall",
              name: "recall",
              arguments: "{}",
            },
            native,
          ],
        },
        {},
      );
      const response = {
        id: "response",
        model: "gpt-test",
        content: req.messages[0].content,
        stopReason: "tool_use" as const,
        usage: { ...ZERO_USAGE },
      };
      expect(findRecallToolUse(response)?.id).toBe("gateway-recall");
      expect(hasOtherToolUse(response)).toBe(true);
    },
  );

  test.each([
    { ...customCall, call_id: "" },
    { ...customCall, call_id: 7 },
    { ...customCall, name: "" },
    { ...customCall, input: {} },
    { ...customCall, namespace: {} },
    { ...searchCall, arguments: null },
    { ...searchCall, arguments: [] },
    { ...searchCall, arguments: "private-token" },
    {
      type: "tool_search_output",
      execution: "server",
      call_id: null,
      tools: {},
    },
    {
      type: "tool_search_output",
      execution: "server",
      call_id: null,
    },
    {
      type: "tool_search_call",
      execution: "server",
      call_id: null,
      arguments: {},
    },
    {
      type: "tool_search_call",
      execution: "server",
      call_id: null,
      name: "web_search",
    },
    {
      type: "tool_search_call",
      execution: "server",
      call_id: null,
      name: "web_search",
      arguments: "{}",
    },
    {
      type: "function_call",
      call_id: "files-call",
      name: "read",
      namespace: "files",
      arguments: "private-token",
    },
    { type: "tool_search_output", call_id: "search-call", tools: {} },
    { type: "custom_tool_call_output", call_id: "patch-call", output: 7 },
  ])("rejects malformed native envelopes without echoing input: %j", (item) => {
    expect(() => parseOpenAIResponsesRequest({ input: [item] }, {})).toThrow(
      "Unsupported cross-provider request",
    );
    try {
      parseOpenAIResponsesRequest({ input: [item] }, {});
    } catch (error) {
      expect((error as Error).message).not.toContain("private-token");
    }
  });

  test.each(["call", "output"] as const)(
    "rejects unknown native %s fields when replaying persisted request data",
    (kind) => {
      const request =
        kind === "call"
          ? parseOpenAIResponsesRequest({ input: [customCall] }, {})
          : parseOpenAIResponsesRequest(
              {
                input: [
                  {
                    type: "custom_tool_call_output",
                    call_id: "patch-call",
                    output: "done",
                  },
                ],
              },
              {},
            );

      if (kind === "call") {
        const message = request.messages.find((entry) =>
          entry.content.some((block) => block.type === "tool_use"),
        );
        const call = message?.content.find(
          (block) => block.type === "tool_use",
        );
        if (!call || call.type !== "tool_use")
          throw new Error("expected native Responses call");
        if (message) delete message.provenanceContent;
        call.responsesCall = {
          ...call.responsesCall,
          provider_private_field: "native-private-sentinel",
        };
      } else {
        const message = request.messages.find((entry) =>
          entry.content.some((block) => block.type === "tool_result"),
        );
        const output = message?.content.find(
          (block) => block.type === "tool_result",
        );
        if (!output || output.type !== "tool_result")
          throw new Error("expected native Responses output");
        if (message) delete message.provenanceContent;
        output.responsesOutput = {
          ...output.responsesOutput,
          provider_private_field: "native-private-sentinel",
        };
      }

      expect(() =>
        buildOpenAIResponsesUpstreamRequest(
          request,
          "https://provider.example",
        ),
      ).toThrow("Unsupported cross-provider request");
    },
  );

  test("rejects unsupported persisted server-owned call status on replay", () => {
    const call = serverOwnedSearchItems[0];
    const request = parseOpenAIResponsesRequest({ input: [{ ...call }] }, {});
    const provenance = request.messages
      .flatMap((message) => message.provenanceContent ?? [])
      .find(
        (block) =>
          block.type === "opaque" && block.raw.type === "tool_search_call",
      );
    if (!provenance || provenance.type !== "opaque") {
      throw new Error("expected server-owned Responses provenance");
    }
    provenance.raw.status = "unsupported";

    expect(() =>
      buildOpenAIResponsesUpstreamRequest(request, "https://provider.example"),
    ).toThrow("Unsupported cross-provider request");
  });

  test.each([
    [
      "function_call",
      {
        type: "function_call",
        id: "item-call",
        call_id: "read-call",
        name: "read",
        arguments: "{}",
        provider_private_field: "native-private-sentinel",
      },
    ],
    [
      "custom_tool_call",
      {
        ...customCall,
        provider_private_field: "native-private-sentinel",
      },
    ],
    [
      "tool_search_call",
      {
        ...searchCall,
        provider_private_field: "native-private-sentinel",
      },
    ],
    [
      "function_call_output",
      {
        type: "function_call_output",
        id: "item-output",
        call_id: "read-call",
        output: "done",
        provider_private_field: "native-private-sentinel",
      },
    ],
    [
      "custom_tool_call_output",
      {
        type: "custom_tool_call_output",
        id: "item-output",
        call_id: "patch-call",
        output: "done",
        provider_private_field: "native-private-sentinel",
      },
    ],
    [
      "tool_search_output",
      {
        type: "tool_search_output",
        id: "item-output",
        call_id: "search-call",
        tools: [],
        provider_private_field: "native-private-sentinel",
      },
    ],
  ])("rejects unknown native persistence fields in %s", (_kind, item) => {
    expect(() => parseOpenAIResponsesRequest({ input: [item] }, {})).toThrow(
      "Unsupported cross-provider request",
    );
    try {
      parseOpenAIResponsesRequest({ input: [item] }, {});
    } catch (error) {
      expect((error as Error).message).not.toContain("native-private-sentinel");
    }
  });

  test.each([
    { label: "custom_tool_call", item: { ...customCall } },
    { label: "client tool_search_call", item: { ...searchCall } },
  ])("rejects unsupported status on $label ingress", ({ item }) => {
    expect(() =>
      parseOpenAIResponsesRequest(
        { input: [{ ...item, status: "unsupported" }] },
        {},
      ),
    ).toThrow("Unsupported cross-provider request");
  });

  test.each([
    {
      label: "custom_tool_call in progress",
      item: { ...customCall, status: "in_progress" },
    },
    {
      label: "client tool_search_call in progress",
      item: { ...searchCall, status: "in_progress" },
    },
  ])("accepts supported status on $label", ({ item }) => {
    const request = parseOpenAIResponsesRequest({ input: [item] }, {});
    expect(() =>
      buildOpenAIResponsesUpstreamRequest(request, "https://provider.example"),
    ).not.toThrow();
  });

  const serverOwnedSearchItems = [
    {
      type: "tool_search_call",
      id: "hosted-call",
      call_id: null,
      execution: "server",
      status: "completed",
      name: "web_search",
      arguments: { paths: ["files"] },
    },
    {
      type: "tool_search_output",
      id: "hosted-output",
      call_id: null,
      execution: "server",
      status: "completed",
      tools: [],
    },
  ];

  test.each(serverOwnedSearchItems)(
    "rejects unknown fields in server-owned $type before checkpointing",
    (item) => {
      expect(() =>
        parseOpenAIResponsesRequest(
          {
            input: [
              { ...item, provider_private_field: "native-private-sentinel" },
            ],
          },
          {},
        ),
      ).toThrow("Unsupported cross-provider request");
    },
  );

  test.each(serverOwnedSearchItems)(
    "rejects unknown fields in persisted server-owned $type provenance on replay",
    (item) => {
      const request = parseOpenAIResponsesRequest({ input: [{ ...item }] }, {});
      const provenance = request.messages
        .flatMap((message) => message.provenanceContent ?? [])
        .find(
          (block) => block.type === "opaque" && block.raw.type === item.type,
        );
      if (!provenance || provenance.type !== "opaque") {
        throw new Error("expected server-owned Responses provenance");
      }
      provenance.raw.provider_private_field = "native-private-sentinel";

      expect(() =>
        buildOpenAIResponsesUpstreamRequest(
          request,
          "https://provider.example",
        ),
      ).toThrow("Unsupported cross-provider request");
    },
  );

  test("preserves incomplete server-owned call status on replay", () => {
    const call = serverOwnedSearchItems[0];
    const request = parseOpenAIResponsesRequest({ input: [{ ...call }] }, {});
    const provenance = request.messages
      .flatMap((message) => message.provenanceContent ?? [])
      .find(
        (block) =>
          block.type === "opaque" && block.raw.type === "tool_search_call",
      );
    if (!provenance || provenance.type !== "opaque") {
      throw new Error("expected server-owned Responses provenance");
    }
    provenance.raw.status = "incomplete";

    expect(() =>
      buildOpenAIResponsesUpstreamRequest(request, "https://provider.example"),
    ).not.toThrow();
  });

  test.each(["missing", "non-array"] as const)(
    "rejects persisted server-owned tool_search_output with %s tools on replay",
    (malformation) => {
      const output = serverOwnedSearchItems[1];
      const request = parseOpenAIResponsesRequest(
        { input: [{ ...output }] },
        {},
      );
      const provenance = request.messages
        .flatMap((message) => message.provenanceContent ?? [])
        .find(
          (block) =>
            block.type === "opaque" && block.raw.type === "tool_search_output",
        );
      if (!provenance || provenance.type !== "opaque") {
        throw new Error("expected server-owned Responses provenance");
      }
      if (malformation === "missing") {
        delete provenance.raw.tools;
      } else {
        provenance.raw.tools = {};
      }

      expect(() =>
        buildOpenAIResponsesUpstreamRequest(
          request,
          "https://provider.example",
        ),
      ).toThrow("Unsupported cross-provider request");
    },
  );

  test.each([
    "missing name",
    "missing arguments",
    "wrong arguments type",
  ] as const)(
    "rejects persisted server-owned tool_search_call with %s on replay",
    (malformation) => {
      const call = serverOwnedSearchItems[0];
      const request = parseOpenAIResponsesRequest({ input: [{ ...call }] }, {});
      const provenance = request.messages
        .flatMap((message) => message.provenanceContent ?? [])
        .find(
          (block) =>
            block.type === "opaque" && block.raw.type === "tool_search_call",
        );
      if (!provenance || provenance.type !== "opaque") {
        throw new Error("expected server-owned Responses provenance");
      }
      if (malformation === "missing name") {
        delete provenance.raw.name;
      } else if (malformation === "missing arguments") {
        delete provenance.raw.arguments;
      } else {
        provenance.raw.arguments = "{}";
      }

      expect(() =>
        buildOpenAIResponsesUpstreamRequest(
          request,
          "https://provider.example",
        ),
      ).toThrow("Unsupported cross-provider request");
    },
  );

  test.each([
    { name: "Anthropic", build: buildAnthropicRequest },
    {
      name: "Chat Completions",
      build: (req: Parameters<typeof buildOpenAIUpstreamRequest>[0]) =>
        buildOpenAIUpstreamRequest(req, "https://provider.example"),
    },
    {
      name: "Gemini",
      build: (req: Parameters<typeof buildGeminiUpstreamRequest>[0]) =>
        buildGeminiUpstreamRequest(req, "https://provider.example"),
    },
  ])(
    "$name rejects every native call/output without tool definitions",
    ({ build }) => {
      for (const item of nativeItems) {
        const req = parseOpenAIResponsesRequest({ input: [item] }, {});
        expect(() => build(req)).toThrow("Unsupported cross-provider request");
      }
    },
  );

  test.each(["string", "array"])(
    "Responses builder rejects a native %s output carried by foreign-source memory",
    (kind) => {
      const req = parseOpenAIResponsesRequest(
        {
          input: [
            {
              type: "custom_tool_call_output",
              call_id: "patch-call",
              output:
                kind === "array"
                  ? [{ type: "input_text", text: "done" }]
                  : "done",
            },
          ],
        },
        {},
      );
      const foreign = { ...req, protocol: "anthropic" as const };
      expect(() =>
        buildOpenAIResponsesUpstreamRequest(
          foreign,
          "https://provider.example",
        ),
      ).toThrow("Unsupported cross-provider request");
    },
  );

  test("native envelope persistence does not capture request credentials", () => {
    const req = parseOpenAIResponsesRequest(
      { input: nativeItems },
      { authorization: "Bearer private-token", "x-api-key": "private-key" },
    );
    const persisted = JSON.stringify(
      gatewayMessagesToLore(req.messages, "security"),
    );
    expect(persisted).not.toContain("private-token");
    expect(persisted).not.toContain("private-key");
    expect(persisted).toContain("responsesCall");
    expect(persisted).toContain("responsesOutput");
  });
});
