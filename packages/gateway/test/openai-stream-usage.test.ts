/**
 * Tests for #1475 — the OpenAI Chat Completions response path must surface
 * `usage` to clients, both for streaming and non-streaming, including cache
 * read/write so clients like Pi can derive cache-hit rate.
 *
 * Three layers under test:
 *   1. Egress — `buildOpenAIResponse` (non-stream top-level `usage` and
 *      stream terminal SSE chunk with `usage`).
 *   2. Ingress — `parseOpenAIRequest` capturing `stream_options` so the
 *      upstream can be told to include usage.
 *   3. Round-trip — `buildOpenAIUpstreamRequest` forwarding
 *      `stream_options` so the upstream's own usage chunk reaches the
 *      client on the same-protocol passthrough path.
 */
import { describe, test, expect } from "vitest";
import {
  buildOpenAIResponse,
  buildOpenAIUpstreamRequest,
  parseOpenAIRequest,
} from "../src/translate/openai";
import type { GatewayResponse } from "../src/translate/types";

const headers = { authorization: "Bearer sk-test123" };

function baseResp(overrides: Partial<GatewayResponse> = {}): GatewayResponse {
  return {
    id: "chatcmpl-test",
    model: "gpt-4o",
    content: [{ type: "text", text: "Hello" }],
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 20 },
    ...overrides,
  };
}

async function readSseChunks(response: Response): Promise<unknown[]> {
  const text = await response.text();
  const events = text.split("\n\n").filter((e) => e.startsWith("data: "));
  const out: unknown[] = [];
  for (const evt of events) {
    const payload = evt.slice("data: ".length);
    if (payload === "[DONE]") {
      out.push("[DONE]" as const);
      continue;
    }
    out.push(JSON.parse(payload));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Egress — non-stream (buildOpenAIResponse(resp, false))
// ---------------------------------------------------------------------------

describe("buildOpenAIResponse (Chat Completions) — non-stream usage (#1475)", () => {
  test("emits cache_write_tokens when cacheCreationInputTokens is set", async () => {
    const resp = baseResp({
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheCreationInputTokens: 50,
      },
    });

    const response = buildOpenAIResponse(resp, false);
    const body = (await response.json()) as Record<string, unknown>;
    const usage = body.usage as Record<string, unknown>;
    const details = usage.prompt_tokens_details as Record<string, number>;
    expect(details.cache_write_tokens).toBe(50);
    expect(usage.prompt_tokens).toBe(150);
  });

  test("emits both cached_tokens and cache_write_tokens together", async () => {
    const resp = baseResp({
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 80,
        cacheCreationInputTokens: 20,
      },
    });

    const response = buildOpenAIResponse(resp, false);
    const body = (await response.json()) as Record<string, unknown>;
    const usage = body.usage as Record<string, unknown>;
    const details = usage.prompt_tokens_details as Record<string, number>;
    expect(details.cached_tokens).toBe(80);
    expect(details.cache_write_tokens).toBe(20);
    expect(usage.prompt_tokens).toBe(200);
  });

  test("omits prompt_tokens_details when neither cache field is set", async () => {
    const resp = baseResp({
      usage: { inputTokens: 100, outputTokens: 20 },
    });

    const response = buildOpenAIResponse(resp, false);
    const body = (await response.json()) as Record<string, unknown>;
    const usage = body.usage as Record<string, unknown>;
    expect(usage.prompt_tokens_details).toBeUndefined();
  });

  test("regression: existing cached_tokens emission still works", async () => {
    const resp = baseResp({
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 80,
      },
    });

    const response = buildOpenAIResponse(resp, false);
    const body = (await response.json()) as Record<string, unknown>;
    const usage = body.usage as Record<string, unknown>;
    expect(usage.prompt_tokens).toBe(180);
    expect(usage.completion_tokens).toBe(20);
    const details = usage.prompt_tokens_details as Record<string, number>;
    expect(details.cached_tokens).toBe(80);
  });

  test("regression: total_tokens === prompt_tokens + completion_tokens even with cache fields", async () => {
    const resp = baseResp({
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 80,
        cacheCreationInputTokens: 20,
      },
    });

    const response = buildOpenAIResponse(resp, false);
    const body = (await response.json()) as Record<string, unknown>;
    const usage = body.usage as Record<string, unknown>;
    expect(usage.total_tokens).toBe(220);
  });
});

