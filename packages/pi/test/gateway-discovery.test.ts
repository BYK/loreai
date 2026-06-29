import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { probeGateway, resolveGatewayUrl } from "../src/internal";

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

  afterAll(async () => {
    await Promise.all([
      new Promise<void>((r) => healthy.close(() => r())),
      new Promise<void>((r) => unhealthy.close(() => r())),
    ]);
  });

  afterEach(() => {
    process.env = { ...savedEnv };
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
    test("returns LORE_REMOTE_URL when reachable (trailing slash stripped)", async () => {
      process.env.LORE_REMOTE_URL = `${healthyUrl}/`;
      delete process.env.LORE_GATEWAY_URL;
      expect(await resolveGatewayUrl()).toBe(healthyUrl);
    });

    test("falls through to LORE_GATEWAY_URL when reachable", async () => {
      delete process.env.LORE_REMOTE_URL;
      process.env.LORE_GATEWAY_URL = healthyUrl;
      expect(await resolveGatewayUrl()).toBe(healthyUrl);
    });
  });
});
