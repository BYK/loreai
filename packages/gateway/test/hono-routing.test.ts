/**
 * Regression coverage for the Hono-routed gateway (INFRA-01).
 *
 * The router change must not move the security boundary: management
 * authorization runs as middleware before every route (static UI, health,
 * unknown paths), the old string matcher's path semantics are preserved
 * (no decoding, no slash collapsing, case-sensitive, exact trailing slashes,
 * declared methods only), and LLM streaming still propagates a client abort
 * to the upstream.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { request as httpRequest } from "node:http";
import { loadConfig, type GatewayConfig } from "../src/config";
import { startServer } from "../src/server";
import { resetPipelineState } from "../src/pipeline";
import { upstreamFetch } from "../src/fetch";

vi.mock("../src/fetch", () => ({ upstreamFetch: vi.fn() }));

const mockedFetch = vi.mocked(upstreamFetch);

type ServerHandle = Awaited<ReturnType<typeof startServer>>;

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    ...loadConfig(),
    port: 0,
    hosts: ["127.0.0.1"],
    debug: false,
    remoteGateway: false,
    hostedMode: false,
    allowRemoteManagement: false,
    ...overrides,
  };
}

interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * node:http sends `path` verbatim, so the server sees exactly this target —
 * `fetch`/`URL` would normalize `..`, `//` and percent-encoding first.
 */
function rawRequest(
  port: number,
  method: string,
  target: string,
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, method, path: target, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const parsed: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) {
            if (value === undefined) continue;
            parsed[key] = Array.isArray(value) ? value.join(", ") : value;
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: parsed,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const HIDDEN = {
  status: 404,
  body: "",
  connection: "close",
};

function expectHidden(response: RawResponse): void {
  expect(response.status).toBe(HIDDEN.status);
  expect(response.body).toBe(HIDDEN.body);
  expect(response.headers.connection).toBe(HIDDEN.connection);
  expect(response.headers["content-type"]).toBeUndefined();
  expect(response.headers["access-control-allow-origin"]).toBeUndefined();
}

function expectJsonNotFound(
  response: RawResponse,
  method: string,
  path: string,
) {
  expect(response.status).toBe(404);
  expect(response.headers["content-type"]).toBe("application/json");
  // node:http never sends a HEAD body; the JSON content-type proves the
  // router's 404 (not a route handler) answered.
  if (method === "HEAD") return;
  expect(JSON.parse(response.body)).toEqual({
    type: "error",
    error: { type: "not_found", message: `No route for ${method} ${path}` },
  });
}

describe("management middleware runs before every route", () => {
  let loopback: ServerHandle;
  let remotePeer: ServerHandle;

  beforeAll(async () => {
    loopback = await startServer(makeConfig());
    remotePeer = await startServer(makeConfig(), {
      peerAddressForRequest: () => "192.0.2.10",
    });
  });

  afterAll(async () => {
    await Promise.all([loopback.stop(), remotePeer.stop()]);
  });

  const MANAGEMENT_TARGETS: Array<[string, string]> = [
    ["GET", "/"],
    ["HEAD", "/"],
    ["GET", "/ui"],
    ["HEAD", "/ui"],
    ["GET", "/ui/"],
    ["GET", "/ui/assets/does-not-exist.js"],
    ["GET", "/ui/index.html"],
    ["GET", "/api"],
    ["GET", "/api/"],
    ["GET", "/api/v1/projects"],
    ["POST", "/api/v1/projects"],
    ["DELETE", "/api/v1/knowledge/x"],
    ["GET", "/api/v1/does-not-exist"],
    ["PUT", "/api/v1/projects"],
    ["GET", "/api/v1/projects?x=1"],
    ["OPTIONS", "/api/v1/projects"],
    ["OPTIONS", "/ui"],
    ["PATCH", "/ui"],
  ];

  test.each(MANAGEMENT_TARGETS)(
    "%s %s from a non-loopback peer is the bodyless 404 + Connection: close",
    async (method, target) => {
      expectHidden(await rawRequest(remotePeer.port, method, target));
    },
  );

  test.each(MANAGEMENT_TARGETS)(
    "%s %s with an untrusted Origin is hidden even from loopback",
    async (method, target) => {
      expectHidden(
        await rawRequest(loopback.port, method, target, {
          Origin: "https://evil.example",
        }),
      );
    },
  );

  test("a WebSocket upgrade on a management path is hidden before the 426", async () => {
    expectHidden(
      await rawRequest(remotePeer.port, "GET", "/api/v1/projects", {
        Upgrade: "websocket",
      }),
    );
  });

  test("loopback unknown management paths get the JSON 404 with anti-framing headers", async () => {
    for (const [method, target] of [
      ["GET", "/api"],
      ["GET", "/api/v1/does-not-exist"],
      ["POST", "/"],
    ] as const) {
      const response = await rawRequest(loopback.port, method, target);
      expect(response.status).toBe(404);
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.headers["content-security-policy"]).toBe(
        "frame-ancestors 'none'",
      );
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    }
  });

  test("bare /api is not routed to the API dispatcher", async () => {
    expectJsonNotFound(
      await rawRequest(loopback.port, "GET", "/api"),
      "GET",
      "/api",
    );
  });

  test("non-management routes are not gated by the peer check", async () => {
    const health = await rawRequest(remotePeer.port, "GET", "/health");
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body).status).toBe("ok");
    expect(health.headers["x-frame-options"]).toBeUndefined();

    const unknown = await rawRequest(remotePeer.port, "GET", "/nope");
    expectJsonNotFound(unknown, "GET", "/nope");
    expect(unknown.headers["x-frame-options"]).toBeUndefined();
  });

  test("data-plane browser origins are denied before routing", async () => {
    const response = await rawRequest(loopback.port, "POST", "/v1/messages", {
      Origin: "http://127.0.0.1",
    });
    expect(response.status).toBe(403);
    expect(response.body).toBe("");
    expect(response.headers.connection).toBe("close");
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});

