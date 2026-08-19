import { afterEach, describe, expect, it } from "vitest";
import { MockAgent } from "undici";
import { loadConfig } from "../src/config";
import {
  getActiveSessions,
  handleRequest,
  resetPipelineState,
  setUpstreamInterceptor,
} from "../src/pipeline";
import { setUpstreamDispatcherForTest } from "../src/fetch";
import type { GatewayRequest } from "../src/translate/types";

describe("foreground upstream extra-header base-path binding", () => {
  let mock: MockAgent | undefined;

  afterEach(async () => {
    setUpstreamInterceptor(undefined);
    setUpstreamDispatcherForTest(null);
    await mock?.close();
    mock = undefined;
    await resetPipelineState({ fast: true });
  });

  it("never attaches admin credentials to a hostile X-Lore-Upstream-URL", async () => {
    mock = new MockAgent();
    mock.disableNetConnect();
    let capturedHeaders: Record<string, string> = {};
    mock
      .get("https://attacker.example")
      .intercept({ path: "/v1/responses", method: "POST" })
      .reply((opts) => {
        capturedHeaders = opts.headers as Record<string, string>;
        return {
          statusCode: 200,
          data: JSON.stringify({
            id: "resp_hostile",
            object: "response",
            status: "completed",
            model: "gpt-5.4",
            output: [],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          responseOptions: {
            headers: { "content-type": "application/json" },
          },
        };
      });
    setUpstreamDispatcherForTest(mock);

    const config = loadConfig();
    config.remoteGateway = false;
    config.hostedMode = false;
    config.upstreamExtraHeaders = {
      authorization: "Bearer admin-secret",
      "x-corp-secret": "gateway-secret",
    };
    config.upstreamExtraHeaderBases = ["https://api.openai.com"];
    const req: GatewayRequest = {
      protocol: "openai-responses",
      model: "gpt-5.4",
      system: "Generate a short title for this conversation.",
      messages: [
        { role: "user", content: [{ type: "text", text: "title me" }] },
      ],
      tools: [],
      stream: false,
      maxTokens: 64,
      metadata: {},
      rawHeaders: {
        authorization: "Bearer client-token",
        "x-lore-upstream-url": "https://attacker.example",
      },
    };

    const response = await handleRequest(req, config);
    expect(response.status).toBe(200);
    expect(capturedHeaders.authorization ?? capturedHeaders.Authorization).toBe(
      "Bearer client-token",
    );
    expect(capturedHeaders["x-corp-secret"]).toBeUndefined();
  });

  it("does not attach tenant-a admin credentials to a sibling base path", async () => {
    mock = new MockAgent();
    mock.disableNetConnect();
    let capturedHeaders: Record<string, string> = {};
    mock
      .get("https://corp.example")
      .intercept({ path: "/tenant-b/v1/responses", method: "POST" })
      .reply((opts) => {
        capturedHeaders = opts.headers as Record<string, string>;
        return {
          statusCode: 200,
          data: JSON.stringify({
            id: "resp_sibling",
            object: "response",
            status: "completed",
            model: "gpt-5.4",
            output: [],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          responseOptions: {
            headers: { "content-type": "application/json" },
          },
        };
      });
    setUpstreamDispatcherForTest(mock);

    const config = loadConfig();
    config.remoteGateway = false;
    config.hostedMode = false;
    config.upstreamExtraHeaders = {
      authorization: "Bearer tenant-a-admin",
      "x-corp-secret": "tenant-a-secret",
    };
    config.upstreamExtraHeaderBases = ["https://corp.example/tenant-a"];
    const response = await handleRequest(
      {
        protocol: "openai-responses",
        model: "gpt-5.4",
        system: "Generate a short title for this conversation.",
        messages: [
          { role: "user", content: [{ type: "text", text: "title me" }] },
        ],
        tools: [],
        stream: false,
        maxTokens: 64,
        metadata: {},
        rawHeaders: {
          authorization: "Bearer client-token",
          "x-lore-provider": "openai",
          "x-lore-upstream-url": "https://corp.example/tenant-b",
        },
      },
      config,
    );

    expect(response.status).toBe(200);
    expect(capturedHeaders.authorization ?? capturedHeaders.Authorization).toBe(
      "Bearer client-token",
    );
    expect(capturedHeaders["x-corp-secret"]).toBeUndefined();
  });

  it("never retains client or admin credentials in routing snapshots", async () => {
    setUpstreamInterceptor(
      async () =>
        new Response(
          JSON.stringify({
            id: "msg_snapshot_safe",
            type: "message",
            role: "assistant",
            model: "claude-test",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const config = loadConfig();
    config.upstreamExtraHeaders = {
      authorization: "Bearer admin-secret",
      "x-corp-secret": "gateway-secret",
    };
    config.upstreamExtraHeaderBases = ["https://api.anthropic.com"];
    const response = await handleRequest(
      {
        protocol: "anthropic",
        model: "claude-test",
        system: "You are a coding assistant.",
        messages: [
          { role: "user", content: [{ type: "text", text: "hello" }] },
        ],
        tools: [{ name: "noop", description: "noop", inputSchema: {} }],
        stream: false,
        maxTokens: 64,
        metadata: {},
        rawHeaders: {
          "x-api-key": "client-secret",
          "x-lore-agent": "coder",
          "x-lore-project": process.cwd(),
          "x-lore-session-id": "snapshot-safe-session",
        },
      },
      config,
    );

    expect(response.status).toBe(200);
    const snapshot = [...getActiveSessions().values()][0]?.lastUpstream;
    expect(snapshot?.headers).toEqual({});
    expect(JSON.stringify(snapshot)).not.toContain("client-secret");
    expect(JSON.stringify(snapshot)).not.toContain("admin-secret");
    expect(JSON.stringify(snapshot)).not.toContain("gateway-secret");
  });

  it("clears a prior warmup body before a failed request captures a new URL", async () => {
    let failNextRequest = false;
    setUpstreamInterceptor(async () => {
      if (failNextRequest) throw new Error("simulated route failure");
      return new Response(
        JSON.stringify({
          id: "msg_warmup_route",
          type: "message",
          role: "assistant",
          model: "claude-test",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const config = loadConfig();
    config.remoteGateway = false;
    config.hostedMode = false;
    config.upstreamExtraHeaders = { authorization: "Bearer admin-secret" };
    config.upstreamExtraHeaderBases = ["https://api.anthropic.com"];
    const request = (rawHeaders: Record<string, string>): GatewayRequest => ({
      protocol: "anthropic",
      model: "claude-test",
      system: "You are a coding assistant.",
      messages: [
        { role: "user", content: [{ type: "text", text: "private turn" }] },
      ],
      tools: [{ name: "noop", description: "noop", inputSchema: {} }],
      stream: false,
      maxTokens: 64,
      metadata: {},
      rawHeaders: {
        "x-api-key": "client-secret",
        "x-lore-agent": "coder",
        "x-lore-project": process.cwd(),
        "x-lore-session-id": "warmup-route-session",
        ...rawHeaders,
      },
    });

    const first = await handleRequest(request({}), config);
    expect(first.status).toBe(200);
    await first.text();
    const state = [...getActiveSessions().values()][0];
    expect(state.cacheAnalytics.lastRequestBody).not.toBeNull();

    failNextRequest = true;
    const failed = await handleRequest(
      request({ "x-lore-upstream-url": "https://attacker.example" }),
      config,
    );
    expect(failed.status).toBe(502);
    await failed.text();
    expect(state.lastUpstream?.url).toBe("https://attacker.example");
    expect(state.cacheAnalytics.lastRequestBody).toBeNull();
  });

  it.each(["unknown-provider", "vllm"])(
    "fails closed before network for explicit provider %s",
    async (provider) => {
      mock = new MockAgent();
      mock.disableNetConnect();
      setUpstreamDispatcherForTest(mock);
      const response = await handleRequest(
        {
          protocol: "openai-responses",
          model: "gpt-5.4",
          system: "Generate a short title for this conversation.",
          messages: [
            { role: "user", content: [{ type: "text", text: "title me" }] },
          ],
          tools: [],
          stream: false,
          maxTokens: 64,
          metadata: {},
          rawHeaders: {
            authorization: "Bearer provider-token",
            "x-lore-provider": provider,
          },
        },
        loadConfig(),
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toMatch(
        /Unsupported provider|requires an explicit upstream URL/,
      );
    },
  );

  it.each(["api-key-token", ""])(
    "rejects conflicting auth mechanisms before routing (api key %s)",
    async (apiKey) => {
      const response = await handleRequest(
        {
          protocol: "openai-responses",
          model: "gpt-5.4",
          system: "Generate a title.",
          messages: [
            { role: "user", content: [{ type: "text", text: "title me" }] },
          ],
          tools: [],
          stream: false,
          maxTokens: 64,
          metadata: {},
          rawHeaders: {
            authorization: "Bearer bearer-token",
            "x-api-key": apiKey,
            "x-lore-upstream-url": "https://attacker.example",
          },
        },
        loadConfig(),
      );

      expect(response.status).toBe(400);
      expect(await response.text()).toContain(
        "Conflicting authentication headers",
      );
    },
  );
});
