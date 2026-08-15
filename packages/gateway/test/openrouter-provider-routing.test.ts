/**
 * Load-bearing integration coverage for foreground OpenRouter routing policy
 * capture, persistence, and real urgent worker dispatch.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import { request as httpRequest } from "node:http";
import {
  close as closeDB,
  loadSessionTracking,
  saveSessionTracking,
} from "@loreai/core";
import { upstreamFetch } from "../src/fetch";
import { setSessionAuth } from "../src/auth";
import type { GatewayConfig } from "../src/config";
import { fetchArgUrl } from "./helpers/fetch-url";

vi.mock("../src/fetch", () => ({ upstreamFetch: vi.fn() }));

const mockFetch = vi.mocked(upstreamFetch);
const SESSION_ID = "provider-routing-fixed-session";
const SESSION_UPSTREAM = "https://session-route.invalid/openrouter";
const DEDICATED_KEY = "dedicated-worker-key";
const OPENROUTER_MODEL = "openrouter/deepseek/deepseek-chat";

type Started = {
  baseURL: string;
  config: GatewayConfig;
  dbPath: string;
  server: { stop(): Promise<void> };
  previousEnv: Map<string, string | undefined>;
};

let started: Started | undefined;

function postLoopback(
  baseURL: string,
  path: string,
  headers: Record<string, string>,
  body: string,
): Promise<Response> {
  const url = new URL(path, baseURL);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: "POST",
        headers: {
          ...headers,
          "content-length": String(Buffer.byteLength(body)),
        },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.once("error", reject);
        incoming.once("end", () => {
          resolve(
            new Response(Buffer.concat(chunks), {
              status: incoming.statusCode ?? 500,
            }),
          );
        });
      },
    );
    request.once("error", reject);
    request.end(body);
  });
}

function openAIResponse(content = "hello"): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl_openrouter",
      object: "chat.completion",
      model: "anthropic/claude-sonnet-4-6",
      content: [{ type: "text", text: content }],
      stop_reason: "end_turn",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function recallResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl_recall",
      object: "chat.completion",
      model: "anthropic/claude-sonnet-4-6",
      content: [
        {
          type: "tool_use",
          id: "call_recall",
          name: "recall",
          input: { query: "provider routing" },
        },
      ],
      stop_reason: "tool_use",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_recall",
                type: "function",
                function: {
                  name: "recall",
                  arguments: JSON.stringify({ query: "provider routing" }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function responsesResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "resp_codex",
      object: "response",
      created_at: 1,
      status: "completed",
      model: "gpt-5.1-codex-mini",
      output: [
        {
          type: "message",
          id: "msg_codex",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "done", annotations: [] }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function workerResponse(content = "[]"): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl_worker",
      content: [{ type: "text", text: content }],
      stop_reason: "end_turn",
      choices: [
        { message: { role: "assistant", content }, finish_reason: "stop" },
      ],
      model: "worker-model",
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function start(
  options: {
    workerModel?: string;
    dedicatedKey?: boolean;
    batchDisabled?: boolean;
  } = {},
): Promise<Started> {
  const env = {
    LORE_DB_PATH: `/tmp/lore-openrouter-routing-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    LORE_LISTEN_PORT: "0",
    LORE_DEBUG: "false",
    // This suite exercises local caller-selected provider routing. Keep it
    // hermetic when the developer shell binds Lore on a non-loopback host.
    LORE_REMOTE_GATEWAY: "0",
    LORE_HOSTED_MODE: "0",
    LORE_BATCH_DISABLED: options.batchDisabled === false ? undefined : "1",
    LORE_WORKER_MODEL: options.workerModel,
    LORE_WORKER_API_KEY: options.dedicatedKey ? DEDICATED_KEY : undefined,
  };
  const previousEnv = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previousEnv.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const { resetPipelineState } = await import("../src/pipeline");
  const { startServer } = await import("../src/server");
  const { loadConfig } = await import("../src/config");
  closeDB();
  await resetPipelineState();
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (input) =>
    fetchArgUrl(input).includes("models.dev")
      ? new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      : workerResponse(),
  );
  const config = loadConfig();
  const server = await startServer(config);
  started = {
    baseURL: `http://127.0.0.1:${server.port}`,
    config,
    dbPath: env.LORE_DB_PATH,
    server,
    previousEnv,
  };
  return started;
}

async function stop(): Promise<void> {
  if (!started) return;
  const current = started;
  started = undefined;
  await current.server.stop();
  const { resetPipelineState, setUpstreamInterceptor } =
    await import("../src/pipeline");
  const { _setTestVertexTokenProvider } = await import("../src/vertex-auth");
  _setTestVertexTokenProvider(null);
  setUpstreamInterceptor(undefined);
  await resetPipelineState();
  closeDB();
  for (const [key, value] of current.previousEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const suffix of ["", "-shm", "-wal"]) {
    const path = `${current.dbPath}${suffix}`;
    if (existsSync(path)) unlinkSync(path);
  }
  mockFetch.mockReset();
}

afterEach(stop);

function requestHeaders(
  providerID: string,
  upstreamUrl = SESSION_UPSTREAM,
): Record<string, string> {
  return {
    authorization: "Bearer foreground-session-key",
    "content-type": "application/json",
    "x-lore-agent": "coder",
    "x-lore-provider": providerID,
    "x-lore-session-id": SESSION_ID,
    "x-lore-upstream-url": upstreamUrl,
  };
}

function chatBody(
  provider: unknown,
  options: { includeProvider?: boolean; message?: string } = {},
): Record<string, unknown> {
  return {
    model: "anthropic/claude-sonnet-4-6",
    messages: [{ role: "user", content: options.message ?? "Hello" }],
    tools: [
      {
        type: "function",
        function: {
          name: "noop",
          description: "Keep this on the conversation path",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
    ...(options.includeProvider === false ? {} : { provider }),
  };
}

async function foreground(
  run: Started,
  options: {
    providerID?: string;
    provider?: unknown;
    includeProvider?: boolean;
    message?: string;
    upstreamUrl?: string;
  } = {},
): Promise<Response> {
  return fetch(`${run.baseURL}/v1/chat/completions`, {
    method: "POST",
    headers: requestHeaders(
      options.providerID ?? "openrouter",
      options.upstreamUrl,
    ),
    body: JSON.stringify(
      chatBody(options.provider, {
        includeProvider: options.includeProvider,
        message: options.message,
      }),
    ),
  });
}

function workerCalls() {
  return mockFetch.mock.calls.filter(
    (call) =>
      typeof (call[1] as { body?: unknown } | undefined)?.body === "string",
  );
}

function workerBodies(from = 0): Array<Record<string, unknown>> {
  return workerCalls()
    .slice(from)
    .map((call) => {
      const options = call[1] as { body: string };
      return JSON.parse(options.body) as Record<string, unknown>;
    });
}

async function useNormalForegroundInterceptor(): Promise<void> {
  const { setUpstreamInterceptor } = await import("../src/pipeline");
  setUpstreamInterceptor(async () => openAIResponse());
}

async function useRecallForegroundInterceptor(): Promise<void> {
  const { setUpstreamInterceptor } = await import("../src/pipeline");
  let calls = 0;
  setUpstreamInterceptor(async () =>
    calls++ === 0 ? recallResponse() : openAIResponse("continued"),
  );
}

function activeSession() {
  // Fixed x-lore-session-id makes this deterministic; no polling or fuzzy match.
  return import("../src/pipeline").then(({ getActiveSessions }) => {
    const state = [...getActiveSessions().values()].find(
      (candidate) => candidate.headerSessionId === SESSION_ID,
    );
    if (!state) throw new Error("fixed test session was not identified");
    return state;
  });
}

describe("OpenRouter provider routing", () => {
  test.each([
    ["explicit null", null],
    ["empty object", {}],
  ])(
    "preserves %s through the real foreground pipeline",
    async (_label, provider) => {
      const run = await start();
      const { setUpstreamInterceptor } = await import("../src/pipeline");
      let forwarded: Record<string, unknown> | undefined;
      setUpstreamInterceptor(async (body) => {
        forwarded = body as Record<string, unknown>;
        return openAIResponse();
      });

      await (await foreground(run, { provider })).text();
      if (!forwarded) throw new Error("foreground request was not forwarded");
      expect(Object.hasOwn(forwarded, "provider")).toBe(true);
      expect(forwarded.provider).toEqual(provider);
      expect((await activeSession()).lastUpstream?.providerOptions).toEqual(
        provider === null ? undefined : provider,
      );
    },
  );

  test("snapshots the exact shared route for protocol overrides and Copilot inference", async () => {
    const run = await start();
    await useNormalForegroundInterceptor();
    const minimaxHeaders = requestHeaders("minimax");
    delete minimaxHeaders["x-lore-upstream-url"];
    const responses = await fetch(`${run.baseURL}/v1/responses`, {
      method: "POST",
      headers: minimaxHeaders,
      body: JSON.stringify({
        model: "anthropic/claude-sonnet-4-6",
        input: "Responses ingress to Anthropic route",
      }),
    });
    expect(responses.ok).toBe(true);
    await responses.text();
    expect((await activeSession()).lastUpstream).toMatchObject({
      providerID: "minimax",
      protocol: "anthropic",
      url: "https://api.minimax.io/anthropic",
    });

    const copilotHeaders = requestHeaders("openai");
    delete copilotHeaders["x-lore-provider"];
    delete copilotHeaders["x-lore-upstream-url"];
    copilotHeaders["copilot-integration-id"] = "copilot-cli";
    const copilot = await fetch(`${run.baseURL}/v1/chat/completions`, {
      method: "POST",
      headers: copilotHeaders,
      body: JSON.stringify(chatBody(undefined, { includeProvider: false })),
    });
    expect(copilot.ok).toBe(true);
    await copilot.text();
    expect((await activeSession()).lastUpstream).toMatchObject({
      providerID: "github-copilot",
      protocol: "openai",
      url: "https://api.githubcopilot.com",
    });
  });

  test("hands exact foreground policy to a real urgent recall worker using the configured model", async () => {
    const run = await start({
      workerModel: OPENROUTER_MODEL,
      dedicatedKey: true,
    });
    const policy = {
      only: ["google-vertex/europe", "amazon-bedrock/eu-west-1"],
      allow_fallbacks: false,
      data_collection: "deny",
    };
    const { setUpstreamInterceptor } = await import("../src/pipeline");
    let foregroundCalls = 0;
    setUpstreamInterceptor(async () =>
      foregroundCalls++ === 0 ? recallResponse() : openAIResponse("continued"),
    );
    mockFetch.mockImplementation(async () =>
      workerResponse('["provider routing policy"]'),
    );

    const response = await foreground(run, { provider: policy });
    expect(response.ok).toBe(true);
    await response.text();

    expect(workerCalls()).toHaveLength(1);
    const body = workerBodies()[0];
    expect(body.provider).toEqual(policy);
    expect(body.model).toBe("deepseek/deepseek-chat");
    expect(fetchArgUrl(workerCalls()[0][0])).toContain(
      "openrouter.ai/api/v1/chat/completions",
    );
    expect(fetchArgUrl(workerCalls()[0][0])).not.toContain(
      "session-route.invalid",
    );
    const headers = (
      workerCalls()[0][1] as {
        headers: Record<string, string>;
      }
    ).headers;
    expect(headers["x-api-key"]).toBe(DEDICATED_KEY);

    const state = await activeSession();
    expect(Object.isFrozen(state.lastUpstream?.providerOptions)).toBe(true);
    expect(Object.isFrozen(state.lastUpstream?.providerOptions?.only)).toBe(
      true,
    );
  });

  test("resolves stale opts.model before a batch-eligible provider queues it", async () => {
    const run = await start({ batchDisabled: false });
    await useNormalForegroundInterceptor();
    const customOpenAIUpstream = "https://custom-openai.invalid/v1";
    await (
      await foreground(run, {
        providerID: "openai",
        includeProvider: false,
        upstreamUrl: customOpenAIUpstream,
      })
    ).text();
    const state = await activeSession();
    setSessionAuth(
      state.sessionID,
      { scheme: "api-key", value: "sk-openai-batch" },
      "openai",
    );
    const { getLLMClientForTest, resetPipelineState } =
      await import("../src/pipeline");
    const client = getLLMClientForTest(run.config) as ReturnType<
      typeof getLLMClientForTest
    > & {
      stats(): { queued: number };
    };
    const before = workerCalls().length;
    const pending = client.prompt("system", "batch me", {
      sessionID: state.sessionID,
      workerID: "lore-distill",
      model: { providerID: "anthropic", modelID: "stale-claude-model" },
    });

    expect(client.stats().queued).toBe(1);
    await resetPipelineState();
    await pending;
    const dispatched = workerCalls()[before];
    expect(dispatched).toBeDefined();
    expect(fetchArgUrl(dispatched[0])).toContain(
      "custom-openai.invalid/v1/responses",
    );
    const body = JSON.parse((dispatched[1] as { body: string }).body) as Record<
      string,
      unknown
    >;
    expect(body.model).not.toBe("stale-claude-model");
  });

  test("replaces P1 with P2 and clears P2 when a newer request omits provider", async () => {
    const run = await start({ workerModel: OPENROUTER_MODEL });
    await useNormalForegroundInterceptor();
    const p1 = { only: ["p1"], allow_fallbacks: false };
    const p2 = { only: ["p2"], allow_fallbacks: false };

    await (await foreground(run, { provider: p1, message: "P1" })).text();
    await useRecallForegroundInterceptor();
    const beforeP2Worker = workerCalls().length;
    await (await foreground(run, { provider: p2, message: "P2" })).text();
    const p2Bodies = workerBodies(beforeP2Worker);
    expect(p2Bodies.length).toBeGreaterThan(0);
    expect(
      p2Bodies.every(
        (body) => JSON.stringify(body.provider) === JSON.stringify(p2),
      ),
    ).toBe(true);

    await useRecallForegroundInterceptor();
    const beforeDefaultWorker = workerCalls().length;
    await (
      await foreground(run, {
        includeProvider: false,
        message: "provider omitted",
      })
    ).text();
    expect(
      (await activeSession()).lastUpstream?.providerOptions,
    ).toBeUndefined();
    const defaultBodies = workerBodies(beforeDefaultWorker);
    expect(defaultBodies.length).toBeGreaterThan(0);
    expect(
      defaultBodies.every(
        (body) =>
          JSON.stringify(body.provider) === JSON.stringify({ sort: "price" }),
      ),
    ).toBe(true);
  });

  test("provider switches use the effective worker provider's own stored snapshot", async () => {
    const run = await start({ workerModel: OPENROUTER_MODEL });
    await useNormalForegroundInterceptor();
    const openRouterPolicy = { only: ["openrouter-owned-endpoint"] };
    await (await foreground(run, { provider: openRouterPolicy })).text();
    const { setUpstreamInterceptor } = await import("../src/pipeline");
    const deepseekBodies: Array<Record<string, unknown>> = [];
    let deepseekCalls = 0;
    setUpstreamInterceptor(async (body) => {
      deepseekBodies.push(body as Record<string, unknown>);
      return deepseekCalls++ === 0
        ? recallResponse()
        : openAIResponse("continued");
    });
    const before = workerCalls().length;
    await (
      await foreground(run, {
        providerID: "deepseek",
        provider: { only: ["foreign-deepseek-policy"] },
        message: "switch provider",
        upstreamUrl: "https://api.deepseek.com",
      })
    ).text();
    expect(Object.hasOwn(deepseekBodies[0], "provider")).toBe(false);
    const bodies = workerBodies(before);
    expect(bodies.length).toBeGreaterThan(0);
    expect(
      bodies.every(
        (body) =>
          JSON.stringify(body.provider) === JSON.stringify(openRouterPolicy),
      ),
    ).toBe(true);
    expect(fetchArgUrl(workerCalls()[before][0])).toContain(
      "session-route.invalid/openrouter",
    );
    expect(fetchArgUrl(workerCalls()[before][0])).not.toContain("deepseek");
  });

  test("different-provider dedicated worker gets no foreign policy", async () => {
    const run = await start({
      workerModel: "deepseek/deepseek-chat",
      dedicatedKey: true,
    });
    await useNormalForegroundInterceptor();
    await useRecallForegroundInterceptor();
    await (
      await foreground(run, { provider: { only: ["openrouter-only"] } })
    ).text();

    const bodies = workerBodies();
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.every((body) => !Object.hasOwn(body, "provider"))).toBe(true);
    expect(fetchArgUrl(workerCalls()[0][0])).toContain("api.deepseek.com");
  });

  test("dedicated OpenRouter worker falls back to price after an omitted policy", async () => {
    const run = await start({
      workerModel: OPENROUTER_MODEL,
      dedicatedKey: true,
    });
    await useRecallForegroundInterceptor();
    await (await foreground(run, { includeProvider: false })).text();

    const bodies = workerBodies();
    expect(bodies.length).toBeGreaterThan(0);
    expect(
      bodies.every(
        (body) =>
          JSON.stringify(body.provider) === JSON.stringify({ sort: "price" }),
      ),
    ).toBe(true);
    expect(fetchArgUrl(workerCalls()[0][0])).not.toContain(
      "session-route.invalid",
    );
  });

  test("protocol-distinct Vertex aliases coexist, persist, and select compatibly", async () => {
    const run = await start();
    await useNormalForegroundInterceptor();
    const gemini = await fetch(
      `${run.baseURL}/v1beta/models/gemini-2.5-flash:generateContent`,
      {
        method: "POST",
        headers: requestHeaders(
          "google-vertex",
          "https://gemini-route.invalid",
        ),
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "native Gemini" }] }],
        }),
      },
    );
    await gemini.text();
    expect((await activeSession()).lastUpstream).toMatchObject({
      providerID: "google-vertex",
      protocol: "gemini",
      url: "https://gemini-route.invalid",
    });

    const { _setTestVertexTokenProvider } = await import("../src/vertex-auth");
    _setTestVertexTokenProvider(async () => "vertex-test-token");
    run.config.vertexProject = "vertex-test-project";
    await (
      await foreground(run, {
        providerID: "google-vertex-anthropic",
        includeProvider: false,
        upstreamUrl: "https://vertex-route.invalid",
        message: "Vertex Claude",
      })
    ).text();

    const {
      matchingProviderSnapshotForTest,
      resetPipelineState,
      setUpstreamInterceptor,
    } = await import("../src/pipeline");
    let state = await activeSession();
    expect(state.upstreamByProvider.get("google-vertex")).toMatchObject({
      protocol: "gemini",
    });
    expect(
      state.upstreamByProvider.get("google-vertex-anthropic"),
    ).toMatchObject({ protocol: "vertex" });
    expect(
      matchingProviderSnapshotForTest(state, "google-vertex")?.protocol,
    ).toBe("gemini");
    expect(
      matchingProviderSnapshotForTest(state, "google-vertex-anthropic")
        ?.protocol,
    ).toBe("vertex");
    expect(matchingProviderSnapshotForTest(state, "vertex")?.protocol).toBe(
      "vertex",
    );

    const persisted = loadSessionTracking(state.sessionID)?.lastUpstream;
    if (!persisted)
      throw new Error("Vertex alias snapshots were not persisted");
    const envelope = JSON.parse(persisted) as {
      upstreamByProvider: Record<string, unknown>;
    };
    expect(Object.keys(envelope.upstreamByProvider)).toEqual(
      expect.arrayContaining(["google-vertex", "google-vertex-anthropic"]),
    );

    await resetPipelineState();
    setUpstreamInterceptor(async () => openAIResponse());
    await (
      await foreground(run, {
        provider: { only: ["restore-trigger"] },
        message: "restore aliases",
      })
    ).text();
    state = await activeSession();
    expect(state.upstreamByProvider.has("google-vertex")).toBe(true);
    expect(state.upstreamByProvider.has("google-vertex-anthropic")).toBe(true);
  });

  test("canonical worker-provider aliases share the matching snapshot route", async () => {
    const run = await start({
      workerModel: "bedrock/anthropic.claude-haiku-4-5-v1:0",
    });
    await useRecallForegroundInterceptor();
    const aliasRoute = "https://bedrock-alias.invalid/anthropic";
    await (
      await foreground(run, {
        providerID: "amazon-bedrock",
        includeProvider: false,
        upstreamUrl: aliasRoute,
      })
    ).text();

    expect(workerCalls()).toHaveLength(1);
    expect(fetchArgUrl(workerCalls()[0][0])).toContain(
      "bedrock-alias.invalid/anthropic/v1/messages",
    );
  });

  test("persists last + provider map, restores policy, supports legacy, and rejects malformed options", async () => {
    const run = await start({
      workerModel: OPENROUTER_MODEL,
      dedicatedKey: true,
    });
    await useNormalForegroundInterceptor();
    const restoredPolicy = { only: ["restored-openrouter"] };
    await (await foreground(run, { provider: restoredPolicy })).text();
    await (
      await foreground(run, {
        providerID: "anthropic",
        includeProvider: false,
        upstreamUrl: "https://api.anthropic.com",
        message: "make anthropic last",
      })
    ).text();
    const sid = (await activeSession()).sessionID;
    const persisted = loadSessionTracking(sid)?.lastUpstream;
    if (!persisted) throw new Error("upstream state was not persisted");
    const envelope = JSON.parse(persisted) as {
      version: number;
      lastUpstream: { providerID?: string; headers: Record<string, string> };
      upstreamByProvider: Record<
        string,
        { providerOptions?: unknown; headers: Record<string, string> }
      >;
    };
    expect(envelope.version).toBe(2);
    expect(envelope.lastUpstream.providerID).toBe("anthropic");
    expect(envelope.lastUpstream.headers).toEqual({});
    expect(envelope.upstreamByProvider.openrouter.providerOptions).toEqual(
      restoredPolicy,
    );
    expect(envelope.upstreamByProvider.openrouter.headers).toEqual({});

    const { resetPipelineState, setUpstreamInterceptor } =
      await import("../src/pipeline");
    await resetPipelineState();
    let restartCalls = 0;
    setUpstreamInterceptor(async () =>
      restartCalls++ === 0 ? recallResponse() : openAIResponse("continued"),
    );
    const restoredStart = workerCalls().length;
    await (
      await foreground(run, {
        providerID: "anthropic",
        includeProvider: false,
        upstreamUrl: "https://api.anthropic.com",
        message: "restart",
      })
    ).text();
    expect(
      (await activeSession()).upstreamByProvider.get("openrouter")
        ?.providerOptions,
    ).toEqual(restoredPolicy);
    expect(workerBodies(restoredStart)[0].provider).toEqual(restoredPolicy);

    const legacyPolicy = { only: ["legacy-openrouter"] };
    saveSessionTracking(sid, {
      lastUpstream: JSON.stringify({
        url: "https://openrouter.ai/api",
        protocol: "openai",
        providerID: "openrouter",
        model: "anthropic/claude-sonnet-4-6",
        headers: {
          authorization: "Bearer persisted-secret",
          "anthropic-beta": "safe-beta",
        },
        providerOptions: legacyPolicy,
      }),
    });
    await resetPipelineState();
    let legacyCalls = 0;
    setUpstreamInterceptor(async () =>
      legacyCalls++ === 0 ? recallResponse() : openAIResponse("continued"),
    );
    const legacyStart = workerCalls().length;
    await (
      await foreground(run, {
        providerID: "anthropic",
        includeProvider: false,
        upstreamUrl: "https://api.anthropic.com",
        message: "legacy restart",
      })
    ).text();
    expect(workerBodies(legacyStart)[0].provider).toEqual(legacyPolicy);
    expect(
      (await activeSession()).upstreamByProvider.get("openrouter")?.headers,
    ).toEqual({ "anthropic-beta": "safe-beta" });

    saveSessionTracking(sid, {
      lastUpstream: JSON.stringify({
        url: "https://openrouter.ai/api",
        protocol: "openai",
        providerID: "openrouter",
        model: "anthropic/claude-sonnet-4-6",
        headers: {},
        providerOptions: ["malformed"],
      }),
    });
    await resetPipelineState();
    let malformedCalls = 0;
    setUpstreamInterceptor(async () =>
      malformedCalls++ === 0 ? recallResponse() : openAIResponse("continued"),
    );
    const malformedStart = workerCalls().length;
    await (
      await foreground(run, {
        providerID: "anthropic",
        includeProvider: false,
        upstreamUrl: "https://api.anthropic.com",
        message: "malformed restart",
      })
    ).text();
    expect((await activeSession()).upstreamByProvider.has("openrouter")).toBe(
      false,
    );
    expect(workerBodies(malformedStart)[0].provider).toEqual({ sort: "price" });

    const validV2Snapshot = {
      url: "https://openrouter.ai/api",
      protocol: "openai",
      providerID: "openrouter",
      model: "anthropic/claude-sonnet-4-6",
      headers: {},
      providerOptions: { only: ["v2-policy"] },
    };
    const invalidV2States = [
      {
        version: 999,
        lastUpstream: validV2Snapshot,
        upstreamByProvider: { openrouter: validV2Snapshot },
      },
      {
        version: 2,
        lastUpstream: {
          ...validV2Snapshot,
          providerOptions: ["malformed-v2"],
        },
        upstreamByProvider: {
          openrouter: {
            ...validV2Snapshot,
            providerOptions: ["malformed-v2"],
          },
        },
      },
    ];
    for (const [index, invalidState] of invalidV2States.entries()) {
      saveSessionTracking(sid, {
        lastUpstream: JSON.stringify(invalidState),
      });
      await resetPipelineState();
      setUpstreamInterceptor(async () => openAIResponse());
      await (
        await foreground(run, {
          providerID: "anthropic",
          includeProvider: false,
          upstreamUrl: "https://api.anthropic.com",
          message: `invalid v2 restart ${index}`,
        })
      ).text();
      expect((await activeSession()).upstreamByProvider.has("openrouter")).toBe(
        false,
      );
    }
  });

  test("captures failed tightening and rejects an older request that resumes before capture", async () => {
    const run = await start();
    const { setBeforeUpstreamCaptureForTest, setUpstreamInterceptor } =
      await import("../src/pipeline");
    const failedPolicy = { only: ["failed-but-authoritative"] };
    setUpstreamInterceptor(
      async () =>
        new Response('{"error":"denied"}', {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    );
    const failed = await foreground(run, { provider: failedPolicy });
    expect(failed.status).toBe(403);
    expect((await activeSession()).lastUpstream?.providerOptions).toEqual(
      failedPolicy,
    );

    let releaseOld!: () => void;
    let markOldStarted!: () => void;
    const oldStarted = new Promise<void>((resolve) => {
      markOldStarted = resolve;
    });
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    setBeforeUpstreamCaptureForTest(async (req) => {
      const text = req.messages
        .flatMap((message) => message.content)
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      if (text.includes("old slow turn")) {
        markOldStarted();
        await oldGate;
      }
    });
    setUpstreamInterceptor(async () => openAIResponse());
    const oldPolicy = { only: ["old-slow-turn"] };
    const newPolicy = { only: ["new-fast-turn"] };
    const oldRequest = foreground(run, {
      provider: oldPolicy,
      message: "old slow turn",
    });
    await oldStarted;
    await (
      await foreground(run, { provider: newPolicy, message: "new fast turn" })
    ).text();
    releaseOld();
    await (await oldRequest).text();

    const state = await activeSession();
    expect(state.lastUpstream?.providerOptions).toEqual(newPolicy);
    expect(state.upstreamByProvider.get("openrouter")?.providerOptions).toEqual(
      newPolicy,
    );
    const persisted = loadSessionTracking(state.sessionID)?.lastUpstream;
    if (!persisted) throw new Error("concurrent policy was not persisted");
    const envelope = JSON.parse(persisted) as {
      lastUpstream: { providerOptions?: unknown };
      upstreamByProvider: Record<string, { providerOptions?: unknown }>;
    };
    expect(envelope.lastUpstream.providerOptions).toEqual(newPolicy);
    expect(envelope.upstreamByProvider.openrouter.providerOptions).toEqual(
      newPolicy,
    );
  });

  test("Codex neither forwards nor durably snapshots provider options", async () => {
    const run = await start();
    const { setUpstreamInterceptor } = await import("../src/pipeline");
    let forwarded: Record<string, unknown> | undefined;
    setUpstreamInterceptor(async (body) => {
      forwarded = body as Record<string, unknown>;
      return responsesResponse();
    });

    const response = await postLoopback(
      run.baseURL,
      "/v1/codex/responses",
      requestHeaders("openai-codex", "https://chatgpt.com/backend-api"),
      JSON.stringify({
        model: "gpt-5.1-codex-mini",
        input: "Hello",
        stream: false,
        provider: { only: ["must-not-survive"] },
        tools: [
          {
            type: "function",
            name: "noop",
            description: "Keep this on the conversation path",
            parameters: { type: "object", properties: {} },
          },
        ],
      }),
    );
    expect(response.ok).toBe(true);
    await response.text();
    if (!forwarded) throw new Error("Codex request was not forwarded");
    expect(Object.hasOwn(forwarded, "provider")).toBe(false);
    const state = await activeSession();
    expect(state.lastUpstream?.providerOptions).toBeUndefined();
    const persisted = loadSessionTracking(state.sessionID)?.lastUpstream ?? "";
    expect(persisted).not.toContain("must-not-survive");
    expect(persisted).not.toContain("providerOptions");
  });

  test("bounds persisted provider history and rejects oversized policies", async () => {
    const run = await start();
    await useNormalForegroundInterceptor();

    for (let index = 0; index < 20; index++) {
      const response = await foreground(run, {
        providerID: `custom-provider-${index}`,
        includeProvider: false,
        message: `provider ${index}`,
        upstreamUrl: `https://custom-provider-${index}.invalid/v1`,
      });
      expect(response.ok).toBe(true);
      await response.text();
    }

    const state = await activeSession();
    expect(state.upstreamByProvider.size).toBe(16);
    const persisted = loadSessionTracking(state.sessionID)?.lastUpstream;
    if (!persisted) throw new Error("bounded upstream state was not persisted");
    const envelope = JSON.parse(persisted) as {
      upstreamByProvider: Record<string, unknown>;
    };
    expect(Object.keys(envelope.upstreamByProvider)).toHaveLength(16);

    const oversized = await foreground(run, {
      provider: { only: ["x".repeat(65 * 1024)] },
      message: "oversized policy",
    });
    expect(oversized.status).toBe(502);
    expect(await oversized.text()).toContain(
      "OpenRouter provider routing options exceed 65536 bytes",
    );
  });
});
