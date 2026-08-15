import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MockAgent } from "undici";
import { db } from "@loreai/core";
import type { GatewayConfig } from "../src/config";
import {
  getAllSessionCosts,
  getDailySpend,
  resetDailyBudgetState,
} from "../src/cost-tracker";
import { setUpstreamDispatcherForTest } from "../src/fetch";
import { getActiveSessions, setUpstreamInterceptor } from "../src/pipeline";
import type { Harness } from "./helpers/harness";
import { createHarness, TEST_GATEWAY_AUTH_TOKEN } from "./helpers/harness";

const ATTACK_PROJECT = `/tmp/lore-browser-origin-${process.pid}`;
const SERVER_ANTHROPIC_ORIGIN = "https://browser-security-anthropic.invalid";
const SERVER_OPENAI_ORIGIN = "https://browser-security-openai.invalid";
const BEDROCK_ORIGIN =
  "https://bedrock-runtime.browser-security-1.amazonaws.com";

type DataPlaneRoute = {
  name: string;
  path: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
};

const projectHeaders = { "x-lore-project": ATTACK_PROJECT };
const anthropicBody = JSON.stringify({
  model: "claude-sonnet-4-6",
  max_tokens: 32,
  messages: [{ role: "user", content: "steal local memory" }],
});
const openAIChatBody = JSON.stringify({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "steal local memory" }],
});
const responsesBody = JSON.stringify({
  model: "gpt-5.4",
  input: [{ role: "user", content: "steal local memory" }],
});
const geminiBody = JSON.stringify({
  contents: [{ role: "user", parts: [{ text: "steal local memory" }] }],
});
const bedrockBody = JSON.stringify({
  messages: [{ role: "user", content: [{ text: "steal local memory" }] }],
});

const DATA_PLANE_ROUTES: DataPlaneRoute[] = [
  {
    name: "Anthropic messages",
    path: "/v1/messages",
    method: "POST",
    headers: {
      ...projectHeaders,
      "anthropic-version": "2023-06-01",
      "x-api-key": "attacker-anthropic-key",
    },
    body: anthropicBody,
  },
  ...["/v1/chat/completions", "/chat/completions"].map(
    (path): DataPlaneRoute => ({
      name: `OpenAI chat ${path}`,
      path,
      method: "POST",
      headers: {
        ...projectHeaders,
        authorization: "Bearer attacker-openai-token",
      },
      body: openAIChatBody,
    }),
  ),
  {
    name: "OpenAI responses",
    path: "/v1/responses",
    method: "POST",
    headers: {
      ...projectHeaders,
      authorization: "Bearer attacker-openai-token",
    },
    body: responsesBody,
  },
  {
    name: "Codex responses",
    path: "/v1/codex/responses",
    method: "POST",
    headers: {
      ...projectHeaders,
      authorization: "Bearer attacker-codex-token",
      "x-lore-provider": "openai-codex",
    },
    body: responsesBody,
  },
  {
    name: "Responses compaction",
    path: "/v1/responses/compact",
    method: "POST",
    headers: {
      ...projectHeaders,
      authorization: "Bearer attacker-openai-token",
      "x-lore-provider": "openai",
    },
    body: responsesBody,
  },
  {
    name: "Explicit compaction",
    path: "/v1/compact",
    method: "POST",
    headers: { "x-api-key": "attacker-anthropic-key" },
    body: JSON.stringify({ project_path: ATTACK_PROJECT }),
  },
  {
    name: "Models passthrough",
    path: "/v1/models",
    method: "GET",
    headers: {
      "x-api-key": "attacker-anthropic-key",
      authorization: "Bearer attacker-openai-token",
    },
  },
  ...["/v1beta", "/v1", ""].flatMap((prefix) =>
    ["generateContent", "streamGenerateContent"].map(
      (verb): DataPlaneRoute => ({
        name: `Gemini ${prefix || "bare"} ${verb}`,
        path: `${prefix}/models/gemini-2.5-flash:${verb}`,
        method: "POST",
        headers: {
          ...projectHeaders,
          "x-goog-api-key": "attacker-gemini-key",
        },
        body: geminiBody,
      }),
    ),
  ),
  ...[
    "converse",
    "converse-stream",
    "invoke",
    "invoke-with-response-stream",
  ].map(
    (verb): DataPlaneRoute => ({
      name: `Bedrock Runtime ${verb}`,
      path: `/v1/model/anthropic.claude-sonnet-4-6-v1/${verb}`,
      method: "POST",
      headers: { authorization: "Bearer attacker-bedrock-token" },
      body: bedrockBody,
    }),
  ),
];

