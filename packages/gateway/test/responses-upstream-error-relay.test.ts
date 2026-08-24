import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequest } from "../src/translate/types";
import { loadConfig } from "../src/config";
import {
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

describe("Responses upstream error relay", () => {
  it("returns a gateway failure before committing a stream on transport errors", async () => {
    setUpstreamInterceptor(async () => {
      throw new TypeError("fetch failed");
    });

    const response = await handleRequest(request(), localConfig());

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("Gateway request failed");
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
