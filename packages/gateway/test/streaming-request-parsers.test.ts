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
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ],
      max_tokens: 100,
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
        { role: "user", content: "question" },
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
        { role: "model", parts: [{ text: "ok" }] },
      ],
      systemInstruction: { parts: [{ text: "system" }] },
      generationConfig: { maxOutputTokens: 10 },
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

  test("duplicate stream keys use the final array", async () => {
    const body = `{"model":"gpt","messages":[{"role":"user","content":"discard"}],"messages":[{"role":"user","content":"keep"}]}`;
    await expect(
      parseOpenAIRequestChunks(chunks(Buffer.from(body)), headers),
    ).resolves.toEqual(
      parseOpenAIRequest(
        {
          model: "gpt",
          messages: [{ role: "user", content: "keep" }],
        },
        headers,
      ),
    );
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
  ])("rejects malformed streamed JSON: %s", async (body) => {
    await expect(
      parseOpenAIRequestChunks(chunks(Buffer.from(body)), headers),
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
      body: "{ invalid",
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("connection")).toBe("close");
    await expect(response.json()).resolves.toMatchObject({
      type: "error",
      error: { type: "invalid_request_error", message: "Invalid JSON body" },
    });
  });
});