const BROWSER_ATTEMPTS = DATA_PLANE_ROUTES.flatMap((route) =>
  ["https://attacker.example", "null"].flatMap((origin) => [
    { ...route, origin, requestKind: "credentialed request" as const },
    {
      ...route,
      origin,
      requestKind: "simple request" as const,
      headers: {},
    },
    {
      ...route,
      origin,
      requestKind: "preflight" as const,
      method: "OPTIONS" as const,
      headers: {},
      body: undefined,
    },
  ]),
);

const STORAGE_TABLES = [
  "projects",
  "temporal_messages",
  "distillations",
  "knowledge",
  "session_state",
  "daily_costs",
  "session_prompt_deltas",
  "session_rollup",
] as const;

function storageSnapshot(): Record<string, number> {
  return Object.fromEntries(
    STORAGE_TABLES.map((table) => {
      const row = db()
        .query(`SELECT COUNT(*) AS count FROM ${table}`)
        .get() as { count: number };
      return [table, row.count];
    }),
  );
}

function assertNoCors(response: Response): void {
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
  expect(response.headers.get("access-control-allow-headers")).toBeNull();
  expect(response.headers.get("access-control-allow-methods")).toBeNull();
  for (const name of response.headers.keys()) {
    expect(name.startsWith("access-control-")).toBe(false);
  }
}

