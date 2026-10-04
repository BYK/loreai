import { afterEach, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { setUpstreamFetchOverrideForTest } from "../src/fetch";
import { handleRequest, resetPipelineState } from "../src/pipeline";
import type { GatewayRequest } from "../src/translate/types";

afterEach(async () => {
  setUpstreamFetchOverrideForTest(null);
  await resetPipelineState({ fast: true });
});

it("replaces lone surrogates in the actual upstream JSON without changing valid text", async () => {
  let wireBody: string | undefined;
  setUpstreamFetchOverrideForTest((_url, init) => {
    if (typeof init?.body === "string") wireBody = init.body;
    return new Response('{"detail":"Bad Request"}', { status: 400 });
  });
  const request: GatewayRequest = {
    protocol: "openai-responses",
    model: "gpt-5.6-luna",
    system: "system \udc00 text",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "before \ud83d after, valid 😀, literal \\ud83d",
          },
        ],
      },
    ],
    tools: [
      {
        name: "tool",
        description: "schema with a malformed key",
        inputSchema: {
          type: "object",
          properties: { ["\ud83d"]: { type: "string" } },
        },
      },
    ],
    stream: false,
    maxTokens: 64,
    metadata: {},
    rawHeaders: { authorization: "Bearer placeholder" },
  };

  const response = await handleRequest(request, loadConfig());

  expect(response.status).toBe(400);
  if (wireBody === undefined) throw new Error("upstream request was not sent");
  const body = JSON.parse(wireBody) as {
    instructions: string;
    input: Array<{ content: Array<{ text: string }> }>;
    tools: Array<{ parameters: { properties: Record<string, unknown> } }>;
  };
  expect(body.instructions).toBe("system � text");
  expect(body.input[0]?.content[0]?.text).toBe(
    "before � after, valid 😀, literal \\ud83d",
  );
  expect(Object.keys(body.tools[0]?.parameters.properties ?? {})).toEqual([
    "�",
  ]);
  expect(await response.text()).toBe('{"detail":"Bad Request"}');
});
