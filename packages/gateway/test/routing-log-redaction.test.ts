import { log } from "@loreai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import {
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

  it("logs a fixed transport failure without exposing upstream content", async () => {
    const messages: string[] = [];
    log.registerSink({
      info: vi.fn(),
      warn: vi.fn(),
      error: (message) => messages.push(message),
      captureException: vi.fn(),
    });
    setUpstreamInterceptor(async () => {
      throw new TypeError("fetch failed");
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
        rawHeaders: { "x-lore-agent": "coder" },
      },
      loadConfig(),
    );

    expect(response.status).toBe(502);
    expect(messages).toContain("pipeline request failed: fetch failed");
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
