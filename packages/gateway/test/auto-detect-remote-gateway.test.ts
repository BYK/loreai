/**
 * Tests for remote-gateway mode auto-detection and `lore start` defaults.
 *
 * Auto-detection (B1): when neither `LORE_REMOTE_GATEWAY` nor `LORE_HOSTED_MODE`
 * is set, the gateway auto-enables remote-gateway mode if its bind address
 * includes any non-loopback host. This prevents the "lore-config" bug from
 * recurring on long-running server deployments.
 *
 * `lore start` default (B5): the long-running-gateway command defaults to
 * `remoteGateway = true` (with `--local` opt-out), mirroring the existing
 * `hostedMode` default.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  loadConfig,
  hasNonLoopbackHost,
  type GatewayConfig,
} from "../src/config";
import type { StartOptions } from "../src/cli/start";

/**
 * Replicate the remote-gateway override logic from startGateway() so we can
 * test it without spinning up a real server. Mirrors the logic in
 * packages/gateway/src/cli/start.ts.
 */
function applyRemoteGatewayOverrides(
  config: GatewayConfig,
  opts: StartOptions,
): GatewayConfig {
  if (opts.local === true) {
    // --local flag always disables remote mode, mirroring hosted mode.
    config.remoteGateway = false;
    config.remoteGatewayAutoDetected = false;
  } else if (
    opts.local === undefined &&
    !("LORE_REMOTE_GATEWAY" in process.env) &&
    !("LORE_HOSTED_MODE" in process.env)
  ) {
    // No --local, no explicit env vars. loadConfig() may have set
    // remoteGateway via bind-address auto-detection — preserve that.
    // Otherwise, this is `lore start` — default to remote mode.
    if (!config.remoteGateway) {
      config.remoteGateway = true;
      config.remoteGatewayCommandDefault = true;
    }
  }
  return config;
}

describe("hasNonLoopbackHost", () => {
  test("returns false for empty list", () => {
    expect(hasNonLoopbackHost([])).toBe(false);
  });

  test("returns false for 127.0.0.1 (IPv4 loopback)", () => {
    expect(hasNonLoopbackHost(["127.0.0.1"])).toBe(false);
  });

  test("returns false for 127.x.x.x (entire /8 loopback range)", () => {
    expect(hasNonLoopbackHost(["127.0.0.1"])).toBe(false);
    expect(hasNonLoopbackHost(["127.1.2.3"])).toBe(false);
  });

  test("returns false for ::1 (IPv6 loopback)", () => {
    expect(hasNonLoopbackHost(["::1"])).toBe(false);
  });

  test("returns false for [::1] (IPv6 loopback with brackets)", () => {
    expect(hasNonLoopbackHost(["[::1]"])).toBe(false);
  });

  test("returns false for 'localhost'", () => {
    expect(hasNonLoopbackHost(["localhost"])).toBe(false);
  });

  test("returns false for 'LOCALHOST' (case-insensitive)", () => {
    expect(hasNonLoopbackHost(["LOCALHOST"])).toBe(false);
  });

  test("returns true for 0.0.0.0 (bind on all interfaces)", () => {
    expect(hasNonLoopbackHost(["0.0.0.0"])).toBe(true);
  });

  test("returns true for :: (IPv6 unspecified)", () => {
    expect(hasNonLoopbackHost(["::"])).toBe(true);
  });

  test("returns true for a Tailscale IP (100.x)", () => {
    expect(hasNonLoopbackHost(["100.107.38.38"])).toBe(true);
  });

  test("returns true for a LAN IP (192.168.x)", () => {
    expect(hasNonLoopbackHost(["192.168.1.42"])).toBe(true);
  });

  test("returns true for a public IP", () => {
    expect(hasNonLoopbackHost(["203.0.113.50"])).toBe(true);
  });

  test("returns true for an IPv6 global address", () => {
    expect(hasNonLoopbackHost(["2001:db8::1"])).toBe(true);
  });

  test("returns true if ANY host in the list is non-loopback", () => {
    expect(hasNonLoopbackHost(["127.0.0.1", "100.107.38.38"])).toBe(true);
    expect(hasNonLoopbackHost(["::1", "0.0.0.0"])).toBe(true);
  });

  test("returns false if ALL hosts are loopback", () => {
    expect(hasNonLoopbackHost(["127.0.0.1", "::1", "localhost"])).toBe(false);
  });
});

