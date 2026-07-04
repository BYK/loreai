import { describe, test, expect } from "vitest";
import {
  parseGeminiRequest,
  buildGeminiUpstreamRequest,
  buildGeminiUpstreamUrl,
  parseGeminiResponseJSON,
  buildGeminiResponseBody,
  buildGeminiResponse,
} from "../src/translate/gemini";
import type { GatewayRequest, GatewayResponse } from "../src/translate/types";

// ---------------------------------------------------------------------------
// parseGeminiRequest (Gemini generateContent body → GatewayRequest)
// ---------------------------------------------------------------------------

describe("parseGeminiRequest", () => {
  test("extracts systemInstruction, maps roles, and sets protocol/model/stream", () => {
    const req = parseGeminiRequest(
      {
        systemInstruction: { parts: [{ text: "You are helpful." }] },
        contents: [
          { role: "user", parts: [{ text: "hi" }] },
          { role: "model", parts: [{ text: "hello" }] },
        ],
        generationConfig: { maxOutputTokens: 1234, temperature: 0.5 },
      },
      { "x-goog-api-key": "k" },
      "gemini-2.5-pro",
      false,
    );
    expect(req.protocol).toBe("gemini");
    expect(req.model).toBe("gemini-2.5-pro");
    expect(req.stream).toBe(false);
    expect(req.system).toBe("You are helpful.");
    expect(req.maxTokens).toBe(1234);
    expect(req.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ]);
    // generationConfig preserved for round-trip.
    expect(req.metadata.generationConfig).toEqual({
      maxOutputTokens: 1234,
      temperature: 0.5,
    });
  });

  test("accepts snake_case system_instruction", () => {
    const req = parseGeminiRequest(
      { system_instruction: { parts: [{ text: "sys" }] }, contents: [] },
      {},
      "m",
      false,
    );
    expect(req.system).toBe("sys");
  });

  test("maps functionCall → tool_use and functionResponse → tool_result (paired by name)", () => {
    const req = parseGeminiRequest(
      {
        contents: [
          {
            role: "model",
            parts: [
              { functionCall: { name: "get_weather", args: { city: "SF" } } },
            ],
          },
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  name: "get_weather",
                  response: { temp: 72 },
                },
              },
            ],
          },
        ],
      },
      {},
      "m",
      false,
    );
    expect(req.messages[0].content[0]).toEqual({
      type: "tool_use",
      id: "get_weather",
      name: "get_weather",
      input: { city: "SF" },
    });
    const tr = req.messages[1].content[0];
    expect(tr.type).toBe("tool_result");
    if (tr.type === "tool_result") {
      expect(tr.toolUseId).toBe("get_weather");
      expect(tr.content).toEqual([
        { type: "text", text: JSON.stringify({ temp: 72 }) },
      ]);
    }
  });

  test("parses functionDeclarations into tools", () => {
    const req = parseGeminiRequest(
      {
        contents: [],
        tools: [
          {
            functionDeclarations: [
              {
                name: "search",
                description: "search the web",
                parameters: {
                  type: "object",
                  properties: { q: { type: "string" } },
                },
              },
            ],
          },
        ],
      },
      {},
      "m",
      false,
    );
    expect(req.tools).toEqual([
      {
        name: "search",
        description: "search the web",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      },
    ]);
  });

  test("preserves unknown parts (inlineData) as opaque blocks", () => {
    const req = parseGeminiRequest(
      {
        contents: [
          {
            role: "user",
            parts: [{ inlineData: { mimeType: "image/png", data: "AAAA" } }],
          },
        ],
      },
      {},
      "m",
      false,
    );
    expect(req.messages[0].content[0]).toEqual({
      type: "opaque",
      raw: { inlineData: { mimeType: "image/png", data: "AAAA" } },
    });
  });

  test("defaults maxTokens when generationConfig omits it", () => {
    const req = parseGeminiRequest({ contents: [] }, {}, "m", false);
    expect(req.maxTokens).toBe(8192);
  });
});

// ---------------------------------------------------------------------------
// buildGeminiUpstreamUrl / buildGeminiUpstreamRequest
// ---------------------------------------------------------------------------

describe("buildGeminiUpstreamUrl", () => {
  test("non-stream → :generateContent", () => {
    expect(
      buildGeminiUpstreamUrl(
        "https://generativelanguage.googleapis.com",
        "gemini-2.5-pro",
        false,
      ),
    ).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
    );
  });

  test("stream → :streamGenerateContent?alt=sse", () => {
    expect(
      buildGeminiUpstreamUrl(
        "https://generativelanguage.googleapis.com",
        "gemini-2.5-flash",
        true,
      ),
    ).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
    );
  });
});

