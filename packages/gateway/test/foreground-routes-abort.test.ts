import { afterEach, describe, expect, test, vi } from "vitest";
import { loadConfig } from "../src/config";
import {
  getActiveSessions,
  handleCompactEndpoint,
  handleRequest,
  handleResponsesCompactEndpoint,
  passthroughResponsesCompact,
  resetPipelineState,
  setUpstreamInterceptor,
} from "../src/pipeline";
import type { GatewayRequest } from "../src/translate/types";
import { handleModelsPassthrough } from "../src/server";
import { upstreamFetch } from "../src/fetch";

vi.mock("../src/fetch", () => ({ upstreamFetch: vi.fn() }));

const mockedFetch = vi.mocked(upstreamFetch);
const config = loadConfig();

function fetchUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function modelsRequest(signal?: AbortSignal): Request {
  return new Request("http://gateway.test/v1/models", { signal });
}

function successfulResponsesResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "resp_session_setup",
      object: "response",
      created_at: 0,
      model: "unrouted-model",
      status: "completed",
      output: [
        {
          type: "message",
          id: "msg_session_setup",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "ok", annotations: [] }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

async function establishSession(
  sessionID: string,
  upstreamUrl?: string,
): Promise<void> {
  setUpstreamInterceptor(async () => successfulResponsesResponse());
  const request: GatewayRequest = {
    protocol: "openai-responses",
    model: "unrouted-model",
    system: "You are a coding agent. ".repeat(30),
    messages: [
      { role: "user", content: [{ type: "text", text: "one" }] },
      { role: "assistant", content: [{ type: "text", text: "two" }] },
      { role: "user", content: [{ type: "text", text: "three" }] },
    ],
    tools: [
      { name: "read", description: "read", inputSchema: {} },
      { name: "write", description: "write", inputSchema: {} },
      { name: "edit", description: "edit", inputSchema: {} },
    ],
    stream: false,
    maxTokens: 1024,
    metadata: {},
    rawHeaders: {
      authorization: "Bearer test-key",
      "x-lore-session-id": sessionID,
      "x-lore-project": "/tmp",
      "x-lore-no-store": "true",
      ...(upstreamUrl ? { "x-lore-upstream-url": upstreamUrl } : {}),
    },
  };
  await (await handleRequest(request, config)).text();
  setUpstreamInterceptor(undefined);
}

const ROUTES = [
  {
    name: "POST /v1/responses/compact fallback",
    target: "/v1/responses/compact",
    invoke: (signal?: AbortSignal) =>
      passthroughResponsesCompact(
        JSON.stringify({ model: "gpt-test", input: [] }),
        { authorization: "Bearer test-key" },
        config,
        signal,
      ),
  },
  {
    name: "GET /v1/models",
    target: "/v1/models",
    invoke: (signal?: AbortSignal) =>
      handleModelsPassthrough(modelsRequest(signal), config),
  },
] as const;

afterEach(async () => {
  vi.useRealTimers();
  mockedFetch.mockReset();
  setUpstreamInterceptor(undefined);
  await resetPipelineState({ fast: true });
});

describe("foreground passthrough route aborts", () => {
  test.each(["compact", "responses-compact"] as const)(
    "applies the foreground deadline to a stalled %s upload",
    async (route) => {
      const sessionID = `stalled-${route}`;
      await establishSession(sessionID);
      vi.useFakeTimers();
      const source = new ReadableStream<Uint8Array>({
        type: "bytes",
        pull() {
          return new Promise(() => {});
        },
      });
      const request = new Request(`http://gateway.test/v1/${route}`, {
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
          "content-type": "application/json",
          "x-lore-session-id": sessionID,
          "x-lore-project": "/tmp",
        },
        body: source,
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      const pending =
        route === "compact"
          ? handleCompactEndpoint(request, config)
          : handleResponsesCompactEndpoint(request, config);

      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(300_000);
      const response = await pending;
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain("timed out");
    },
  );

  test("routes Responses compaction credentials only to the explicit upstream", async () => {
    mockedFetch.mockResolvedValue(new Response("{}"));
    const response = await passthroughResponsesCompact(
      JSON.stringify({ model: "custom-model", input: [] }),
      {
        authorization: "Bearer custom-provider-key",
        "x-lore-provider": "custom-provider",
        "x-lore-upstream-url": "https://custom.example.test/v1",
      },
      config,
    );
    await response.text();

    expect(fetchUrl(mockedFetch.mock.calls[0]?.[0])).toBe(
      "https://custom.example.test/v1/responses/compact",
    );
    expect(mockedFetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer custom-provider-key",
    });
  });

  test("does not forward credentials for an unresolved explicit provider", async () => {
    const response = await passthroughResponsesCompact(
      JSON.stringify({ model: "custom-model", input: [] }),
      {
        authorization: "Bearer custom-provider-key",
        "x-lore-provider": "custom-provider",
      },
      config,
    );

    expect(response.status).toBe(502);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  test("pins Responses compaction to the captured session route", async () => {
    const sessionID = "route-less-compact-session";
    await establishSession(sessionID);
    const state = [...getActiveSessions().values()].find(
      (candidate) => candidate.headerSessionId === sessionID,
    );
    const trustedRoute = state?.lastUpstream;
    expect(trustedRoute?.url).toBe("https://api.openai.com");
    let attackerCalled = false;
    let trustedCalled = false;
    mockedFetch.mockImplementation((url) => {
      const target = fetchUrl(url);
      if (target.startsWith("https://attacker.example.test")) {
        attackerCalled = true;
      }
      if (target === "https://api.openai.com/v1/responses/compact") {
        trustedCalled = true;
      }
      return Promise.resolve(new Response("{}"));
    });

    const response = await handleResponsesCompactEndpoint(
      new Request("http://gateway.test/v1/responses/compact", {
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
          "content-type": "application/json",
          "x-lore-session-id": sessionID,
          "x-lore-project": "/tmp",
          "x-lore-upstream-url": "https://attacker.example.test/v1",
        },
        body: JSON.stringify({
          model: "unrouted-model",
          instructions: "You are a coding agent.",
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: "compact" }],
            },
          ],
          tools: [],
        }),
      }),
      config,
    );

    expect(response.status).toBe(200);
    await response.text();
    expect(attackerCalled).toBe(false);
    expect(trustedCalled).toBe(true);
    expect(state?.lastUpstream).toBe(trustedRoute);
  });

  test("pins structural compaction fallback to the session route", async () => {
    const sessionID = "trusted-structural-route-session";
    await establishSession(sessionID, "https://trusted.example.test/v1");
    let attackerCalled = false;
    let trustedCalled = false;
    mockedFetch.mockImplementation((url) => {
      const target = fetchUrl(url);
      attackerCalled ||= target.startsWith("https://attacker.example.test");
      trustedCalled ||= target.startsWith("https://trusted.example.test");
      return Promise.resolve(successfulResponsesResponse());
    });
    const request: GatewayRequest = {
      protocol: "openai-responses",
      model: "unrouted-model",
      system: "You are an anchored context summarization assistant.",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Create an anchored summary from the conversation history above.",
            },
          ],
        },
      ],
      tools: [],
      stream: false,
      maxTokens: 1024,
      metadata: {},
      rawHeaders: {
        authorization: "Bearer test-key",
        "x-lore-session-id": sessionID,
        "x-lore-project": "/tmp",
        "x-lore-upstream-url": "https://attacker.example.test/v1",
      },
    };

    const response = await handleRequest(request, config);
    expect(response.status).toBe(200);
    await response.text();
    expect(trustedCalled).toBe(true);
    expect(attackerCalled).toBe(false);
  });

  test.each(ROUTES)(
    "caller abort settles $name when fetch ignores signal",
    async ({ invoke, target }) => {
      mockedFetch.mockImplementation((url) =>
        fetchUrl(url).endsWith(target)
          ? new Promise(() => {})
          : Promise.resolve(new Response("{}")),
      );
      const caller = new AbortController();
      const pending = invoke(caller.signal);
      await Promise.resolve();
      caller.abort(new DOMException("caller aborted", "AbortError"));
      const response = await pending;
      expect(response.status).toBe(502);
      const init = mockedFetch.mock.calls.find(([url]) =>
        fetchUrl(url).endsWith(target),
      )?.[1];
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal?.aborted).toBe(true);
    },
  );

  test.each(ROUTES)(
    "300s deadline settles $name when fetch ignores signal",
    async ({ invoke, target }) => {
      vi.useFakeTimers();
      mockedFetch.mockImplementation((url) =>
        fetchUrl(url).endsWith(target)
          ? new Promise(() => {})
          : Promise.resolve(new Response("{}")),
      );
      const pending = invoke();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(300_000);
      const response = await pending;
      expect(response.status).toBe(502);
      expect(
        mockedFetch.mock.calls.find(([url]) =>
          fetchUrl(url).endsWith(target),
        )?.[1]?.signal?.aborted,
      ).toBe(true);
    },
  );

  test.each(ROUTES)(
    "preserves $name response metadata and aborts a hostile body",
    async ({ invoke, target }) => {
      let cancelled = false;
      const upstream = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial"));
          },
          pull() {
            return new Promise(() => {});
          },
          cancel() {
            cancelled = true;
            return new Promise<void>(() => {});
          },
        }),
        {
          status: 207,
          statusText: "Multi-Status",
          headers: { "x-upstream": "kept" },
        },
      );
      mockedFetch.mockImplementation((url) =>
        fetchUrl(url).endsWith(target)
          ? Promise.resolve(upstream)
          : Promise.resolve(new Response("{}")),
      );
      const caller = new AbortController();
      const response = await invoke(caller.signal);
      expect(response.status).toBe(207);
      expect(response.statusText).toBe("Multi-Status");
      expect(response.headers.get("x-upstream")).toBe("kept");
      const pending = response.text();
      await new Promise((resolve) => setImmediate(resolve));
      caller.abort(new DOMException("caller aborted", "AbortError"));
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(cancelled).toBe(true);
      expect(upstream.body?.locked).toBe(false);
    },
  );
});
