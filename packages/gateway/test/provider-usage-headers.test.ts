import { dirname } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createHarness, type Harness } from "./helpers/harness";
import { DEFAULT_SYSTEM } from "./helpers/fixtures";
import { anthropicMessageToSSE } from "./helpers/replay";
import { getActiveSessions, setUpstreamInterceptor } from "../src/pipeline";
import { _setTestVertexTokenProvider } from "../src/vertex-auth";
import { buildOpenAIResponse } from "../src/translate/openai";
import { buildOpenAIResponsesResponse } from "../src/translate/openai-responses";
import { buildGeminiResponse } from "../src/translate/gemini";
import type { GatewayProtocol, GatewayResponse } from "../src/translate/types";

// Quota namespaces seen on provider/aggregator responses. Gemini's public
// API does not document quota headers; a proxy can still supply these, and
// the gateway must not fabricate any when the upstream omits them.
const limits = {
  "anthropic-ratelimit-unified-5h-utilization": "0.23",
  "x-ratelimit-remaining-tokens": "149984",
  "x-ratelimit-reset-requests": "1s",
  "x-ratelimit-remaining-tokens-minute": "59990",
  "x-rate-limit-remaining": "42",
  "ratelimit-remaining": "99",
  ratelimit: '"default";r=99;t=30',
  "ratelimit-policy": '"default";q=100;w=60',
  "x-codex-primary-used-percent": "12.5",
  "x-codex-primary-window-minutes": "300",
  "x-codex-secondary-reset-at": "2000500000",
  "x-codex-bengalfox-primary-used-percent": "80",
  "x-codex-bengalfox-limit-name": "model-specific",
  "x-review-primary-used-percent": "30",
  "x-review-primary-window-minutes": "300",
  "x-review-secondary-reset-at": "2000100000",
  "x-review-limit-name": "review-meter",
  "x-codex-credits-has-credits": "true",
  "x-codex-credits-unlimited": "false",
  "x-codex-credits-balance": "10.25",
  "x-codex-rate-limit-reached-type": "credits",
};
let harness: Harness | undefined;
afterEach(async () => {
  await harness?.teardown();
  harness = undefined;
  _setTestVertexTokenProvider(null);
});

type Client = Exclude<GatewayProtocol, "vertex"> | "codex";
// Keep this exhaustive as wire protocols are added. Native Responses/Gemini
// ingress accepts an explicit Anthropic override, while other provider headers
// retain the native protocol. Bedrock uses the Anthropic wire family.
const clientProtocols = {
  anthropic: ["anthropic", "openai", "openai-responses", "gemini"],
  openai: ["anthropic", "openai"],
  "openai-responses": ["anthropic", "openai", "openai-responses", "codex"],
  vertex: ["anthropic", "openai"],
  gemini: ["gemini"],
} satisfies Record<GatewayProtocol, Client[]>;
const routes = [
  ...Object.entries(clientProtocols).flatMap(([upstream, clients]) =>
    clients.map((client) => ({ upstream, client })),
  ),
  { upstream: "bedrock", client: "anthropic" as const },
];

function upstreamReply(protocol: string, stream: boolean): Response {
  const response: GatewayResponse = {
    id: "msg_quota",
    model: "quota-model",
    content: [{ type: "text", text: "Hello quota" }],
    stopReason: "end_turn",
    usage: { inputTokens: 10, outputTokens: 3 },
  };
  if (protocol === "openai") return buildOpenAIResponse(response, stream);
  if (protocol === "openai-responses")
    return buildOpenAIResponsesResponse(response, stream);
  if (protocol === "gemini") return buildGeminiResponse(response, stream);
  const message = {
    id: response.id,
    type: "message",
    role: "assistant",
    model: response.model,
    content: [{ type: "text", text: "Hello quota" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 3 },
  };
  return stream
    ? new Response(anthropicMessageToSSE(message), {
        headers: { "content-type": "text/event-stream" },
      })
    : Response.json(message);
}

function requestBody(client: Client, stream: boolean, meta: boolean) {
  const system = meta
    ? ""
    : DEFAULT_SYSTEM + "\nWorking directory: " + dirname(harness!.dbPath);
  const maxTokens = meta ? 32 : 1024;
  const functions = ["read", "write", "shell"].map((name) => ({
    name,
    description: name,
    parameters: { type: "object", properties: {} },
  }));
  if (client === "gemini")
    return {
      contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      systemInstruction: { parts: [{ text: system }] },
      generationConfig: { maxOutputTokens: maxTokens },
      tools: meta ? [] : [{ functionDeclarations: functions }],
    };
  if (client === "openai-responses" || client === "codex")
    return {
      model: "gpt-4o",
      stream,
      max_output_tokens: maxTokens,
      instructions: system,
      input: [{ role: "user", content: "Hello" }],
      tools: meta ? [] : functions.map((f) => ({ type: "function", ...f })),
    };
  if (client === "openai")
    return {
      model: "gpt-4o",
      stream,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: "Hello" },
      ],
      tools: meta
        ? []
        : functions.map((f) => ({ type: "function", function: f })),
    };
  return {
    model: "claude-sonnet-4-6",
    stream,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: "Hello" }],
    tools: meta
      ? []
      : functions.map(({ parameters, ...f }) => ({
          ...f,
          input_schema: parameters,
        })),
  };
}

