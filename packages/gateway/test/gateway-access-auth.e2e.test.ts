import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { db } from "@loreai/core";
import { MockAgent } from "undici";
import {
  getAllSessionCosts,
  getDailySpend,
  resetDailyBudgetState,
} from "../src/cost-tracker";
import { setUpstreamDispatcherForTest } from "../src/fetch";
import {
  getActiveSessions,
  setBeforeUpstreamCaptureForTest,
  setUpstreamInterceptor,
} from "../src/pipeline";
import {
  createHarness,
  TEST_GATEWAY_AUTH_TOKEN,
  type Harness,
} from "./helpers/harness";
import {
  DEFAULT_MODEL,
  DEFAULT_SYSTEM,
  STANDARD_TOOLS,
} from "./helpers/fixtures";

const ACCESS_HEADER = "x-lore-gateway-token";
const PROJECT = `/tmp/lore-gateway-access-${process.pid}`;
const SESSION = "gateway-access-session";
const COMPACT_SESSION = "gateway-access-compact-session";
const ADMIN_ANTHROPIC_ORIGIN = "https://gateway-access-admin.invalid";
const BEDROCK_ORIGIN = "https://bedrock-runtime.gateway-access-1.amazonaws.com";

type HeaderValue = string | string[];

type DataPlaneRoute = {
  name: string;
  path: string;
  method: "GET" | "POST" | "WS";
  headers: Record<string, HeaderValue>;
  body?: string;
  expectedStatus?: number;
};

const anthropicBody = JSON.stringify({
  model: DEFAULT_MODEL,
  max_tokens: 32,
  system: DEFAULT_SYSTEM,
  messages: [{ role: "user", content: "authorized request" }],
  tools: STANDARD_TOOLS,
});
const chatBody = JSON.stringify({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "authorized request" }],
});
const responsesBody = JSON.stringify({
  model: "gpt-5.4",
  input: [{ role: "user", content: "authorized request" }],
});
const geminiBody = JSON.stringify({
  contents: [{ role: "user", parts: [{ text: "authorized request" }] }],
});
const bedrockBody = JSON.stringify({
  messages: [{ role: "user", content: [{ text: "authorized request" }] }],
});

const projectHeaders = {
  "x-lore-project": PROJECT,
  "x-lore-session-id": SESSION,
};

