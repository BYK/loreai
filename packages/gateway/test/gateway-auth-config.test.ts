import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { assertGatewayAccessConfigured, loadConfig } from "../src/config";
import { startServer } from "../src/server";

const TOKEN = "gateway-auth-config-test-token-at-least-32";
const ENV_KEYS = [
  "LORE_GATEWAY_AUTH_TOKEN",
  "LORE_HOSTED_MODE",
  "LORE_LISTEN_HOST",
  "LORE_ALLOW_REMOTE_MANAGEMENT",
  "LORE_REMOTE_GATEWAY",
  "LORE_UPSTREAM_EXTRA_HEADERS",
  "LORE_EXPOSE_PROVIDER_DIAGNOSTICS",
] as const;

describe("gateway access configuration", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  });

  test("ignores a legacy gateway token", () => {
    process.env.LORE_GATEWAY_AUTH_TOKEN = TOKEN;
    process.env.LORE_REMOTE_GATEWAY = "1";
    const config = loadConfig();

    expect(config.gatewayAuthToken).toBeUndefined();
    expect(config.remoteGateway).toBe(true);
    expect(config.remoteUrl).toBeUndefined();
    expect(config.upstreamExtraHeaders).toEqual({});
    expect(() => assertGatewayAccessConfigured(config)).not.toThrow();
  });

  test.each([
    { remoteGateway: true, hostedMode: false },
    { remoteGateway: false, hostedMode: true },
    { remoteGateway: true, hostedMode: true },
  ])("allows remote/hosted mode without a token %#", (mode) => {
    expect(() =>
      assertGatewayAccessConfigured({ ...mode, gatewayAuthToken: undefined }),
    ).not.toThrow();
  });

  test("keeps local mode token-optional", () => {
    expect(() =>
      assertGatewayAccessConfigured({
        remoteGateway: false,
        hostedMode: false,
        gatewayAuthToken: undefined,
      }),
    ).not.toThrow();
  });

  test("keeps remote management disabled unless explicitly enabled", () => {
    const disabled = loadConfig();
    expect(disabled.allowRemoteManagement).toBe(false);

    process.env.LORE_ALLOW_REMOTE_MANAGEMENT = "1";
    const enabled = loadConfig();
    expect(enabled.allowRemoteManagement).toBe(true);
  });

  test("allows remote management without a gateway token", () => {
    expect(() =>
      assertGatewayAccessConfigured({
        remoteGateway: false,
        hostedMode: false,
        allowRemoteManagement: true,
        gatewayAuthToken: undefined,
      }),
    ).not.toThrow();
  });

  test("exposes provider-frame diagnostics unless explicitly disabled", () => {
    expect(loadConfig().exposeProviderDiagnostics).toBe(true);

    process.env.LORE_EXPOSE_PROVIDER_DIAGNOSTICS = "false";
    expect(loadConfig().exposeProviderDiagnostics).toBe(false);

    process.env.LORE_EXPOSE_PROVIDER_DIAGNOSTICS = "0";
    expect(loadConfig().exposeProviderDiagnostics).toBe(false);
  });

  test("ignores a legacy token supplied through a programmatic config", () => {
    expect(() =>
      assertGatewayAccessConfigured({
        remoteGateway: true,
        hostedMode: false,
        gatewayAuthToken: "short",
      }),
    ).not.toThrow();
  });

  test("public server startup allows remote mode without a token", async () => {
    const config = loadConfig();
    config.port = 0;
    config.remoteGateway = true;
    config.hostedMode = false;
    config.gatewayAuthToken = undefined;

    const server = await startServer(config);
    try {
      expect(server.port).toBeGreaterThan(0);
    } finally {
      await server.stop();
    }
  });

  test("rejects configured mixed provider auth at config load", () => {
    process.env.LORE_UPSTREAM_EXTRA_HEADERS =
      "Authorization: Bearer admin\nX-Api-Key: competing-admin";
    expect(() => loadConfig()).toThrow(
      "at most one provider authentication mechanism",
    );
  });

  test("rejects attempts to configure the gateway access header as upstream auth", () => {
    process.env.LORE_UPSTREAM_EXTRA_HEADERS =
      "X-Lore-Gateway-Token: must-never-leave-the-gateway";
    expect(() => loadConfig()).toThrow("gateway access header");
  });

  test("rejects a case-variant gateway access header in a programmatic config", () => {
    expect(() =>
      assertGatewayAccessConfigured({
        remoteGateway: false,
        hostedMode: false,
        gatewayAuthToken: undefined,
        upstreamExtraHeaders: {
          "X-Lore-Gateway-Token": "must-never-leave-the-gateway",
        },
      }),
    ).toThrow("gateway access header");
  });
});
