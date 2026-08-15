/**
 * Tests for the OpenAI Responses API translator.
 *
 * Covers:
 *  - String/array input parsing
 *  - Upstream request round-trip
 *  - Response conversion (non-streaming and streaming)
 *  - Stop reason → status mapping
 *  - Extras: reasoning/truncation passthrough; previous_response_id is DROPPED
 *    (the gateway is a stateless full-history proxy)
 */
import { describe, test, expect } from "vitest";
import {
  parseOpenAIResponsesRequest,
  buildOpenAIResponsesUpstreamRequest,
  buildOpenAIResponsesResponse,
} from "../src/translate/openai-responses";
import { buildOpenAIResponse } from "../src/translate/openai";
import {
  loreMessagesToGateway,
  removeOrphanedToolResults,
} from "../src/pipeline";
import {
  gatewayMessagesToLore,
  resolveToolResults,
} from "../src/temporal-adapter";
import type {
  GatewayResponse,
  GatewayContentBlock,
  GatewayToolUseBlock,
  GatewayToolResultBlock,
} from "../src/translate/types";

// ---------------------------------------------------------------------------
// parseOpenAIResponsesRequest
// ---------------------------------------------------------------------------

describe("parseOpenAIResponsesRequest", () => {
  const headers = { authorization: "Bearer sk-test123" };

  test("parses string input as single user message", () => {
    const req = parseOpenAIResponsesRequest(
      { model: "gpt-4o", input: "Hello world", stream: false },
      headers,
    );
    expect(req.protocol).toBe("openai-responses");
    expect(req.model).toBe("gpt-4o");
    expect(req.stream).toBe(false);
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0].role).toBe("user");
    expect(req.messages[0].content).toEqual([
      { type: "text", text: "Hello world" },
    ]);
  });

  test("parses array input with message items", () => {
    const req = parseOpenAIResponsesRequest(
      {
        model: "gpt-4o",
        input: [
          { type: "message", role: "user", content: "What is 2+2?" },
          {
            type: "message",
            role: "assistant",
            content: "4",
          },
          { type: "message", role: "user", content: "Thanks!" },
        ],
      },
      headers,
    );
    expect(req.messages).toHaveLength(3);
    expect(req.messages[0].role).toBe("user");
    expect(req.messages[0].content).toEqual([
      { type: "text", text: "What is 2+2?" },
    ]);
    expect(req.messages[1].role).toBe("assistant");
    expect(req.messages[1].content).toEqual([{ type: "text", text: "4" }]);
    expect(req.messages[2].role).toBe("user");
  });

  test("parses function_call and function_call_output items", () => {
    const req = parseOpenAIResponsesRequest(
      {
        model: "gpt-4o",
        input: [
          { type: "message", role: "user", content: "Search for cats" },
          {
            type: "function_call",
            call_id: "call_123",
            name: "search",
            arguments: '{"query":"cats"}',
          },
          {
            type: "function_call_output",
            call_id: "call_123",
            output: "Found 5 cats",
          },
        ],
      },
      headers,
    );
    expect(req.messages).toHaveLength(3);

    // User message
    expect(req.messages[0].role).toBe("user");

    // Function call → tool_use
    expect(req.messages[1].role).toBe("assistant");
    expect(req.messages[1].content).toEqual([
      {
        type: "tool_use",
        id: "call_123",
        name: "search",
        input: { query: "cats" },
      },
    ]);

    // Function output → tool_result
    expect(req.messages[2].role).toBe("user");
    expect(req.messages[2].content).toEqual([
      {
        type: "tool_result",
        toolUseId: "call_123",
        content: [{ type: "text", text: "Found 5 cats" }],
      },
    ]);
  });

  test("extracts text from a structured (array) function_call_output.output", () => {
    // The Responses API also allows `output` to be an array of content parts
    // instead of a plain string. Its text must be extracted (not flattened to
    // "") and any non-text parts preserved as opaque blocks.
    const req = parseOpenAIResponsesRequest(
      {
        model: "gpt-4o",
        input: [
          { type: "message", role: "user", content: "read the chart" },
          {
            type: "function_call",
            call_id: "call_img",
            name: "read",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: "call_img",
            output: [
              { type: "output_text", text: "chart summary" },
              {
                type: "input_image",
                image_url: "data:image/png;base64,AAA",
              },
            ],
          },
        ],
      },
      headers,
    );

    expect(req.messages[2].role).toBe("user");
    expect(req.messages[2].content).toEqual([
      {
        type: "tool_result",
        toolUseId: "call_img",
        content: [
          { type: "text", text: "chart summary" },
          {
            type: "opaque",
            raw: {
              type: "input_image",
              image_url: "data:image/png;base64,AAA",
            },
          },
        ],
      },
    ]);
  });

  test("binds incoming reasoning to provenance without normalizing it as content", () => {
    const reasoning = {
      type: "reasoning",
      id: "rs_1",
      encrypted_content: "encrypted",
      summary: [],
    };
    const req = parseOpenAIResponsesRequest(
      {
        model: "gpt-5.6",
        input: [
          { type: "message", role: "user", content: "continue" },
          reasoning,
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "answer" }],
          },
        ],
      },
      headers,
    );

    expect(req.messages[1].content).toEqual([{ type: "text", text: "answer" }]);
    const assistantProvenance = req.messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.provenanceContent ?? message.content);
    expect(assistantProvenance).toEqual([
      { type: "opaque", raw: reasoning, responsesItem: true },
      {
        type: "opaque",
        raw: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "answer" }],
        },
        responsesItem: true,
      },
    ]);
    expect(req.messages[1].provenancePositions).toEqual([1]);
  });

  test("binds unknown self-contained output items to provenance", () => {
    const unknown = {
      type: "computer_screenshot",
      id: "screen_1",
      image_url: "data:image/png;base64,AAA",
    };
    const req = parseOpenAIResponsesRequest(
      {
        model: "gpt-5.6",
        input: [
          { type: "message", role: "user", content: "continue" },
          unknown,
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "answer" }],
          },
        ],
      },
      headers,
    );

    expect(req.messages[1].content).toEqual([{ type: "text", text: "answer" }]);
    const assistantProvenance = req.messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.provenanceContent ?? message.content);
    expect(assistantProvenance).toEqual([
      { type: "opaque", raw: unknown, responsesItem: true },
      {
        type: "opaque",
        raw: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "answer" }],
        },
        responsesItem: true,
      },
    ]);
  });

  test("round-trips refusal and unknown output as top-level Responses items", () => {
    const refusal = {
      type: "message",
      id: "msg_refusal",
      role: "assistant",
      content: [{ type: "refusal", refusal: "cannot comply" }],
    };
    const unknown = {
      type: "computer_screenshot",
      id: "screen_1",
      image_url: "data:image/png;base64,AAA",
    };
    const req = parseOpenAIResponsesRequest(
      {
        model: "gpt-5.6",
        input: [
          { type: "message", role: "user", content: "continue" },
          refusal,
          unknown,
        ],
      },
      headers,
    );
    const body = buildOpenAIResponsesUpstreamRequest(
      req,
      "https://api.openai.com",
    ).body as { input: Array<Record<string, unknown>> };

    expect(
      req.messages
        .filter((message) => message.role === "assistant")
        .flatMap((message) => message.provenanceContent ?? message.content),
    ).toEqual([
      { type: "opaque", raw: refusal, responsesItem: true },
      { type: "opaque", raw: unknown, responsesItem: true },
    ]);
    expect(body.input).toContainEqual(refusal);
    expect(body.input).toContainEqual(unknown);
    expect(body.input).not.toContainEqual(
      expect.objectContaining({ content: [refusal] }),
    );
  });

  test("coalesces canonical fragments from one assistant message", () => {
    const message = {
      type: "message",
      id: "msg_mixed",
      role: "assistant",
      status: "completed",
      content: [
        { type: "output_text", text: "preamble" },
        { type: "refusal", refusal: "cannot continue" },
      ],
    };
    const req = parseOpenAIResponsesRequest(
      { model: "gpt-5.6", input: [message] },
      headers,
    );
    const body = buildOpenAIResponsesUpstreamRequest(
      req,
      "https://api.openai.com",
    ).body as { input: Array<Record<string, unknown>> };

    expect(body.input).toEqual([message]);
  });

  test("coalesces parallel function_call items into one assistant message", () => {
    const req = parseOpenAIResponsesRequest(
      {
        model: "gpt-5.5",
        input: [
          { type: "message", role: "user", content: "do two things" },
          {
            type: "function_call",
            call_id: "call_A",
            name: "read",
            arguments: "{}",
          },
          {
            type: "function_call",
            call_id: "call_B",
            name: "grep",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: "call_A",
            output: "result A",
          },
          {
            type: "function_call_output",
            call_id: "call_B",
            output: "result B",
          },
        ],
      },
      headers,
    );

    // user, assistant (both tool_use), user (both tool_result)
    expect(req.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);

    const toolUses = req.messages[1].content as GatewayToolUseBlock[];
    expect(toolUses.map((b) => b.id)).toEqual(["call_A", "call_B"]);

    const toolResults = req.messages[2].content as GatewayToolResultBlock[];
    expect(toolResults.map((b) => b.toolUseId)).toEqual(["call_A", "call_B"]);
  });

  test("coalesces parallel function_call items across interleaved reasoning items", () => {
    const req = parseOpenAIResponsesRequest(
      {
        model: "gpt-5.5",
        input: [
          { type: "message", role: "user", content: "do two things" },
          {
            type: "function_call",
            call_id: "call_A",
            name: "read",
            arguments: "{}",
          },
          // The Responses API can interleave reasoning items between calls;
          // they are skipped and must NOT break coalescing of A and B.
          { type: "reasoning", summary: [] },
          {
            type: "function_call",
            call_id: "call_B",
            name: "grep",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: "call_A",
            output: "result A",
          },
          {
            type: "function_call_output",
            call_id: "call_B",
            output: "result B",
          },
        ],
      },
      headers,
    );

    expect(req.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(
      (req.messages[1].content as GatewayToolUseBlock[]).map((b) => b.id),
    ).toEqual(["call_A", "call_B"]);
    expect(
      (req.messages[2].content as GatewayToolResultBlock[]).map(
        (b) => b.toolUseId,
      ),
    ).toEqual(["call_A", "call_B"]);
  });

  test("sequential call/output pairs are NOT coalesced across the boundary", () => {
    const req = parseOpenAIResponsesRequest(
      {
        model: "gpt-5.5",
        input: [
          { type: "message", role: "user", content: "go" },
          {
            type: "function_call",
            call_id: "call_A",
            name: "read",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: "call_A",
            output: "result A",
          },
          {
            type: "function_call",
            call_id: "call_B",
            name: "grep",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: "call_B",
            output: "result B",
          },
        ],
      },
      headers,
    );

    // Each call stays adjacent to its own output: asst[A] user[A] asst[B] user[B].
    expect(req.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(
      (req.messages[1].content as GatewayToolUseBlock[]).map((b) => b.id),
    ).toEqual(["call_A"]);
    expect(
      (req.messages[2].content as GatewayToolResultBlock[]).map(
        (b) => b.toolUseId,
      ),
    ).toEqual(["call_A"]);
    expect(
      (req.messages[3].content as GatewayToolUseBlock[]).map((b) => b.id),
    ).toEqual(["call_B"]);
    expect(
      (req.messages[4].content as GatewayToolResultBlock[]).map(
        (b) => b.toolUseId,
      ),
    ).toEqual(["call_B"]);
  });

  test("does not merge function_call into a preceding assistant text message", () => {
    const req = parseOpenAIResponsesRequest(
      {
        model: "gpt-5.5",
        input: [
          { type: "message", role: "user", content: "go" },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Let me check." }],
          },
          {
            type: "function_call",
            call_id: "call_A",
            name: "read",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: "call_A",
            output: "result A",
          },
        ],
      },
      headers,
    );

    // The assistant text message stays separate from the tool_use message.
    expect(req.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "assistant",
      "user",
    ]);
    expect(req.messages[1].content).toEqual([
      { type: "text", text: "Let me check." },
    ]);
    expect(
      (req.messages[2].content as GatewayToolUseBlock[]).map((b) => b.id),
    ).toEqual(["call_A"]);
  });

  test("end-to-end: parallel tool calls survive reconstruction with no orphans", () => {
    const req = parseOpenAIResponsesRequest(
      {
        model: "gpt-5.5",
        input: [
          { type: "message", role: "user", content: "do two things" },
          {
            type: "function_call",
            call_id: "call_A",
            name: "read",
            arguments: "{}",
          },
          {
            type: "function_call",
            call_id: "call_B",
            name: "grep",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: "call_A",
            output: "result A",
          },
          {
            type: "function_call_output",
            call_id: "call_B",
            output: "result B",
          },
          { type: "message", role: "user", content: "now summarize" },
        ],
      },
      headers,
    );

    const lore = gatewayMessagesToLore(req.messages, "test-session");
    resolveToolResults(lore);
    const reconstructed = loreMessagesToGateway(lore);

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      removeOrphanedToolResults(reconstructed);
    } finally {
      console.warn = origWarn;
    }

    expect(warnings.filter((w) => w.includes("orphaned tool_use"))).toEqual([]);

    const allText = reconstructed
      .flatMap((m) => m.content)
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text);
    expect(allText).not.toContain("[assistant response]");

    const assistant = reconstructed.find(
      (m) =>
        m.role === "assistant" &&
        m.content.some((b: GatewayContentBlock) => b.type === "tool_use"),
    );
    if (!assistant) throw new Error("expected assistant message");
    const ids = assistant.content
      .filter((b): b is GatewayToolUseBlock => b.type === "tool_use")
      .map((b) => b.id)
      .sort();
    expect(ids).toEqual(["call_A", "call_B"]);
  });

  test("drops item_reference items without breaking surrounding messages", () => {
    const reference = { type: "item_reference", id: "msg_server_123" };
    const req = parseOpenAIResponsesRequest(
      {
        model: "gpt-5.5",
        input: [
          { type: "message", role: "user", content: "hello" },
          // Server-side reference the gateway cannot resolve — must be dropped,
          // not crash, and not corrupt the surrounding messages.
          reference,
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "hi" }],
          },
        ],
      },
      headers,
    );

    expect(req.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(req.messages[0].content).toEqual([{ type: "text", text: "hello" }]);
    expect(req.messages[1].content).toEqual([{ type: "text", text: "hi" }]);
    expect(
      req.messages.flatMap(
        (message) => message.provenanceContent ?? message.content,
      ),
    ).not.toContainEqual(reference);
    const body = buildOpenAIResponsesUpstreamRequest(
      req,
      "https://api.openai.com",
    ).body as { input: Array<Record<string, unknown>> };
    expect(body.input).not.toContainEqual(reference);
  });

  test("extracts instructions as system prompt", () => {
    const req = parseOpenAIResponsesRequest(
      {
        model: "gpt-4o",
        instructions: "You are a helpful assistant.",
        input: "Hi",
      },
      headers,
    );
    expect(req.system).toBe("You are a helpful assistant.");
  });

  test("parses tools in Responses API format", () => {
    const req = parseOpenAIResponsesRequest(
      {
        model: "gpt-4o",
        input: "Hello",
        tools: [
          {
            type: "function",
            name: "get_weather",
            description: "Get the weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
            },
          },
          {
            type: "web_search",
            name: "web_search",
          },
        ],
      },
      headers,
    );
    // Only function tools are parsed
    expect(req.tools).toHaveLength(1);
    expect(req.tools[0]).toEqual({
      name: "get_weather",
      description: "Get the weather",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
      },
    });
  });

  test("extracts max_output_tokens", () => {
    const req = parseOpenAIResponsesRequest(
      { model: "gpt-4o", input: "Hi", max_output_tokens: 8192 },
      headers,
    );
    expect(req.maxTokens).toBe(8192);
  });

  test("defaults max_output_tokens to 4096", () => {
    const req = parseOpenAIResponsesRequest(
      { model: "gpt-4o", input: "Hi" },
      headers,
    );
    expect(req.maxTokens).toBe(4096);
  });

  test("preserves Responses API extras", () => {
    const req = parseOpenAIResponsesRequest(
      {
        model: "gpt-4o",
        input: "Hi",
        temperature: 0.7,
        previous_response_id: "resp_abc123",
        reasoning: { effort: "high" },
        truncation: "auto",
        provider: { only: ["google-vertex/europe"], allow_fallbacks: false },
      },
      headers,
    );
    expect(req.extras?.temperature).toBe(0.7);
    expect(req.extras?.previous_response_id).toBe("resp_abc123");
    expect(req.extras?.reasoning).toEqual({ effort: "high" });
    expect(req.extras?.truncation).toBe("auto");
    expect(req.extras?.provider).toEqual({
      only: ["google-vertex/europe"],
      allow_fallbacks: false,
    });
  });

  test("parses message with content array (input_text parts)", () => {
    const req = parseOpenAIResponsesRequest(
      {
        model: "gpt-4o",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "Hello " },
              { type: "input_text", text: "world" },
            ],
          },
        ],
      },
      headers,
    );
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0].content).toEqual([
      { type: "text", text: "Hello " },
      { type: "text", text: "world" },
    ]);
  });

  test("handles messages without explicit type field", () => {
    const req = parseOpenAIResponsesRequest(
      {
        model: "gpt-4o",
        input: [{ role: "user", content: "Hello" }],
      },
      headers,
    );
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0].role).toBe("user");
  });
});

