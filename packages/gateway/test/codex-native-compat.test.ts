import fc from "fast-check";
import { responsesProvenanceByMessageId } from "../src/semantic-preparation";
import { describe, expect, test } from "vitest";
import {
  buildOpenAIResponsesUpstreamRequest,
  parseOpenAICodexRequest,
  parseOpenAIResponsesRequest,
  parseOpenAIResponsesRequestChunks,
  STREAMING_PARSE_SPOOL_BYTES,
} from "../src/translate/openai-responses";
import { gatewayMessagesToLore } from "../src/temporal-adapter";
import { loreMessagesToGateway } from "../src/pipeline";

const metadata = { private_native_sentinel: "request-only" };
const developer = (id: string, text: string) => ({
  type: "message",
  id,
  role: "developer",
  content: [{ type: "input_text", text }],
  internal_chat_message_metadata_passthrough: metadata,
});
const user = (id: string, text: string) => ({
  type: "message",
  id,
  role: "user",
  content: [{ type: "input_text", text }],
  internal_chat_message_metadata_passthrough: metadata,
});
const declaration = {
  type: "additional_tools",
  id: "tools_1",
  role: "developer",
  tools: [
    {
      type: "namespace",
      name: "functions",
      description: "Client tools",
      tools: [
        {
          type: "custom",
          name: "exec",
          description: "Run a command",
          format: { type: "text" },
        },
        {
          type: "function",
          name: "wait",
          description: "Wait",
          parameters: { type: "object", properties: {} },
          strict: false,
        },
      ],
    },
  ],
};
function build(input: unknown[], tools?: unknown[]) {
  return {
    model: "gpt-6.1-sol",
    stream: true,
    input,
    ...(tools ? { tools } : {}),
  };
}
function wire(req: ReturnType<typeof parseOpenAIResponsesRequest>) {
  return buildOpenAIResponsesUpstreamRequest(req, "https://api.openai.com")
    .body as Record<string, unknown>;
}
async function* chunks(body: unknown) {
  const bytes = Buffer.from(JSON.stringify(body));
  for (let i = 0; i < bytes.length; i += 509) yield bytes.subarray(i, i + 509);
}

describe("current Codex native Responses compatibility", () => {
  test.each([false, true])(
    "preserves native instructions and tool declarations (large=%s)",
    async (large) => {
      const input = [
        declaration,
        developer("dev_1", "Keep the rule"),
        user(
          "user_1",
          // Cross the streaming cutoff without making token estimation merge
          // one enormous word during the real temporal conversion below.
          large
            ? "native context ".repeat(
                Math.ceil((STREAMING_PARSE_SPOOL_BYTES + 1) / 15),
              )
            : "Hello",
        ),
      ];
      const body = build(input);
      expect(
        Buffer.byteLength(JSON.stringify(body)) > STREAMING_PARSE_SPOOL_BYTES,
      ).toBe(large);
      const req = parseOpenAIResponsesRequest(body, {});
      expect(await parseOpenAIResponsesRequestChunks(chunks(body), {})).toEqual(
        req,
      );
      expect(wire(req).input).toEqual(input);
      expect(wire(req).tools).toBeUndefined();
      expect(req.tools.map((t) => t.name)).toEqual([
        "functions.exec",
        "functions.wait",
      ]);
      expect(req.system).toBe("Keep the rule");
      const stored = JSON.stringify(
        gatewayMessagesToLore(req.messages, "native-session"),
      );
      expect(stored).not.toContain("private_native_sentinel");
      expect(stored).not.toContain("Client tools");
    },
  );

  test("preserves inline instructions around retained history after compression", () => {
    const input = [
      developer("dev_1", "Initial rule"),
      user("user_1", "Old turn"),
      developer("dev_2", "Updated rule"),
      declaration,
      user("user_2", "New turn"),
    ];
    const req = parseOpenAIResponsesRequest(build(input), {});
    expect(wire(req).input).toEqual(input);
    const lore = gatewayMessagesToLore(req.messages, "native-session");
    const provenance = responsesProvenanceByMessageId(req.messages, lore);
    req.messages = loreMessagesToGateway(
      lore.slice(1),
      provenance,
      false,
      true,
    );
    expect(wire(req).input).toEqual([input[0], ...input.slice(2)]);
  });

  test("round trips custom and namespaced calls and results after provenance is dropped", () => {
    const input = [
      declaration,
      user("user_1", "Run it"),
      {
        type: "custom_tool_call",
        id: "ct_1",
        call_id: "call_1",
        name: "exec",
        input: "echo hello",
        status: "completed",
        internal_chat_message_metadata_passthrough: metadata,
      },
      {
        type: "custom_tool_call_output",
        id: "out_1",
        call_id: "call_1",
        output: "hello",
        internal_chat_message_metadata_passthrough: metadata,
      },
      {
        type: "function_call",
        id: "fc_2",
        call_id: "call_2",
        namespace: "functions",
        name: "wait",
        arguments: "{}",
        status: "completed",
        internal_chat_message_metadata_passthrough: metadata,
      },
      {
        type: "function_call_output",
        id: "out_2",
        call_id: "call_2",
        output: "done",
        internal_chat_message_metadata_passthrough: metadata,
      },
      user("user_2", "Continue"),
    ];
    const req = parseOpenAICodexRequest(build(input), {});
    expect(wire(req).input).toEqual(input);
    expect(
      req.messages
        .flatMap((m) => m.content)
        .filter((b) => b.type === "tool_use"),
    ).toMatchObject([
      { name: "exec", input: "echo hello" },
      { name: "functions.wait", input: {} },
    ]);
    const lore = gatewayMessagesToLore(req.messages, "native-tool-session");
    const provenance = responsesProvenanceByMessageId(req.messages, lore);
    req.messages = loreMessagesToGateway(
      lore,
      provenance,
      false,
      true,
      false,
      true,
      true,
    );
    const replay = wire(req).input as Array<Record<string, unknown>>;
    expect(
      replay.find(
        (i) => i.call_id === "call_1" && i.type === "custom_tool_call",
      ),
    ).toMatchObject({ input: "echo hello", name: "exec" });
    expect(
      replay.find((i) => i.call_id === "call_2" && i.type === "function_call"),
    ).toMatchObject({ namespace: "functions", name: "wait", arguments: "{}" });
    expect(
      replay.filter((i) => i.type === "custom_tool_call_output"),
    ).toHaveLength(1);
  });

  test("preserves top-level namespace and custom tool definitions without duplicating them", () => {
    const req = parseOpenAIResponsesRequest(
      build([user("user_1", "Hello")], declaration.tools),
      {},
    );
    expect(wire(req).tools).toEqual(declaration.tools);
  });

  test.each([null, [], "private", 12])(
    "rejects malformed native metadata %j",
    (value) => {
      const item = {
        ...developer("dev_1", "Rule"),
        internal_chat_message_metadata_passthrough: value,
      };
      expect(() =>
        parseOpenAIResponsesRequest(build([item, user("user_1", "Hello")]), {}),
      ).toThrow();
    },
  );
});