describe("buildGeminiUpstreamRequest", () => {
  const base: GatewayRequest = {
    protocol: "gemini",
    model: "gemini-2.5-pro",
    system: "sys prompt",
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "f", name: "f", input: { a: 1 } }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "f",
            content: [{ type: "text", text: '{"ok":true}' }],
          },
        ],
      },
    ],
    tools: [{ name: "f", description: "d", inputSchema: { type: "object" } }],
    stream: false,
    maxTokens: 555,
    metadata: {},
    rawHeaders: { "x-goog-api-key": "key123" },
  };

  test("builds systemInstruction, role-mapped contents, functionCall/response, tools, generationConfig", () => {
    const { url, headers, body } = buildGeminiUpstreamRequest(
      base,
      "https://generativelanguage.googleapis.com",
    );
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
    );
    // x-goog-api-key forwarded (not a managed header).
    expect(headers["x-goog-api-key"]).toBe("key123");
    const b = body as Record<string, unknown>;
    expect(b.systemInstruction).toEqual({ parts: [{ text: "sys prompt" }] });
    expect(b.contents).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
      {
        role: "model",
        parts: [{ functionCall: { name: "f", args: { a: 1 } } }],
      },
      {
        role: "user",
        parts: [{ functionResponse: { name: "f", response: { ok: true } } }],
      },
    ]);
    expect(b.tools).toEqual([
      {
        functionDeclarations: [
          { name: "f", description: "d", parameters: { type: "object" } },
        ],
      },
    ]);
    expect(b.generationConfig).toEqual({ maxOutputTokens: 555 });
  });

  test("stream request builds the streaming URL", () => {
    const { url } = buildGeminiUpstreamRequest(
      { ...base, stream: true },
      "https://generativelanguage.googleapis.com",
    );
    expect(url).toContain(":streamGenerateContent?alt=sse");
  });

  test("omits systemInstruction when there is no system prompt", () => {
    const { body } = buildGeminiUpstreamRequest(
      { ...base, system: "" },
      "https://x",
    );
    expect((body as Record<string, unknown>).systemInstruction).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseGeminiResponseJSON
// ---------------------------------------------------------------------------

describe("parseGeminiResponseJSON", () => {
  test("maps candidate text parts + usageMetadata", () => {
    const resp = parseGeminiResponseJSON({
      candidates: [
        {
          content: { role: "model", parts: [{ text: "answer" }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 3,
        cachedContentTokenCount: 4,
        totalTokenCount: 13,
      },
      modelVersion: "gemini-2.5-pro",
    });
    expect(resp.content).toEqual([{ type: "text", text: "answer" }]);
    expect(resp.stopReason).toBe("end_turn");
    expect(resp.model).toBe("gemini-2.5-pro");
    expect(resp.usage).toEqual({
      inputTokens: 10,
      outputTokens: 3,
      cacheReadInputTokens: 4,
    });
  });

  test("functionCall part → tool_use and stopReason tool_use", () => {
    const resp = parseGeminiResponseJSON({
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ functionCall: { name: "f", args: { x: 1 } } }],
          },
          finishReason: "STOP",
        },
      ],
    });
    expect(resp.content).toEqual([
      { type: "tool_use", id: "f", name: "f", input: { x: 1 } },
    ]);
    expect(resp.stopReason).toBe("tool_use");
  });

  test("MAX_TOKENS finishReason → max_tokens", () => {
    const resp = parseGeminiResponseJSON({
      candidates: [
        { content: { parts: [{ text: "x" }] }, finishReason: "MAX_TOKENS" },
      ],
    });
    expect(resp.stopReason).toBe("max_tokens");
  });

  test("missing usageMetadata → zero usage", () => {
    const resp = parseGeminiResponseJSON({
      candidates: [{ content: { parts: [{ text: "x" }] } }],
    });
    expect(resp.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  test("thought part → thinking block, NOT merged into visible text", () => {
    const resp = parseGeminiResponseJSON({
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              { text: "secret reasoning", thought: true },
              { text: "visible answer" },
            ],
          },
          finishReason: "STOP",
        },
      ],
    });
    expect(resp.content).toEqual([
      { type: "thinking", thinking: "secret reasoning" },
      { type: "text", text: "visible answer" },
    ]);
  });

  test("thoughtsTokenCount is folded into outputTokens", () => {
    const resp = parseGeminiResponseJSON({
      candidates: [{ content: { parts: [{ text: "x" }] } }],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 20,
        thoughtsTokenCount: 500,
      },
    });
    expect(resp.usage).toEqual({ inputTokens: 100, outputTokens: 520 });
  });

  test("SAFETY finishReason is preserved verbatim (not laundered to end_turn)", () => {
    const resp = parseGeminiResponseJSON({
      candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }],
    });
    expect(resp.stopReason).toBe("SAFETY");
  });

  test("prompt-level block (no candidates) surfaces promptFeedback.blockReason", () => {
    const resp = parseGeminiResponseJSON({
      promptFeedback: { blockReason: "SAFETY" },
      usageMetadata: { promptTokenCount: 8 },
    });
    expect(resp.content).toEqual([]);
    expect(resp.stopReason).toBe("SAFETY");
  });

  test("multi-candidate: only candidates[0] is surfaced (documented limitation)", () => {
    const resp = parseGeminiResponseJSON({
      candidates: [
        { content: { parts: [{ text: "cand0" }] }, finishReason: "STOP" },
        { content: { parts: [{ text: "cand1" }] }, finishReason: "STOP" },
      ],
    });
    expect(resp.content).toEqual([{ type: "text", text: "cand0" }]);
  });
});