// ---------------------------------------------------------------------------
// Egress — stream (buildOpenAIResponse(resp, true))
// ---------------------------------------------------------------------------

describe("buildOpenAIResponse (Chat Completions) — stream usage (#1475)", () => {
  test("emits a terminal chunk with usage before [DONE]", async () => {
    const resp = baseResp({
      usage: { inputTokens: 100, outputTokens: 20 },
    });

    const response = buildOpenAIResponse(resp, true);
    const chunks = await readSseChunks(response);
    const last = chunks[chunks.length - 1];
    const penultimate = chunks[chunks.length - 2];
    expect(last).toBe("[DONE]");
    expect(penultimate).toMatchObject({
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
    const terminalChunk = penultimate as Record<string, unknown>;
    const usage = terminalChunk.usage as Record<string, unknown>;
    expect(usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
    });
  });

  test("stream terminal usage includes cached_tokens when cacheReadInputTokens is set", async () => {
    const resp = baseResp({
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 80,
      },
    });

    const response = buildOpenAIResponse(resp, true);
    const chunks = await readSseChunks(response);
    const penultimate = chunks[chunks.length - 2] as Record<string, unknown>;
    const usage = penultimate.usage as Record<string, unknown>;
    const details = usage.prompt_tokens_details as Record<string, number>;
    expect(details.cached_tokens).toBe(80);
  });

  test("stream terminal usage includes cache_write_tokens when cacheCreationInputTokens is set", async () => {
    const resp = baseResp({
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheCreationInputTokens: 50,
      },
    });

    const response = buildOpenAIResponse(resp, true);
    const chunks = await readSseChunks(response);
    const penultimate = chunks[chunks.length - 2] as Record<string, unknown>;
    const usage = penultimate.usage as Record<string, unknown>;
    const details = usage.prompt_tokens_details as Record<string, number>;
    expect(details.cache_write_tokens).toBe(50);
    expect(usage.prompt_tokens).toBe(150);
  });

  test("stream terminal usage includes both cache fields together", async () => {
    const resp = baseResp({
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 80,
        cacheCreationInputTokens: 20,
      },
    });

    const response = buildOpenAIResponse(resp, true);
    const chunks = await readSseChunks(response);
    const penultimate = chunks[chunks.length - 2] as Record<string, unknown>;
    const usage = penultimate.usage as Record<string, unknown>;
    const details = usage.prompt_tokens_details as Record<string, number>;
    expect(details.cached_tokens).toBe(80);
    expect(details.cache_write_tokens).toBe(20);
    expect(usage.prompt_tokens).toBe(200);
  });

  test("stream emits usage chunk even when resp.usage is undefined (ZERO_USAGE fallback)", async () => {
    const resp = baseResp();
    delete (resp as { usage?: unknown }).usage;

    const response = buildOpenAIResponse(resp, true);
    const chunks = await readSseChunks(response);
    const penultimate = chunks[chunks.length - 2] as Record<string, unknown>;
    const usage = penultimate.usage as Record<string, unknown>;
    expect(usage).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
    expect(usage.prompt_tokens_details).toBeUndefined();
  });

  test("tool-call stream: usage chunk is still emitted and finish_reason is 'tool_calls'", async () => {
    const resp = baseResp({
      content: [
        {
          type: "tool_use",
          id: "call_1",
          name: "get_weather",
          input: { city: "Paris" },
        },
      ],
      stopReason: "tool_use",
    });

    const response = buildOpenAIResponse(resp, true);
    const chunks = await readSseChunks(response);
    const last = chunks[chunks.length - 1];
    const penultimate = chunks[chunks.length - 2];
    expect(last).toBe("[DONE]");
    expect(penultimate).toMatchObject({
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    });
    const terminalChunk = penultimate as Record<string, unknown>;
    const usage = terminalChunk.usage as Record<string, unknown>;
    expect(usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
    });
  });

  test("usage chunk is the last data chunk before [DONE]", async () => {
    const resp = baseResp({
      content: [{ type: "text", text: "Hello world" }],
      usage: {
        inputTokens: 50,
        outputTokens: 10,
        cacheReadInputTokens: 30,
      },
    });

    const response = buildOpenAIResponse(resp, true);
    const chunks = await readSseChunks(response);
    expect(chunks[chunks.length - 1]).toBe("[DONE]");
    const usageChunks = chunks
      .slice(0, -1)
      .filter((c) => c !== "[DONE]") as Array<Record<string, unknown>>;
    const chunksWithUsage = usageChunks.filter((c) => c.usage !== undefined);
    expect(chunksWithUsage).toHaveLength(1);
    expect(chunksWithUsage[0]).toBe(chunks[chunks.length - 2]);
  });
});

