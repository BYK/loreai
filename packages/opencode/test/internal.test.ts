import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { PluginInput } from "@opencode-ai/plugin";
import { log } from "@loreai/core";
import {
  gatewayAccessHeadersForRemote,
  installEmbeddedGatewaySigtermHandler,
  shouldForwardUpstreamExtraHeader,
  surfaceGatewayUnavailable,
} from "../src/internal";

describe("embedded gateway SIGTERM", () => {
  function fakeHost() {
    const events = new EventEmitter();
    let resolveExit: ((code: number | undefined) => void) | undefined;
    const exited = new Promise<number | undefined>((resolve) => {
      resolveExit = resolve;
    });
    return {
      events,
      exited,
      host: {
        prependOnceListener: (event: "SIGTERM", listener: () => void) =>
          events.prependOnceListener(event, listener),
        removeListener: (event: "SIGTERM", listener: () => void) =>
          events.removeListener(event, listener),
        exit: (code?: number) => resolveExit?.(code),
      },
    };
  }

  test("awaits embedded gateway shutdown before completing SIGTERM", async () => {
    let finishShutdown: (() => void) | undefined;
    const shutdown = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishShutdown = resolve;
        }),
    );
    const { events, exited, host } = fakeHost();
    installEmbeddedGatewaySigtermHandler(shutdown, host);

    events.emit("SIGTERM");
    expect(shutdown).toHaveBeenCalledTimes(1);
    let didExit = false;
    void exited.then(() => {
      didExit = true;
    });
    await Promise.resolve();
    expect(didExit).toBe(false);

    finishShutdown?.();
    await expect(exited).resolves.toBe(0);
  });

  test("still completes termination when gateway shutdown fails", async () => {
    const { events, exited, host } = fakeHost();
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    log.silenceStderr(false);
    try {
      installEmbeddedGatewaySigtermHandler(async () => {
        throw new Error("shutdown failed");
      }, host);
      events.emit("SIGTERM");
      await expect(exited).resolves.toBe(0);
    } finally {
      stderr.mockRestore();
      log.silenceStderr(false);
    }
  });

  test("cleanup removes the process signal listener", () => {
    const shutdown = vi.fn(async () => {});
    const { events, host } = fakeHost();
    const cleanup = installEmbeddedGatewaySigtermHandler(shutdown, host);

    cleanup();
    events.emit("SIGTERM");
    expect(shutdown).not.toHaveBeenCalled();
  });
});

describe("remote gateway access headers", () => {
  const token = "opencode-remote-gateway-token-at-least-32";

  test("injects the access token only for the matching LORE_REMOTE_URL", () => {
    expect(
      gatewayAccessHeadersForRemote("https://lore.example", {
        LORE_REMOTE_URL: "https://lore.example/",
        LORE_GATEWAY_AUTH_TOKEN: token,
      }),
    ).toEqual({ "x-lore-gateway-token": token });

    expect(
      gatewayAccessHeadersForRemote("http://127.0.0.1:3207", {
        LORE_REMOTE_URL: "https://lore.example",
        LORE_GATEWAY_AUTH_TOKEN: token,
      }),
    ).toEqual({});
  });

  test("does not confuse provider credentials with gateway access", () => {
    expect(
      gatewayAccessHeadersForRemote("https://lore.example", {
        LORE_REMOTE_URL: "https://lore.example",
        ANTHROPIC_API_KEY: "provider-key",
      }),
    ).toEqual({});
  });

  test.each([
    "x-api-key",
    "X-Goog-Api-Key",
    "Authorization",
    "X-Lore-Gateway-Token",
  ])("does not forward managed credential header %s from extras", (name) => {
    expect(shouldForwardUpstreamExtraHeader(name)).toBe(false);
  });

  test("still forwards non-credential upstream extras", () => {
    expect(shouldForwardUpstreamExtraHeader("CF-Access-Client-Id")).toBe(true);
  });
});

/**
 * `surfaceGatewayUnavailable` is the one user-visible signal left when the
 * in-process gateway fails to start. In embedded/TUI mode `log.error` is
 * silenced on stderr (so it can't corrupt the render), which would otherwise
 * make a totally-failed gateway a silent no-op (Daniel's Windows report). The
 * helper raises a TUI-safe toast instead — and must NEVER let a missing,
 * throwing, or rejecting toast turn a degraded session into a crash.
 */
describe("surfaceGatewayUnavailable", () => {
  const MSG = "Lore failed to start — memory features are unavailable.";
  let stderr: ReturnType<typeof vi.spyOn>;

  function clientWith(showToast: (...args: unknown[]) => unknown) {
    return {
      tui: { showToast },
    } as unknown as PluginInput["client"];
  }

  beforeEach(() => {
    stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    // log.error only reaches stderr when NOT silenced; assert that path here.
    log.silenceStderr(false);
  });

  afterEach(() => {
    stderr.mockRestore();
    log.silenceStderr(false);
  });

  test("raises a TUI-safe error toast carrying the message", () => {
    const showToast = vi.fn(() => Promise.resolve());
    surfaceGatewayUnavailable(clientWith(showToast), MSG);

    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith({
      body: { title: "Lore", message: MSG, variant: "error" },
    });
  });

  test("still records the failure via log.error (file + Sentry sink)", () => {
    surfaceGatewayUnavailable(
      clientWith(() => Promise.resolve()),
      MSG,
    );
    const logged = stderr.mock.calls.some((args: unknown[]) =>
      args.join(" ").includes(MSG),
    );
    expect(logged).toBe(true);
  });

  test("swallows a synchronously throwing showToast (no crash)", () => {
    const showToast = vi.fn(() => {
      throw new Error("no TUI attached");
    });
    expect(() =>
      surfaceGatewayUnavailable(clientWith(showToast), MSG),
    ).not.toThrow();
  });

  test("swallows a rejected toast promise (no unhandled rejection)", async () => {
    const showToast = vi.fn(() => Promise.reject(new Error("no /tui route")));
    expect(() =>
      surfaceGatewayUnavailable(clientWith(showToast), MSG),
    ).not.toThrow();
    // Let the swallowed rejection settle — the helper attaches a `.catch`.
    await Promise.resolve();
  });

  test("tolerates a client without a TUI toast capability", () => {
    expect(() =>
      surfaceGatewayUnavailable({} as unknown as PluginInput["client"], MSG),
    ).not.toThrow();
    expect(() => surfaceGatewayUnavailable(undefined, MSG)).not.toThrow();
  });
});
