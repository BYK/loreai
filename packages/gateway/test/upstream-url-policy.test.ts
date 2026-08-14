import { afterEach, describe, expect, it } from "vitest";
import { MockAgent } from "undici";
import { loadConfig, parseCallerUpstreamAllowlist } from "../src/config";
import {
  handleRequest,
  passthroughResponsesCompact,
  resetPipelineState,
  restoreUpstreamStateForTest,
  setUpstreamInterceptor,
} from "../src/pipeline";
import { setUpstreamDispatcherForTest } from "../src/fetch";
import type { GatewayRequest } from "../src/translate/types";

function request(upstreamUrl: string): GatewayRequest {
  return {
    protocol: "openai-responses",
    model: "gpt-5.4",
    system: "Generate a short title for this conversation.",
    messages: [
      { role: "user", content: [{ type: "text", text: "private body" }] },
    ],
    tools: [],
    stream: false,
    maxTokens: 64,
    metadata: {},
    rawHeaders: {
      authorization: "Bearer client-secret",
      "x-lore-upstream-url": upstreamUrl,
      // Unknown headers must never be able to downgrade server-side policy.
      "x-lore-hosted-mode": "0",
      "x-lore-remote-gateway": "0",
    },
  };
}

const BLOCKED_DESTINATIONS = [
  "http://127.0.0.1:8080",
  "http://10.23.45.67:8080",
  "http://169.254.169.254/latest/meta-data",
  "http://[::1]:8080",
  "https://192.168.10.20",
  "https://[::ffff:127.0.0.1]",
  "https://[::1",
] as const;