describe("path matching preserves the pre-Hono semantics", () => {
  let server: ServerHandle;

  beforeAll(async () => {
    server = await startServer(makeConfig());
  });

  afterAll(async () => {
    await server.stop();
  });

  afterEach(() => {
    mockedFetch.mockReset();
  });

  test.each([
    ["GET", "/health/"],
    ["GET", "/Health"],
    ["GET", "/HEALTH"],
    ["GET", "//health"],
    ["GET", "/%68ealth"],
    ["GET", "/health%2F"],
    ["HEAD", "/health"],
    ["POST", "/health"],
    ["POST", "/v1/messages/"],
    ["POST", "/V1/messages"],
    ["POST", "//v1/messages"],
    ["POST", "/v1//messages"],
    ["POST", "/v1%2Fmessages"],
    ["GET", "/v1/messages"],
    ["HEAD", "/v1/models"],
    ["POST", "/v1/models"],
    ["GET", "/v1/models/"],
    ["HEAD", "/"],
    ["GET", "/_lore/control/"],
    ["DELETE", "/_lore/control"],
  ])("%s %s is the JSON 404", async (method, target) => {
    const response = await rawRequest(server.port, method, target);
    expectJsonNotFound(response, method, target);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  test("`..` segments are normalized before classification, as before", async () => {
    // node:http hands the raw target to `new URL()`, which resolves dot
    // segments; the old matcher and Hono therefore both see `/health`.
    const response = await rawRequest(server.port, "GET", "/api/../health");
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).status).toBe("ok");
    expect(response.headers["x-frame-options"]).toBeUndefined();
  });

  test("encoded and doubled slashes do not reach management handlers", async () => {
    for (const target of [
      "/api%2Fv1/projects",
      "//api/v1/projects",
      "/API/v1/projects",
      "//ui",
      "/UI",
    ]) {
      const response = await rawRequest(server.port, "GET", target);
      expectJsonNotFound(response, "GET", target);
      expect(response.headers["x-frame-options"]).toBeUndefined();
    }
  });

  test("/ui/ and nested UI paths still reach the UI handler", async () => {
    for (const target of ["/ui", "/ui/", "/ui/memory"]) {
      const response = await rawRequest(server.port, "GET", target);
      // 503 when the UI bundle is absent (source checkout without a build).
      expect([200, 404, 503]).toContain(response.status);
      // The UI handler (not the router 404) answered: it sets its own CSP.
      expect(response.headers["content-security-policy"]).not.toBe(
        "frame-ancestors 'none'",
      );
      expect(response.headers["content-security-policy"]).toContain(
        "frame-ancestors 'none'",
      );
    }
  });

  test("the query string does not affect route matching", async () => {
    const response = await rawRequest(server.port, "GET", "/health?x=/api");
    expect(response.status).toBe(200);
  });

  test("OPTIONS without Origin is a bare 204 on every route class", async () => {
    for (const target of [
      "/v1/messages",
      "/health",
      "/nope",
      "/api/v1/projects",
      "/ui",
    ]) {
      const response = await rawRequest(server.port, "OPTIONS", target);
      expect(response.status).toBe(204);
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    }
  });
});

describe("LLM proxy streaming through the router", () => {
  afterEach(async () => {
    mockedFetch.mockReset();
    await resetPipelineState({ fast: true });
  });

  test("client disconnect mid-stream aborts and cancels the upstream body", async () => {
    let upstreamSignal: AbortSignal | undefined;
    let upstreamCancelled = false;
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
    const encoder = new TextEncoder();
    mockedFetch.mockImplementation(async (_url, init) => {
      upstreamSignal = init?.signal ?? undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controllerRef = controller;
            controller.enqueue(
              encoder.encode(
                'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-test","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
              ),
            );
          },
          pull() {
            return new Promise(() => {});
          },
          cancel() {
            upstreamCancelled = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });

    const server = await startServer(makeConfig());
    try {
      const body = JSON.stringify({
        model: "claude-test",
        max_tokens: 16,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      });
      const firstChunk = await new Promise<{
        status: number;
        headers: Record<string, string | string[] | undefined>;
        chunk: string;
        destroy: () => void;
      }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: server.port,
            method: "POST",
            path: "/v1/messages",
            headers: {
              "content-type": "application/json",
              "x-api-key": "sk-ant-test",
              "anthropic-version": "2023-06-01",
              "content-length": Buffer.byteLength(body),
            },
          },
          (res) => {
            res.once("data", (chunk: Buffer) => {
              resolve({
                status: res.statusCode ?? 0,
                headers: res.headers,
                chunk: chunk.toString("utf8"),
                destroy: () => res.destroy(),
              });
            });
            res.once("error", reject);
          },
        );
        req.on("error", reject);
        req.end(body);
      });

      expect(firstChunk.status).toBe(200);
      expect(firstChunk.headers["content-type"]).toContain("text/event-stream");
      expect(firstChunk.headers["access-control-allow-origin"]).toBeUndefined();
      expect(firstChunk.chunk).toContain("message_start");
      expect(controllerRef).toBeDefined();

      firstChunk.destroy();

      await vi.waitFor(() => {
        expect(upstreamSignal?.aborted).toBe(true);
        expect(upstreamCancelled).toBe(true);
      });
    } finally {
      await server.stop();
    }
  });
});
