import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  assertGatewayAccessConfigured,
  GATEWAY_AUTH_TOKEN_MAX_LENGTH,
  GATEWAY_AUTH_TOKEN_MIN_LENGTH,
  loadConfig,
  parseGatewayAuthToken,
} from "../src/config";
import { startServer } from "../src/server";

const TOKEN = "gateway-auth-config-test-token-at-least-32";
const ENV_KEYS = [
  "LORE_GATEWAY_AUTH_TOKEN",
  "LORE_HOSTED_MODE",
  "LORE_LISTEN_HOST",
  "LORE_REMOTE_GATEWAY",
  "LORE_UPSTREAM_EXTRA_HEADERS",
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

  test("parses a strong header-safe token without transforming it", () => {
    expect(parseGatewayAuthToken(TOKEN)).toBe(TOKEN);
    expect(
      parseGatewayAuthToken("a".repeat(GATEWAY_AUTH_TOKEN_MIN_LENGTH)),
    ).toBe("a".repeat(GATEWAY_AUTH_TOKEN_MIN_LENGTH));
    expect(
      parseGatewayAuthToken("z".repeat(GATEWAY_AUTH_TOKEN_MAX_LENGTH)),
    ).toBe("z".repeat(GATEWAY_AUTH_TOKEN_MAX_LENGTH));
  });

  test.each([
    "short",
    "a".repeat(GATEWAY_AUTH_TOKEN_MAX_LENGTH + 1),
    `a${"b".repeat(GATEWAY_AUTH_TOKEN_MIN_LENGTH)} c`,
    `a${"b".repeat(GATEWAY_AUTH_TOKEN_MIN_LENGTH)},c`,
    `a${"b".repeat(GATEWAY_AUTH_TOKEN_MIN_LENGTH)}\n`,
    "é".repeat(GATEWAY_AUTH_TOKEN_MIN_LENGTH),
  ])("rejects weak or non-header-safe token %#", (token) => {
    expect(() => parseGatewayAuthToken(token)).toThrow(
      "LORE_GATEWAY_AUTH_TOKEN",
    );
  });

  test("loads LORE_GATEWAY_AUTH_TOKEN separately from remote URL and provider auth", () => {
    process.env.LORE_GATEWAY_AUTH_TOKEN = TOKEN;
    process.env.LORE_REMOTE_GATEWAY = "1";
    const config = loadConfig();

    expect(config.gatewayAuthToken).toBe(TOKEN);
    expect(config.remoteGateway).toBe(true);
    expect(config.remoteUrl).toBeUndefined();
    expect(config.upstreamExtraHeaders).toEqual({});
    expect(() => assertGatewayAccessConfigured(config)).not.toThrow();
  });

  test.each([
    { remoteGateway: true, hostedMode: false },
    { remoteGateway: false, hostedMode: true },
    { remoteGateway: true, hostedMode: true },
  ])("fails closed for remote/hosted mode without a token %#", (mode) => {
    expect(() =>
      assertGatewayAccessConfigured({ ...mode, gatewayAuthToken: undefined }),
    ).toThrow("LORE_GATEWAY_AUTH_TOKEN");
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

  test("rejects a weak token supplied through a programmatic config", () => {
    expect(() =>
      assertGatewayAccessConfigured({
        remoteGateway: true,
        hostedMode: false,
        gatewayAuthToken: "short",
      }),
    ).toThrow("LORE_GATEWAY_AUTH_TOKEN");
  });

  test("public server startup applies the same fail-closed invariant", async () => {
    const config = loadConfig();
    config.port = 0;
    config.remoteGateway = true;
    config.hostedMode = false;
    config.gatewayAuthToken = undefined;

    await expect(startServer(config)).rejects.toThrow(
      "LORE_GATEWAY_AUTH_TOKEN",
    );
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
