import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { data, ensureProject, ltm } from "@loreai/core";
import { connect } from "node:net";
import { request } from "node:http";
import { loadConfig, type GatewayConfig } from "../src/config";
import { isLoopbackAddress, startServer } from "../src/server";

type ServerHandle = Awaited<ReturnType<typeof startServer>>;

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    ...loadConfig(),
    port: 0,
    hosts: ["127.0.0.1"],
    debug: false,
    remoteGateway: false,
    hostedMode: false,
    ...overrides,
  };
}

describe("management route access control", () => {
  let wideListener: ServerHandle;
  let remotePeer: ServerHandle;
  let remoteManagementPeer: ServerHandle;
  let mappedLoopbackPeer: ServerHandle;

  beforeAll(async () => {
    // A wildcard listener is intentionally public for the data plane. Access to
    // management routes must depend on the socket peer, not the bind address.
    wideListener = await startServer(makeConfig({ hosts: ["0.0.0.0"] }));
    remotePeer = await startServer(makeConfig(), {
      // A real non-loopback source address is not available hermetically on all
      // CI hosts. This seam changes only the address delivered by the
      // node:http bridge; requests still traverse a real TCP socket and server.
      peerAddressForRequest: () => "192.0.2.10",
    });
    remoteManagementPeer = await startServer(
      makeConfig({ allowRemoteManagement: true }),
      { peerAddressForRequest: () => "192.0.2.10" },
    );
    mappedLoopbackPeer = await startServer(makeConfig(), {
      peerAddressForRequest: () => "::ffff:127.0.0.1",
    });
  });

  afterAll(async () => {
    await Promise.all([
      wideListener.stop(),
      remotePeer.stop(),
      remoteManagementPeer.stop(),
      mappedLoopbackPeer.stop(),
    ]);
  });

  const urlFor = (server: ServerHandle, path: string): string =>
    `http://127.0.0.1:${server.port}${path}`;

  test("allows loopback clients through a 0.0.0.0 listener", async () => {
    const response = await fetch(urlFor(wideListener, "/api/v1/projects"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.any(Array));
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test.each([
    ["management API", "/api/v1/projects"],
    ["dashboard", "/ui"],
    ["dashboard root", "/"],
  ])("allows same-origin browser access to the %s", async (_label, path) => {
    const origin = `http://127.0.0.1:${wideListener.port}`;
    const response = await fetch(urlFor(wideListener, path), {
      headers: { origin },
      redirect: "manual",
    });

    expect(response.status).not.toBe(404);
    expect(response.status).not.toBe(500);
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    expect(response.headers.get("access-control-allow-origin")).not.toBe("*");
  });

  test("prevents remote sites from framing the loopback dashboard", async () => {
    const response = await fetch(urlFor(wideListener, "/ui"));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
  });

  test.each(["/api/v1/projects", "/ui", "/"])(
    "allows remote management route %s only with the explicit override",
    async (path) => {
      const response = await fetch(urlFor(remoteManagementPeer, path), {
        redirect: "manual",
      });

      expect(response.status).not.toBe(404);
      expect(response.status).not.toBe(500);
    },
  );

  test("allows the external dashboard's exact browser origin", async () => {
    const host = `labs.sheep-fir.ts.net:${remoteManagementPeer.port}`;
    const origin = `http://${host}`;
    const response = await new Promise<{
      status: number;
      allowOrigin: string | undefined;
    }>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: remoteManagementPeer.port,
          path: "/api/v1/projects",
          headers: { host, origin },
        },
        (res) => {
          res.resume();
          res.once("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              allowOrigin: res.headers["access-control-allow-origin"],
            }),
          );
        },
      );
      req.once("error", reject);
      req.end();
    });

    expect(response.status).toBe(200);
    expect(response.allowOrigin).toBe(origin);
    expect(response.allowOrigin).not.toBe("*");
  });

  test("keeps the external host when redirecting the dashboard root", async () => {
    const host = `labs.sheep-fir.ts.net:${remoteManagementPeer.port}`;
    const response = await new Promise<{
      status: number;
      location: string | undefined;
    }>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: remoteManagementPeer.port,
          path: "/",
          headers: { host },
        },
        (res) => {
          res.resume();
          res.once("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              location: res.headers.location,
            }),
          );
        },
      );
      req.once("error", reject);
      req.end();
    });

    expect(response.status).toBe(302);
    expect(response.location).toBe("/ui");
  });

  test("still hides remote management from a different browser origin", async () => {
    const host = `labs.sheep-fir.ts.net:${remoteManagementPeer.port}`;
    const response = await fetch(
      urlFor(remoteManagementPeer, "/api/v1/projects"),
      { headers: { host, origin: "https://attacker.example" } },
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("does not trust a loopback Origin from a remote peer", async () => {
    const response = await fetch(
      urlFor(remoteManagementPeer, "/api/v1/projects"),
      {
        headers: {
          host: `labs.sheep-fir.ts.net:${remoteManagementPeer.port}`,
          origin: `http://localhost:${remoteManagementPeer.port}`,
        },
      },
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("allows IPv4-mapped IPv6 loopback peers", async () => {
    const response = await fetch(
      urlFor(mappedLoopbackPeer, "/api/v1/projects"),
    );

    expect(response.status).toBe(200);
  });

  test("ignores forged forwarding headers from a non-loopback peer", async () => {
    const response = await fetch(urlFor(remotePeer, "/api/v1/projects"), {
      headers: {
        forwarded: "for=127.0.0.1;host=localhost",
        "x-forwarded-for": "127.0.0.1, ::1",
        "x-real-ip": "127.0.0.1",
      },
    });

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("denies destructive API calls without touching data", async () => {
    const projectPath = `/test/remote-management-${Date.now()}`;
    const projectId = ensureProject(projectPath, "remote-management-guard");

    const response = await fetch(
      urlFor(remotePeer, `/api/v1/projects/${projectId}`),
      { method: "DELETE" },
    );

    expect(response.status).toBe(404);
    expect(
      data.listProjects().some((project) => project.id === projectId),
    ).toBe(true);
  });

  test("denies before parsing a management request body", async () => {
    const response = await fetch(urlFor(remotePeer, "/api/v1/import/record"), {
      method: "POST",
      headers: {
        "content-encoding": "not-a-real-encoding",
        "content-type": "application/json",
      },
      body: "not json",
    });

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });

  test("responds without waiting for an unauthorized body to arrive", async () => {
    const rawResponse = await new Promise<string>((resolve, reject) => {
      const socket = connect(remotePeer.port, "127.0.0.1");
      let received = "";
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("management denial waited for the request body"));
      }, 2_000);
      const finish = (): void => {
        clearTimeout(timer);
        socket.destroy();
        resolve(received);
      };
      socket.once("connect", () => {
        socket.write(
          "POST /api/v1/import/record HTTP/1.1\r\n" +
            `Host: 127.0.0.1:${remotePeer.port}\r\n` +
            "Content-Type: application/json\r\n" +
            "Content-Length: 100000\r\n" +
            "\r\n" +
            "{",
        );
      });
      socket.on("data", (chunk) => {
        received += chunk.toString();
        if (received.includes("\r\n\r\n")) finish();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.once("close", () => {
        if (received) finish();
      });
    });

    expect(rawResponse).toContain("404 Not Found");
    expect(rawResponse.toLowerCase()).toContain("connection: close");
  });

  test.each(["/ui", "/ui/projects", "/"])(
    "denies remote dashboard route %s without enumeration",
    async (path) => {
      const response = await fetch(urlFor(remotePeer, path), {
        redirect: "manual",
      });

      expect(response.status).toBe(404);
      expect(await response.text()).toBe("");
    },
  );

  test("denies management preflights from non-loopback peers", async () => {
    const response = await fetch(urlFor(remotePeer, "/api/v1/projects"), {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:4173",
        "access-control-request-method": "DELETE",
        "access-control-request-headers": "content-type",
      },
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-methods")).toBeNull();
  });

  test("denies management preflights from non-loopback origins", async () => {
    const response = await fetch(urlFor(wideListener, "/api/v1/projects"), {
      method: "OPTIONS",
      headers: {
        origin: "https://attacker.example",
        "access-control-request-method": "DELETE",
        "access-control-request-headers": "content-type",
      },
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-methods")).toBeNull();
  });

  test("denies a simple management POST from a remote web origin", async () => {
    const projectPath = `/test/browser-management-${Date.now()}`;
    const projectId = ensureProject(projectPath, "browser-management-guard");
    const knowledgeId = ltm.create({
      projectPath,
      category: "gotcha",
      title: "Browser management guard",
      content: "This entry must survive a cross-origin management request.",
      session: "management-access-test",
      scope: "project",
    });
    const response = await fetch(
      urlFor(wideListener, `/api/v1/projects/${projectId}/clear`),
      {
        method: "POST",
        // text/plain makes this a CORS-safelisted request that a browser can
        // send without preflight. The Origin check must still stop it.
        headers: {
          origin: "https://attacker.example",
          "content-type": "text/plain",
        },
        body: "{}",
      },
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(ltm.get(knowledgeId)).not.toBeNull();
  });

  test("reflects only an allowed loopback origin on management preflight", async () => {
    const origin = "http://localhost:4173";
    const response = await fetch(urlFor(wideListener, "/api/v1/projects"), {
      method: "OPTIONS",
      headers: {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    expect(response.headers.get("access-control-allow-origin")).not.toBe("*");
    expect(response.headers.get("vary")).toContain("Origin");
  });

  test("keeps no-Origin health and data-plane routes reachable remotely", async () => {
    const health = await fetch(urlFor(remotePeer, "/health"));
    expect(health.status).toBe(200);
    expect(health.headers.get("access-control-allow-origin")).toBeNull();

    const dataPlane = await fetch(urlFor(remotePeer, "/v1/messages"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(dataPlane.status).toBe(400);
    expect(dataPlane.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("isLoopbackAddress", () => {
  test.each([
    "127.0.0.1",
    "127.255.255.254",
    "::1",
    "0:0:0:0:0:0:0:1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
  ])("accepts loopback address %s", (address) => {
    expect(isLoopbackAddress(address)).toBe(true);
  });

  test.each([
    undefined,
    "",
    "localhost",
    "0.0.0.0",
    "::",
    "192.168.1.20",
    "100.64.0.10",
    "203.0.113.10",
    "2001:db8::1",
    "::ffff:192.168.1.20",
  ])("rejects non-loopback address %s", (address) => {
    expect(isLoopbackAddress(address)).toBe(false);
  });
});
