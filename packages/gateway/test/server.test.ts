/**
 * Route-level tests for `src/server.ts`.
 *
 * Starts a real gateway server (via `startServer`) on a random port and
 * exercises the pre-pipeline routes + error paths that the replay
 * integration tests (replay.test.ts) don't reach: OPTIONS, health,
 * 404, invalid-JSON 400 on each protocol endpoint, the /v1/models passthrough
 * 502 path (unreachable upstream), the `/` redirect, and the empty-hosts
 * defensive default.
 *
 * The upstream is pointed at a refused port so /v1/models fails fast (502)
 * without real network access; the other routes never reach the pipeline.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { connect } from "node:net";
import {
  createServer as createHttpServer,
  request as httpRequest,
} from "node:http";
import { Readable } from "node:stream";
import { brotliCompressSync, gzipSync, zstdCompressSync } from "node:zlib";
import { startServer } from "../src/server";
import { loadConfig } from "../src/config";
import type { GatewayConfig } from "../src/config";
import { MAX_HTTP_REQUEST_DECOMPRESSED_BYTES } from "../src/http-body";
import {
  loopbackRequest,
  type LoopbackRequestInit,
} from "./helpers/loopback-request";

type ServerHandle = Awaited<ReturnType<typeof startServer>>;

function fetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input);
  const headers = new Headers(init.headers);
  let body: Buffer | undefined;
  if (typeof init.body === "string") {
    body = Buffer.from(init.body);
  } else if (init.body instanceof ArrayBuffer) {
    body = Buffer.from(init.body);
  } else if (ArrayBuffer.isView(init.body)) {
    body = Buffer.from(
      init.body.buffer,
      init.body.byteOffset,
      init.body.byteLength,
    );
  } else if (init.body !== undefined && init.body !== null) {
    throw new TypeError("server test loopback fetch received unsupported body");
  }
  if (body && !headers.has("content-length")) {
    headers.set("content-length", String(body.byteLength));
  }

  return new Promise<Response>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? "GET",
        headers: Object.fromEntries(headers),
      },
      (incoming) => {
        const responseHeaders = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          responseHeaders.append(
            incoming.rawHeaders[index],
            incoming.rawHeaders[index + 1],
          );
        }
        const status = incoming.statusCode ?? 500;
        const noBody =
          init.method === "HEAD" ||
          status === 204 ||
          status === 205 ||
          status === 304;
        if (noBody) incoming.resume();
        resolve(
          new Response(
            noBody
              ? null
              : (Readable.toWeb(
                  incoming,
                ) as unknown as ReadableStream<Uint8Array>),
            {
              status,
              statusText: incoming.statusMessage,
              headers: responseHeaders,
            },
          ),
        );
      },
    );
    request.once("error", reject);
    if (init.signal) {
      const abort = () => request.destroy();
      init.signal.addEventListener("abort", abort, { once: true });
      request.once("close", () =>
        init.signal?.removeEventListener("abort", abort),
      );
    }
    request.end(body);
  });
}

function makeConfig(overrides?: Partial<GatewayConfig>): GatewayConfig {
  return {
    ...loadConfig(),
    port: 0,
    hosts: ["127.0.0.1"],
    debug: false,
    remoteGateway: false,
    hostedMode: false,
    // Refused port → upstreamFetch fails fast so /v1/models returns 502.
    upstreamAnthropic: "http://127.0.0.1:9",
    ...overrides,
  };
}

let server: ServerHandle;

function localRequest(
  port: number,
  path: string,
  init: LoopbackRequestInit = {},
  hostname = "127.0.0.1",
): Promise<Response> {
  const host = hostname.includes(":") ? `[${hostname}]` : hostname;
  return loopbackRequest(`http://${host}:${port}${path}`, init);
}

beforeAll(async () => {
  server = await startServer(makeConfig());
});

afterAll(async () => {
  await server.stop();
});

describe("server routing", () => {
  test("owner control identity is unavailable without a configured token", async () => {
    const res = await localRequest(server.port, "/_lore/control", {
      headers: { authorization: "Bearer attacker" },
    });
    expect(res.status).toBe(404);
  });

  test("owner control identity requires the exact configured token", async () => {
    const token = "test-control-token".repeat(3);
    const controlled = await startServer(makeConfig(), { controlToken: token });
    try {
      const url = `http://127.0.0.1:${controlled.port}/_lore/control`;
      expect((await fetch(url)).status).toBe(404);
      expect(
        (
          await fetch(url, {
            headers: { authorization: "Bearer wrong-token" },
          })
        ).status,
      ).toBe(404);
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        status: "ok",
        service: "lore",
        pid: process.pid,
      });
      expect(
        (
          await fetch(url, {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
          })
        ).status,
      ).toBe(404);
    } finally {
      await controlled.stop();
    }
  });

  test("authenticated POST flushes its response before shutdown closes the listener", async () => {
    const token = "shutdown-control-token".repeat(3);
    let controlled: ServerHandle;
    let callbackCount = 0;
    let markShutdownComplete!: () => void;
    const shutdownComplete = new Promise<void>((resolve) => {
      markShutdownComplete = resolve;
    });
    controlled = await startServer(makeConfig(), {
      controlToken: token,
      onShutdown: async () => {
        callbackCount += 1;
        await controlled.stop();
        markShutdownComplete();
      },
    });
    const response = await fetch(
      `http://127.0.0.1:${controlled.port}/_lore/control`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      service: "lore",
      pid: process.pid,
      shutdown: "requested",
    });
    await shutdownComplete;
    expect(callbackCount).toBe(1);
  });

  test("unauthorized POST is an indistinguishable 404 and does not invoke shutdown", async () => {
    const token = "shutdown-control-token".repeat(3);
    let callbackCount = 0;
    const controlled = await startServer(makeConfig(), {
      controlToken: token,
      onShutdown: () => {
        callbackCount += 1;
      },
    });
    try {
      const response = await fetch(
        `http://127.0.0.1:${controlled.port}/_lore/control`,
        {
          method: "POST",
          headers: { authorization: "Bearer wrong-token" },
        },
      );
      expect(response.status).toBe(404);
      await response.arrayBuffer();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(callbackCount).toBe(0);
    } finally {
      await controlled.stop();
    }
  });

  test("destroying a client socket aborts a pending upstream fetch", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    let markClosed!: () => void;
    const closed = new Promise<void>((resolve) => (markClosed = resolve));
    const upstream = createHttpServer((req) => {
      markStarted();
      req.once("close", markClosed);
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("no address");
    const gateway = await startServer(
      makeConfig({ upstreamAnthropic: `http://127.0.0.1:${address.port}` }),
    );
    const socket = connect(gateway.port, "127.0.0.1", () => {
      socket.write(
        `GET /v1/models HTTP/1.1\r\nHost: 127.0.0.1:${gateway.port}\r\n\r\n`,
      );
    });
    try {
      await started;
      socket.destroy();
      await Promise.race([
        closed,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("upstream fetch stayed open")),
            2000,
          ),
        ),
      ]);
    } finally {
      socket.destroy();
      await gateway.stop();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  test("destroying a client socket cancels an open upstream response body", async () => {
    let markClosed!: () => void;
    const closed = new Promise<void>((resolve) => (markClosed = resolve));
    const upstream = createHttpServer((_req, res) => {
      res.once("close", markClosed);
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"partial":');
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("no address");
    const gateway = await startServer(
      makeConfig({ upstreamAnthropic: `http://127.0.0.1:${address.port}` }),
    );
    const socket = connect(gateway.port, "127.0.0.1", () => {
      socket.write(
        `GET /v1/models HTTP/1.1\r\nHost: 127.0.0.1:${gateway.port}\r\n\r\n`,
      );
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("data", () => resolve());
        socket.once("error", reject);
      });
      socket.destroy();
      await Promise.race([
        closed,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("upstream body stayed open")),
            2000,
          ),
        ),
      ]);
    } finally {
      socket.destroy();
      await gateway.stop();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  test("no-Origin OPTIONS remains a 204 without enabling browser CORS", async () => {
    const res = await localRequest(server.port, "/v1/messages", {
      method: "OPTIONS",
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-methods")).toBeNull();
    expect(res.headers.get("access-control-allow-headers")).toBeNull();
  });

  test("GET /health remains public without making it browser-readable cross-origin", async () => {
    const res = await localRequest(server.port, "/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; version: string };
    expect(body.status).toBe("ok");
    expect(typeof body.version).toBe("string");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("unknown route returns a 404 error envelope", async () => {
    const res = await localRequest(server.port, "/definitely-not-a-route");
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      type: string;
      error: { type: string };
    };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("not_found");
  });

  test.each([
    "/v1/messages",
    "/v1/chat/completions",
    "/v1/responses",
    "/v1/codex/responses",
  ])("POST %s with invalid JSON returns 400", async (path) => {
    const res = await localRequest(server.port, path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ this is not valid json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { type: string; message: string };
    };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toBe("Invalid JSON body");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  // A zstd-compressed body (as Codex sends) is decoded first; if the *decoded*
  // text is still not valid JSON, the handler returns the same 400 — proving
  // the decode path runs before JSON parsing (issue #1032).
  test.each([
    "/v1/messages",
    "/v1/chat/completions",
    "/v1/responses",
    "/v1/codex/responses",
  ])("POST %s with a zstd body of invalid JSON returns 400", async (path) => {
    const compressed = zstdCompressSync(Buffer.from("{ not json after all"));
    const res = await localRequest(server.port, path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "zstd",
      },
      body: compressed,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { type: string; message: string };
    };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toBe("Invalid JSON body");
  });

  test("GET /v1/models returns 502 when the upstream is unreachable", async () => {
    const res = await localRequest(server.port, "/v1/models");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("api_error");
  });

  test("POST /v1/responses/compact rejects invalid JSON before routing", async () => {
    const res = await localRequest(server.port, "/v1/responses/compact", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "test-key",
      },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "invalid_request",
    });
  });

  test.each([
    ["/v1/messages", "gzip", 400],
    ["/v1/chat/completions", "br", 400],
    ["/v1/responses", "zstd", 400],
    ["/v1beta/models/gemini-test:generateContent", "gzip", 400],
    ["/v1/compact", "br", 404],
    ["/v1/responses/compact", "zstd", 400],
  ] as const)(
    "POST %s rejects a %s decompression bomb",
    async (path, encoding, expectedStatus) => {
      const expanded = Buffer.alloc(
        MAX_HTTP_REQUEST_DECOMPRESSED_BYTES + 1,
        0x61,
      );
      const compressed =
        encoding === "gzip"
          ? gzipSync(expanded)
          : encoding === "br"
            ? brotliCompressSync(expanded)
            : zstdCompressSync(expanded);
      const res = await localRequest(server.port, path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-encoding": encoding,
          "x-api-key": "test-key",
        },
        body: compressed,
      });
      expect(res.status).toBe(expectedStatus);
    },
  );

  test("rejects a raw WebSocket upgrade with 426 at the socket level", async () => {
    // node:http dispatches Upgrade requests via a separate 'upgrade' event,
    // bypassing the fetch handler. undici's fetch refuses to parse a non-101
    // upgrade response, so use a raw TCP socket to exercise the dedicated
    // upgrade listener (server.ts) and read the raw 426 it writes.
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect(server.port, "127.0.0.1", () => {
        socket.write(
          "GET /v1/responses HTTP/1.1\r\n" +
            `Host: 127.0.0.1:${server.port}\r\n` +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            "Sec-WebSocket-Version: 13\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
            "\r\n",
        );
      });
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString();
      });
      socket.on("close", () => resolve(data));
      socket.on("error", reject);
      setTimeout(() => {
        socket.destroy();
        resolve(data);
      }, 2000);
    });
    expect(raw).toContain("426 Upgrade Required");
    expect(raw).toContain("websocket_not_supported");
  });

  test("GET / redirects toward the dashboard (not a 500)", async () => {
    const res = await localRequest(server.port, "/");
    // Regression guard: Response.redirect()'s headers are immutable, so
    // the old CORS wrapper used to throw and the root path returned 500.
    expect(res.status).not.toBe(500);
    expect([301, 302, 307, 308]).toContain(res.status);
  });
});

describe("startServer configuration", () => {
  test("defaults empty hosts to 127.0.0.1 and still serves", async () => {
    const s = await startServer(makeConfig({ hosts: [] }));
    try {
      expect(s.hosts).toEqual(["127.0.0.1"]);
      const res = await localRequest(s.port, "/health");
      expect(res.status).toBe(200);
    } finally {
      await s.stop();
    }
  });

  test("debug mode serves requests (covers debug logging branch)", async () => {
    const s = await startServer(makeConfig({ debug: true }));
    try {
      const res = await localRequest(s.port, "/health");
      expect(res.status).toBe(200);
    } finally {
      await s.stop();
    }
  });

  // Regression: a configured host that isn't assigned to any local interface
  // (e.g. a Tailscale IP from a tailnet you've left) used to fail the whole
  // bind with EADDRNOTAVAIL, which startGateway() then misreported as a port
  // conflict ("Port N in use … Failed to bind to any port"). Such hosts must
  // be treated as optional: skipped with a warning while the reachable hosts
  // (loopback) still bind and serve. 192.0.2.1 is TEST-NET-1 (RFC 5737) — it
  // is guaranteed not assigned to any interface, so binding it yields
  // EADDRNOTAVAIL deterministically and hermetically.
  test("skips an unavailable host (EADDRNOTAVAIL) and still serves on loopback", async () => {
    const s = await startServer(
      makeConfig({ hosts: ["127.0.0.1", "192.0.2.1"] }),
    );
    try {
      // The unavailable host is dropped; only the bound host remains.
      expect(s.hosts).toEqual(["127.0.0.1"]);
      const res = await localRequest(s.port, "/health");
      expect(res.status).toBe(200);
    } finally {
      await s.stop();
    }
  });

  // The unavailable host appearing FIRST must not prevent binding the
  // reachable host that follows it (adversarial ordering — the resolved port
  // must come from the first host that actually binds).
  test("skips a leading unavailable host and binds the reachable one", async () => {
    const s = await startServer(
      makeConfig({ hosts: ["192.0.2.1", "127.0.0.1"] }),
    );
    try {
      expect(s.hosts).toEqual(["127.0.0.1"]);
      expect(s.port).toBeGreaterThan(0);
      const res = await localRequest(s.port, "/health");
      expect(res.status).toBe(200);
    } finally {
      await s.stop();
    }
  });

  // If EVERY configured host is unavailable, that is a genuine failure — the
  // gateway must throw rather than silently bind nothing. Assert the specific
  // "none available" message (not the raw EADDRNOTAVAIL the base branch threw)
  // so this is a real guard for the new behavior, not an incidental match.
  test("throws when all configured hosts are unavailable", async () => {
    await expect(
      startServer(makeConfig({ hosts: ["192.0.2.1", "203.0.113.1"] })),
    ).rejects.toThrow(/none of the configured hosts are available/);
  });

  // Regression for #907: handleNodeRequest interpolated the bind host into the
  // request URL without bracketing IPv6 literals, so a `::1` bind produced the
  // invalid `http://::1:PORT/...`; `new Request()` threw and every request 500'd.
  // The bind itself succeeds (node's listen() accepts `::1`) — the failure only
  // surfaced once a request reached the node:http handler. Asserting a 200 here
  // fails pre-fix (500) and passes post-fix.
  //
  // Guard: on IPv4-only environments the `::1` bind yields EADDRNOTAVAIL, so
  // every configured host is skipped and startServer throws "none available".
  // Treat that as "no IPv6 loopback here" and skip — keeps the test hermetic.
  test("serves over an IPv6 loopback bind (brackets the host in the request URL)", async () => {
    let s: ServerHandle;
    try {
      s = await startServer(makeConfig({ hosts: ["::1"] }));
    } catch (e) {
      expect(String(e)).toMatch(/none of the configured hosts are available/);
      return;
    }
    try {
      expect(s.hosts).toContain("::1");
      const res = await localRequest(s.port, "/health", {}, "::1");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("ok");
    } finally {
      await s.stop();
    }
  });
});