import { isImplicitChatGPTResponses } from "../src/codex-routing";
import { loadConfig } from "../src/config";
import { resolveRequestUpstreamRouteForTest } from "../src/pipeline";

describe("Codex ChatGPT routing", () => {
  const headers = {
    authorization: "Bearer synthetic-chatgpt-token",
    "chatgpt-account-id": "synthetic-account",
  };
  test("routes explicit ChatGPT identity to the Codex backend", () => {
    const route = resolveRequestUpstreamRouteForTest(
      {
        model: "gpt-6.1-sol",
        protocol: "openai-responses",
        rawHeaders: headers,
      },
      { ...loadConfig(), upstreamOpenAI: "https://api.openai.com" },
    );
    expect(route.providerID).toBe("openai-codex");
    expect(route.effectiveUpstreamBase).toBe("https://chatgpt.com/backend-api");
  });
  test.each([
    {},
    { authorization: "Bearer api-key" },
    { "chatgpt-account-id": "account" },
    { ...headers, "x-lore-provider": "openai" },
    { ...headers, "x-lore-upstream-url": "https://proxy.example/v1" },
    { ...headers, "x-lore-upstream-path": "/v1/responses" },
  ])(
    "does not infer ChatGPT for missing identity/auth or explicit routing %j",
    (rawHeaders) => {
      expect(
        isImplicitChatGPTResponses(
          Object.fromEntries(
            Object.entries(rawHeaders).filter(
              ([, value]) => typeof value === "string",
            ),
          ),
          {
            upstreamOpenAI: "https://api.openai.com",
          },
        ),
      ).toBe(false);
    },
  );
  test("keeps administrator-configured proxies", () => {
    expect(
      isImplicitChatGPTResponses(headers, {
        upstreamOpenAI: "https://proxy.example/v1",
      }),
    ).toBe(false);
  });
});

import { accumulateResponsesSSEStream } from "../src/stream/openai-responses";