function mockedUpstreamResponse(model: string): Response {
  let body: unknown;
  if (model.startsWith("claude")) {
    body = {
      id: "msg_browser_security",
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  } else if (model.startsWith("gemini")) {
    body = {
      candidates: [
        {
          content: { role: "model", parts: [{ text: "ok" }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 1,
        candidatesTokenCount: 1,
        totalTokenCount: 2,
      },
      modelVersion: model,
    };
  } else {
    body = {
      id: "chatcmpl_browser_security",
      object: "chat.completion",
      created: 1,
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
    },
  });
}

describe("browser-origin data-plane isolation", () => {
  let harness: Harness;
  let mockAgent: MockAgent;
  let pipelineInterceptorCalls = 0;
  let dispatcherCalls = 0;
  let initialStorage: Record<string, number>;
  let initialSpend = 0;

  beforeAll(async () => {
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();

    const interceptedOrigins = [
      SERVER_ANTHROPIC_ORIGIN,
      SERVER_OPENAI_ORIGIN,
      "https://generativelanguage.googleapis.com",
      "https://chatgpt.com",
      BEDROCK_ORIGIN,
    ];
    for (const origin of interceptedOrigins) {
      for (const method of ["GET", "POST"] as const) {
        mockAgent
          .get(origin)
          .intercept({ path: () => true, method })
          .reply(() => {
            dispatcherCalls += 1;
            return {
              statusCode: 200,
              data: JSON.stringify({ data: [], output: [] }),
              responseOptions: {
                headers: {
                  "content-type": "application/json",
                  "access-control-allow-origin": "*",
                  "access-control-allow-headers": "*",
                },
              },
            };
          })
          .persist();
      }
    }
    setUpstreamDispatcherForTest(mockAgent);

    const configOverrides: Partial<GatewayConfig> = {
      upstreamAnthropic: SERVER_ANTHROPIC_ORIGIN,
      upstreamOpenAI: SERVER_OPENAI_ORIGIN,
      remoteGateway: true,
      gatewayAuthToken: TEST_GATEWAY_AUTH_TOKEN,
      bedrockRegion: "browser-security-1",
      workerApiKey: "victim-server-worker-key",
      upstreamExtraHeaders: {
        authorization: "Bearer victim-server-upstream-token",
      },
      upstreamExtraHeaderBases: [SERVER_ANTHROPIC_ORIGIN, SERVER_OPENAI_ORIGIN],
    };
    harness = await createHarness({ fixtures: [], configOverrides });

    setUpstreamInterceptor(async (_body, model) => {
      pipelineInterceptorCalls += 1;
      return mockedUpstreamResponse(model);
    });
    resetDailyBudgetState();
    initialStorage = storageSnapshot();
    initialSpend = getDailySpend().spend;
  });

  afterAll(async () => {
    if (harness) await harness.teardown();
    setUpstreamDispatcherForTest(null);
    if (mockAgent) await mockAgent.close();
  });

  function gatewayRequest(
    path: string,
    options: {
      method: string;
      headers?: Record<string, string>;
      body?: string;
    },
  ): Promise<Response> {
    const gateway = new URL(harness.baseURL);
    return new Promise<Response>((resolve, reject) => {
      const request = httpRequest(
        {
          hostname: gateway.hostname,
          port: gateway.port,
          path,
          method: options.method,
          headers: options.headers,
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
          incoming.once("end", () => {
            const headers = new Headers();
            for (
              let index = 0;
              index < incoming.rawHeaders.length;
              index += 2
            ) {
              headers.append(
                incoming.rawHeaders[index],
                incoming.rawHeaders[index + 1],
              );
            }
            const body = Buffer.concat(chunks);
            resolve(
              new Response(body.length === 0 ? null : body, {
                status: incoming.statusCode ?? 500,
                statusText: incoming.statusMessage,
                headers,
              }),
            );
          });
        },
      );
      request.once("error", reject);
      request.end(options.body);
    });
  }

  describe("route and preflight battery", () => {
    test.each(BROWSER_ATTEMPTS)(
      "rejects $requestKind for $name with Origin $origin",
      async ({ path, method, headers, body, origin, requestKind }) => {
        const requestHeaders: Record<string, string> = {
          origin,
          ...headers,
        };
        if (requestKind === "preflight") {
          requestHeaders["access-control-request-method"] =
            DATA_PLANE_ROUTES.find((route) => route.path === path)?.method ??
            "POST";
          requestHeaders["access-control-request-headers"] =
            "authorization, content-type, x-api-key, x-goog-api-key";
        } else if (body !== undefined) {
          // text/plain is CORS-safelisted. The simple-request cases carry no
          // other non-safelisted headers; credentialed cases separately cover
          // attacker-supplied provider authentication.
          requestHeaders["content-type"] = "text/plain;charset=UTF-8";
          requestHeaders["content-length"] = String(Buffer.byteLength(body));
        }

        const response = await gatewayRequest(path, {
          method,
          headers: requestHeaders,
          body,
        });

        expect(response.status).toBe(403);
        expect(await response.text()).toBe("");
        expect(response.headers.get("cache-control")).toBe("no-store");
        assertNoCors(response);
        expect(pipelineInterceptorCalls).toBe(0);
        expect(dispatcherCalls).toBe(0);
        expect(getActiveSessions().size).toBe(0);
        expect(getAllSessionCosts().size).toBe(0);
        expect(getDailySpend().spend).toBe(initialSpend);
        expect(storageSnapshot()).toEqual(initialStorage);
      },
    );
  });

  test("rejects before waiting for or parsing a data-plane body", async () => {
    const port = Number(new URL(harness.baseURL).port);
    const rawResponse = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1");
      let received = "";
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("browser-origin denial waited for the request body"));
      }, 2_000);
      const finish = (): void => {
        clearTimeout(timer);
        socket.destroy();
        resolve(received);
      };
      socket.once("connect", () => {
        socket.write(
          "POST /v1/messages HTTP/1.1\r\n" +
            `Host: 127.0.0.1:${port}\r\n` +
            "Origin: https://attacker.example\r\n" +
            "Content-Type: text/plain\r\n" +
            "X-Api-Key: attacker-key\r\n" +
            "Content-Length: 100000\r\n" +
            "\r\n" +
            "{",
        );
      });
      socket.on("data", (chunk) => {
        received += chunk.toString();
        if (received.includes("\r\n\r\n")) finish();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.once("close", () => {
        if (received) finish();
      });
    });

    expect(rawResponse).toContain("403 Forbidden");
    expect(rawResponse.toLowerCase()).toContain("connection: close");
    expect(rawResponse.toLowerCase()).not.toContain("access-control-");
    expect(pipelineInterceptorCalls).toBe(0);
    expect(dispatcherCalls).toBe(0);
    expect(getActiveSessions().size).toBe(0);
    expect(storageSnapshot()).toEqual(initialStorage);
  });

  test.each(["https://attacker.example", "null"])(
    "rejects browser WebSocket upgrade with Origin %s before route handling",
    async (origin) => {
      const port = Number(new URL(harness.baseURL).port);
      const rawResponse = await new Promise<string>((resolve, reject) => {
        const socket = connect(port, "127.0.0.1", () => {
          socket.write(
            "GET /v1/responses HTTP/1.1\r\n" +
              `Host: 127.0.0.1:${port}\r\n` +
              `Origin: ${origin}\r\n` +
              "Upgrade: websocket\r\n" +
              "Connection: Upgrade\r\n" +
              "Sec-WebSocket-Version: 13\r\n" +
              "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
              "\r\n",
          );
        });
        let received = "";
        socket.on("data", (chunk) => {
          received += chunk.toString();
        });
        socket.once("close", () => resolve(received));
        socket.once("error", reject);
      });

      expect(rawResponse).toContain("403 Forbidden");
      expect(rawResponse.toLowerCase()).not.toContain("access-control-");
      expect(pipelineInterceptorCalls).toBe(0);
      expect(dispatcherCalls).toBe(0);
    },
  );

  test("rejects an Origin matching the gateway itself on data-plane routes", async () => {
    const response = await gatewayRequest("/v1/messages", {
      method: "POST",
      headers: {
        ...projectHeaders,
        origin: harness.baseURL,
        "content-type": "text/plain;charset=UTF-8",
        "x-api-key": "attacker-anthropic-key",
      },
      body: anthropicBody,
    });

    expect(response.status).toBe(403);
    assertNoCors(response);
    expect(pipelineInterceptorCalls).toBe(0);
    expect(dispatcherCalls).toBe(0);
    expect(getActiveSessions().size).toBe(0);
    expect(storageSnapshot()).toEqual(initialStorage);
  });

  test.each(["https://attacker.example", "null"])(
    "keeps health public for Origin %s without granting CORS read access",
    async (origin) => {
      const response = await gatewayRequest("/health", {
        method: "GET",
        headers: { origin },
      });

      expect(response.status).toBe(200);
      assertNoCors(response);
    },
  );

  test("keeps no-Origin Anthropic and OpenAI SDK requests working", async () => {
    const anthropicCallsBefore = pipelineInterceptorCalls;
    const anthropic = await gatewayRequest("/v1/messages", {
      method: "POST",
      headers: {
        ...projectHeaders,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-api-key": "cli-anthropic-key",
        "x-lore-gateway-token": TEST_GATEWAY_AUTH_TOKEN,
      },
      body: anthropicBody,
    });
    expect(anthropic.status).toBe(200);
    expect(pipelineInterceptorCalls).toBe(anthropicCallsBefore + 1);
    assertNoCors(anthropic);

    const openAICallsBefore = pipelineInterceptorCalls;
    const openAI = await gatewayRequest("/v1/chat/completions", {
      method: "POST",
      headers: {
        ...projectHeaders,
        authorization: "Bearer cli-openai-token",
        "content-type": "application/json",
        "x-lore-gateway-token": TEST_GATEWAY_AUTH_TOKEN,
      },
      body: openAIChatBody,
    });
    expect(openAI.status).toBe(200);
    expect(pipelineInterceptorCalls).toBe(openAICallsBefore + 1);
    assertNoCors(openAI);
  });

  test("keeps no-Origin model passthrough clients working and strips upstream CORS", async () => {
    const modelsCallsBefore = dispatcherCalls;
    const models = await gatewayRequest("/v1/models", {
      method: "GET",
      headers: {
        "x-api-key": "cli-anthropic-key",
        "x-lore-gateway-token": TEST_GATEWAY_AUTH_TOKEN,
      },
    });
    expect(models.status).toBe(200);
    expect(dispatcherCalls).toBe(modelsCallsBefore + 1);
    assertNoCors(models);

    const bedrockCallsBefore = dispatcherCalls;
    const bedrock = await gatewayRequest(
      "/v1/model/anthropic.claude-sonnet-4-6-v1/converse",
      {
        method: "POST",
        headers: {
          authorization: "Bearer sdk-bedrock-token",
          "content-type": "application/json",
          "x-lore-gateway-token": TEST_GATEWAY_AUTH_TOKEN,
        },
        body: bedrockBody,
      },
    );
    expect(bedrock.status).toBe(200);
    expect(dispatcherCalls).toBe(bedrockCallsBefore + 1);
    assertNoCors(bedrock);
  });
});
