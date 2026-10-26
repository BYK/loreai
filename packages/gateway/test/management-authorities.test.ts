import { afterEach, expect, test, vi } from "vitest";
import { connect } from "node:net";
import * as api from "../src/api";
import * as ui from "../src/ui-static";
import { loadConfig } from "../src/config";
import { startServer } from "../src/server";
import { loopbackRequest } from "./helpers/loopback-request";

afterEach(() => vi.unstubAllEnvs());

async function upgrade(
  port: number,
  path: string,
  headers: Record<string, string>,
  method = "GET",
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Management upgrade did not close its connection"));
    }, 2000);
    socket.once("connect", () =>
      socket.write(
        `${method} ${path} HTTP/1.1\r\n` +
          Object.entries(headers)
            .map(([key, value]) => `${key}: ${value}\r\n`)
            .join("") +
          "Connection: Upgrade\r\nUpgrade: websocket\r\nContent-Length: 100\r\n\r\n{",
      ),
    );
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("close", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

test.each([
  {
    peer: "192.0.2.10",
    allow: false,
    host: "gateway.example.test",
    status: 404,
  },
  {
    peer: "192.0.2.10",
    allow: false,
    host: "gateway.example.test",
    origin: "https://gateway.example.test",
    status: 404,
  },
  { peer: "127.0.0.1", allow: true, host: "rebound.example.test", status: 404 },
  {
    peer: "127.0.0.1",
    allow: true,
    host: "rebound.example.test",
    origin: "https://rebound.example.test",
    status: 404,
  },
  {
    peer: "127.0.0.1",
    allow: true,
    host: "gateway.example.test",
    origin: "https://foreign.example.test",
    status: 404,
  },
  {
    peer: "192.0.2.10",
    allow: true,
    host: "gateway.example.test",
    origin: "https://foreign.example.test",
    status: 404,
  },
  {
    peer: "192.0.2.10",
    allow: true,
    host: "gateway.example.test",
    status: 426,
  },
  {
    peer: "192.0.2.10",
    allow: true,
    host: "gateway.example.test",
    origin: "https://gateway.example.test",
    status: 426,
  },
  {
    peer: "127.0.0.1",
    allow: true,
    host: "gateway.example.test",
    origin: "https://gateway.example.test",
    status: 426,
  },
  { peer: "127.0.0.1", allow: false, host: "localhost", status: 426 },
])(
  "raw upgrades enforce management policy for $peer / $host / $origin",
  async ({ peer, allow, host, origin, status }) => {
    const server = await startServer(
      {
        ...loadConfig(),
        port: 0,
        hosts: ["127.0.0.1"],
        debug: true,
        allowRemoteManagement: allow,
        managementOrigins: ["https://gateway.example.test"],
      },
      { peerAddressForRequest: () => peer },
    );
    const handler = vi.spyOn(api, "handleAPIRequest");
    const uiHandler = vi.spyOn(ui, "handleUIRequest");
    const logs: unknown[] = [];
    const diagnostic = vi
      .spyOn(console, "error")
      .mockImplementation((...args) => {
        logs.push(args);
      });
    try {
      for (const path of ["/api/v1/account", "/api/v1/projects", "/ui"]) {
        const response = await upgrade(
          server.port,
          `${path}?attempt=private-upgrade-sentinel`,
          {
            host,
            ...(origin ? { origin } : {}),
            forwarded: "for=127.0.0.1;host=localhost",
            "x-forwarded-for": "127.0.0.1",
            "x-forwarded-host": "localhost",
          },
        );
        expect(response).toMatch(new RegExp(`^HTTP/1.1 ${status} `));
        expect(response.toLowerCase()).toContain("connection: close");
        if (status === 404) {
          expect(response.split("\r\n\r\n")[1]).toBe("");
          expect(response.toLowerCase()).not.toContain("access-control-");
        } else {
          expect(response).toContain("websocket_not_supported");
        }
        expect(response).not.toContain("private-upgrade-sentinel");
      }
      expect(handler).not.toHaveBeenCalled();
      expect(uiHandler).not.toHaveBeenCalled();
      expect(JSON.stringify(logs)).not.toContain("private-upgrade-sentinel");
    } finally {
      handler.mockRestore();
      uiHandler.mockRestore();
      diagnostic.mockRestore();
      await server.stop();
    }
  },
);

test.each([undefined, "https://rebound.example.test"])(
  "remote management rejects an untrusted authority with Origin %s",
  async (origin) => {
    const server = await startServer(
      {
        ...loadConfig(),
        port: 0,
        hosts: ["127.0.0.1"],
        allowRemoteManagement: true,
      },
      { peerAddressForRequest: () => "192.0.2.10" },
    );
    try {
      for (const path of ["/api/v1/account", "/api/v1/projects", "/ui"]) {
        const response = await loopbackRequest(
          `http://127.0.0.1:${server.port}${path}`,
          {
            headers: {
              host: "rebound.example.test",
              ...(origin ? { origin } : {}),
              forwarded: "for=127.0.0.1;host=gateway.example.test",
              "x-forwarded-host": "gateway.example.test",
            },
          },
        );
        expect(response.status).toBe(404);
        expect(await response.text()).toBe("");
      }
    } finally {
      await server.stop();
    }
  },
);

for (const peer of ["127.0.0.1", "192.0.2.10"]) {
  test.each(["http:", "https:"])(
    `an explicit %s dashboard origin works through socket peer ${peer}`,
    async (protocol) => {
      const origin = `${protocol}//gateway.example.test:8443`;
      const server = await startServer(
        {
          ...loadConfig(),
          port: 0,
          hosts: ["127.0.0.1"],
          allowRemoteManagement: true,
          managementOrigins: [origin],
        },
        { peerAddressForRequest: () => peer },
      );
      try {
        for (const requestOrigin of [undefined, origin]) {
          const response = await loopbackRequest(
            `http://127.0.0.1:${server.port}/api/v1/account`,
            {
              headers: {
                host: "gateway.example.test:8443",
                ...(requestOrigin ? { origin: requestOrigin } : {}),
              },
            },
          );
          expect(response.status).toBe(200);
          expect(await response.json()).toHaveProperty("signed_in");
          expect(response.headers.get("access-control-allow-origin")).toBe(
            requestOrigin ?? null,
          );
        }
        for (const headers of [
          { host: "gateway.example.test:8444", origin },
          {
            host: "rebound.example.test:8443",
            origin: `${protocol}//rebound.example.test:8443`,
          },
        ]) {
          const response = await loopbackRequest(
            `http://127.0.0.1:${server.port}/api/v1/account`,
            { headers },
          );
          expect(response.status).toBe(404);
          await response.text();
        }
      } finally {
        await server.stop();
      }
    },
  );
}

test("a wildcard bind address never becomes a trusted dashboard authority", async () => {
  const server = await startServer({
    ...loadConfig(),
    port: 0,
    hosts: ["0.0.0.0"],
    allowRemoteManagement: true,
  });
  try {
    const response = await loopbackRequest(
      `http://127.0.0.1:${server.port}/api/v1/account`,
      {
        headers: { host: `0.0.0.0:${server.port}` },
      },
    );
    expect(response.status).toBe(404);
    await response.text();
  } finally {
    await server.stop();
  }
});

test("management origins are administrator configured and normalized", () => {
  vi.stubEnv(
    "LORE_MANAGEMENT_ORIGINS",
    "https://GATEWAY.example.test:443/,http://gateway.example.test:8080",
  );
  expect(loadConfig().managementOrigins).toEqual([
    "https://gateway.example.test",
    "http://gateway.example.test:8080",
  ]);
});

test.each([
  "https://*.example.test",
  "https://user:password@gateway.example.test",
  "https://gateway.example.test/path/..",
  "https://gateway.example.test/?private=value",
  "https://gateway.example.test/#fragment",
  "ftp://gateway.example.test",
  "https://gateway.example.test,https://GATEWAY.example.test:443/",
])("invalid management origin configuration fails closed: %s", (origin) => {
  vi.stubEnv("LORE_MANAGEMENT_ORIGINS", origin);
  expect(() => loadConfig()).toThrow(/LORE_MANAGEMENT_ORIGINS/);
});

test.each(["ftp://gateway.example.test", "https://*.example.test"])(
  "programmatic listeners reject invalid management origins: %s",
  async (origin) => {
    const started = startServer({
      ...loadConfig(),
      port: 0,
      hosts: ["127.0.0.1"],
      managementOrigins: [origin],
    });
    try {
      await expect(started).rejects.toThrow(/LORE_MANAGEMENT_ORIGINS/);
    } finally {
      await started.then(
        (server) => server.stop(),
        () => {},
      );
    }
  },
);

test.each([
  { name: "empty element", origins: [""], publicOrigins: [] },
  { name: "whitespace element", origins: [" "], publicOrigins: [] },
  {
    name: "comma-separated element",
    origins: [
      "https://GATEWAY.example.test:443,http://other.example.test:8080",
    ],
    publicOrigins: [
      "https://gateway.example.test",
      "http://other.example.test:8080",
    ],
  },
  {
    name: "two separate origins",
    origins: [
      " https://GATEWAY.example.test:443/ ",
      "http://other.example.test:8080/",
    ],
    publicOrigins: [
      "https://gateway.example.test",
      "http://other.example.test:8080",
    ],
  },
])(
  "programmatic listeners serve the normalized policy for $name",
  async ({ origins, publicOrigins }) => {
    const server = await startServer(
      Object.freeze({
        ...loadConfig(),
        port: 0,
        hosts: ["127.0.0.1"],
        allowRemoteManagement: true,
        managementOrigins: Object.freeze(origins),
      }),
    );
    try {
      const endpoint = `http://127.0.0.1:${server.port}/api/v1/account`;
      for (const origin of [new URL(endpoint).origin, ...publicOrigins]) {
        const host = new URL(origin).host;
        for (const requestOrigin of [undefined, origin]) {
          const headers = {
            host,
            ...(requestOrigin ? { origin: requestOrigin } : {}),
          };
          const response = await loopbackRequest(endpoint, { headers });
          expect(response.status).toBe(200);
          expect(await response.json()).toHaveProperty("signed_in");

          const upgraded = await upgrade(
            server.port,
            "/api/v1/account",
            headers,
          );
          expect(upgraded).toMatch(/^HTTP\/1\.1 426 /);
        }
      }
    } finally {
      await server.stop();
    }
  },
);
