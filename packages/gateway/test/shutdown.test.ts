/**
 * Tests for the bounded-shutdown helpers (cli/shutdown.ts).
 *
 * These guarantee Ctrl+C can never hang the process: `runShutdownWithDeadline`
 * always resolves (fast path, timeout, or shutdown error), and `signalExitCode`
 * maps signals to POSIX-conventional codes.
 */
import { describe, test, expect, vi, afterEach } from "vitest";
import {
  runShutdownWithDeadline,
  signalExitCode,
  SHUTDOWN_DEADLINE_MS,
} from "../src/cli/shutdown";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("signalExitCode", () => {
  test("maps known signals to 128 + signal number", () => {
    expect(signalExitCode("SIGINT")).toBe(130);
    expect(signalExitCode("SIGTERM")).toBe(143);
    expect(signalExitCode("SIGHUP")).toBe(129);
    expect(signalExitCode("SIGQUIT")).toBe(131);
  });

  test("falls back to 129 (128 + 1) for unknown signals", () => {
    expect(signalExitCode("SIGUSR2" as NodeJS.Signals)).toBe(129);
  });
});

describe("SHUTDOWN_DEADLINE_MS", () => {
  test("has a sane positive default", () => {
    expect(SHUTDOWN_DEADLINE_MS).toBeGreaterThan(0);
    expect(Number.isFinite(SHUTDOWN_DEADLINE_MS)).toBe(true);
  });
});

describe("runShutdownWithDeadline", () => {
  test("resolves promptly when shutdown completes fast (no timeout log)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let ran = false;
    await runShutdownWithDeadline(async () => {
      ran = true;
    }, 1000);
    expect(ran).toBe(true);
    expect(
      errSpy.mock.calls.some((c) => String(c[0]).includes("timed out")),
    ).toBe(false);
  });

  test("resolves (with timeout log) when shutdown hangs past the deadline", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const start = Date.now();
    // Never resolves — only the deadline can end the race.
    await runShutdownWithDeadline(() => new Promise<void>(() => {}), 20);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(
      errSpy.mock.calls.some((c) => String(c[0]).includes("timed out")),
    ).toBe(true);
  });

  test("swallows a shutdown error (logs it) and still resolves", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      runShutdownWithDeadline(async () => {
        throw new Error("boom");
      }, 1000),
    ).resolves.toBeUndefined();
    expect(
      errSpy.mock.calls.some((c) =>
        String(c[0]).includes("Error during shutdown"),
      ),
    ).toBe(true);
  });
});