// ---------------------------------------------------------------------------
// buildOpenAIResponsesUpstreamRequest
// ---------------------------------------------------------------------------

describe("buildOpenAIResponsesUpstreamRequest", () => {
  test("builds correct URL and body structure", () => {
    const req = parseOpenAIResponsesRequest(
      {
        model: "gpt-4o",
        input: "Hello",
        instructions: "Be helpful",
        stream: true,
        max_output_tokens: 2048,
        temperature: 0.5,
        provider: { only: ["google-vertex/europe"] },
      },
      { authorization: "Bearer sk-test" },
    );

    const result = buildOpenAIResponsesUpstreamRequest(
      req,
      "https://openrouter.ai/api",
    );

    expect(result.url).toBe("https://openrouter.ai/api/v1/responses");
    expect(result.headers["content-type"]).toBe("application/json");
    expect(result.headers.Authorization).toBe("Bearer sk-test");

    const body = result.body as Record<string, unknown>;
    expect(body.model).toBe("gpt-4o");
    expect(body.stream).toBe(true);
    expect(body.instructions).toBe("Be helpful");
    expect(body.max_output_tokens).toBe(2048);
    expect(body.temperature).toBe(0.5);
    expect(body.provider).toEqual({ only: ["google-vertex/europe"] });
    expect(Array.isArray(body.input)).toBe(true);
  });

  test("does not forward OpenRouter provider options to another provider", () => {
    const req = parseOpenAIResponsesRequest(
      {
        model: "gpt-5-mini",
        input: "Hello",
        provider: { only: ["must-not-leak"] },
      },
      { "x-lore-provider": "openai" },
    );
    const body = buildOpenAIResponsesUpstreamRequest(
      req,
      "https://api.openai.com",
    ).body as Record<string, unknown>;

    expect(Object.hasOwn(body, "provider")).toBe(false);
  });

  test.each([
    ["explicit null", null],
    ["empty object", {}],
  ])("preserves %s OpenRouter provider values", (_label, provider) => {
    const req = parseOpenAIResponsesRequest(
      {
        model: "anthropic/claude-sonnet-4-6",
        input: "Hello",
        provider,
      },
      {},
    );
    req.metadata.provider = { only: ["stale-metadata-provider"] };

    const body = buildOpenAIResponsesUpstreamRequest(
      req,
      "https://openrouter.ai/api",
    ).body as Record<string, unknown>;
    expect(Object.hasOwn(body, "provider")).toBe(true);
    expect(body.provider).toEqual(provider);
  });

  test("round-trips tool definitions", () => {
    const req = parseOpenAIResponsesRequest(
      {
        model: "gpt-4o",
        input: "Hello",
        tools: [
          {
            type: "function",
            name: "search",
            description: "Search the web",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
      {},
    );

    const result = buildOpenAIResponsesUpstreamRequest(
      req,
      "https://api.openai.com",
    );
    const body = result.body as Record<string, unknown>;
    const tools = body.tools as Array<Record<string, unknown>>;

    expect(tools).toHaveLength(1);
    expect(tools[0].type).toBe("function");
    expect(tools[0].name).toBe("search");
    expect(tools[0].description).toBe("Search the web");
    expect(tools[0].parameters).toEqual({ type: "object", properties: {} });
  });

  test("marks the closed recall schema strict without changing client tools", () => {
    const req = parseOpenAIResponsesRequest(
      {
        model: "gpt-4o",
        input: "Hello",
        tools: [
          {
            type: "function",
            name: "read",
            description: "Read a file",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
      {},
    );
    req.tools.push({
      name: "recall",
      description: "Recall memory",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          scope: { type: "string" },
          id: { type: "string" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    });

    const body = buildOpenAIResponsesUpstreamRequest(
      req,
      "https://api.openai.com",
    ).body as { tools: Array<Record<string, unknown>> };

    expect(body.tools[0]).not.toHaveProperty("strict");
    expect(body.tools[1]).toMatchObject({ name: "recall", strict: true });
    expect(body.tools[1].parameters).toMatchObject({
      required: ["query", "scope", "id"],
      additionalProperties: false,
      properties: {
        scope: { type: ["string", "null"], enum: [null] },
        id: { type: ["string", "null"] },
      },
    });
  });

  test("does NOT forward previous_response_id (gateway is stateless full-history)", () => {
    // The gateway always sends the complete conversation as `input`. Forwarding
    // previous_response_id would make the upstream ALSO prepend its server-stored
    // history (duplication) and defeat the gateway's compression/recall edits.
    const req = parseOpenAIResponsesRequest(
      {
        model: "gpt-4o",
        input: "Hello",
        previous_response_id: "resp_abc",
        reasoning: { effort: "medium" },
      },
      {},
    );

    const result = buildOpenAIResponsesUpstreamRequest(
      req,
      "https://api.openai.com",
    );
    const body = result.body as Record<string, unknown>;
    expect(body.previous_response_id).toBeUndefined();
    // reasoning is still forwarded
    expect(body.reasoning).toEqual({ effort: "medium" });
  });

  test("reconstructs input items from gateway messages", () => {
    const req = parseOpenAIResponsesRequest(
      {
        model: "gpt-4o",
        input: [
          { type: "message", role: "user", content: "Search for cats" },
          {
            type: "function_call",
            call_id: "call_1",
            name: "search",
            arguments: '{"q":"cats"}',
          },
          {
            type: "function_call_output",
            call_id: "call_1",
            output: "cats found",
          },
        ],
      },
      {},
    );

    const result = buildOpenAIResponsesUpstreamRequest(
      req,
      "https://api.openai.com",
    );
    const body = result.body as Record<string, unknown>;
    const input = body.input as Array<Record<string, unknown>>;

    expect(input).toHaveLength(3);
    expect(input[0].type).toBe("message");
    expect(input[1].type).toBe("function_call");
    expect(input[1].call_id).toBe("call_1");
    expect(input[1].name).toBe("search");
    expect(input[2].type).toBe("function_call_output");
    expect(input[2].call_id).toBe("call_1");
    expect(input[2].output).toBe("cats found");
  });

  test("emits preserved reasoning as a top-level Responses input item", () => {
    const req = parseOpenAIResponsesRequest(
      { model: "gpt-5.6", input: "continue", stream: true },
      {},
    );
    req.messages.push({
      role: "assistant",
      content: [
        {
          type: "opaque",
          responsesItem: true,
          raw: {
            type: "reasoning",
            id: "rs_1",
            encrypted_content: "encrypted",
          },
        },
      ],
    });

    const body = buildOpenAIResponsesUpstreamRequest(
      req,
      "https://api.openai.com",
    ).body as { input: Array<Record<string, unknown>> };

    expect(body.input).toContainEqual({
      type: "reasoning",
      id: "rs_1",
      encrypted_content: "encrypted",
    });
    expect(body.input).not.toContainEqual(
      expect.objectContaining({
        type: "message",
        content: [expect.objectContaining({ type: "reasoning" })],
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// buildOpenAIResponsesResponse
// ---------------------------------------------------------------------------

describe("buildOpenAIResponsesResponse", () => {
  const baseResponse: GatewayResponse = {
    id: "resp_test123",
    model: "gpt-4o",
    content: [{ type: "text", text: "Hello! How can I help?" }],
    stopReason: "end_turn",
    usage: {
      inputTokens: 10,
      outputTokens: 8,
    },
  };

  test("non-streaming: builds correct Responses API JSON", async () => {
    const response = buildOpenAIResponsesResponse(baseResponse, false);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.id).toBe("resp_test123");
    expect(body.object).toBe("response");
    expect(body.model).toBe("gpt-4o");
    expect(body.status).toBe("completed");

    const output = body.output as Array<Record<string, unknown>>;
    expect(output).toHaveLength(1);
    expect(output[0].type).toBe("message");
    expect(output[0].role).toBe("assistant");

    const content = output[0].content as Array<Record<string, unknown>>;
    expect(content[0].type).toBe("output_text");
    expect(content[0].text).toBe("Hello! How can I help?");

    const usage = body.usage as Record<string, number>;
    expect(usage.input_tokens).toBe(10);
    expect(usage.output_tokens).toBe(8);
    expect(usage.total_tokens).toBe(18);
  });

  test("non-streaming: tool_use maps to function_call output", async () => {
    const resp: GatewayResponse = {
      id: "test",
      model: "gpt-4o",
      content: [
        { type: "text", text: "Let me search." },
        {
          type: "tool_use",
          id: "call_abc",
          name: "search",
          input: { query: "cats" },
        },
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 5, outputTokens: 10 },
    };

    const response = buildOpenAIResponsesResponse(resp, false);
    const body = (await response.json()) as Record<string, unknown>;
    const output = body.output as Array<Record<string, unknown>>;

    expect(output).toHaveLength(2);
    // First: text message
    expect(output[0].type).toBe("message");
    // Second: function_call
    expect(output[1].type).toBe("function_call");
    expect(output[1].call_id).toBe("call_abc");
    expect(output[1].name).toBe("search");
    expect(output[1].arguments).toBe('{"query":"cats"}');
  });

  test("non-streaming: preserves validated native output items", async () => {
    const rawOutputItems = [
      {
        type: "web_search_call",
        id: "ws_abc",
        status: "completed",
        action: { type: "search", query: "cats" },
      },
    ];
    const response = buildOpenAIResponsesResponse(
      { ...baseResponse, rawOutputItems },
      false,
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.output).toEqual(rawOutputItems);
  });

  test("non-streaming: max_tokens maps to incomplete status", async () => {
    const resp: GatewayResponse = {
      ...baseResponse,
      stopReason: "max_tokens",
    };

    const response = buildOpenAIResponsesResponse(resp, false);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("incomplete");
    expect(body.incomplete_details).toEqual({
      reason: "max_output_tokens",
    });
  });

  test("non-streaming: id gets resp_ prefix if missing", async () => {
    const resp: GatewayResponse = {
      ...baseResponse,
      id: "msg_123",
    };

    const response = buildOpenAIResponsesResponse(resp, false);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.id).toBe("resp_msg_123");
  });

  test("streaming: produces Responses API SSE events", async () => {
    const response = buildOpenAIResponsesResponse(baseResponse, true);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const text = await response.text();
    // Should contain key event types
    expect(text).toContain("event: response.created");
    expect(text).toContain("event: response.in_progress");
    expect(text).toContain("event: response.output_item.added");
    expect(text).toContain("event: response.output_text.delta");
    expect(text).toContain("event: response.output_text.done");
    expect(text).toContain("event: response.output_item.done");
    expect(text).toContain("event: response.completed");

    // Should contain the actual text
    expect(text).toContain("Hello! How can I help?");
  });

  test("streaming: max_tokens emits an incomplete terminal", async () => {
    const response = buildOpenAIResponsesResponse(
      { ...baseResponse, stopReason: "max_tokens" },
      true,
    );
    const text = await response.text();

    expect(text).toContain("event: response.incomplete");
    expect(text).toContain('"status":"incomplete"');
    expect(text).toContain('"reason":"max_output_tokens"');
    expect(text).not.toContain("event: response.completed");
  });

  test.each([false, true])(
    "stream=%s: content_filter remains an incomplete terminal",
    async (streaming) => {
      const response = buildOpenAIResponsesResponse(
        { ...baseResponse, stopReason: "content_filter" },
        streaming,
      );
      const text = await response.text();

      expect(text).toContain('"status":"incomplete"');
      expect(text).toContain('"reason":"content_filter"');
      if (streaming) {
        expect(text).toContain("event: response.incomplete");
        expect(text).not.toContain("event: response.completed");
      }
    },
  );

  test("streaming: tool_use produces function_call events", async () => {
    const resp: GatewayResponse = {
      id: "test",
      model: "gpt-4o",
      content: [
        {
          type: "tool_use",
          id: "call_abc",
          name: "search",
          input: { query: "cats" },
        },
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 5, outputTokens: 10 },
    };

    const response = buildOpenAIResponsesResponse(resp, true);
    const text = await response.text();
    expect(text).toContain("event: response.function_call_arguments.delta");
    expect(text).toContain("event: response.function_call_arguments.done");
    expect(text).toContain('"name":"search"');
  });

  test("non-streaming: emits input_tokens_details.cached_tokens when present", async () => {
    const resp: GatewayResponse = {
      ...baseResponse,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 80,
      },
    };

    const response = buildOpenAIResponsesResponse(resp, false);
    const body = (await response.json()) as Record<string, unknown>;
    const usage = body.usage as Record<string, unknown>;
    expect(usage.input_tokens).toBe(180);
    expect(usage.output_tokens).toBe(20);
    const details = usage.input_tokens_details as Record<string, number>;
    expect(details.cached_tokens).toBe(80);
  });

  test("non-streaming: omits input_tokens_details when no cached tokens", async () => {
    const response = buildOpenAIResponsesResponse(baseResponse, false);
    const body = (await response.json()) as Record<string, unknown>;
    const usage = body.usage as Record<string, unknown>;
    expect(usage.input_tokens_details).toBeUndefined();
  });

  test("streaming: emits cached_tokens in response.completed usage", async () => {
    const resp: GatewayResponse = {
      ...baseResponse,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 80,
      },
    };

    const response = buildOpenAIResponsesResponse(resp, true);
    const text = await response.text();
    expect(text).toContain('"cached_tokens":80');
  });
});

// ---------------------------------------------------------------------------
// buildOpenAIResponse — cached_tokens tracking (Chat Completions egress)
// ---------------------------------------------------------------------------

describe("buildOpenAIResponse (Chat Completions) — cached_tokens", () => {
  test("non-streaming: emits prompt_tokens_details.cached_tokens when present", async () => {
    const resp: GatewayResponse = {
      id: "chatcmpl-test",
      model: "gpt-4o",
      content: [{ type: "text", text: "Hello" }],
      stopReason: "end_turn",
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 80,
      },
    };

    const response = buildOpenAIResponse(resp, false);
    const body = (await response.json()) as Record<string, unknown>;
    const usage = body.usage as Record<string, unknown>;
    expect(usage.prompt_tokens).toBe(180);
    expect(usage.completion_tokens).toBe(20);
    const details = usage.prompt_tokens_details as Record<string, number>;
    expect(details.cached_tokens).toBe(80);
  });

  test("non-streaming: omits prompt_tokens_details when no cached tokens", async () => {
    const resp: GatewayResponse = {
      id: "chatcmpl-test",
      model: "gpt-4o",
      content: [{ type: "text", text: "Hello" }],
      stopReason: "end_turn",
      usage: { inputTokens: 50, outputTokens: 10 },
    };

    const response = buildOpenAIResponse(resp, false);
    const body = (await response.json()) as Record<string, unknown>;
    const usage = body.usage as Record<string, unknown>;
    expect(usage.prompt_tokens_details).toBeUndefined();
  });
});
