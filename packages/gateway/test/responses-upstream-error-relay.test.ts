import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSessionTracking, setForceMinLayer } from "@loreai/core";
import type { GatewayRequest, GatewayResponse } from "../src/translate/types";
import { loadConfig } from "../src/config";
import { buildOpenAIResponsesResponse } from "../src/translate/openai-responses";
import {
  getActiveSessions,
  handleRequest,
  resetPipelineState,
  setForegroundErrorBodyTimeoutForTest,
  setUpstreamInterceptor,
} from "../src/pipeline";

function localConfig() {
  const config = loadConfig();
  config.remoteGateway = false;
  config.hostedMode = false;
  return config;
}

function request(): GatewayRequest {
  return {
    protocol: "openai-responses",
    model: "gpt-5.6-terra",
    system: "You are a coding agent.",
    messages: [{ role: "user", content: [{ type: "text", text: "continue" }] }],
    tools: [{ name: "read", description: "Read a file", inputSchema: {} }],
    stream: true,
    maxTokens: 1024,
    metadata: {},
    rawHeaders: {
      authorization: "Bearer test-key",
      "x-lore-session-id": "responses-upstream-error-relay",
      "x-lore-agent": "coder",
      "x-lore-project": process.cwd(),
      "x-lore-provider": "openai",
      "x-lore-upstream-url": "https://api.openai.com/v1",
    },
  };
}

afterEach(async () => {
  setUpstreamInterceptor(undefined);
  await resetPipelineState();
});

function requestWithMessages(
  messages: GatewayRequest["messages"],
): GatewayRequest {
  return { ...request(), stream: false, messages };
}

function requestWithTools(tools: GatewayRequest["tools"]): GatewayRequest {
  return { ...request(), stream: false, tools };
}

function activeSessionID(headerSessionID: string): string {
  const state = [...getActiveSessions().values()].find(
    (candidate) => candidate.headerSessionId === headerSessionID,
  );
  if (!state)
    throw new Error(`active session not found for ${headerSessionID}`);
  return state.sessionID;
}

function successfulResponsesResponse(): Response {
  const response: GatewayResponse = {
    id: "resp_retry_test",
    model: "gpt-5.6-terra",
    content: [{ type: "text", text: "ok" }],
    stopReason: "end_turn",
    usage: { inputTokens: 10, outputTokens: 1 },
  };
  return buildOpenAIResponsesResponse(response, false);
}

