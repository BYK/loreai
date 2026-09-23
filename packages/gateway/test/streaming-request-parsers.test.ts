import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, test } from "vitest";
import {
  parseAnthropicRequest,
  parseAnthropicRequestChunks,
} from "../src/translate/anthropic";
import {
  parseGeminiRequest,
  parseGeminiRequestChunks,
} from "../src/translate/gemini";
import {
  parseOpenAIRequest,
  parseOpenAIRequestChunks,
} from "../src/translate/openai";
import { STREAMING_PARSE_SPOOL_BYTES } from "../src/translate/streaming-request";
import { createHarness, type Harness } from "./helpers/harness";
import { digestChain } from "../src/chain-digest";
import { encodeContextBoundary } from "../src/context-boundary";

const headers = { authorization: "Bearer test" };

async function* chunks(
  bytes: Uint8Array,
  size = 31,
): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    yield bytes.subarray(offset, offset + size);
  }
}

function encoded(body: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(body));
}

describe("streaming request parsers", () => {
  test("Anthropic matches sync parsing for large and small bodies", async () => {
    const body = {
      model: "claude",
      system: "system",
      messages: [
        { role: "user", content: "x".repeat(STREAMING_PARSE_SPOOL_BYTES) },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call-1", name: "lookup", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-1",
              content: [{ type: "text", text: "ok" }],
            },
          ],
        },
      ],
      tools: [
        {
          name: "lookup",
          description: "Look up a value",
          input_schema: { type: "object" },
        },
      ],
      stream: true,
      max_tokens: 100,
      metadata: { user_id: "u1" },
      temperature: 0.3,
    };
    await expect(
      parseAnthropicRequestChunks(chunks(encoded(body)), headers),
    ).resolves.toEqual(parseAnthropicRequest(body, headers));
    const small = {
      model: "claude",
      messages: [{ role: "user", content: "hi" }],
    };
    await expect(
      parseAnthropicRequestChunks(chunks(encoded(small)), headers),
    ).resolves.toEqual(parseAnthropicRequest(small, headers));
  });

  test("OpenAI preserves system ordering and coalesces tool messages", async () => {
    const body = {
      model: "gpt",
      messages: [
        { role: "system", content: "one" },
        { role: "user", content: "x".repeat(STREAMING_PARSE_SPOOL_BYTES) },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "a",
              type: "function",
              function: { name: "a", arguments: "{}" },
            },
            {
              id: "b",
              type: "function",
              function: { name: "b", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "a", content: "A" },
        { role: "tool", tool_call_id: "b", content: "B" },
        { role: "developer", content: "two" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "a",
            description: "Call a",
            parameters: { type: "object" },
          },
        },
      ],
      stream: true,
      stream_options: { include_usage: true },
      provider: { order: ["openai"] },
    };
    await expect(
      parseOpenAIRequestChunks(chunks(encoded(body)), headers),
    ).resolves.toEqual(parseOpenAIRequest(body, headers));
  });

  test("Gemini matches sync parsing and gzip decoding", async () => {
    const body = {
      contents: [
        {
          role: "user",
          parts: [{ text: "x".repeat(STREAMING_PARSE_SPOOL_BYTES) }],
        },
        {
          role: "model",
          parts: [
            {
              functionCall: {
                name: "lookup",
                args: { query: "value" },
              },
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                name: "lookup",
                response: { value: "ok" },
              },
            },
          ],
        },
      ],
      systemInstruction: { parts: [{ text: "system" }] },
      tools: [
        {
          functionDeclarations: [
            {
              name: "lookup",
              description: "Look up a value",
              parameters: { type: "object" },
            },
          ],
        },
      ],
      generationConfig: { maxOutputTokens: 10, temperature: 0.2 },
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      ],
    };
    const compressed = gzipSync(encoded(body));
    const request = new Request("http://gateway.test", {
      method: "POST",
      headers: { "content-encoding": "gzip" },
      body: compressed,
      ...({ duplex: "half" } as RequestInit),
    });
    const { decodedRequestChunks } = await import("../src/http-body");
    await expect(
      parseGeminiRequestChunks(
        decodedRequestChunks(request, request.signal),
        headers,
        "gemini",
        false,
      ),
    ).resolves.toEqual(parseGeminiRequest(body, headers, "gemini", false));
  });

  test("Anthropic resumes from a suffix-only messages array", async () => {
    const prefixBody = {
      model: "claude",
      messages: [
        { role: "user", content: "old question" },
        { role: "assistant", content: "old answer" },
      ],
    };
    const prefix = parseAnthropicRequest(prefixBody, headers);
    const source = prefix.sourceInput!;
    const boundary = encodeContextBoundary({
      v: 1,
      protocol: "anthropic",
      inputItems: source.itemCount,
      inputDigest: source.inputDigest,
      retainedItems: source.retainedItems,
      sourceMessages: prefix.messages.length,
      sourceDigest: digestChain(prefix.messages),
    });
    const resumed = await parseAnthropicRequestChunks(
      chunks(
        encoded({
          model: "claude",
          messages: [{ role: "user", content: "new question" }],
        }),
      ),
      { ...headers, "x-lore-context-boundary": boundary },
    );

    expect(resumed.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "new question" }] },
    ]);
    expect(resumed.sourceInput).toMatchObject({
      itemCount: 3,
      sourcePrefix: {
        messageCount: 2,
        sourceDigest: digestChain(prefix.messages),
      },
    });
  });

  test("rejects a continuation that appends no source items", async () => {
    const prefixBody = {
      model: "claude",
      messages: [{ role: "user", content: "old question" }],
    };
    const prefix = parseAnthropicRequest(prefixBody, headers);
    const source = prefix.sourceInput;
    if (!source) throw new Error("missing source input metadata");
    const boundary = encodeContextBoundary({
      v: 1,
      protocol: "anthropic",
      inputItems: source.itemCount,
      inputDigest: source.inputDigest,
      retainedItems: 0,
      sourceMessages: prefix.messages.length,
      sourceDigest: digestChain(prefix.messages),
    });

    await expect(
      parseAnthropicRequestChunks(
        chunks(encoded({ model: "claude", messages: [] })),
        { ...headers, "x-lore-context-boundary": boundary },
      ),
    ).rejects.toThrow("no new context items");
  });

  test("OpenAI retains its system preamble while resuming from a suffix", async () => {
    const system = { role: "system", content: "stable system" };
    const prefixBody = {
      model: "gpt",
      messages: [
        system,
        { role: "user", content: "old question" },
        { role: "assistant", content: "old answer" },
      ],
    };
    const prefix = parseOpenAIRequest(prefixBody, headers);
    const source = prefix.sourceInput!;
    const boundary = encodeContextBoundary({
      v: 1,
      protocol: "openai",
      inputItems: source.itemCount,
      inputDigest: source.inputDigest,
      retainedItems: source.retainedItems,
      sourceMessages: prefix.messages.length,
      sourceDigest: digestChain(prefix.messages),
    });
    const resumed = await parseOpenAIRequestChunks(
      chunks(
        encoded({
          model: "gpt",
          messages: [system, { role: "user", content: "new question" }],
        }),
      ),
      { ...headers, "x-lore-context-boundary": boundary },
    );

    expect(resumed.system).toBe("stable system");
    expect(resumed.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "new question" }] },
    ]);
    expect(resumed.sourceInput).toMatchObject({
      itemCount: 4,
      retainedItems: 1,
      sourcePrefix: { messageCount: 2 },
    });
  });

  test("Gemini resumes from a suffix-only contents array", async () => {
    const prefixBody = {
      contents: [
        { role: "user", parts: [{ text: "old question" }] },
        { role: "model", parts: [{ text: "old answer" }] },
      ],
    };
    const prefix = parseGeminiRequest(prefixBody, headers, "gemini", false);
    const source = prefix.sourceInput!;
    const boundary = encodeContextBoundary({
      v: 1,
      protocol: "gemini",
      inputItems: source.itemCount,
      inputDigest: source.inputDigest,
      retainedItems: source.retainedItems,
      sourceMessages: prefix.messages.length,
      sourceDigest: digestChain(prefix.messages),
    });
    const resumed = await parseGeminiRequestChunks(
      chunks(
        encoded({
          contents: [{ role: "user", parts: [{ text: "new question" }] }],
        }),
      ),
      { ...headers, "x-lore-context-boundary": boundary },
      "gemini",
      false,
    );

    expect(resumed.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "new question" }] },
    ]);
    expect(resumed.sourceInput).toMatchObject({
      itemCount: 3,
      sourcePrefix: { messageCount: 2 },
    });
  });

  test("duplicate stream keys use the final array", async () => {
    const body = `{"model":"gpt","messages":[{"role":"user","content":"${"x".repeat(STREAMING_PARSE_SPOOL_BYTES)}"}],"messages":"nope"}`;
    await expect(
      parseOpenAIRequestChunks(chunks(Buffer.from(body)), headers),
    ).resolves.toEqual(
      parseOpenAIRequest(
        {
          model: "gpt",
          messages: "nope",
        },
        headers,
      ),
    );
  });

  test("duplicate non-array stream keys can precede the final array", async () => {
    const body = `{"model":"gpt","messages":"nope","messages":[{"role":"user","content":"${"x".repeat(STREAMING_PARSE_SPOOL_BYTES)}"}]}`;
    await expect(
      parseOpenAIRequestChunks(chunks(Buffer.from(body)), headers),
    ).resolves.toEqual(parseOpenAIRequest(JSON.parse(body), headers));
  });

  test("non-array stream values are retained by sync parity", async () => {
    const body = { model: "gpt", messages: "prompt" };
    await expect(
      parseOpenAIRequestChunks(chunks(encoded(body)), headers),
    ).resolves.toEqual(parseOpenAIRequest(body, headers));
  });

  test("large non-object roots become empty requests", async () => {
    const body = `"${"x".repeat(STREAMING_PARSE_SPOOL_BYTES)}"`;
    await expect(
      parseGeminiRequestChunks(
        chunks(Buffer.from(body)),
        headers,
        "gemini",
        false,
      ),
    ).resolves.toEqual(parseGeminiRequest({}, headers, "gemini", false));
  });

  test.each([
    `{"model":"gpt","messages":[{"role":"user","content":"${"x".repeat(STREAMING_PARSE_SPOOL_BYTES)}"}]} null`,
    ` \t\uFEFF{"model":"gpt","messages":[{"role":"user","content":"${"x".repeat(STREAMING_PARSE_SPOOL_BYTES)}"}]}`,
    `{"model":"gpt","messages":[{"role":"user","content":"${"x".repeat(STREAMING_PARSE_SPOOL_BYTES)}"}]`,
  ])("rejects malformed streamed JSON: %s", async (body) => {
    await expect(
      parseAnthropicRequestChunks(chunks(Buffer.from(body)), headers),
    ).rejects.toThrow("Invalid JSON body");
  });
});

describe("streaming route malformed-body responses", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.teardown();
    harness = undefined;
  });

  test.each([
    ["/v1/messages", {}],
    ["/v1/chat/completions", {}],
    ["/v1beta/models/gemini:generateContent", { "x-goog-api-key": "key" }],
  ])("returns a closeable 400 for %s", async (path, headers) => {
    harness = await createHarness({ fixtures: [] });
    const response = await harness.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: `{"padding":"${"x".repeat(STREAMING_PARSE_SPOOL_BYTES)}"} null`,
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("connection")).toBe("close");
    await expect(response.json()).resolves.toMatchObject({
      type: "error",
      error: { type: "invalid_request_error", message: "Invalid JSON body" },
    });
  });
});
