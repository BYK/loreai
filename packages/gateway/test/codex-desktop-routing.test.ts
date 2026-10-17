import { afterEach, expect, test } from "vitest";
import { Headers as UndiciHeaders, MockAgent } from "undici";
import { createHarness, type Harness } from "./helpers/harness";
import { setUpstreamDispatcherForTest } from "../src/fetch";
import { setUpstreamInterceptor } from "../src/pipeline";

let harness: Harness | undefined;
let mock: MockAgent | undefined;
afterEach(async () => {
  await harness?.teardown();
  harness = undefined;
  setUpstreamInterceptor(undefined);
  setUpstreamDispatcherForTest(null);
  await mock?.close();
  mock = undefined;
});

const cases: Array<{
  name: string;
  headers: Record<string, string>;
  codex: boolean;
}> = [
  {
    name: "ChatGPT sign-in",
    headers: { "chatgpt-account-id": "fake-account" },
    codex: true,
  },
  {
    name: "explicit ChatGPT provider",
    headers: {
      "x-lore-provider": "openai-codex",
      "chatgpt-account-id": "fake-account",
    },
    codex: true,
  },
  {
    name: "ChatGPT sign-in with an unrelated Copilot hint",
    headers: {
      "chatgpt-account-id": "fake-account",
      "copilot-integration-id": "vscode-chat",
    },
    codex: true,
  },
  {
    name: "ChatGPT with an empty provider header",
    headers: { "chatgpt-account-id": "fake-account", "x-lore-provider": "" },
    codex: true,
  },
  {
    name: "ChatGPT with an empty upstream header",
    headers: {
      "chatgpt-account-id": "fake-account",
      "x-lore-upstream-url": "",
    },
    codex: true,
  },
  { name: "API key", headers: {}, codex: false },
  {
    name: "explicit API provider",
    headers: {
      "x-lore-provider": "openai",
      "chatgpt-account-id": "fake-account",
    },
    codex: false,
  },
  {
    name: "explicit custom upstream",
    headers: {
      "x-lore-upstream-url": "https://proxy.example/v1",
      "chatgpt-account-id": "fake-account",
    },
    codex: false,
  },
];
test.each(cases)(
  "routes $name without changing explicit destinations",
  async ({ headers, codex }) => {
    mock = new MockAgent();
    mock.disableNetConnect();
    setUpstreamDispatcherForTest(mock);
    harness = await createHarness({
      fixtures: [],
      configOverrides: { hostedMode: false, remoteGateway: false },
    });
    setUpstreamInterceptor((_body, _model, _stream, makeReal) => makeReal());
    const custom = Boolean(headers["x-lore-upstream-url"]);
    const origin = custom
      ? "https://proxy.example"
      : codex
        ? "https://chatgpt.com"
        : "https://api.openai.com";
    const path = codex ? "/backend-api/codex/responses" : "/v1/responses";
    let upstream: Record<string, unknown> | undefined;
    let upstreamHeaders: Record<string, string> | undefined;
    mock
      .get(origin)
      .intercept({ method: "POST", path })
      .reply((opts) => {
        if (typeof opts.body !== "string")
          throw new Error("Expected JSON request body");
        upstream = JSON.parse(opts.body);
        upstreamHeaders = Object.fromEntries(new UndiciHeaders(opts.headers));
        return {
          statusCode: 200,
          data: [
            {
              type: "response.created",
              response: {
                id: "resp_fake",
                model: "gpt-test",
                status: "in_progress",
                output: [],
              },
            },
            {
              type: "response.completed",
              response: {
                id: "resp_fake",
                model: "gpt-test",
                status: "completed",
                output: [],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            },
          ]
            .map(
              (event) =>
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            )
            .join(""),
          responseOptions: { headers: { "content-type": "text/event-stream" } },
        };
      });
    const response = await harness.request("/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer fake-client-token",
        "x-lore-project": "/private/tmp/codex-routing",
        "x-lore-no-store": "true",
        ...headers,
      },
      body: JSON.stringify({
        model: "gpt-test",
        stream: true,
        input: [{ role: "user", content: "hello" }],
        max_output_tokens: 42,
        include: ["reasoning.encrypted_content"],
        prompt_cache_key: "fake-cache-key",
        service_tier: "auto",
      }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(mock.pendingInterceptors()).toEqual([]);
    expect(upstreamHeaders?.authorization).toBe("Bearer fake-client-token");
    if (codex) {
      expect(upstreamHeaders?.["chatgpt-account-id"]).toBe("fake-account");
      expect(upstream).toMatchObject({
        store: false,
        stream: true,
        include: ["reasoning.encrypted_content"],
        prompt_cache_key: "fake-cache-key",
        service_tier: "auto",
      });
      expect(upstream).not.toHaveProperty("max_output_tokens");
    } else {
      expect(upstream?.max_output_tokens).toBe(42);
    }
  },
);
