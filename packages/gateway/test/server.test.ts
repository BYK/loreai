/**
 * Route-level tests for `src/server.ts`.
 *
 * Starts a real gateway server (via `startServer`) on a random port and
 * exercises the pre-pipeline routes + error paths that the replay
 * integration tests (replay.test.ts) don't reach: CORS preflight, health,
 * 404, invalid-JSON 400 on each protocol endpoint, the /v1/models passthrough
 * 502 path (unreachable upstream), the `/` redirect, and the empty-hosts
 * defensive default.
 *
 * The upstream is pointed at a refused port so /v1/models fails fast (502)
 * without real network access; the other routes never reach the pipeline.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { connect } from "node:net";
import { startServer } from "../src/server";
import { loadConfig } from "../src/config";
import type { GatewayConfig } from "../src/config";

type ServerHandle = Awaited<ReturnType<typeof startServer>>;

function makeConfig(overrides?: Partial<GatewayConfig>): GatewayConfig {
  return {
    ...loadConfig(),
    port: 0,
    hosts: ["127.0.0.1"],
    debug: false,
    // Refused port → upstreamFetch fails fast so /v1/models returns 502.
    upstreamAnthropic: "http://127.0.0.1:9",
    ...overrides,
  };
}

let server: ServerHandle;
let baseURL: string;

beforeAll(async () => {
  server = await startServer(makeConfig());
  baseURL = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop();
});

describe("server routing", () => {
  test("OPTIONS preflight returns 204 with permissive CORS headers", async () => {
    const res = await fetch(`${baseURL}/v1/messages`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  test("GET /health returns ok + version with CORS", async () => {
    const res = await fetch(`${baseURL}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; version: string };
    expect(body.status).toBe("ok");
    expect(typeof body.version).toBe("string");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("unknown route returns a 404 error envelope", async () => {
    const res = await fetch(`${baseURL}/definitely-not-a-route`);
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
    const res = await fetch(`${baseURL}${path}`, {
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
  });

  test("GET /v1/models returns 502 when the upstream is unreachable", async () => {
    const res = await fetch(`${baseURL}/v1/models`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("api_error");
  });

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
    const res = await fetch(`${baseURL}/`, { redirect: "manual" });
    // undici surfaces a manual redirect as an opaqueredirect (status 0); a
    // real 3xx is also acceptable. Regression guard: Response.redirect()'s
    // headers are immutable, so withCors() used to throw "immutable" and the
    // root path 500'd instead of redirecting.
    expect(res.status).not.toBe(500);
    expect([0, 301, 302, 307, 308]).toContain(res.status);
  });
});

describe("startServer configuration", () => {
  test("defaults empty hosts to 127.0.0.1 and still serves", async () => {
    const s = await startServer(makeConfig({ hosts: [] }));
    try {
      expect(s.hosts).toEqual(["127.0.0.1"]);
      const res = await fetch(`http://127.0.0.1:${s.port}/health`);
      expect(res.status).toBe(200);
    } finally {
      s.stop();
    }
  });

  test("debug mode serves requests (covers debug logging branch)", async () => {
    const s = await startServer(makeConfig({ debug: true }));
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/health`);
      expect(res.status).toBe(200);
    } finally {
      s.stop();
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
      const res = await fetch(`http://127.0.0.1:${s.port}/health`);
      expect(res.status).toBe(200);
    } finally {
      s.stop();
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
      const res = await fetch(`http://127.0.0.1:${s.port}/health`);
      expect(res.status).toBe(200);
    } finally {
      s.stop();
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
      const res = await fetch(`http://[::1]:${s.port}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("ok");
    } finally {
      s.stop();
    }
  });
});