describe("Responses upstream error relay", () => {
  it("does not consume an unsent layer transition's provenance boundary", async () => {
    const sessionID = "responses-upstream-error-retry";
    const reasoning = {
      type: "opaque" as const,
      responsesItem: true,
      raw: {
        type: "reasoning",
        id: "rs_retry_test",
        encrypted_content: "encrypted_retry_test",
        summary: [],
      },
    };
    const messages: GatewayRequest["messages"] = [
      { role: "user", content: [{ type: "text", text: "question" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
        provenanceContent: [reasoning, { type: "text", text: "answer" }],
        provenancePositions: [1],
      },
      { role: "user", content: [{ type: "text", text: "continue" }] },
    ];
    let calls = 0;
    const bodies: unknown[] = [];
    setUpstreamInterceptor(async (body) => {
      bodies.push(body);
      calls++;
      return calls === 2
        ? new Response(JSON.stringify({ error: { message: "retry" } }), {
            status: 502,
            headers: { "content-type": "application/json" },
          })
        : successfulResponsesResponse();
    });

    const first = requestWithMessages([
      { role: "user", content: [{ type: "text", text: "start" }] },
    ]);
    first.rawHeaders["x-lore-session-id"] = sessionID;
    const accepted = await handleRequest(first, localConfig());
    expect(accepted.status).toBe(200);
    await accepted.text();

    const internalSessionID = activeSessionID(sessionID);
    expect(
      loadSessionTracking(internalSessionID)?.lastAcceptedProvenanceLayer,
    ).toBe(0);
    setForceMinLayer(1, internalSessionID);
    const transition = requestWithMessages(messages);
    transition.rawHeaders["x-lore-session-id"] = sessionID;
    const failed = await handleRequest(transition, localConfig());
    expect(failed.status).toBe(502);
    await failed.text();
    expect(
      getActiveSessions().get(internalSessionID)?.lastAcceptedProvenanceLayer,
    ).toBe(0);
    expect(
      loadSessionTracking(internalSessionID)?.lastAcceptedProvenanceLayer,
    ).toBe(0);

    setForceMinLayer(1, internalSessionID);
    const retry = requestWithMessages(messages);
    retry.rawHeaders["x-lore-session-id"] = sessionID;
    const recovered = await handleRequest(retry, localConfig());
    expect(recovered.status).toBe(200);
    await recovered.text();

    expect(JSON.stringify(bodies[1])).not.toContain("encrypted_retry_test");
    expect(JSON.stringify(bodies[2])).not.toContain("encrypted_retry_test");
    expect(
      getActiveSessions().get(internalSessionID)?.lastAcceptedProvenanceLayer,
    ).toBe(1);
    expect(
      loadSessionTracking(internalSessionID)?.lastAcceptedProvenanceLayer,
    ).toBe(1);
  });

  it("does not advance the accepted layer on a transport error", async () => {
    const sessionID = "responses-transport-boundary";
    let calls = 0;
    setUpstreamInterceptor(async () => {
      calls++;
      if (calls === 1) return successfulResponsesResponse();
      throw new TypeError("fetch failed");
    });

    const first = requestWithMessages([
      { role: "user", content: [{ type: "text", text: "start" }] },
    ]);
    first.rawHeaders["x-lore-session-id"] = sessionID;
    const accepted = await handleRequest(first, localConfig());
    expect(accepted.status).toBe(200);
    await accepted.text();

    const internalSessionID = activeSessionID(sessionID);
    expect(
      getActiveSessions().get(internalSessionID)?.lastAcceptedProvenanceLayer,
    ).toBe(0);
    setForceMinLayer(1, internalSessionID);

    const failed = requestWithMessages([
      { role: "user", content: [{ type: "text", text: "retry" }] },
    ]);
    failed.rawHeaders["x-lore-session-id"] = sessionID;
    const response = await handleRequest(failed, localConfig());
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("Gateway request failed");
    expect(
      getActiveSessions().get(internalSessionID)?.lastAcceptedProvenanceLayer,
    ).toBe(0);
    expect(
      loadSessionTracking(internalSessionID)?.lastAcceptedProvenanceLayer,
    ).toBe(0);
  });

  it("returns a gateway failure before committing a stream on transport errors", async () => {
    setUpstreamInterceptor(async () => {
      throw new TypeError("fetch failed");
    });

    const response = await handleRequest(request(), localConfig());

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("Gateway request failed");
  });

  it("does not advance the accepted layer on synthetic resolution", async () => {
    const sessionID = "responses-synthetic-boundary";
    const config = localConfig();
    config.remoteGateway = true;
    config.callerUpstreamAllowlist = ["https://api.openai.com"];
    let calls = 0;
    setUpstreamInterceptor(async () => {
      calls++;
      return successfulResponsesResponse();
    });

    const first = requestWithTools([
      { name: "write", description: "Write a file", inputSchema: {} },
    ]);
    first.rawHeaders["x-lore-session-id"] = sessionID;
    first.rawHeaders["x-lore-project"] = "";
    const accepted = await handleRequest(first, config);
    expect(accepted.status).toBe(200);
    await accepted.text();

    const internalSessionID = activeSessionID(sessionID);
    expect(
      getActiveSessions().get(internalSessionID)?.lastAcceptedProvenanceLayer,
    ).toBe(0);
    setForceMinLayer(1, internalSessionID);

    const synthetic = requestWithTools([
      { name: "read", description: "Read a file", inputSchema: {} },
    ]);
    synthetic.rawHeaders["x-lore-session-id"] = sessionID;
    synthetic.rawHeaders["x-lore-project"] = "";
    const response = await handleRequest(synthetic, config);
    expect(response.status).toBe(200);
    await response.text();

    expect(calls).toBe(1);
    expect(
      getActiveSessions().get(internalSessionID)?.lastAcceptedProvenanceLayer,
    ).toBe(0);
    expect(
      loadSessionTracking(internalSessionID)?.lastAcceptedProvenanceLayer,
    ).toBe(0);
  });

  it("does not replay provenance across a restart before an accepted layer transition", async () => {
    const sessionID = "responses-restart-boundary";
    const reasoning = {
      type: "opaque" as const,
      responsesItem: true,
      raw: {
        type: "reasoning",
        id: "rs_restart_test",
        encrypted_content: "encrypted_restart_test",
        summary: [],
      },
    };
    const messages: GatewayRequest["messages"] = [
      { role: "user", content: [{ type: "text", text: "question" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
        provenanceContent: [reasoning, { type: "text", text: "answer" }],
        provenancePositions: [1],
      },
      { role: "user", content: [{ type: "text", text: "continue" }] },
    ];
    const bodies: unknown[] = [];
    setUpstreamInterceptor(async (body) => {
      bodies.push(body);
      return successfulResponsesResponse();
    });

    const first = requestWithMessages(messages);
    first.rawHeaders["x-lore-session-id"] = sessionID;
    const accepted = await handleRequest(first, localConfig());
    expect(accepted.status).toBe(200);
    await accepted.text();

    const internalSessionID = activeSessionID(sessionID);
    expect(
      loadSessionTracking(internalSessionID)?.lastAcceptedProvenanceLayer,
    ).toBe(0);

    await resetPipelineState();
    setUpstreamInterceptor(async (body) => {
      bodies.push(body);
      return successfulResponsesResponse();
    });
    setForceMinLayer(1, internalSessionID);

    const resumed = requestWithMessages(messages);
    resumed.rawHeaders["x-lore-session-id"] = sessionID;
    const response = await handleRequest(resumed, localConfig());
    expect(response.status).toBe(200);
    await response.text();

    expect(JSON.stringify(bodies[1])).not.toContain("encrypted_restart_test");
    expect(
      loadSessionTracking(internalSessionID)?.lastAcceptedProvenanceLayer,
    ).toBe(1);
    expect(
      getActiveSessions().get(internalSessionID)?.lastAcceptedProvenanceLayer,
    ).toBe(1);
  });

  it("preserves a rate-limit response status and retry delay before streaming", async () => {
    setUpstreamInterceptor(
      async () =>
        new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "17",
            "retry-after-ms": "1200",
          },
        }),
    );

    const response = await handleRequest(request(), localConfig());

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
    expect(response.headers.get("retry-after-ms")).toBe("1200");
    expect(await response.text()).toContain("Gateway request failed");
  });

  it("sanitizes HTTP-date retry delays and strips upstream status details", async () => {
    const now = 1_700_000_000_000;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      setUpstreamInterceptor(
        async () =>
          new Response("provider diagnostic: token=secret", {
            status: 503,
            statusText: "provider secret status",
            headers: {
              "content-type": "text/plain",
              "retry-after": new Date(now + 17_000).toUTCString(),
              "retry-after-ms": "999999999",
              "x-provider-diagnostic": "token=secret",
            },
          }),
      );

      const response = await handleRequest(request(), localConfig());

      expect(response.status).toBe(503);
      expect(response.statusText).toBe("");
      expect(response.headers.get("retry-after")).toBe("17");
      expect(response.headers.get("retry-after-ms")).toBe("300000");
      expect(response.headers.get("x-provider-diagnostic")).toBeNull();
      await expect(response.json()).resolves.toEqual({
        type: "error",
        error: { type: "server_error", message: "Gateway request failed" },
      });
    } finally {
      dateNow.mockRestore();
    }
  });

  it("caps far-future HTTP-date retry delays", async () => {
    const now = 1_700_000_000_000;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      setUpstreamInterceptor(
        async () =>
          new Response(null, {
            status: 503,
            headers: {
              "retry-after": new Date(now + 86_400_000).toUTCString(),
            },
          }),
      );

      const response = await handleRequest(request(), localConfig());

      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("300");
    } finally {
      dateNow.mockRestore();
    }
  });

  it("sanitizes error bodies and bounds forwarded retry delays", async () => {
    setUpstreamInterceptor(
      async () =>
        new Response("provider diagnostic: token=secret", {
          status: 503,
          headers: {
            "content-type": "text/plain",
            "retry-after": "999999",
            "retry-after-ms": "not-a-number",
          },
        }),
    );

    const response = await handleRequest(request(), localConfig());

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("300");
    expect(response.headers.get("retry-after-ms")).toBeNull();
    expect(await response.text()).not.toContain("token=secret");
  });

  it("bounds a stalled upstream error body", async () => {
    setForegroundErrorBodyTimeoutForTest(1);
    let cancelled = false;
    setUpstreamInterceptor(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull: () => new Promise<void>(() => {}),
            cancel: () => {
              cancelled = true;
            },
          }),
          { status: 503 },
        ),
    );

    const response = await handleRequest(request(), localConfig());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      type: "error",
      error: { type: "server_error", message: "Gateway request failed" },
    });
    expect(cancelled).toBe(true);
  }, 2_000);
});