// ---------------------------------------------------------------------------
// Egress: thinking + preserved finishReason round-trip
// ---------------------------------------------------------------------------

describe("buildGeminiResponseBody — thinking + block reason", () => {
  test("thinking block re-emits as a thought part (thought:true), separate from text", () => {
    const b = buildGeminiResponseBody({
      id: "r",
      model: "gemini-2.5-pro",
      content: [
        { type: "thinking", thinking: "reasoning" },
        { type: "text", text: "answer" },
      ],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const cand = (b.candidates as Array<Record<string, unknown>>)[0];
    const parts = (cand.content as { parts: unknown[] }).parts;
    expect(parts).toEqual([
      { text: "reasoning", thought: true },
      { text: "answer" },
    ]);
  });

  test("preserved block reason echoes verbatim on egress finishReason", () => {
    const b = buildGeminiResponseBody({
      id: "r",
      model: "m",
      content: [],
      stopReason: "SAFETY",
      usage: { inputTokens: 1, outputTokens: 0 },
    });
    const cand = (b.candidates as Array<Record<string, unknown>>)[0];
    expect(cand.finishReason).toBe("SAFETY");
  });
});

// ---------------------------------------------------------------------------
// buildGeminiResponseBody / buildGeminiResponse
// ---------------------------------------------------------------------------

describe("buildGeminiResponse", () => {
  const resp: GatewayResponse = {
    id: "r1",
    model: "gemini-2.5-pro",
    content: [
      { type: "text", text: "hello" },
      { type: "tool_use", id: "f", name: "f", input: { a: 1 } },
    ],
    stopReason: "tool_use",
    usage: { inputTokens: 5, outputTokens: 2, cacheReadInputTokens: 1 },
  };

  test("body shape: candidates(model role) + parts + usageMetadata", () => {
    const b = buildGeminiResponseBody(resp);
    expect(b.candidates).toEqual([
      {
        content: {
          role: "model",
          parts: [
            { text: "hello" },
            { functionCall: { name: "f", args: { a: 1 } } },
          ],
        },
        finishReason: "STOP",
        index: 0,
      },
    ]);
    expect(b.usageMetadata).toEqual({
      promptTokenCount: 5,
      candidatesTokenCount: 2,
      totalTokenCount: 7,
      cachedContentTokenCount: 1,
    });
    expect(b.modelVersion).toBe("gemini-2.5-pro");
  });

  test("non-stream → application/json; stream → SSE data frame", async () => {
    const jsonRes = buildGeminiResponse(resp, false);
    expect(jsonRes.headers.get("content-type")).toBe("application/json");
    const sseRes = buildGeminiResponse(resp, true);
    expect(sseRes.headers.get("content-type")).toBe("text/event-stream");
    const text = await sseRes.text();
    expect(text.startsWith("data: ")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Round-trip structural equivalence (client request → internal → upstream body)
// ---------------------------------------------------------------------------

describe("Gemini round-trip", () => {
  test("request → internal → upstream body preserves contents/tools/system", () => {
    const clientBody = {
      systemInstruction: { parts: [{ text: "sys" }] },
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      tools: [
        {
          functionDeclarations: [
            { name: "f", description: "d", parameters: { type: "object" } },
          ],
        },
      ],
      generationConfig: { maxOutputTokens: 100, temperature: 0.2 },
    };
    const req = parseGeminiRequest(clientBody, {}, "gemini-2.5-pro", false);
    const { body } = buildGeminiUpstreamRequest(req, "https://x");
    const b = body as Record<string, unknown>;
    expect(b.systemInstruction).toEqual(clientBody.systemInstruction);
    expect(b.contents).toEqual(clientBody.contents);
    expect(b.tools).toEqual(clientBody.tools);
    expect(b.generationConfig).toEqual({
      maxOutputTokens: 100,
      temperature: 0.2,
    });
  });
});
