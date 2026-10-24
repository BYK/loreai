import { describe, expect, test } from "vitest";
import { compareCopilotChatRequests } from "../src/copilot-chat-comparison";
import { createCaptureServer } from "../script/capture-copilot-chat";
import {
  buildOpenAIUpstreamRequest,
  parseOpenAIRequest,
} from "../src/translate/openai";

describe("content-free Copilot Chat comparison", () => {
  test("loopback capture reports structure and stops the request without forwarding", async () => {
    const reports: unknown[] = [];
    const server = createCaptureServer((value) => reports.push(value));
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing test port");
      const health = await fetch(`http://127.0.0.1:${address.port}/health`);
      expect(health.status).toBe(200);
      await health.text();
      const unsupported = await fetch(
        `http://127.0.0.1:${address.port}/v1/responses`,
        {
          method: "POST",
          body: "PRIVATE",
        },
      );
      expect(unsupported.status).toBe(404);
      await unsupported.text();
      const malformed = await fetch(
        `http://127.0.0.1:${address.port}/v1/chat/completions`,
        {
          method: "POST",
          body: "PRIVATE",
        },
      );
      expect(malformed.status).toBe(400);
      expect(await malformed.text()).not.toContain("PRIVATE");
      expect(reports).toHaveLength(0);
      const response = await fetch(
        `http://127.0.0.1:${address.port}/v1/chat/completions`,
        {
          method: "POST",
          headers: { authorization: "Bearer PRIVATE_CREDENTIAL" },
          body: JSON.stringify({
            model: "gemini-4-argon",
            messages: [{ role: "user", content: "PRIVATE_PROMPT" }],
          }),
        },
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("no upstream call was made");
      expect(reports).toHaveLength(1);
      expect(JSON.stringify(reports)).not.toContain("PRIVATE");
      expect(reports[0]).toMatchObject({
        serializer: { controls: { added: ["stream", "max_tokens"] } },
        withGatewayCache: { rebuilt: { cacheAnnotations: 1 } },
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  test("reports actual serializer losses and cache additions without exposing values", () => {
    const ingress = {
      model: "gemini-4-argon",
      messages: [
        { role: "system", content: "PRIVATE_SYSTEM" },
        { role: "user", content: "PRIVATE_PROMPT" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "PRIVATE_TOOL",
            description: "PRIVATE_DESCRIPTION",
            parameters: {
              type: "object",
              properties: { PRIVATE_PROPERTY: { type: "string" } },
            },
          },
        },
      ],
      stream: true,
      thinking_budget: 1234,
      reasoning_effort: "PRIVATE_EFFORT",
      max_tokens: 8192,
      PRIVATE_KEY: "PRIVATE_VALUE",
    };
    const rebuilt = buildOpenAIUpstreamRequest(
      parseOpenAIRequest(ingress, {}),
      "https://api.githubcopilot.com",
      { systemTTL: "5m", cacheTools: true, cacheConversation: true },
    ).body;
    const result = compareCopilotChatRequests(ingress, rebuilt);
    expect(result.controls.removed).toEqual([
      "thinking_budget",
      "reasoning_effort",
    ]);
    expect(result.controls.changed).toEqual([]);
    expect(result.ingress.unknownControls).toBe(1);
    expect(result.ingress.cacheAnnotations).toBe(0);
    expect(result.rebuilt.cacheAnnotations).toBe(3);
    expect(result.toolSchemasEqual).toBe(true);
    expect(result.toolNamesEqual).toBe(true);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });

  test("detects defaulted controls, altered schemas and malformed envelopes", () => {
    const ingress = {
      messages: [{ role: "user", content: "PRIVATE" }],
      tools: [
        {
          type: "function",
          function: { name: "PRIVATE", parameters: { type: "object" } },
        },
      ],
    };
    const rebuilt = {
      ...ingress,
      max_tokens: 4096,
      tools: [
        { type: "function", function: { name: "PRIVATE", parameters: [] } },
      ],
      messages: [{ role: "PRIVATE", content: 42 }],
    };
    const result = compareCopilotChatRequests(ingress, rebuilt);
    expect(result.controls.added).toEqual(["max_tokens"]);
    expect(result.toolSchemasEqual).toBe(false);
    expect(result.rebuilt.invalidToolSchemas).toBe(1);
    expect(result.rebuilt.invalidMessages).toBe(1);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });

  test("bounds oversized collections and never claims uninspected schemas are equal", () => {
    const body = {
      messages: [],
      tools: Array.from({ length: 129 }, () => ({})),
    };
    const result = compareCopilotChatRequests(body, body);
    expect(result.toolSchemasEqual).toBe(null);
    expect(result.ingress.truncated).toBe(true);
  });
});
