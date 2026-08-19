import { afterEach, describe, expect, it } from "vitest";
import { MockAgent } from "undici";
import { loadConfig } from "../src/config";
import {
  handleResponsesCompactEndpoint,
  resetPipelineState,
} from "../src/pipeline";
import { setUpstreamDispatcherForTest } from "../src/fetch";

describe("Responses compact fallback routing", () => {
  let mock: MockAgent | undefined;

  afterEach(async () => {
    setUpstreamDispatcherForTest(null);
    await mock?.close();
    mock = undefined;
    await resetPipelineState({ fast: true });
  });

  it("routes provider-selected compact fallback to the provider endpoint", async () => {
    mock = new MockAgent();
    mock.disableNetConnect();
    let receivedAuthorization = "";
    mock
      .get("https://chatgpt.com")
      .intercept({
        path: "/backend-api/codex/responses/compact",
        method: "POST",
      })
      .reply((opts) => {
        const headers = opts.headers as Record<string, string>;
        receivedAuthorization = headers.authorization ?? "";
        return {
          statusCode: 200,
          data: JSON.stringify({ output: [] }),
          responseOptions: {
            headers: { "content-type": "application/json" },
          },
        };
      });
    setUpstreamDispatcherForTest(mock);

    const response = await handleResponsesCompactEndpoint(
      new Request("http://gateway.test/v1/responses/compact", {
        method: "POST",
        headers: {
          authorization: "Bearer codex-session-token",
          "content-type": "application/json",
          "x-lore-provider": "openai-codex",
          "x-lore-project": "/tmp/lore-compact-provider-routing",
        },
        body: JSON.stringify({
          model: "gpt-5.4",
          input: [{ type: "message", role: "user", content: "compact" }],
        }),
      }),
      loadConfig(),
    );

    expect(response.status).toBe(200);
    expect(receivedAuthorization).toBe("Bearer codex-session-token");
  });

  it("honors a safe custom compact endpoint without leaking admin extras", async () => {
    mock = new MockAgent();
    mock.disableNetConnect();
    let capturedHeaders: Record<string, string> = {};
    mock
      .get("https://compact.corp.example")
      .intercept({ path: "/custom/responses/compact", method: "POST" })
      .reply((opts) => {
        capturedHeaders = opts.headers as Record<string, string>;
        return {
          statusCode: 200,
          data: JSON.stringify({ output: [] }),
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

    const response = await handleResponsesCompactEndpoint(
      new Request("http://gateway.test/v1/responses/compact", {
        method: "POST",
        headers: {
          authorization: "Bearer client-token",
          "content-type": "application/json",
          "x-lore-provider": "openai",
          "x-lore-upstream-url": "https://compact.corp.example/custom",
          "x-lore-upstream-path": "/custom/responses/compact",
          "x-lore-project": "/tmp/lore-compact-custom-routing",
        },
        body: JSON.stringify({
          model: "gpt-5.4",
          input: [{ type: "message", role: "user", content: "compact" }],
        }),
      }),
      config,
    );

    expect(response.status).toBe(200);
    expect(capturedHeaders.authorization).toBe("Bearer client-token");
    expect(capturedHeaders["x-corp-secret"]).toBeUndefined();
  });

  it("fails closed when a compact request has a provider with no endpoint", async () => {
    const response = await handleResponsesCompactEndpoint(
      new Request("http://gateway.test/v1/responses/compact", {
        method: "POST",
        headers: {
          authorization: "Bearer provider-token",
          "content-type": "application/json",
          "x-lore-provider": "vllm",
        },
        body: JSON.stringify({
          model: "custom-model",
          input: [{ type: "message", role: "user", content: "compact" }],
        }),
      }),
      loadConfig(),
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: "compaction_routing_failed",
    });
  });

  it("rejects conflicting auth before reading or routing compact input", async () => {
    const response = await handleResponsesCompactEndpoint(
      new Request("http://gateway.test/v1/responses/compact", {
        method: "POST",
        headers: {
          authorization: "Bearer bearer-token",
          "x-api-key": "api-key-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-5.4", input: [] }),
      }),
      loadConfig(),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain(
      "Conflicting authentication headers",
    );
  });
});
