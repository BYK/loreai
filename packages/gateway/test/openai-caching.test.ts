/**
 * Tests for OpenRouter/OpenAI-protocol prompt caching in
 * buildOpenAIUpstreamRequest.
 *
 * Regression guard for the "cache hit rate = 0 on OpenRouter" bug: the OpenAI
 * builder previously emitted ZERO `cache_control` breakpoints, so OpenRouter
 * (which honors Anthropic-style ephemeral breakpoints on the Chat Completions
 * API for Anthropic models) never cached anything. These tests pin the
 * breakpoint placement on the system prefix, the conversation tail, and the
 * last tool — and pin the no-cache passthrough shape (plain-string content)
 * so the cache-stability invariant is preserved for meta requests.
 */
import { describe, expect, test } from "vitest";
import type { AnthropicCacheOptions } from "../src/translate/anthropic";
import { buildOpenAIUpstreamRequest } from "../src/translate/openai";
import type { GatewayRequest } from "../src/translate/types";

const BASE = "https://openrouter.ai/api";

function makeRequest(overrides: Partial<GatewayRequest> = {}): GatewayRequest {
  return {
    protocol: "openai",
    model: "anthropic/claude-opus-4.8",
    system: "You are a helpful assistant.",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [],
    stream: true,
    maxTokens: 4096,
    metadata: {},
    rawHeaders: { "x-api-key": "test-key" },
    extras: {},
    ...overrides,
  };
}

function getBody(req: GatewayRequest, cache?: AnthropicCacheOptions) {
  return buildOpenAIUpstreamRequest(req, BASE, cache).body as Record<
    string,
    unknown
  >;
}

type Msg = { role: string; content: unknown; tool_calls?: unknown };

function messagesOf(body: Record<string, unknown>): Msg[] {
  return body.messages as Msg[];
}

// ---------------------------------------------------------------------------
// No caching (default / passthrough) — cache-stability invariant
// ---------------------------------------------------------------------------

describe("buildOpenAIUpstreamRequest — no caching", () => {
  test("system is a plain string when no cache options", () => {
    const msgs = messagesOf(getBody(makeRequest()));
    const sys = msgs.find((m) => m.role === "system");
    expect(sys?.content).toBe("You are a helpful assistant.");
  });

  test("text-only user content stays a plain string", () => {
    const msgs = messagesOf(getBody(makeRequest()));
    const user = msgs.find((m) => m.role === "user");
    expect(user?.content).toBe("Hello");
  });

  test("no cache_control anywhere when cache is undefined", () => {
    const json = JSON.stringify(getBody(makeRequest()));
    expect(json).not.toContain("cache_control");
  });

  test("no cache_control when systemTTL is false and no conversation", () => {
    const json = JSON.stringify(getBody(makeRequest(), { systemTTL: false }));
    expect(json).not.toContain("cache_control");
  });
});

// ---------------------------------------------------------------------------
// System caching
// ---------------------------------------------------------------------------

