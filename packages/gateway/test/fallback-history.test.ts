import { expect, it } from "vitest";
import { boundFallbackHistory } from "../src/fallback-history";
import type { GatewayMessage, GatewayRequest } from "../src/translate/types";

function request(messages: GatewayMessage[]): GatewayRequest {
  return {
    protocol: "openai-responses",
    model: "gpt-5.6-sol",
    system: "You are a coding agent.",
    messages,
    tools: [{ name: "read", description: "Read file", inputSchema: {} }],
    stream: true,
    maxTokens: 1000,
    metadata: {},
    rawHeaders: {},
  };
}

it("drops older turns within a smaller model budget while retaining tool pairs and encrypted reasoning", () => {
  const history: GatewayMessage[] = Array.from({ length: 80 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: [{ type: "text", text: `older-${i} ${"word ".repeat(70)}` }],
  }));
  const reasoning = {
    type: "opaque" as const,
    responsesItem: true,
    raw: { type: "reasoning", encrypted_content: "KEEP_CIPHERTEXT" },
  };
  const call = {
    type: "tool_use" as const,
    id: "call_recent",
    name: "read",
    input: { filePath: "example" },
  };
  history.push(
    {
      role: "user",
      content: [{ type: "text", text: "inspect the latest file" }],
    },
    {
      role: "assistant",
      content: [call],
      provenanceContent: [reasoning, call],
      provenancePositions: [1],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "call_recent",
          content: [{ type: "text", text: "result" }],
        },
        { type: "text", text: "continue" },
      ],
    },
  );
  const input = request(history);
  const result = boundFallbackHistory(input, 10_000, 1000);
  expect(result).not.toBeNull();
  expect(result?.removed).toBeGreaterThan(0);
  expect(result?.estimatedTokens).toBeLessThanOrEqual(result?.budget);
  expect(input.messages[0].role).toBe("user");
  expect(
    input.messages.some((m) => JSON.stringify(m).includes("older-0")),
  ).toBe(false);
  expect(input.messages.at(-2)?.provenanceContent?.[0]).toEqual(reasoning);
  expect(input.messages.at(-2)?.content).toContain(call);
  expect(input.messages.at(-1)?.content[0]).toMatchObject({
    toolUseId: "call_recent",
  });
});

it("fails closed if the latest message alone exceeds the model budget", () => {
  const input = request([
    { role: "user", content: [{ type: "text", text: "x".repeat(100_000) }] },
  ]);
  expect(boundFallbackHistory(input, 12_000, 1000)).toBeNull();
  expect(input.messages).toHaveLength(1);
});

it("never treats a nonfinite output reserve as unlimited context", () => {
  const input = request([
    { role: "user", content: [{ type: "text", text: "x".repeat(100_000) }] },
  ]);
  expect(boundFallbackHistory(input, 12_000, Number.NaN)).toBeNull();
  input.maxTokens = Number.NaN;
  expect(boundFallbackHistory(input, 12_000, 1000)).toBeNull();
  expect(input.messages).toHaveLength(1);
});

it("fails closed for media whose token cost cannot be bounded", () => {
  const input = request([
    {
      role: "user",
      content: [
        {
          type: "opaque",
          raw: {
            type: "input_image",
            image_url: "https://example.com/huge.jpg",
          },
        },
      ],
    },
  ]);
  expect(boundFallbackHistory(input, 1_000_000, 1000)).toBeNull();
});

it("fails closed when a safe user boundary cannot retain the final tool result", () => {
  const input = request([
    { role: "user", content: [{ type: "text", text: "x".repeat(100_000) }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "call_a", name: "read", input: {} }],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "call_a",
          content: [{ type: "text", text: "result" }],
        },
      ],
    },
  ]);
  expect(boundFallbackHistory(input, 12_000, 1000)).toBeNull();
  expect(input.messages).toHaveLength(3);
});

it("checks provider-native tool calls even when they are absent from visible content", () => {
  const input = request([
    { role: "user", content: [{ type: "text", text: "ask" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      provenanceContent: [
        { type: "tool_use", id: "hidden_call", name: "read", input: {} },
        { type: "text", text: "answer" },
      ],
      provenancePositions: [1],
    },
    { role: "user", content: [{ type: "text", text: "continue" }] },
  ]);
  expect(boundFallbackHistory(input, 1_000_000, 1000)).toBeNull();
});

it("keeps an already bounded history and its native provenance intact", () => {
  const content = [{ type: "text" as const, text: "answer" }];
  const native = [
    {
      type: "opaque" as const,
      responsesItem: true,
      raw: { type: "reasoning", encrypted_content: "ciphertext" },
    },
    content[0],
  ];
  const input = request([
    { role: "user", content: [{ type: "text", text: "ask" }] },
    {
      role: "assistant",
      content,
      provenanceContent: native,
      provenancePositions: [1],
    },
    { role: "user", content: [{ type: "text", text: "continue" }] },
  ]);
  const previous = input.messages;
  expect(boundFallbackHistory(input, 1_000_000, 1000)?.removed).toBe(0);
  expect(input.messages[1].provenanceContent).toEqual(native);
  expect(previous).toEqual(input.messages);
});