const DATA_PLANE_ROUTES: DataPlaneRoute[] = [
  {
    name: "Anthropic messages",
    path: "/v1/messages",
    method: "POST",
    headers: {
      ...projectHeaders,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-api-key": "client-anthropic-key",
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
        authorization: "Bearer client-openai-token",
        "content-type": "application/json",
      },
      body: chatBody,
    }),
  ),
  {
    name: "OpenAI Responses",
    path: "/v1/responses",
    method: "POST",
    headers: {
      ...projectHeaders,
      authorization: "Bearer client-openai-token",
      "content-type": "application/json",
    },
    body: responsesBody,
  },
  {
    name: "Codex Responses",
    path: "/v1/codex/responses",
    method: "POST",
    headers: {
      ...projectHeaders,
      authorization: "Bearer client-codex-token",
      "content-type": "application/json",
      "x-lore-provider": "openai-codex",
    },
    body: responsesBody,
  },
  {
    name: "Responses compact",
    path: "/v1/responses/compact",
    method: "POST",
    headers: {
      "x-lore-project": PROJECT,
      authorization: "Bearer client-openai-token",
      "content-type": "application/json",
      "x-lore-provider": "openai",
    },
    body: responsesBody,
  },
  {
    name: "Explicit compact",
    path: "/v1/compact",
    method: "POST",
    headers: {
      ...projectHeaders,
      "content-type": "application/json",
      "x-api-key": "client-anthropic-key",
      "x-lore-session-id": COMPACT_SESSION,
    },
    body: JSON.stringify({ project_path: PROJECT, tokens_before: 1 }),
  },
  {
    name: "Models passthrough",
    path: "/v1/models",
    method: "GET",
    headers: { "x-api-key": "client-anthropic-key" },
  },
  {
    name: "Models passthrough with Google key",
    path: "/v1/models",
    method: "GET",
    headers: { "x-goog-api-key": "client-google-key" },
  },
  ...["/v1beta", "/v1", ""].flatMap((prefix) =>
    ["generateContent", "streamGenerateContent"].map(
      (verb): DataPlaneRoute => ({
        name: `Gemini ${prefix || "bare"} ${verb}`,
        path: `${prefix}/models/gemini-2.5-flash:${verb}`,
        method: "POST",
        headers: {
          ...projectHeaders,
          "content-type": "application/json",
          "x-goog-api-key": "client-google-key",
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
      headers: {
        authorization: "Bearer client-bedrock-token",
        "content-type": "application/json",
      },
      body: bedrockBody,
    }),
  ),
  {
    name: "Responses WebSocket upgrade",
    path: "/v1/responses",
    method: "WS",
    headers: { authorization: "Bearer client-openai-token" },
    expectedStatus: 426,
  },
];

const ACCESS_FAILURES = [
  { name: "missing", value: undefined },
  { name: "wrong", value: "wrong-gateway-token-with-32-characters" },
  { name: "malformed", value: "malformed gateway token with spaces" },
  {
    name: "duplicate-equivalent",
    value: [TEST_GATEWAY_AUTH_TOKEN, TEST_GATEWAY_AUTH_TOKEN] as string[],
  },
] as const;

const MIXED_AUTH_PAIRS = [
  {
    name: "x-api-key + x-goog-api-key",
    headers: { "x-api-key": "api-key", "x-goog-api-key": "google-key" },
  },
  {
    name: "x-api-key + bearer",
    headers: {
      "x-api-key": "api-key",
      authorization: "Bearer bearer-token",
    },
  },
  {
    name: "x-goog-api-key + bearer",
    headers: {
      "x-goog-api-key": "google-key",
      authorization: "Bearer bearer-token",
    },
  },
] as const;

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

function statusFromRawResponse(response: string): number {
  const match = /^HTTP\/1\.1 (\d{3})/.exec(response);
  return match ? Number(match[1]) : 0;
}

function websocketRequest(
  baseURL: string,
  route: DataPlaneRoute,
  headers: Record<string, HeaderValue>,
): Promise<{ status: number; body: string; headers: Headers }> {
  const url = new URL(baseURL);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname);
    let received = "";
    socket.once("connect", () => {
      const lines = [
        `GET ${route.path} HTTP/1.1`,
        `Host: ${url.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      ];
      for (const [name, value] of Object.entries(headers)) {
        for (const item of Array.isArray(value) ? value : [value]) {
          lines.push(`${name}: ${item}`);
        }
      }
      socket.end(`${lines.join("\r\n")}\r\n\r\n`);
    });
    socket.on("data", (chunk) => {
      received += chunk.toString();
    });
    socket.once("close", () => {
      const [headerText, body = ""] = received.split("\r\n\r\n", 2);
      const responseHeaders = new Headers();
      for (const line of headerText.split("\r\n").slice(1)) {
        const separator = line.indexOf(":");
        if (separator > 0) {
          responseHeaders.append(
            line.slice(0, separator),
            line.slice(separator + 1).trim(),
          );
        }
      }
      resolve({
        status: statusFromRawResponse(received),
        body,
        headers: responseHeaders,
      });
    });
    socket.once("error", reject);
  });
}

function httpDataPlaneRequest(
  baseURL: string,
  route: DataPlaneRoute,
  headers: Record<string, HeaderValue>,
): Promise<{ status: number; body: string; headers: Headers }> {
  const url = new URL(baseURL);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: route.path,
        method: route.method,
        headers,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.once("end", () => {
          const responseHeaders = new Headers();
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
            responseHeaders.append(
              incoming.rawHeaders[index],
              incoming.rawHeaders[index + 1],
            );
          }
          resolve({
            status: incoming.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
            headers: responseHeaders,
          });
        });
      },
    );
    request.once("error", reject);
    request.end(route.body);
  });
}

function sendRoute(
  baseURL: string,
  route: DataPlaneRoute,
  headers: Record<string, HeaderValue>,
) {
  return route.method === "WS"
    ? websocketRequest(baseURL, route, headers)
    : httpDataPlaneRequest(baseURL, route, headers);
}

function withoutProviderAuth(
  headers: Record<string, HeaderValue>,
): Record<string, HeaderValue> {
  const copy = { ...headers };
  delete copy.authorization;
  delete copy["x-api-key"];
  delete copy["x-goog-api-key"];
  return copy;
}

function mockedPipelineResponse(
  body: unknown,
  model: string,
  streaming: boolean,
): Response {
  if (model.startsWith("gemini")) {
    const payload = JSON.stringify({
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
    });
    return new Response(streaming ? `data: ${payload}\n\n` : payload, {
      status: 200,
      headers: {
        "content-type": streaming ? "text/event-stream" : "application/json",
      },
    });
  }
  if (model.startsWith("gpt")) {
    const isResponses =
      typeof body === "object" && body !== null && "input" in body;
    return new Response(
      JSON.stringify(
        isResponses
          ? {
              id: "resp_gateway_access",
              object: "response",
              status: "completed",
              model,
              output: [],
              usage: { input_tokens: 1, output_tokens: 1 },
            }
          : {
              id: "chatcmpl_gateway_access",
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
              usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
              },
            },
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return new Response(
    JSON.stringify({
      id: "msg_gateway_access",
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function installDispatcher(
  mock: MockAgent,
  onRequest: (headers: unknown) => void,
) {
  for (const origin of [
    ADMIN_ANTHROPIC_ORIGIN,
    "https://api.openai.com",
    "https://chatgpt.com",
    BEDROCK_ORIGIN,
  ]) {
    for (const method of ["GET", "POST"] as const) {
      mock
        .get(origin)
        .intercept({ path: () => true, method })
        .reply((options) => {
          onRequest(options.headers);
          return {
            statusCode: 200,
            data: JSON.stringify({
              data: [],
              id: "resp_compact_gateway_access",
              object: "response.compaction",
              output: [],
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
            responseOptions: {
              headers: { "content-type": "application/json" },
            },
          };
        })
        .persist();
    }
  }
  setUpstreamDispatcherForTest(mock);
}

describe("remote gateway central access and mixed-auth enforcement", () => {
  let harness: Harness;
  let mock: MockAgent;
  let pipelineCalls = 0;
  let dispatcherCalls = 0;
  let initialStorage: Record<string, number>;
  let initialSpend = 0;

  beforeAll(async () => {
    mock = new MockAgent();
    mock.disableNetConnect();
    installDispatcher(mock, () => {
      dispatcherCalls++;
    });
    harness = await createHarness({
      fixtures: [],
      projectPath: PROJECT,
      configOverrides: {
        remoteGateway: true,
        gatewayAuthToken: TEST_GATEWAY_AUTH_TOKEN,
        upstreamAnthropic: ADMIN_ANTHROPIC_ORIGIN,
        bedrockRegion: "gateway-access-1",
        workerApiKey: "server-owned-worker-credential",
        upstreamExtraHeaders: {
          authorization: "Bearer server-owned-foreground-credential",
        },
        upstreamExtraHeaderBases: [ADMIN_ANTHROPIC_ORIGIN],
      },
    });
    setUpstreamInterceptor(async (body, model, streaming) => {
      pipelineCalls++;
      return mockedPipelineResponse(body, model, streaming);
    });
    resetDailyBudgetState();
    initialStorage = storageSnapshot();
    initialSpend = getDailySpend().spend;
  });

  afterAll(async () => {
    setBeforeUpstreamCaptureForTest(undefined);
    setUpstreamDispatcherForTest(null);
    await harness?.teardown();
    await mock?.close();
  });

  test.each(
    DATA_PLANE_ROUTES.flatMap((route) =>
      ACCESS_FAILURES.map((failure) => ({ route, failure })),
    ),
  )(
    "$route.name rejects $failure.name gateway access uniformly before work",
    async ({ route, failure }) => {
      const headers: Record<string, HeaderValue> = { ...route.headers };
      if (failure.value !== undefined) headers[ACCESS_HEADER] = failure.value;

      const response = await sendRoute(harness.baseURL, route, headers);

      expect(response.status).toBe(401);
      expect(response.body).toBe("");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(pipelineCalls).toBe(0);
      expect(dispatcherCalls).toBe(0);
      expect(getActiveSessions().size).toBe(0);
      expect(getAllSessionCosts().size).toBe(0);
      expect(getDailySpend().spend).toBe(initialSpend);
      expect(storageSnapshot()).toEqual(initialStorage);
    },
  );

  test.each(
    DATA_PLANE_ROUTES.flatMap((route) =>
      MIXED_AUTH_PAIRS.map((pair) => ({ route, pair })),
    ),
  )(
    "$route.name rejects mixed provider auth $pair.name before work",
    async ({ route, pair }) => {
      const headers = {
        ...withoutProviderAuth(route.headers),
        [ACCESS_HEADER]: TEST_GATEWAY_AUTH_TOKEN,
        ...pair.headers,
      };
      const response = await sendRoute(harness.baseURL, route, headers);

      expect(response.status).toBe(400);
      expect(response.body).toContain("Conflicting provider authentication");
      expect(pipelineCalls).toBe(0);
      expect(dispatcherCalls).toBe(0);
      expect(getActiveSessions().size).toBe(0);
      expect(getAllSessionCosts().size).toBe(0);
      expect(getDailySpend().spend).toBe(initialSpend);
      expect(storageSnapshot()).toEqual(initialStorage);
    },
  );

  test("rejects a stalled body before parsing or waiting for it", async () => {
    const port = Number(new URL(harness.baseURL).port);
    const rawResponse = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1");
      let received = "";
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("gateway access denial waited for the request body"));
      }, 2_000);
      socket.once("connect", () => {
        socket.write(
          "POST /v1/messages HTTP/1.1\r\n" +
            `Host: 127.0.0.1:${port}\r\n` +
            "Content-Type: application/json\r\n" +
            "X-Api-Key: fake-client-key\r\n" +
            "Content-Length: 100000\r\n" +
            "\r\n" +
            "{",
        );
      });
      socket.on("data", (chunk) => {
        received += chunk.toString();
        if (received.includes("\r\n\r\n")) {
          clearTimeout(timer);
          socket.destroy();
          resolve(received);
        }
      });
      socket.once("error", reject);
    });

    expect(rawResponse).toContain("401 Unauthorized");
    expect(pipelineCalls).toBe(0);
    expect(dispatcherCalls).toBe(0);
    expect(getActiveSessions().size).toBe(0);
    expect(storageSnapshot()).toEqual(initialStorage);
  });
});

describe("authorized remote data-plane routes", () => {
  let harness: Harness;
  let mock: MockAgent;
  let pipelineCalls = 0;
  let dispatcherCalls = 0;
  const downstreamHeaders: Array<Record<string, string>> = [];

  beforeAll(async () => {
    mock = new MockAgent();
    mock.disableNetConnect();
    installDispatcher(mock, (headers) => {
      dispatcherCalls++;
      downstreamHeaders.push(headers as Record<string, string>);
    });
    harness = await createHarness({
      fixtures: [],
      projectPath: PROJECT,
      configOverrides: {
        remoteGateway: true,
        gatewayAuthToken: TEST_GATEWAY_AUTH_TOKEN,
        upstreamAnthropic: ADMIN_ANTHROPIC_ORIGIN,
        bedrockRegion: "gateway-access-1",
        workerApiKey: "server-owned-worker-credential",
        upstreamExtraHeaders: {
          authorization: "Bearer server-owned-foreground-credential",
        },
        upstreamExtraHeaderBases: [ADMIN_ANTHROPIC_ORIGIN],
      },
    });
    setUpstreamInterceptor(async (body, model, streaming) => {
      pipelineCalls++;
      return mockedPipelineResponse(body, model, streaming);
    });
    const seeded = await harness.chat(
      JSON.parse(anthropicBody),
      "client-anthropic-key",
      {
        ...projectHeaders,
        "x-lore-session-id": COMPACT_SESSION,
        [ACCESS_HEADER]: TEST_GATEWAY_AUTH_TOKEN,
      },
    );
    if (seeded.status !== 200) {
      throw new Error(
        `failed to seed authorized compact session: ${seeded.status}`,
      );
    }
    await seeded.text();
    const seededSessions = harness.queryDB<{
      header_session_id: string;
      project_path: string;
    }>(
      "SELECT header_session_id, project_path FROM session_state WHERE header_session_id = ?",
      [COMPACT_SESSION],
    );
    if (seededSessions.length !== 1) {
      throw new Error(
        `failed to persist compact session: ${JSON.stringify(seededSessions)}`,
      );
    }
  });

  afterAll(async () => {
    setBeforeUpstreamCaptureForTest(undefined);
    setUpstreamDispatcherForTest(null);
    await harness?.teardown();
    await mock?.close();
  });

  test.each(DATA_PLANE_ROUTES)(
    "$name accepts the gateway token plus one provider auth mechanism",
    async (route) => {
      const headers = {
        ...route.headers,
        [ACCESS_HEADER]: TEST_GATEWAY_AUTH_TOKEN,
      };
      let rawHeadersAtPipeline: Record<string, string> | undefined;
      setBeforeUpstreamCaptureForTest(async (request) => {
        rawHeadersAtPipeline = { ...request.rawHeaders };
      });
      const callsBefore = pipelineCalls + dispatcherCalls;
      const response = await sendRoute(harness.baseURL, route, headers);
      setBeforeUpstreamCaptureForTest(undefined);

      if (response.status !== (route.expectedStatus ?? 200)) {
        throw new Error(
          `${route.name} returned ${response.status}: ${response.body}`,
        );
      }
      expect(response).toMatchObject({ status: route.expectedStatus ?? 200 });
      if (route.method !== "WS" && route.path !== "/v1/compact") {
        expect(pipelineCalls + dispatcherCalls).toBeGreaterThan(callsBefore);
      }
      expect(rawHeadersAtPipeline?.[ACCESS_HEADER]).toBeUndefined();
    },
  );

  test("configured foreground auth replaces client auth and never forwards gateway access", () => {
    expect(dispatcherCalls).toBeGreaterThan(0);
    const serialized = JSON.stringify(downstreamHeaders);
    expect(serialized).not.toContain(TEST_GATEWAY_AUTH_TOKEN);

    const modelsHeaders = downstreamHeaders.find(
      (headers) =>
        (headers.authorization ?? headers.Authorization) ===
        "Bearer server-owned-foreground-credential",
    );
    expect(modelsHeaders).toBeDefined();
    expect(modelsHeaders?.["x-api-key"]).toBeUndefined();
    expect(modelsHeaders?.["x-goog-api-key"]).toBeUndefined();
  });

  test("gateway access token is not persisted or learned as session state", () => {
    const serializedRows = JSON.stringify({
      sessions: harness.queryDB("SELECT * FROM session_state"),
      temporal: harness.queryDB("SELECT * FROM temporal_messages"),
      projects: harness.queryDB("SELECT * FROM projects"),
    });
    expect(serializedRows).not.toContain(TEST_GATEWAY_AUTH_TOKEN);
  });
});