describe("buildOpenAIUpstreamRequest — system caching", () => {
  test("system becomes a block array with an ephemeral breakpoint", () => {
    const msgs = messagesOf(getBody(makeRequest(), { systemTTL: "5m" }));
    const sys = msgs.find((m) => m.role === "system");
    expect(Array.isArray(sys?.content)).toBe(true);
    const block = (sys?.content as Array<Record<string, unknown>>)?.[0];
    expect(block.text).toBe("You are a helpful assistant.");
    expect(block.cache_control).toEqual({ type: "ephemeral" });
  });

  test("systemTTL 1h emits the extended ttl", () => {
    const msgs = messagesOf(getBody(makeRequest(), { systemTTL: "1h" }));
    const sys = msgs.find((m) => m.role === "system");
    const block = (sys?.content as Array<Record<string, unknown>>)?.[0];
    expect(block.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("no system block emitted when system is empty", () => {
    const msgs = messagesOf(
      getBody(makeRequest({ system: "" }), { systemTTL: "5m" }),
    );
    expect(msgs.find((m) => m.role === "system")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Conversation caching
// ---------------------------------------------------------------------------

describe("buildOpenAIUpstreamRequest — conversation caching", () => {
  test("breakpoint on the last block of the last message (string→array)", () => {
    const msgs = messagesOf(
      getBody(makeRequest(), { cacheConversation: true }),
    );
    const last = msgs[msgs.length - 1];
    expect(Array.isArray(last.content)).toBe(true);
    const parts = last.content as Array<Record<string, unknown>>;
    expect(parts[parts.length - 1].cache_control).toEqual({
      type: "ephemeral",
    });
  });

  test("conversationTTL 1h emits the extended ttl on the tail", () => {
    const msgs = messagesOf(
      getBody(makeRequest(), {
        cacheConversation: true,
        conversationTTL: "1h",
      }),
    );
    const last = msgs[msgs.length - 1];
    const parts = last.content as Array<Record<string, unknown>>;
    expect(parts[parts.length - 1].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
  });

  test("only the LAST message carries a conversation breakpoint", () => {
    const req = makeRequest({
      messages: [
        { role: "user", content: [{ type: "text", text: "first" }] },
        { role: "assistant", content: [{ type: "text", text: "reply" }] },
        { role: "user", content: [{ type: "text", text: "second" }] },
      ],
    });
    const msgs = messagesOf(getBody(req, { cacheConversation: true }));
    // exactly one cache_control across all conversation messages
    const count = msgs.filter((m) =>
      JSON.stringify(m.content).includes("cache_control"),
    ).length;
    expect(count).toBe(1);
    // ...and it's on the last one
    expect(JSON.stringify(msgs[msgs.length - 1].content)).toContain(
      "cache_control",
    );
  });

  test("all text messages use array content (no string↔array flip as the breakpoint moves)", () => {
    // Regression (#cache-content-flip): the conversation breakpoint is placed on
    // the LAST message and promotes a plain string to a [{type:text}] block to
    // carry cache_control. Because that breakpoint moves forward every turn, a
    // message emitted as an array on turn N would revert to a plain string on
    // turn N+1 — flipping the SAME historical message's bytes and busting the
    // cached prefix at that point. With caching on, EVERY text message must be
    // array-form so only the single cache_control marker moves (matching the
    // always-array native Anthropic path).
    const req = makeRequest({
      messages: [
        { role: "user", content: [{ type: "text", text: "first" }] },
        { role: "assistant", content: [{ type: "text", text: "reply" }] },
        { role: "user", content: [{ type: "text", text: "second" }] },
      ],
    });
    const msgs = messagesOf(getBody(req, { cacheConversation: true }));
    const convo = msgs.filter((m) => m.role !== "system");
    // Every conversation message is array-form — including the interior ones
    // that do NOT carry the (moving) breakpoint.
    expect(convo.every((m) => Array.isArray(m.content))).toBe(true);
    // The interior messages carry NO cache_control (only the last does), so the
    // only per-turn delta is the marker moving — the content bytes are stable.
    const interior = convo.slice(0, -1);
    expect(
      interior.every(
        (m) => !JSON.stringify(m.content).includes("cache_control"),
      ),
    ).toBe(true);
  });

  test("caching OFF keeps text-only content as a plain string (no breakpoint to move)", () => {
    // The shape-stability promotion to array form only applies when conversation
    // caching is on; without it, the simpler plain-string form is preserved
    // (and there is no moving breakpoint, so no flip risk).
    const req = makeRequest({
      messages: [
        { role: "user", content: [{ type: "text", text: "first" }] },
        { role: "assistant", content: [{ type: "text", text: "reply" }] },
        { role: "user", content: [{ type: "text", text: "second" }] },
      ],
    });
    const msgs = messagesOf(getBody(req)); // no cache options
    const convo = msgs.filter((m) => m.role !== "system");
    expect(convo.every((m) => typeof m.content === "string")).toBe(true);
  });

  test("tool-role tail: breakpoint moves to prior non-tool message, tool content stays a string", () => {
    // Agentic mid-turn shape: assistant tool_call, then a tool_result message.
    const req = makeRequest({
      messages: [
        { role: "user", content: [{ type: "text", text: "do it" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "calling" },
            { type: "tool_use", id: "t1", name: "recall", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "t1",
              content: [{ type: "text", text: "result" }],
            },
          ],
        },
      ],
    });
    const msgs = messagesOf(getBody(req, { cacheConversation: true }));
    const toolMsg = msgs.find((m) => m.role === "tool");
    // tool message content MUST remain a string (OpenAI wire requirement)
    expect(typeof toolMsg?.content).toBe("string");
    expect(JSON.stringify(toolMsg?.content)).not.toContain("cache_control");
    // breakpoint lands on the assistant message (last non-tool)
    const assistant = msgs.find((m) => m.role === "assistant");
    expect(JSON.stringify(assistant?.content)).toContain("cache_control");
    // exactly one breakpoint total
    const count = (JSON.stringify(msgs).match(/"cache_control"/g) ?? []).length;
    expect(count).toBe(1);
  });

  test("tool_calls-only assistant tail: breakpoint walks back to a message with content", () => {
    // Regression for the case where the last non-tool message is an assistant
    // message carrying ONLY tool_calls (no `content` field) — the breakpoint
    // must not be silently dropped; it walks further back to the user message.
    const req = makeRequest({
      messages: [
        { role: "user", content: [{ type: "text", text: "do it" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "recall", input: {} }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "t1",
              content: [{ type: "text", text: "result" }],
            },
          ],
        },
      ],
    });
    const msgs = messagesOf(getBody(req, { cacheConversation: true }));
    // the assistant message has only tool_calls, no content to annotate
    const assistant = msgs.find((m) => m.role === "assistant");
    expect(assistant?.content).toBeUndefined();
    // ...so the breakpoint lands on the first user message ("do it")
    const firstUser = msgs.find(
      (m) => m.role === "user" && JSON.stringify(m.content).includes("do it"),
    );
    expect(JSON.stringify(firstUser?.content)).toContain("cache_control");
    // exactly one breakpoint total, and NOT on the tool message
    const count = (JSON.stringify(msgs).match(/"cache_control"/g) ?? []).length;
    expect(count).toBe(1);
    const toolMsg = msgs.find((m) => m.role === "tool");
    expect(typeof toolMsg?.content).toBe("string");
  });

  test("never overwrites the system breakpoint when no message is annotatable", () => {
    // All post-system messages are non-annotatable (tool_calls-only assistant +
    // tool result), so the walk-back would otherwise reach the system message.
    // The system keeps its own (1h) breakpoint; the conversation (5m) one is
    // simply not placed rather than clobbering the system TTL.
    const req = makeRequest({
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "recall", input: {} }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "t1",
              content: [{ type: "text", text: "result" }],
            },
          ],
        },
      ],
    });
    const msgs = messagesOf(
      getBody(req, {
        systemTTL: "1h",
        cacheConversation: true,
        conversationTTL: "5m",
      }),
    );
    const sys = msgs.find((m) => m.role === "system");
    const sysBlock = (sys?.content as Array<Record<string, unknown>>)?.[0];
    // system breakpoint intact at 1h — NOT downgraded to the 5m conversation TTL
    expect(sysBlock.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    // exactly one breakpoint total (the system one)
    const count = (JSON.stringify(msgs).match(/"cache_control"/g) ?? []).length;
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tool caching
// ---------------------------------------------------------------------------

describe("buildOpenAIUpstreamRequest — tool caching", () => {
  const withTools = makeRequest({
    tools: [
      { name: "a", description: "first", inputSchema: {} },
      { name: "recall", description: "last", inputSchema: {} },
    ],
  });

  test("breakpoint on the last tool when cacheTools is set", () => {
    const body = getBody(withTools, { cacheTools: true, systemTTL: "5m" });
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools[0].cache_control).toBeUndefined();
    expect(tools[1].cache_control).toEqual({ type: "ephemeral" });
  });

  test("tool breakpoint uses 1h when systemTTL is 1h", () => {
    const body = getBody(withTools, { cacheTools: true, systemTTL: "1h" });
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("no tool breakpoint when cacheTools is falsy", () => {
    const body = getBody(withTools, { systemTTL: "5m" });
    const tools = body.tools as Array<Record<string, unknown>>;
    for (const t of tools) expect(t.cache_control).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Full session config (what the pipeline actually sends) — end-to-end shape
// ---------------------------------------------------------------------------

describe("buildOpenAIUpstreamRequest — full session cache config", () => {
  test("system + conversation + tool breakpoints all present", () => {
    const req = makeRequest({
      tools: [{ name: "recall", description: "search", inputSchema: {} }],
    });
    const body = getBody(req, {
      systemTTL: "5m",
      cacheTools: true,
      cacheConversation: true,
      conversationTTL: "5m",
    });
    // exactly 3 breakpoints: system, tool, conversation tail
    const count = (JSON.stringify(body).match(/"cache_control"/g) ?? []).length;
    expect(count).toBe(3);
  });
});