describe("Codex native tool responses", () => {
  test.each(["public", "codex"] as const)(
    "accumulates custom tool input and preserves namespace in %s streams",
    async (validation) => {
      const items = [
        {
          type: "custom_tool_call",
          id: "ct_native",
          call_id: "call_custom",
          name: "exec",
          input: "echo hello",
          status: "completed",
        },
        {
          type: "function_call",
          id: "fc_native",
          call_id: "call_native",
          namespace: "functions",
          name: "recall",
          arguments: '{"query":"client"}',
          status: "completed",
        },
      ];
      const frame = (type: string, data: Record<string, unknown>) =>
        `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      let sse = frame("response.created", {
        response: {
          id: "resp_native",
          model: "gpt-6.1-sol",
          status: "in_progress",
        },
      });
      for (const [output_index, item] of items.entries()) {
        sse += frame("response.output_item.added", {
          output_index,
          item: {
            ...item,
            status: "in_progress",
            ...(item.type === "custom_tool_call"
              ? { input: "" }
              : { arguments: "" }),
          },
        });
        if (item.type === "function_call")
          sse += frame("response.function_call_arguments.done", {
            output_index,
            item_id: item.id,
            arguments: item.arguments,
          });
        sse += frame("response.output_item.done", { output_index, item });
      }
      sse += frame("response.completed", {
        response: {
          id: "resp_native",
          model: "gpt-6.1-sol",
          status: "completed",
          output: items,
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      });
      const response = await accumulateResponsesSSEStream(new Response(sse), {
        validation,
      });
      expect(response.content).toMatchObject([
        { type: "tool_use", name: "exec", input: "echo hello" },
        {
          type: "tool_use",
          name: "functions.recall",
          input: { query: "client" },
        },
      ]);
      expect(response.stopReason).toBe("tool_use");
      expect(response.rawOutputItems).toEqual(items);
    },
  );
});

describe("native instruction ordering properties", () => {
  test("keeps context relative to every surviving source turn", () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 15 }),
        (retained) => {
          const input: Array<ReturnType<typeof developer>> = [
            developer("initial", "Initial"),
          ];
          for (let i = 0; i < retained.length; i++)
            input.push(
              user(`u_${i}`, `Question ${i}`),
              developer(`d_${i}`, `Rule ${i}`),
            );
          input.push(user("final", "Latest question"));
          const req = parseOpenAIResponsesRequest(build(input), {});
          const lore = gatewayMessagesToLore(req.messages, "property-session");
          const provenance = responsesProvenanceByMessageId(req.messages, lore);
          req.messages = loreMessagesToGateway(
            lore.filter((_m, i) => i === retained.length || retained[i]),
            provenance,
            false,
            true,
          );
          const expected = input.filter(
            (item) =>
              item.role === "developer" ||
              item.id === "final" ||
              retained[Number(item.id.slice(2))],
          );
          expect(wire(req).input).toEqual(expected);
        },
      ),
      { numRuns: 50 },
    );
  });
});

test("retains multipart custom result kind after raw provenance is dropped", () => {
  const input = [
    declaration,
    user("u", "Run"),
    {
      type: "custom_tool_call",
      id: "ct",
      call_id: "call",
      name: "exec",
      input: "echo hello",
      status: "completed",
    },
    {
      type: "custom_tool_call_output",
      id: "out",
      call_id: "call",
      output: [
        { type: "output_text", text: "first" },
        { type: "output_text", text: "second" },
      ],
      internal_chat_message_metadata_passthrough: metadata,
    },
  ];
  const req = parseOpenAIResponsesRequest(build(input), {});
  const lore = gatewayMessagesToLore(req.messages, "multipart-session");
  const provenance = responsesProvenanceByMessageId(req.messages, lore);
  req.messages = loreMessagesToGateway(lore, provenance, false, true);
  expect(
    (wire(req).input as Array<Record<string, unknown>>).find(
      (item) =>
        item.call_id === "call" && item.type === "custom_tool_call_output",
    ),
  ).toEqual(input[3]);
});

import {
  PreparationTiming,
  prepareSemanticMessages,
} from "../src/semantic-preparation";

test("keeps native provenance out of durable and speculative source checkpoints", async () => {
  const req = parseOpenAIResponsesRequest(
    build([developer("dev", "Rule"), user("u", "Hello")]),
    {},
  );
  const prepared = await prepareSemanticMessages({
    messages: req.messages,
    sessionID: "native-private-checkpoint",
    projectPath: "/test/native-private-checkpoint",
    noStore: false,
    protocol: req.protocol,
    checkpointBoundarySafe: false,
    forceFull: true,
    timing: new PreparationTiming(req),
  });
  expect(prepared.checkpoint).toBeUndefined();
  expect(prepared.sourceWindow).toBeUndefined();
});

import { accumulateResponsesNonStreamJSON } from "../src/pipeline";

test("keeps native tool identity in buffered Responses too", () => {
  const result = accumulateResponsesNonStreamJSON({
    id: "resp_buffered_native",
    model: "gpt-6-sol",
    status: "completed",
    output: [
      {
        type: "custom_tool_call",
        id: "ct_buffered",
        call_id: "call_custom_buffered",
        name: "exec",
        input: "echo hello",
        status: "completed",
      },
      {
        type: "function_call",
        id: "fc_buffered",
        call_id: "call_function_buffered",
        name: "recall",
        namespace: "functions",
        arguments: '{"query":"client"}',
        status: "completed",
      },
    ],
    usage: { input_tokens: 10, output_tokens: 2 },
  });
  expect(result.content).toMatchObject([
    { type: "tool_use", name: "exec", input: "echo hello" },
    { type: "tool_use", name: "functions.recall", input: { query: "client" } },
  ]);
});
