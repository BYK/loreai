import { log } from "@loreai/core";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import {
  getActiveSessions,
  handleRequest,
  resetPipelineState,
  setUpstreamInterceptor,
} from "../src/pipeline";
import type { GatewayRequest } from "../src/translate/types";
import { _setModelDataForTest } from "../src/worker-model";

const silentSink = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  captureException: vi.fn(),
};

afterEach(async () => {
  setUpstreamInterceptor(undefined);
  log.registerSink(silentSink);
  await resetPipelineState({ fast: true });
});

describe("routing log credential redaction", () => {
  it("records only the auth scheme, never credential bytes", async () => {
    const credential = "routing-secret-prefix-and-suffix";
    const messages: string[] = [];
    log.registerSink({
      info: (message) => messages.push(message),
      warn: vi.fn(),
      error: vi.fn(),
      captureException: vi.fn(),
    });
    setUpstreamInterceptor(
      async () =>
        new Response(
          JSON.stringify({
            id: "resp_routing_log",
            object: "response",
            status: "completed",
            model: "gpt-5.4",
            output: [],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const request: GatewayRequest = {
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
      rawHeaders: { authorization: `Bearer ${credential}` },
    };

    const response = await handleRequest(request, loadConfig());

    expect(response.status).toBe(200);
    const routingMessage = messages.find((message) =>
      message.startsWith("upstream:"),
    );
    expect(routingMessage).toContain("scheme=bearer");
    expect(routingMessage).not.toContain(credential);
    expect(routingMessage).not.toContain(credential.slice(0, 8));
  });

  it("strips userinfo, query values, and fragments from routing URLs", async () => {
    const messages: string[] = [];
    log.registerSink({
      info: (message) => messages.push(message),
      warn: vi.fn(),
      error: vi.fn(),
      captureException: vi.fn(),
    });
    setUpstreamInterceptor(
      async () =>
        new Response(
          JSON.stringify({
            id: "msg_route_url",
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
    config.upstreamAnthropic =
      "https://user:LOCAL_LOG_SECRET@example.com/custom?code=QUERY_LOG_SECRET#FRAGMENT_SECRET";
    const response = await handleRequest(
      {
        protocol: "anthropic",
        model: "unrouted-model",
        system: "You are a coding assistant.",
        messages: [
          { role: "user", content: [{ type: "text", text: "hello" }] },
        ],
        tools: [],
        stream: false,
        maxTokens: 64,
        metadata: {},
        rawHeaders: {
          "x-lore-agent": "coder",
          "x-lore-project": process.cwd(),
        },
      },
      config,
    );

    expect(response.status).toBe(200);
    const output = messages.join("\n");
    expect(output).toContain("https://example.com/custom");
    expect(output).not.toContain("LOCAL_LOG_SECRET");
    expect(output).not.toContain("QUERY_LOG_SECRET");
    expect(output).not.toContain("FRAGMENT_SECRET");
  });

  it("never logs an upstream response body", async () => {
    const privateBodyMarker = "PRIVATE_UPSTREAM_RESPONSE_BODY_MARKER";
    const messages: string[] = [];
    log.registerSink({
      info: (message) => messages.push(message),
      warn: (message) => messages.push(message),
      error: (message) => messages.push(message),
      captureException: vi.fn(),
    });
    setUpstreamInterceptor(
      async () =>
        new Response(
          JSON.stringify({ error: { message: privateBodyMarker } }),
          { status: 500, headers: { "content-type": "application/json" } },
        ),
    );
    const request: GatewayRequest = {
      protocol: "anthropic",
      model: "claude-test",
      system: "You are a coding assistant.",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: [],
      stream: false,
      maxTokens: 64,
      metadata: {},
      rawHeaders: { "x-lore-agent": "coder" },
    };

    const response = await handleRequest(request, loadConfig());

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(privateBodyMarker);
    expect(messages.join("\n")).not.toContain(privateBodyMarker);
  });

  it("never logs malformed successful upstream text or statusText", async () => {
    const privateBodyMarker = "PRIVATE_MALFORMED_FOREGROUND_BODY_MARKER";
    const messages: string[] = [];
    log.registerSink({
      info: (message) => messages.push(message),
      warn: (message) => messages.push(message),
      error: (message) => messages.push(message),
      captureException: vi.fn(),
    });
    setUpstreamInterceptor(
      async () =>
        new Response(`${privateBodyMarker} not-json`, {
          status: 200,
          statusText: "PRIVATE_FOREGROUND_REASON_MARKER",
          headers: { "content-type": "application/json" },
        }),
    );
    const request: GatewayRequest = {
      protocol: "anthropic",
      model: "claude-test",
      system: "You are a coding assistant.",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: [],
      stream: false,
      maxTokens: 64,
      metadata: {},
      rawHeaders: { "x-lore-agent": "coder" },
    };

    const response = await handleRequest(request, loadConfig());

    expect(response.status).toBe(502);
    const output = messages.join("\n");
    expect(output).toContain("pipeline request failed");
    expect(output).not.toContain(privateBodyMarker);
    expect(output).not.toContain("PRIVATE_FOREGROUND_REASON_MARKER");
  });

  it.each([
    {
      exposed: false,
      expected: "pipeline request failed: malformed OpenAI stream event",
    },
    {
      exposed: true,
      expected:
        "pipeline request failed: malformed OpenAI stream event (rule=invalid-json)",
    },
  ])(
    "logs only the categorical OpenAI validation rule unless opted out",
    async ({ exposed, expected }) => {
      const messages: string[] = [];
      log.registerSink({
        info: vi.fn(),
        warn: vi.fn(),
        error: (message) => messages.push(message),
        captureException: vi.fn(),
      });
      setUpstreamInterceptor(
        async () =>
          new Response("data: {not-json}\n\n", {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      );
      const config = loadConfig();
      config.exposeProviderDiagnostics = exposed;

      const response = await handleRequest(
        {
          protocol: "openai",
          model: "gpt-test",
          system: "You are a coding assistant.",
          messages: [
            { role: "user", content: [{ type: "text", text: "hello" }] },
          ],
          tools: [],
          stream: true,
          maxTokens: 64,
          metadata: {},
          rawHeaders: { "x-lore-agent": "coder" },
        },
        config,
      );

      expect(response.status).toBe(502);
      expect(messages).toContain(expected);
      expect(messages.join("\n")).not.toContain("not-json");
    },
  );

  it("does not classify interceptor exceptions as upstream transport failures", async () => {
    const credential = "PRIVATE_GATEWAY_CREDENTIAL_MARKER";
    const privateCauseMessage = "PRIVATE_TRANSPORT_MESSAGE_MARKER";
    const messages: string[] = [];
    log.registerSink({
      info: vi.fn(),
      warn: vi.fn(),
      error: (message) => messages.push(message),
      captureException: vi.fn(),
    });
    setUpstreamInterceptor(async () => {
      const connectionReset = Object.assign(new Error(privateCauseMessage), {
        code: "ECONNRESET",
      });
      const socketError = Object.assign(new Error(privateCauseMessage), {
        code: "UND_ERR_SOCKET",
        errno: -104,
        syscall: "connect",
        hostname: "PRIVATE_TRANSPORT_HOSTNAME_MARKER",
        cause: connectionReset,
      });
      throw new TypeError("fetch failed", { cause: socketError });
    });

    const response = await handleRequest(
      {
        protocol: "openai",
        model: "gemini-3.8-flash",
        system: "You are a coding assistant.",
        messages: [
          { role: "user", content: [{ type: "text", text: "hello" }] },
        ],
        tools: [],
        stream: false,
        maxTokens: 64,
        metadata: {},
        rawHeaders: {
          "x-lore-agent": "coder",
          "x-lore-provider": "github-copilot",
          authorization: `Bearer ${credential}`,
        },
      },
      loadConfig(),
    );

    expect(response.status).toBe(502);
    expect(messages).toContain("pipeline request failed: fetch failed");
    expect(
      messages.some((message) => message.startsWith("upstream fetch failed")),
    ).toBe(false);
    expect(messages.join("\n")).not.toContain(credential);
    expect(messages.join("\n")).not.toContain(privateCauseMessage);
    expect(messages.join("\n")).not.toContain(
      "PRIVATE_TRANSPORT_HOSTNAME_MARKER",
    );
  });

  it("logs safe route metadata for an upstream 400 without its response body", async () => {
    const credential = "PRIVATE_400_CREDENTIAL_MARKER";
    const privateBodyMarker = "PRIVATE_400_RESPONSE_MESSAGE_MARKER";
    const messages: string[] = [];
    log.registerSink({
      info: (message) => messages.push(message),
      warn: (message) => messages.push(message),
      error: (message) => messages.push(message),
      captureException: vi.fn(),
    });
    setUpstreamInterceptor(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 400,
              status: "INVALID_ARGUMENT",
              message: privateBodyMarker,
            },
          }),
          {
            status: 400,
            headers: {
              "content-type": "application/json",
              "x-github-request-id": "GHREQ-1234567890",
            },
          },
        ),
    );

    const response = await handleRequest(
      {
        protocol: "openai",
        model: "gemini-3.8-flash",
        system: "You are a coding assistant.",
        messages: [
          { role: "user", content: [{ type: "text", text: "hello" }] },
        ],
        tools: [],
        stream: false,
        maxTokens: 64,
        metadata: {},
        rawHeaders: {
          "x-lore-agent": "coder",
          "x-lore-provider": "github-copilot",
          authorization: `Bearer ${credential}`,
        },
      },
      loadConfig(),
    );

    expect(response.status).toBe(400);
    const diagnostic = messages.find((message) =>
      message.startsWith("upstream error: 400"),
    );
    expect(diagnostic).toContain("provider=github-copilot");
    expect(diagnostic).toContain("model=gemini-3.8-flash");
    expect(diagnostic).toContain("protocol=openai");
    expect(diagnostic).toContain("host=api.githubcopilot.com");
    expect(diagnostic).toContain("category=INVALID_ARGUMENT");
    expect(diagnostic).toContain("requestId=GHREQ-1234567890");
    expect(diagnostic).toMatch(/bodyBytes=\d+ inputItems=\d+ tools=\d+/);
    expect(diagnostic).toContain("inputItems=2");
    expect(diagnostic).not.toContain("instructionsBytes=");
    expect(diagnostic).not.toContain("/chat/completions");
    expect(messages.join("\n")).not.toContain(privateBodyMarker);
    expect(messages.join("\n")).not.toContain(credential);
    expect(await response.text()).not.toContain(privateBodyMarker);
  });

  it("logs a Responses meta 400 without exposing the provider body", async () => {
    const privateMarker = "PRIVATE_META_400_RESPONSE_MARKER";
    const messages: string[] = [];
    log.registerSink({
      info: (message) => messages.push(message),
      warn: (message) => messages.push(message),
      error: (message) => messages.push(message),
      captureException: vi.fn(),
    });
    setUpstreamInterceptor(
      async () =>
        new Response(JSON.stringify({ detail: privateMarker }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );
    const response = await handleRequest(
      {
        protocol: "openai-responses",
        model: "gpt-5.6-luna",
        system: "Generate a short title.",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "PRIVATE_META_PROMPT" }],
          },
        ],
        tools: [],
        stream: false,
        maxTokens: 64,
        metadata: {},
        rawHeaders: {},
      },
      loadConfig(),
    );

    expect(response.status).toBe(400);
    const diagnostic = messages.find((message) =>
      message.startsWith("upstream error: 400"),
    );
    expect(diagnostic).toContain("protocol=openai-responses");
    expect(diagnostic).toContain("inputItems=1");
    expect(diagnostic).toMatch(/bodyBytes=\d+/);
    expect(messages.join("\n")).not.toContain(privateMarker);
    expect(messages.join("\n")).not.toContain("PRIVATE_META_PROMPT");
    expect(await response.text()).toContain(privateMarker);
  });

  it("captures the exact rejected conversation request only after an explicit session match", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lore-400-turn-"));
    const path = join(directory, "rejected.json");
    const previousPath = process.env.LORE_UPSTREAM_400_CAPTURE_PATH;
    const previousSession = process.env.LORE_UPSTREAM_400_CAPTURE_SESSION;
    const marker = "PRIVATE_REJECTED_REQUEST_MARKER";
    const logged: string[] = [];
    let upstreamBody: unknown;
    try {
      process.env.LORE_UPSTREAM_400_CAPTURE_PATH = path;
      log.registerSink({
        info: (message) => logged.push(message),
        warn: (message) => logged.push(message),
        error: (message) => logged.push(message),
        captureException: vi.fn(),
      });
      let reject = false;
      setUpstreamInterceptor(async (body) => {
        upstreamBody = body;
        return reject
          ? new Response('{"detail":"Bad Request"}', { status: 400 })
          : new Response(
              JSON.stringify({
                id: "resp_capture_setup",
                object: "response",
                status: "completed",
                model: "gpt-5.6-luna",
                output: [],
                usage: { input_tokens: 1, output_tokens: 1 },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
      });
      const request: GatewayRequest = {
        protocol: "openai-responses",
        model: "gpt-5.6-luna",
        system: "You are a coding assistant.",
        messages: [{ role: "user", content: [{ type: "text", text: marker }] }],
        tools: [],
        stream: false,
        maxTokens: 64,
        metadata: {},
        rawHeaders: {
          "x-lore-agent": "coder",
          "x-lore-project": process.cwd(),
          "x-session-affinity": "capture-test-session",
          authorization: "Bearer placeholder",
        },
      };
      const config = loadConfig();
      const setup = await handleRequest(request, config);
      expect(setup.status).toBe(200);
      await setup.text();
      const sessionID = [...getActiveSessions().values()][0]?.sessionID;
      expect(sessionID).toBeTruthy();
      process.env.LORE_UPSTREAM_400_CAPTURE_SESSION = sessionID;
      reject = true;
      const response = await handleRequest(request, config);

      expect(response.status).toBe(400);
      expect(upstreamBody).toBeDefined();
      expect(readFileSync(path, "utf8")).toBe(JSON.stringify(upstreamBody));
      expect(logged.join("\n")).not.toContain(marker);
      expect(logged.join("\n")).toContain("captured locally");
    } finally {
      if (previousPath === undefined)
        delete process.env.LORE_UPSTREAM_400_CAPTURE_PATH;
      else process.env.LORE_UPSTREAM_400_CAPTURE_PATH = previousPath;
      if (previousSession === undefined)
        delete process.env.LORE_UPSTREAM_400_CAPTURE_SESSION;
      else process.env.LORE_UPSTREAM_400_CAPTURE_SESSION = previousSession;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("sanitizes the configured worker initialization URL", async () => {
    const userinfoMarker = "PRIVATE_WORKER_INIT_USERINFO";
    const queryMarker = "PRIVATE_WORKER_INIT_QUERY";
    const fragmentMarker = "PRIVATE_WORKER_INIT_FRAGMENT";
    const messages: string[] = [];
    log.registerSink({
      info: (message) => messages.push(message),
      warn: (message) => messages.push(message),
      error: (message) => messages.push(message),
      captureException: vi.fn(),
    });
    const config = loadConfig();
    config.workerUpstream =
      `https://user:${userinfoMarker}@worker.example/custom` +
      `?token=${queryMarker}#${fragmentMarker}`;

    await resetPipelineState({ fast: true });
    _setModelDataForTest({});
    let intercepted = false;
    setUpstreamInterceptor(async () => {
      intercepted = true;
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const response = await handleRequest(
      {
        protocol: "anthropic",
        model: "claude-test",
        system: "You are a coding assistant.",
        messages: [
          { role: "user", content: [{ type: "text", text: "hello" }] },
        ],
        tools: [],
        stream: false,
        maxTokens: 64,
        metadata: {},
        rawHeaders: {
          "x-lore-agent": "coder",
          "x-lore-project": process.cwd(),
        },
      },
      config,
    );

    expect(response.status).toBe(200);
    expect(intercepted).toBe(true);
    const output = messages.join("\n");
    expect(output).toContain("worker routing:");
    expect(output).toContain("source=session");
    expect(output).toContain("https://worker.example/custom");
    expect(output).not.toContain(userinfoMarker);
    expect(output).not.toContain(queryMarker);
    expect(output).not.toContain(fragmentMarker);
  });
});
