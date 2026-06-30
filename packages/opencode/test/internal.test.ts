import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PluginInput } from "@opencode-ai/plugin";
import { log } from "@loreai/core";
import { surfaceGatewayUnavailable } from "../src/internal";

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