describe("loadConfig — remoteGateway auto-detection (B1)", () => {
  let savedRemote: string | undefined;
  let savedHosted: string | undefined;
  let savedHost: string | undefined;

  beforeEach(() => {
    savedRemote = process.env.LORE_REMOTE_GATEWAY;
    savedHosted = process.env.LORE_HOSTED_MODE;
    savedHost = process.env.LORE_LISTEN_HOST;
    delete process.env.LORE_REMOTE_GATEWAY;
    delete process.env.LORE_HOSTED_MODE;
    delete process.env.LORE_LISTEN_HOST;
  });

  afterEach(() => {
    if (savedRemote === undefined) delete process.env.LORE_REMOTE_GATEWAY;
    else process.env.LORE_REMOTE_GATEWAY = savedRemote;
    if (savedHosted === undefined) delete process.env.LORE_HOSTED_MODE;
    else process.env.LORE_HOSTED_MODE = savedHosted;
    if (savedHost === undefined) delete process.env.LORE_LISTEN_HOST;
    else process.env.LORE_LISTEN_HOST = savedHost;
  });

  test("default bind (127.0.0.1) + no env vars → remoteGateway=false", () => {
    expect(loadConfig().remoteGateway).toBe(false);
    expect(loadConfig().remoteGatewayAutoDetected).toBe(false);
  });

  test("LORE_LISTEN_HOST=100.107.38.38 (Tailscale) + no env → remoteGateway=true (auto-detected)", () => {
    process.env.LORE_LISTEN_HOST = "100.107.38.38";
    const config = loadConfig();
    expect(config.remoteGateway).toBe(true);
    expect(config.remoteGatewayAutoDetected).toBe(true);
  });

  test("LORE_LISTEN_HOST=0.0.0.0 + no env → remoteGateway=true (auto-detected)", () => {
    process.env.LORE_LISTEN_HOST = "0.0.0.0";
    const config = loadConfig();
    expect(config.remoteGateway).toBe(true);
    expect(config.remoteGatewayAutoDetected).toBe(true);
  });

  test("LORE_LISTEN_HOST=192.168.1.42 (LAN) + no env → remoteGateway=true (auto-detected)", () => {
    process.env.LORE_LISTEN_HOST = "192.168.1.42";
    const config = loadConfig();
    expect(config.remoteGateway).toBe(true);
    expect(config.remoteGatewayAutoDetected).toBe(true);
  });

  test("LORE_LISTEN_HOST=127.0.0.1,100.107.38.38 + no env → remoteGateway=true (any non-loopback host triggers)", () => {
    process.env.LORE_LISTEN_HOST = "127.0.0.1,100.107.38.38";
    const config = loadConfig();
    expect(config.remoteGateway).toBe(true);
    expect(config.remoteGatewayAutoDetected).toBe(true);
  });

  test("LORE_LISTEN_HOST=127.0.0.1 (explicit loopback) + no env → remoteGateway=false", () => {
    process.env.LORE_LISTEN_HOST = "127.0.0.1";
    const config = loadConfig();
    expect(config.remoteGateway).toBe(false);
    expect(config.remoteGatewayAutoDetected).toBe(false);
  });

  test("LORE_LISTEN_HOST=localhost + no env → remoteGateway=false", () => {
    process.env.LORE_LISTEN_HOST = "localhost";
    const config = loadConfig();
    expect(config.remoteGateway).toBe(false);
    expect(config.remoteGatewayAutoDetected).toBe(false);
  });

  test("LORE_REMOTE_GATEWAY=1 + loopback bind → remoteGateway=true, autoDetected=false (explicit wins)", () => {
    process.env.LORE_LISTEN_HOST = "127.0.0.1";
    process.env.LORE_REMOTE_GATEWAY = "1";
    const config = loadConfig();
    expect(config.remoteGateway).toBe(true);
    expect(config.remoteGatewayAutoDetected).toBe(false);
  });

  test("LORE_REMOTE_GATEWAY=1 + non-loopback bind → remoteGateway=true, autoDetected=false (explicit wins)", () => {
    process.env.LORE_LISTEN_HOST = "100.107.38.38";
    process.env.LORE_REMOTE_GATEWAY = "1";
    const config = loadConfig();
    expect(config.remoteGateway).toBe(true);
    expect(config.remoteGatewayAutoDetected).toBe(false);
  });

  test("LORE_HOSTED_MODE=1 + loopback bind → remoteGateway=true (hosted implies remote)", () => {
    process.env.LORE_LISTEN_HOST = "127.0.0.1";
    process.env.LORE_HOSTED_MODE = "1";
    const config = loadConfig();
    expect(config.remoteGateway).toBe(true);
    expect(config.remoteGatewayAutoDetected).toBe(false);
  });

  test("LORE_HOSTED_MODE=1 + non-loopback bind → remoteGateway=true", () => {
    process.env.LORE_LISTEN_HOST = "100.107.38.38";
    process.env.LORE_HOSTED_MODE = "1";
    const config = loadConfig();
    expect(config.remoteGateway).toBe(true);
    expect(config.remoteGatewayAutoDetected).toBe(false);
  });

  test("LORE_REMOTE_GATEWAY=0 + non-loopback bind → remoteGateway=false (explicit disable wins over auto-detect)", () => {
    process.env.LORE_REMOTE_GATEWAY = "0";
    process.env.LORE_LISTEN_HOST = "100.107.38.38";
    const config = loadConfig();
    expect(config.remoteGateway).toBe(false);
    expect(config.remoteGatewayAutoDetected).toBe(false);
  });

  test("LORE_HOSTED_MODE=0 + non-loopback bind → remoteGateway=false (explicit disable wins over auto-detect)", () => {
    process.env.LORE_HOSTED_MODE = "0";
    process.env.LORE_LISTEN_HOST = "100.107.38.38";
    const config = loadConfig();
    expect(config.remoteGateway).toBe(false);
    expect(config.remoteGatewayAutoDetected).toBe(false);
  });
});