describe("caller-selected upstream policy", () => {
  let mock: MockAgent | undefined;

  afterEach(async () => {
    setUpstreamInterceptor(undefined);
    setUpstreamDispatcherForTest(null);
    await mock?.close();
    mock = undefined;
    await resetPipelineState({ fast: true });
  });

  it.each([
    { mode: "remote", remoteGateway: true, hostedMode: false },
    { mode: "hosted", remoteGateway: false, hostedMode: true },
  ])(
    "rejects loopback, private, link-local, IPv6, and malformed URLs in $mode mode before forwarding",
    async ({ remoteGateway, hostedMode }) => {
      let forwardCount = 0;
      const forwarded = { body: "" };
      setUpstreamInterceptor(async (body) => {
        forwardCount++;
        forwarded.body = JSON.stringify(body);
        return new Response(
          JSON.stringify({
            id: "resp_ssrf",
            object: "response",
            status: "completed",
            model: "gpt-5.4",
            output: [],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });
      const config = loadConfig();
      config.remoteGateway = remoteGateway;
      config.hostedMode = hostedMode;

      for (const destination of BLOCKED_DESTINATIONS) {
        const response = await handleRequest(request(destination), config);
        expect(response.status, destination).toBe(400);
      }

      expect(forwardCount).toBe(0);
      expect(forwarded.body).not.toContain("private body");
      expect(forwarded.body).not.toContain("client-secret");
    },
  );

  it("allows an explicitly allowlisted HTTPS origin in remote mode", async () => {
    mock = new MockAgent();
    mock.disableNetConnect();
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = "";
    mock
      .get("https://allowed.example:8443")
      .intercept({ path: "/tenant/v1/responses", method: "POST" })
      .reply((opts) => {
        capturedHeaders = opts.headers as Record<string, string>;
        capturedBody =
          typeof opts.body === "string"
            ? opts.body
            : (JSON.stringify(opts.body) ?? "");
        return {
          statusCode: 200,
          data: JSON.stringify({
            id: "resp_allowed",
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
    config.remoteGateway = true;
    config.callerUpstreamAllowlist = ["https://allowed.example:8443"];

    const response = await handleRequest(
      request("https://allowed.example:8443/tenant"),
      config,
    );

    expect(response.status).toBe(200);
    expect(capturedHeaders.authorization ?? capturedHeaders.Authorization).toBe(
      "Bearer client-secret",
    );
    expect(capturedBody).toContain("private body");
  });

  it("matches allowlisted origins exactly", async () => {
    let forwardCount = 0;
    setUpstreamInterceptor(async () => {
      forwardCount++;
      return new Response("unreachable", { status: 200 });
    });
    const config = loadConfig();
    config.remoteGateway = true;
    config.callerUpstreamAllowlist = ["https://allowed.example"];

    for (const destination of [
      "https://sub.allowed.example",
      "https://allowed.example:8443",
      "http://allowed.example",
    ]) {
      const response = await handleRequest(request(destination), config);
      expect(response.status, destination).toBe(400);
    }
    expect(forwardCount).toBe(0);
  });

  it("never permits HTTP in remote mode through a manually constructed config", async () => {
    let forwardCount = 0;
    setUpstreamInterceptor(async () => {
      forwardCount++;
      return new Response("unreachable", { status: 200 });
    });
    const config = loadConfig();
    config.remoteGateway = true;
    config.callerUpstreamAllowlist = ["http://127.0.0.1:8080"];

    const response = await handleRequest(
      request("http://127.0.0.1:8080"),
      config,
    );

    expect(response.status).toBe(400);
    expect(forwardCount).toBe(0);
  });

  it("allows an administrator-configured private upstream in remote mode", async () => {
    mock = new MockAgent();
    mock.disableNetConnect();
    let capturedAuthorization = "";
    mock
      .get("http://10.23.45.67:8080")
      .intercept({ path: "/v1/responses", method: "POST" })
      .reply((opts) => {
        const headers = opts.headers as Record<string, string>;
        capturedAuthorization =
          headers.authorization ?? headers.Authorization ?? "";
        return {
          statusCode: 200,
          data: JSON.stringify({
            id: "resp_configured",
            object: "response",
            status: "completed",
            model: "custom-model",
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
    config.remoteGateway = true;
    config.upstreamOpenAI = "http://10.23.45.67:8080";
    const req = request("https://unused.example");
    req.model = "custom-model";
    delete req.rawHeaders["x-lore-upstream-url"];

    const response = await handleRequest(req, config);

    expect(response.status).toBe(200);
    expect(capturedAuthorization).toBe("Bearer client-secret");
  });

  it("preserves caller-selected private upstreams for local gateways", async () => {
    mock = new MockAgent();
    mock.disableNetConnect();
    let forwarded = false;
    mock
      .get("http://192.168.10.20:11434")
      .intercept({ path: "/v1/responses", method: "POST" })
      .reply(() => {
        forwarded = true;
        return {
          statusCode: 200,
          data: JSON.stringify({
            id: "resp_local",
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

    const response = await handleRequest(
      request("http://192.168.10.20:11434"),
      config,
    );

    expect(response.status).toBe(200);
    expect(forwarded).toBe(true);
  });

  it("rejects compact fallback routing before forwarding credentials or body", async () => {
    mock = new MockAgent();
    mock.disableNetConnect();
    let forwardCount = 0;
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = "";
    mock
      .get("http://127.0.0.1:8080")
      .intercept({ path: "/v1/responses/compact", method: "POST" })
      .reply((opts) => {
        forwardCount++;
        capturedHeaders = opts.headers as Record<string, string>;
        capturedBody =
          typeof opts.body === "string"
            ? opts.body
            : (JSON.stringify(opts.body) ?? "");
        return { statusCode: 200, data: JSON.stringify({ output: [] }) };
      });
    setUpstreamDispatcherForTest(mock);
    const config = loadConfig();
    config.remoteGateway = true;

    const response = await passthroughResponsesCompact(
      '{"private":"compact body"}',
      {
        authorization: "Bearer compact-secret",
        "x-lore-upstream-url": "http://127.0.0.1:8080",
      },
      config,
    );

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("not allowed");
    expect(forwardCount).toBe(0);
    expect(capturedHeaders.authorization).toBeUndefined();
    expect(capturedBody).not.toContain("compact body");
  });
});

describe("parseCallerUpstreamAllowlist", () => {
  it("normalizes comma-separated HTTPS origins", () => {
    expect(
      parseCallerUpstreamAllowlist(
        " HTTPS://Allowed.Example:443/ , https://api.example:8443 ",
      ),
    ).toEqual(["https://allowed.example", "https://api.example:8443"]);
  });

  it.each([
    "http://allowed.example",
    "https://user:pass@allowed.example",
    "https://allowed.example/path",
    "https://allowed.example/%2e",
    "https://*.allowed.example",
    "https://allowed.example?tenant=a",
    "https://allowed.example#fragment",
    "https://allowed.example:",
    "https://allowed.example,",
    "not-an-origin",
  ])("rejects invalid entry %s", (entry) => {
    expect(() => parseCallerUpstreamAllowlist(entry)).toThrow(
      /expected a unique HTTPS origin/,
    );
  });

  it("rejects duplicate origins after normalization", () => {
    expect(() =>
      parseCallerUpstreamAllowlist(
        "https://allowed.example,HTTPS://ALLOWED.EXAMPLE:443/",
      ),
    ).toThrow(/duplicate normalized origin/);
  });

  it("loads the explicit allowlist and defaults to deny-all", () => {
    const saved = process.env.LORE_CALLER_UPSTREAM_ALLOWLIST;
    try {
      delete process.env.LORE_CALLER_UPSTREAM_ALLOWLIST;
      expect(loadConfig().callerUpstreamAllowlist).toEqual([]);
      process.env.LORE_CALLER_UPSTREAM_ALLOWLIST =
        "https://one.example,https://two.example:8443";
      expect(loadConfig().callerUpstreamAllowlist).toEqual([
        "https://one.example",
        "https://two.example:8443",
      ]);
    } finally {
      if (saved === undefined) {
        delete process.env.LORE_CALLER_UPSTREAM_ALLOWLIST;
      } else {
        process.env.LORE_CALLER_UPSTREAM_ALLOWLIST = saved;
      }
    }
  });
});

describe("persisted caller-selected upstream policy", () => {
  function persistedState(url: string, callerSelected?: boolean): string {
    const snapshot = {
      url,
      ...(callerSelected === undefined ? {} : { callerSelected }),
      protocol: "anthropic",
      providerID: "anthropic",
      model: "claude-test",
      headers: {},
    };
    return JSON.stringify({
      version: 2,
      lastUpstream: snapshot,
      upstreamByProvider: { anthropic: snapshot },
    });
  }

  it.each([
    { name: "legacy", callerSelected: undefined },
    { name: "caller-selected", callerSelected: true },
  ])(
    "drops a $name arbitrary snapshot before remote workers can reuse it",
    ({ callerSelected }) => {
      const config = loadConfig();
      config.remoteGateway = true;
      config.hostedMode = false;
      config.callerUpstreamAllowlist = [];

      const restored = restoreUpstreamStateForTest(
        persistedState(
          "http://169.254.169.254/latest/meta-data",
          callerSelected,
        ),
        config,
      );

      expect(restored.lastUpstream).toBeUndefined();
      expect(restored.upstreamByProvider.size).toBe(0);
    },
  );

  it("retains administrator-selected and currently allowlisted snapshots", () => {
    const config = loadConfig();
    config.remoteGateway = true;
    config.hostedMode = false;
    config.callerUpstreamAllowlist = ["https://allowed.example"];

    const configured = restoreUpstreamStateForTest(
      persistedState("http://10.23.45.67:8080", false),
      config,
    );
    const allowlisted = restoreUpstreamStateForTest(
      persistedState("https://allowed.example/tenant", true),
      config,
    );

    expect(configured.lastUpstream?.url).toBe("http://10.23.45.67:8080");
    expect(allowlisted.lastUpstream?.url).toBe(
      "https://allowed.example/tenant",
    );
  });
});
