/**
 * Tests for the bounded-shutdown helpers (cli/shutdown.ts).
 *
 * These guarantee Ctrl+C can never hang the process: `runShutdownWithDeadline`
 * always resolves (fast path, timeout, or shutdown error); the signal-handler
 * factories run a bounded shutdown / forward to the child on the first signal
 * and force-exit on the second; and `signalExitCode` maps signals to
 * POSIX-conventional codes.
 *
 * The signal-handler exit paths now use `forcedExit` (not `safeExit`) because
 * the bounded shutdown may have timed out and the embedding worker may still
 * be mid-inference in a native call — `safeExit → process.exit()` would walk
 * NAPI destructors under it and SIGABRT (the "💣 Program crashed" report).
 * Both `safeExit` and `forcedExit` are mocked to throw a sentinel so we can
 * observe "process would exit here" without actually exiting the test worker
 * (both are `never`-typed in production and never return).
 */
import { describe, test, expect, vi, afterEach } from "vitest";

const { safeExitMock, forcedExitMock } = vi.hoisted(() => ({
  safeExitMock: vi.fn((code: number) => {
    throw new Error(`__safeExit__:${code}`);
  }),
  forcedExitMock: vi.fn((code: number) => {
    throw new Error(`__forcedExit__:${code}`);
  }),
}));
vi.mock("../src/cli/exit", () => ({
  safeExit: safeExitMock,
  forcedExit: forcedExitMock,
}));

import {
  runShutdownWithDeadline,
  signalExitCode,
  SHUTDOWN_DEADLINE_MS,
  parseShutdownDeadline,
  makeSignalShutdownHandler,
  makeChildForwardHandler,
  installSignalShutdown,
  installChildSignalForwarding,
} from "../src/cli/shutdown";

afterEach(() => {
  vi.restoreAllMocks();
  safeExitMock.mockClear();
  forcedExitMock.mockClear();
});

describe("signalExitCode", () => {
  test("maps known signals to 128 + signal number", () => {
    expect(signalExitCode("SIGINT")).toBe(130);
    expect(signalExitCode("SIGTERM")).toBe(143);
    expect(signalExitCode("SIGHUP")).toBe(129);
    expect(signalExitCode("SIGQUIT")).toBe(131);
  });

  test("falls back to 129 (128 + 1) for unknown signals", () => {
    expect(signalExitCode("SIGUSR2")).toBe(129);
  });
});

describe("SHUTDOWN_DEADLINE_MS", () => {
  test("has a sane positive default", () => {
    expect(SHUTDOWN_DEADLINE_MS).toBeGreaterThan(0);
    expect(Number.isFinite(SHUTDOWN_DEADLINE_MS)).toBe(true);
  });
});

describe("parseShutdownDeadline", () => {
  test("returns the parsed value for a valid positive number", () => {
    expect(parseShutdownDeadline("2000", 4000)).toBe(2000);
  });

  test.each([
    ["undefined", undefined],
    ["empty", ""],
    ["non-numeric", "abc"],
    ["zero", "0"],
    ["negative", "-5"],
    ["Infinity", "Infinity"],
  ])("falls back to default for %s input — never disables", (_label, raw) => {
    expect(parseShutdownDeadline(raw, 4000)).toBe(4000);
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
    const result = await runShutdownWithDeadline(
      () => new Promise<void>(() => {}),
      20,
    );
    expect(Date.now() - start).toBeLessThan(1000);
    expect(result.timedOut).toBe(true);
    expect(
      errSpy.mock.calls.some((c) => String(c[0]).includes("timed out")),
    ).toBe(true);
  });

  test("returns timedOut:false when shutdown completes before the deadline", async () => {
    const result = await runShutdownWithDeadline(async () => {}, 1000);
    expect(result.timedOut).toBe(false);
  });

  test("swallows a shutdown error (logs it) and still resolves", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await runShutdownWithDeadline(async () => {
      throw new Error("boom");
    }, 1000);
    expect(result.timedOut).toBe(false);
    expect(
      errSpy.mock.calls.some((c) =>
        String(c[0]).includes("Error during shutdown"),
      ),
    ).toBe(true);
  });
});

describe("makeSignalShutdownHandler", () => {
  test("first signal runs shutdown then force-exits with the signal code", async () => {
    const shutdown = vi.fn(async () => {});
    const handle = makeSignalShutdownHandler(shutdown);
    await expect(handle("SIGINT")).rejects.toThrow("__forcedExit__:130");
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(forcedExitMock).toHaveBeenCalledWith(130);
    expect(safeExitMock).not.toHaveBeenCalled();
  });

  test("first signal STILL uses forcedExit when shutdown hangs past the deadline", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const shutdown = vi.fn(
      () => new Promise<void>(() => {}), // never resolves
    );
    const handle = makeSignalShutdownHandler(shutdown);
    await expect(handle("SIGINT")).rejects.toThrow("__forcedExit__:130");
    expect(forcedExitMock).toHaveBeenCalledWith(130);
    expect(safeExitMock).not.toHaveBeenCalled();
  });

  test("second signal force-exits immediately without running shutdown again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const shutdown = vi.fn(async () => {});
    const handle = makeSignalShutdownHandler(shutdown);

    await expect(handle("SIGTERM")).rejects.toThrow("__forcedExit__:143");
    expect(shutdown).toHaveBeenCalledTimes(1);

    // Second interrupt: exits at once, shutdown not invoked a second time.
    await expect(handle("SIGTERM")).rejects.toThrow("__forcedExit__:143");
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});

describe("makeChildForwardHandler", () => {
  test("first signal forwards to the child and does not exit", () => {
    const child = { kill: vi.fn() };
    const handle = makeChildForwardHandler(child);
    handle("SIGINT");
    expect(child.kill).toHaveBeenCalledWith("SIGINT");
    expect(safeExitMock).not.toHaveBeenCalled();
    expect(forcedExitMock).not.toHaveBeenCalled();
  });

  test("second signal force-exits and stops forwarding", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const child = { kill: vi.fn() };
    const handle = makeChildForwardHandler(child);

    handle("SIGINT");
    expect(child.kill).toHaveBeenCalledTimes(1);

    // forcedExit throws (never returns in prod), so child.kill is not reached.
    expect(() => handle("SIGINT")).toThrow("__forcedExit__:130");
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(forcedExitMock).toHaveBeenCalledWith(130);
    expect(safeExitMock).not.toHaveBeenCalled();
  });
});

describe("install*", () => {
  test("installSignalShutdown registers SIGINT and SIGTERM handlers", () => {
    const onSpy = vi.spyOn(process, "on").mockReturnValue(process);
    installSignalShutdown(async () => {});
    const signals = onSpy.mock.calls.map((c) => c[0]);
    expect(signals).toContain("SIGINT");
    expect(signals).toContain("SIGTERM");
  });

  test("installChildSignalForwarding registers SIGINT and SIGTERM handlers", () => {
    const onSpy = vi.spyOn(process, "on").mockReturnValue(process);
    installChildSignalForwarding({ kill: vi.fn() });
    const signals = onSpy.mock.calls.map((c) => c[0]);
    expect(signals).toContain("SIGINT");
    expect(signals).toContain("SIGTERM");
  });
});