describe("startGateway remote-gateway override (B5)", () => {
  let savedRemote: string | undefined;
  let savedHosted: string | undefined;
  let savedHost: string | undefined;

  beforeEach(() => {
    savedRemote = process.env.LORE_REMOTE_GATEWAY;
    savedHosted = process.env.LORE_HOSTED_MODE;
    savedHost = process.env.LORE_LISTEN_HOST;
    delete process.env.LORE_REMOTE_GATEWAY;
    delete process.env.LORE_HOSTED_MODE;
    delete process.env.LORE_LISTEN_HOST;
  });

  afterEach(() => {
    if (savedRemote === undefined) delete process.env.LORE_REMOTE_GATEWAY;
    else process.env.LORE_REMOTE_GATEWAY = savedRemote;
    if (savedHosted === undefined) delete process.env.LORE_HOSTED_MODE;
    else process.env.LORE_HOSTED_MODE = savedHosted;
    if (savedHost === undefined) delete process.env.LORE_LISTEN_HOST;
    else process.env.LORE_LISTEN_HOST = savedHost;
  });

  test("lore start (no opts.local, no env) + loopback bind → remoteGateway=true (command default)", () => {
    process.env.LORE_LISTEN_HOST = "127.0.0.1";
    const config = applyRemoteGatewayOverrides(loadConfig(), {});
    expect(config.remoteGateway).toBe(true);
    expect(config.remoteGatewayCommandDefault).toBe(true);
  });

  test("lore start (no opts.local, no env) + non-loopback bind → remoteGateway=true (auto-detect, NOT command default)", () => {
    process.env.LORE_LISTEN_HOST = "100.107.38.38";
    const config = applyRemoteGatewayOverrides(loadConfig(), {});
    expect(config.remoteGateway).toBe(true);
    // autoDetected was set by loadConfig; commandDefault was NOT set
    // because remoteGateway was already true.
    expect(config.remoteGatewayAutoDetected).toBe(true);
    expect(config.remoteGatewayCommandDefault).toBeFalsy();
  });

  test("lore start --local + loopback bind → remoteGateway=false", () => {
    process.env.LORE_LISTEN_HOST = "127.0.0.1";
    const config = applyRemoteGatewayOverrides(loadConfig(), { local: true });
    expect(config.remoteGateway).toBe(false);
    expect(config.remoteGatewayAutoDetected).toBe(false);
  });

  test("lore start --local + non-loopback bind → remoteGateway=false (--local always wins)", () => {
    process.env.LORE_LISTEN_HOST = "100.107.38.38";
    const config = applyRemoteGatewayOverrides(loadConfig(), { local: true });
    expect(config.remoteGateway).toBe(false);
    expect(config.remoteGatewayAutoDetected).toBe(false);
  });

  test("LORE_REMOTE_GATEWAY=0 + lore start + loopback bind → remoteGateway=false (env var wins over command default)", () => {
    process.env.LORE_REMOTE_GATEWAY = "0";
    process.env.LORE_LISTEN_HOST = "127.0.0.1";
    const config = applyRemoteGatewayOverrides(loadConfig(), {});
    expect(config.remoteGateway).toBe(false);
  });

  test("LORE_REMOTE_GATEWAY=0 + lore start + non-loopback bind → remoteGateway=false (explicit disable wins over auto-detect AND command default)", () => {
    process.env.LORE_REMOTE_GATEWAY = "0";
    process.env.LORE_LISTEN_HOST = "100.107.38.38";
    const config = applyRemoteGatewayOverrides(loadConfig(), {});
    expect(config.remoteGateway).toBe(false);
    expect(config.remoteGatewayAutoDetected).toBe(false);
  });

  test("LORE_REMOTE_GATEWAY=1 + lore start --local → remoteGateway=false (--local wins over env var)", () => {
    process.env.LORE_REMOTE_GATEWAY = "1";
    process.env.LORE_LISTEN_HOST = "100.107.38.38";
    const config = applyRemoteGatewayOverrides(loadConfig(), { local: true });
    expect(config.remoteGateway).toBe(false);
  });

  test("LORE_REMOTE_GATEWAY=1 + lore start + non-loopback bind → remoteGateway=true (env var wins)", () => {
    process.env.LORE_REMOTE_GATEWAY = "1";
    process.env.LORE_LISTEN_HOST = "100.107.38.38";
    const config = applyRemoteGatewayOverrides(loadConfig(), {});
    expect(config.remoteGateway).toBe(true);
    // explicit env var → autoDetected stays false
    expect(config.remoteGatewayAutoDetected).toBe(false);
    // commandDefault not set because remoteGateway was already true
    expect(config.remoteGatewayCommandDefault).toBeFalsy();
  });

  test("lore run (local: true) + non-loopback bind → remoteGateway=false (in-process callers always disable remote)", () => {
    process.env.LORE_LISTEN_HOST = "100.107.38.38";
    const config = applyRemoteGatewayOverrides(loadConfig(), { local: true });
    expect(config.remoteGateway).toBe(false);
  });
});
