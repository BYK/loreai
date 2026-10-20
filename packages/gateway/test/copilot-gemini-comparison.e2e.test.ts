import { expect, test } from "vitest";
import { compareCopilotChatRequests } from "../src/copilot-chat-comparison";
import { setUpstreamInterceptor } from "../src/pipeline";
import { createHarness } from "./helpers/harness";

test("compares ingress with the actual prepared Gemini body without upstream dispatch", async () => {
  const harness = await createHarness({ fixtures: [] });
  try {
    const ingress = {
      model: "gemini-4-argon",
      stream: true,
      max_tokens: 8192,
      thinking_budget: 1024,
      reasoning_effort: "high",
      messages: [
        { role: "system", content: "PRIVATE_SYSTEM" },
        { role: "user", content: "PRIVATE_USER" },
      ],
      tools: Array.from({ length: 64 }, (_, i) => ({
        type: "function",
        function: {
          name: `private_tool_${i}`,
          description: "PRIVATE_DESCRIPTION",
          parameters: { type: "object", properties: {} },
        },
      })),
    };
    let comparison: ReturnType<typeof compareCopilotChatRequests> | undefined;
    setUpstreamInterceptor(async (body) => {
      comparison = compareCopilotChatRequests(ingress, body);
      return new Response('{"error":{"code":"invalid_request_body"}}', {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    });
    const response = await harness.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-lore-provider": "github-copilot",
        "x-lore-agent": "coder",
        "x-lore-project": "/test/copilot-gemini-comparison",
        authorization: "Bearer PRIVATE_CREDENTIAL",
      },
      body: JSON.stringify(ingress),
    });
    await response.text();
    expect(response.status).toBe(400);
    expect(comparison).toBeDefined();
    expect(comparison?.controls.removed).toEqual([
      "thinking_budget",
      "reasoning_effort",
    ]);
    expect(comparison?.ingress.cacheAnnotations).toBe(0);
    expect(comparison?.rebuilt.cacheAnnotations).toBeGreaterThan(0);
    expect(comparison?.rebuilt.invalidMessages).toBe(0);
    expect(comparison?.rebuilt.invalidToolSchemas).toBe(0);
    expect(JSON.stringify(comparison)).not.toContain("PRIVATE");
    expect(JSON.stringify(comparison)).not.toContain("private_tool");
  } finally {
    await harness.teardown();
  }
});
