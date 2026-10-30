import { afterEach, expect, test, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { installFetchInterceptor } from "../src/fetch-interceptor";
import { encodeContextBoundary } from "../src/context-boundary";
import { digestChain } from "../src/chain-digest";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  vi.unstubAllGlobals();
});

test("request-selected destinations own routing, observation, access headers and boundary caches", async () => {
  const a = "https://gateway-a.example";
  const b = "https://gateway-b.example";
  const prefix = [{ role: "user", content: "prefix" }];
  const suffix = { role: "user", content: "suffix" };
  const boundary = encodeContextBoundary({
    v: 1,
    protocol: "anthropic",
    inputItems: 1,
    inputDigest: digestChain(prefix),
    retainedItems: 0,
    sourceMessages: 1,
    sourceDigest: digestChain([]),
  });
  const calls: Request[] = [];
  const observed: Array<string | undefined> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init));
      return new Response("ok", {
        headers: { "x-lore-context-boundary": boundary },
      });
    }),
  );
  cleanup = installFetchInterceptor({
    gatewayBase: a,
    resolveGateway: (_url, headers) => headers.get("test-gateway"),
    getHeaders: (_headers, gateway) => ({
      "x-lore-session-id": "same-session",
      "x-lore-gateway-token": gateway === a ? "token-a" : "token-b",
    }),
    onRequestHeaders: (_headers, gateway) => observed.push(gateway),
  });
  const send = async (
    gateway: string,
    messages: unknown[],
    request = false,
  ) => {
    const init = {
      method: "POST",
      headers: { "test-gateway": gateway },
      body: JSON.stringify({ model: "model", messages }),
    };
    const response = request
      ? await fetch(new Request("https://api.anthropic.com/v1/messages", init))
      : await fetch(new URL("https://api.anthropic.com/v1/messages"), init);
    await response.text();
  };
  await send(a, prefix);
  await send(b, [...prefix, suffix], true);
  await send(a, [...prefix, suffix]);
  expect(calls.map((request) => request.url)).toEqual([
    `${a}/v1/messages`,
    `${b}/v1/messages`,
    `${a}/v1/messages`,
  ]);
  expect(
    calls.map((request) => request.headers.get("x-lore-gateway-token")),
  ).toEqual(["token-a", "token-b", "token-a"]);
  expect(observed).toEqual([a, b, a]);
  expect(calls[0].headers.get("x-lore-context-boundary")).toBeNull();
  expect(calls[1].headers.get("x-lore-context-boundary")).toBeNull();
  expect(calls[2].headers.get("x-lore-context-boundary")).toBe(boundary);
});

test("ambiguous ownership preserves unrelated authenticated fetch redirect behavior", async () => {
  const calls: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init));
      return Response.json({});
    }),
  );
  cleanup = installFetchInterceptor({
    gatewayBase: "https://gateway.example",
    resolveGateway: () => null,
    getHeaders: () => ({}),
  });
  await fetch("https://api.github.com/user", {
    headers: { authorization: "Bearer github-token" },
  });
  await fetch(
    new Request("https://api.github.com/user", {
      headers: { authorization: "Bearer github-token" },
      redirect: "follow",
    }),
  );
  expect(calls.map((request) => request.redirect)).toEqual([
    "follow",
    "follow",
  ]);
});

test.each([
  { path: "/llm/messages", stream: false },
  { path: "/llm/messages", stream: true },
  { path: "/v2/chat/completions", stream: false },
  { path: "/v2/chat/completions", stream: true },
])(
  "ambiguous ownership protects $path redirects with stream=$stream",
  async ({ path, stream }) => {
    const leaked: Array<string | undefined> = [];
    const target = createServer((request, response) => {
      leaked.push(request.headers["x-api-key"] as string | undefined);
      request.resume();
      response.end("redirected");
    });
    const source = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(307, {
          location: `http://127.0.0.1:${(target.address() as AddressInfo).port}/capture`,
        });
        response.end("redirect");
      });
    });
    const listen = async (server: ReturnType<typeof createServer>) => {
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      return (server.address() as AddressInfo).port;
    };
    await listen(target);
    const port = await listen(source);
    cleanup = installFetchInterceptor({
      gatewayBase: "https://gateway.example",
      resolveGateway: () => null,
      getHeaders: () => ({}),
    });
    try {
      const body = JSON.stringify({
        model: "model",
        messages: [{ role: "user", content: "memory" }],
      });
      const init: RequestInit & { duplex: "half" } = {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "private-provider-key",
        },
        body: stream
          ? new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(body));
                controller.close();
              },
            })
          : body,
        duplex: "half",
      };
      const url = `http://127.0.0.1:${port}${path}`;
      const response = stream
        ? await fetch(url, init)
        : await fetch(new Request(url, init));
      await response.text();
      expect({ status: response.status, leaked }).toEqual({
        status: 307,
        leaked: [],
      });
    } finally {
      for (const server of [source, target]) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
  },
);

test.each(["/health", "/v1/compact"])(
  "unresolved credentialed gateway %s protects remaining provider credentials",
  async (path) => {
    const calls: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(new Request(input, init));
        return Response.json({});
      }),
    );
    cleanup = installFetchInterceptor({
      gatewayBase: "https://gateway.example",
      resolveGateway: () => null,
      getHeaders: () => ({}),
    });
    const input = new Request(`https://unremembered-gateway.example${path}`, {
      headers: {
        "x-lore-gateway-token": "gateway-secret",
        "x-api-key": "provider-secret",
      },
    });
    await fetch(input);
    expect(calls[0].redirect).toBe("manual");
    expect(calls[0].headers.get("x-lore-gateway-token")).toBeNull();
    expect(calls[0].headers.get("x-api-key")).toBe("provider-secret");
    expect(input.headers.get("x-lore-gateway-token")).toBe("gateway-secret");
  },
);