// ---------------------------------------------------------------------------
// Ingress — request parsing (stream_options capture)
// ---------------------------------------------------------------------------

describe("parseOpenAIRequest — stream_options capture (#1475)", () => {
  test("captures stream_options.include_usage: true into extras", () => {
    const req = parseOpenAIRequest(
      {
        model: "gpt-4o",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
        stream_options: { include_usage: true },
      },
      headers,
    );
    expect(req.extras?.stream_options).toEqual({ include_usage: true });
  });

  test("captures stream_options.include_usage: false (spec opt-out preserved for symmetry)", () => {
    const req = parseOpenAIRequest(
      {
        model: "gpt-4o",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
        stream_options: { include_usage: false },
      },
      headers,
    );
    expect(req.extras?.stream_options).toEqual({ include_usage: false });
  });

  test("ignores stream_options when it is not an object (defensive)", () => {
    const req = parseOpenAIRequest(
      {
        model: "gpt-4o",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
        stream_options: null,
      },
      headers,
    );
    expect(req.extras?.stream_options).toBeUndefined();
  });

  test("ignores stream_options when include_usage is not a boolean", () => {
    const req = parseOpenAIRequest(
      {
        model: "gpt-4o",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
        stream_options: { include_usage: "yes" },
      },
      headers,
    );
    expect(req.extras?.stream_options).toBeUndefined();
  });

  test("omits stream_options from extras when client did not send it", () => {
    const req = parseOpenAIRequest(
      {
        model: "gpt-4o",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      },
      headers,
    );
    expect(req.extras?.stream_options).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Egress-to-ingress round-trip (buildOpenAIUpstreamRequest)
// ---------------------------------------------------------------------------

describe("buildOpenAIUpstreamRequest — stream_options forwarding (#1475)", () => {
  test("forwards stream_options.include_usage: true when set on extras", () => {
    const req = parseOpenAIRequest(
      {
        model: "gpt-4o",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
        stream_options: { include_usage: true },
      },
      headers,
    );
    const result = buildOpenAIUpstreamRequest(req, "https://api.openai.com/v1");
    const body = result.body as Record<string, unknown>;
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  test("forwards stream_options.include_usage: false when set on extras", () => {
    const req = parseOpenAIRequest(
      {
        model: "gpt-4o",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
        stream_options: { include_usage: false },
      },
      headers,
    );
    const result = buildOpenAIUpstreamRequest(req, "https://api.openai.com/v1");
    const body = result.body as Record<string, unknown>;
    expect(body.stream_options).toEqual({ include_usage: false });
  });

  test("omits stream_options from upstream body when client did not set it", () => {
    const req = parseOpenAIRequest(
      {
        model: "gpt-4o",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      },
      headers,
    );
    const result = buildOpenAIUpstreamRequest(req, "https://api.openai.com/v1");
    const body = result.body as Record<string, unknown>;
    expect(body.stream_options).toBeUndefined();
  });

  test("round-trip: parseOpenAIRequest → buildOpenAIUpstreamRequest preserves stream_options verbatim", () => {
    const req = parseOpenAIRequest(
      {
        model: "gpt-4o",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
        stream_options: { include_usage: true },
        temperature: 0.5,
      },
      headers,
    );
    const result = buildOpenAIUpstreamRequest(req, "https://api.openai.com/v1");
    const body = result.body as Record<string, unknown>;
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.temperature).toBe(0.5);
    expect(body.stream).toBe(true);
  });
});