function sendRequest(
  upstream: string,
  client: Client,
  stream: boolean,
  meta: boolean,
): Promise<Response> {
  const path =
    client === "gemini"
      ? `/v1beta/models/gemini-2.5-pro:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`
      : client === "anthropic"
        ? "/v1/messages"
        : client === "openai"
          ? "/v1/chat/completions"
          : client === "codex"
            ? "/v1/codex/responses"
            : "/v1/responses";
  const provider =
    upstream === "openai"
      ? "groq"
      : upstream === "openai-responses"
        ? client === "codex"
          ? "openai-codex"
          : "openai"
        : upstream === "gemini"
          ? "opencode"
          : upstream;
  return harness!.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-key",
      "x-lore-provider": provider,
      "x-lore-project": dirname(harness!.dbPath),
    },
    body: JSON.stringify(requestBody(client, stream, meta)),
  });
}

for (const { upstream, client } of routes) {
  for (const stream of [false, true]) {
    for (const meta of [false, true]) {
      it(`${upstream} → ${client}, stream=${stream}, meta=${meta}: preserves quota metadata`, async () => {
        _setTestVertexTokenProvider(() => Promise.resolve("test-vertex-token"));
        harness = await createHarness({
          fixtures: [],
          configOverrides: {
            vertexProject: "quota-test",
            vertexRegion: "global",
          },
        });
        let calls = 0;
        setUpstreamInterceptor(async (_body, _model, upstreamStream) => {
          calls++;
          const response = upstreamReply(upstream, upstreamStream);
          for (const [name, value] of Object.entries(limits))
            response.headers.set(name, value);
          return response;
        });
        const response = await sendRequest(upstream, client, stream, meta);
        const body = await response.text();
        expect(response.status, body).toBe(200);
        expect(body).toContain("Hello");
        expect(calls).toBe(1);
        expect(getActiveSessions().size).toBe(meta ? 0 : 1);
        for (const [name, value] of Object.entries(limits))
          expect(response.headers.get(name), name).toBe(value);
      });
    }
  }
}

// Exercise HTTP errors through every upstream wire family and Codex, including
// side-channel errors (which intentionally retain the provider error body).
for (const { upstream, client } of [
  { upstream: "anthropic", client: "anthropic" },
  { upstream: "openai", client: "openai" },
  { upstream: "openai-responses", client: "codex" },
  { upstream: "gemini", client: "gemini" },
  { upstream: "vertex", client: "anthropic" },
  { upstream: "bedrock", client: "anthropic" },
] as const) {
  for (const stream of [false, true]) {
    for (const meta of [false, true]) {
      it(`${upstream} 429, stream=${stream}, meta=${meta}: retains quotas and retry hints`, async () => {
        _setTestVertexTokenProvider(() => Promise.resolve("test-vertex-token"));
        harness = await createHarness({
          fixtures: [],
          configOverrides: {
            vertexProject: "quota-test",
            vertexRegion: "global",
          },
        });
        setUpstreamInterceptor(
          async () =>
            new Response("private upstream diagnostic", {
              status: 429,
              headers: {
                ...limits,
                "retry-after": "30",
                "set-cookie": "private=secret",
              },
            }),
        );
        const response = await sendRequest(upstream, client, stream, meta);
        const body = await response.text();
        expect(response.status).toBe(429);
        expect(response.headers.get("retry-after")).toBe("30");
        expect(response.headers.get("set-cookie")).toBeNull();
        if (!meta) expect(body).not.toContain("private upstream diagnostic");
        for (const [name, value] of Object.entries(limits))
          expect(response.headers.get(name), name).toBe(value);
      });
    }
  }
}
