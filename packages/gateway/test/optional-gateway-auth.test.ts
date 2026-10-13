import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { connect } from "node:net";
import { request } from "node:http";
import { loadConfig } from "../src/config";
import { startServer } from "../src/server";

// Exercise real startup and middleware with the peer address of a Tailscale client.
describe.each([
  { remoteGateway: false, hostedMode: false },
  { remoteGateway: true, hostedMode: false },
  { remoteGateway: true, hostedMode: true },
])("token-optional gateway %j", (mode) => {
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    server = await startServer(
      {
        ...loadConfig(),
        port: 0,
        hosts: ["127.0.0.1"],
        ...mode,
        allowRemoteManagement: true,
        gatewayAuthToken: undefined,
      },
      { peerAddressForRequest: () => "100.69.65.126" },
    );
  });
  afterAll(async () => {
    await server?.stop();
  });

  test("opens the remote management API without a token", async () => {
    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/v1/projects`,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.any(Array));
  });

  test("opens the remote dashboard without a token", async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/ui`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  test.each(["/v1/messages", "/v1/responses", "/v1/compact", "/v1/models"])(
    "accepts non-browser preflight on %s without a token",
    async (path) => {
      const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
        method: "OPTIONS",
      });
      expect(response.status).toBe(204);
    },
  );

  test.each([
    ["http://labs.sheep-fir.ts.net:3207", 200],
    ["https://untrusted.example", 404],
  ])(
    "checks management browser origin %s without a token",
    async (origin, expectedStatus) => {
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: server.port,
            path: "/api/v1/projects",
            headers: {
              host: "labs.sheep-fir.ts.net:3207",
              origin,
            },
          },
          (res) => {
            res.resume();
            res.once("end", () => resolve(res.statusCode ?? 0));
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(expectedStatus);
      const response = await fetch(
        `http://127.0.0.1:${server.port}/v1/models`,
        {
          headers: { origin: "https://untrusted.example" },
        },
      );
      expect(response.status).toBe(403);
    },
  );

  test("rejects a tokenless WebSocket upgrade as unsupported, not unauthorized", async () => {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(server.port, "127.0.0.1");
      let raw = "";
      socket.setTimeout(5000, () => {
        socket.destroy();
        reject(new Error("upgrade timed out"));
      });
      socket.on("connect", () =>
        socket.write(
          "GET /v1/responses HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        ),
      );
      socket.on("data", (chunk) => {
        raw += chunk.toString();
      });
      socket.on("end", () => resolve(raw));
      socket.on("error", reject);
    });
    expect(response).toMatch(/^HTTP\/1\.1 426 /);
  });
});
