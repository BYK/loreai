import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { vi } from "vitest";
import { probeGateway, resolveGatewayUrl } from "../src/internal";
import * as internal from "../src/internal";
import { log } from "@loreai/core";

const gatewayMock = vi.hoisted(() => ({
  prepareSourceUiAssets: vi.fn(async () => ({
    attempted: true,
    files: 17,
    buildId: "build-a",
  })),
  readPortFile: vi.fn(),
}));

vi.mock("@loreai/gateway", () => gatewayMock);
vi.mock("@loreai/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@loreai/core")>()),
  installFetchInterceptor: vi.fn(),
}));

/**
 * Unit coverage for the Pi extension's gateway discovery: `probeGateway` and
 * the env-var resolution order of `resolveGatewayUrl`. A real loopback HTTP
 * server stands in for a gateway (answers `/health`).
 */
describe("pi gateway discovery", () => {
  let healthy: Server;
  let unhealthy: Server;
  let healthyUrl: string;
  let unhealthyUrl: string;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    healthy = createServer((req, res) => {
      if ((req.url ?? "").startsWith("/health")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    unhealthy = createServer((_req, res) => {
      res.writeHead(500);
      res.end("nope");
    });
    await Promise.all([
      new Promise<void>((r) => healthy.listen(0, "127.0.0.1", () => r())),
      new Promise<void>((r) => unhealthy.listen(0, "127.0.0.1", () => r())),
    ]);
    healthyUrl = `http://127.0.0.1:${(healthy.address() as AddressInfo).port}`;
    unhealthyUrl = `http://127.0.0.1:${(unhealthy.address() as AddressInfo).port}`;
  });

  beforeEach(() => {
    delete process.env.LORE_DISABLED;
    delete process.env.LORE_REMOTE_URL;
    delete process.env.LORE_GATEWAY_URL;
    gatewayMock.readPortFile.mockReturnValue(Number(new URL(healthyUrl).port));
  });

  afterAll(async () => {
    await Promise.all([
      new Promise<void>((r) => healthy.close(() => r())),
      new Promise<void>((r) => unhealthy.close(() => r())),
    ]);
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    gatewayMock.prepareSourceUiAssets.mockClear();
    gatewayMock.readPortFile.mockClear();
    vi.restoreAllMocks();
    log.silenceStderr(false);
  });

  describe("probeGateway", () => {
    test("true when /health answers 2xx", async () => {
      expect(await probeGateway(healthyUrl, 2000)).toBe(true);
    });
    test("false when the endpoint returns non-2xx", async () => {
      expect(await probeGateway(unhealthyUrl, 2000)).toBe(false);
    });
    test("false when nothing is listening", async () => {
      expect(await probeGateway("http://127.0.0.1:1", 500)).toBe(false);
    });
  });

  describe("resolveGatewayUrl env-var order", () => {
    test.each(["LORE_REMOTE_URL", "LORE_GATEWAY_URL"])(
      "an unavailable %s never chooses a healthy local gateway",
      async (name) => {
        process.env[name] = unhealthyUrl;
        if (name === "LORE_REMOTE_URL")
          process.env.LORE_GATEWAY_URL = healthyUrl;
        expect(await resolveGatewayUrl()).toBeNull();
        expect(gatewayMock.readPortFile).not.toHaveBeenCalled();
      },
    );

    test.each(["LORE_REMOTE_URL", "LORE_GATEWAY_URL"])(
      "an invalid %s never chooses the healthy port-file gateway",
      async (name) => {
        process.env[name] = "not a gateway URL";
        expect(await resolveGatewayUrl()).toBeNull();
        expect(gatewayMock.readPortFile).not.toHaveBeenCalled();
      },
    );

    test("ordinary local discovery still uses the port-file gateway", async () => {
      expect(await resolveGatewayUrl()).toBe(healthyUrl);
      expect(gatewayMock.prepareSourceUiAssets).toHaveBeenCalledOnce();
      expect(gatewayMock.readPortFile).toHaveBeenCalledOnce();
    });

    test("returns LORE_REMOTE_URL when reachable (trailing slash stripped)", async () => {
      process.env.LORE_REMOTE_URL = `${healthyUrl}/`;
      delete process.env.LORE_GATEWAY_URL;
      expect(await resolveGatewayUrl()).toBe(healthyUrl);
      expect(gatewayMock.prepareSourceUiAssets).not.toHaveBeenCalled();
    });

    test("falls through to LORE_GATEWAY_URL when reachable", async () => {
      delete process.env.LORE_REMOTE_URL;
      process.env.LORE_GATEWAY_URL = healthyUrl;
      expect(await resolveGatewayUrl()).toBe(healthyUrl);
      expect(gatewayMock.prepareSourceUiAssets).toHaveBeenCalledOnce();
    });
  });

  test("failed explicit resolution never starts an embedded gateway", async () => {
    // Isolate the entry point's no-running-gateway path, without host port probes.
    vi.spyOn(internal, "resolveGatewayUrl").mockResolvedValue(null);
    const start = vi
      .spyOn(internal, "startInProcess")
      .mockResolvedValue(healthyUrl);
    process.env.LORE_REMOTE_URL = unhealthyUrl;
    process.env.LORE_PI_FORCE_ACTIVE = "1";
    const pi = {
      registerProvider: vi.fn(),
      registerTool: vi.fn(),
      on: vi.fn(),
    };
    const { default: extension } = await import("../src/index");
    await extension(pi as unknown as Parameters<typeof extension>[0]);
    expect(start).not.toHaveBeenCalled();
    expect(pi.registerProvider).not.toHaveBeenCalled();
    expect(pi.registerTool).not.toHaveBeenCalled();
  });
});
