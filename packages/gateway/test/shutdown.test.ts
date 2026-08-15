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
  makeProcessShutdownController,
  makeChildForwardHandler,
  installSignalShutdown,
  installChildSignalForwarding,
} from "../src/cli/shutdown";

afterEach(() => {
  vi.useRealTimers();
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
    expect(signalExitCode("SIGKILL")).toBe(137);
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
    ["NaN", "NaN"],
    ["fractional", "10.5"],
    ["timer overflow", "2147483648"],
    ["unsafe integer", "9007199254740992"],
  ])("falls back to default for %s input — never disables", (_label, raw) => {
    expect(parseShutdownDeadline(raw, 4000)).toBe(4000);
  });

  test("clamps tiny integers and accepts the largest Node timer", () => {
    expect(parseShutdownDeadline("1", 4000)).toBe(10);
    expect(parseShutdownDeadline("2147483647", 4000)).toBe(2147483647);
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

  test("swallows a synchronous shutdown throw and still resolves", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await runShutdownWithDeadline(() => {
      throw new Error("synchronous boom");
    }, 1000);
    expect(result).toEqual({ timedOut: false, failed: true });
  });
});

describe("makeSignalShutdownHandler", () => {
  test("first signal runs shutdown then safely exits with the signal code", async () => {
    const shutdown = vi.fn(async () => {});
    const handle = makeSignalShutdownHandler(shutdown);
    await expect(handle("SIGINT")).rejects.toThrow("__safeExit__:130");
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(safeExitMock).toHaveBeenCalledWith(130);
    expect(forcedExitMock).not.toHaveBeenCalled();
  });

  test("first signal STILL uses forcedExit when shutdown hangs past the deadline", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const shutdown = vi.fn(
      () => new Promise<void>(() => {}), // never resolves
    );
    const processShutdown = makeProcessShutdownController(shutdown, {
      deadlineMs: 20,
    });
    const handle = makeSignalShutdownHandler(shutdown, processShutdown);
    await expect(handle("SIGINT")).rejects.toThrow("__forcedExit__:130");
    expect(forcedExitMock).toHaveBeenCalledWith(130);
    expect(safeExitMock).not.toHaveBeenCalled();
  });

  test("second signal force-exits immediately without running shutdown again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const shutdown = vi.fn(async () => {});
    const handle = makeSignalShutdownHandler(shutdown);

    await expect(handle("SIGTERM")).rejects.toThrow("__safeExit__:143");
    expect(shutdown).toHaveBeenCalledTimes(1);

    // Second interrupt: exits at once, shutdown not invoked a second time.
    await expect(handle("SIGTERM")).rejects.toThrow("__forcedExit__:143");
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});

describe("makeProcessShutdownController", () => {
  test("deduplicates signal and control requests onto one whole-teardown deadline", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const shutdown = vi.fn(() => new Promise<void>(() => {}));
    const controller = makeProcessShutdownController(shutdown, {
      deadlineMs: 20,
    });

    const control = controller(0);
    const signal = controller(143);
    expect(signal).toBe(control);
    await expect(control).rejects.toThrow("__forcedExit__:143");
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(forcedExitMock).toHaveBeenCalledWith(143);
    expect(safeExitMock).not.toHaveBeenCalled();
  });

  test("force-exits nonzero when teardown rejects", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const controller = makeProcessShutdownController(
      async () => {
        throw new Error("teardown failed");
      },
      { deadlineMs: 1000 },
    );

    await expect(controller(0)).rejects.toThrow("__forcedExit__:1");
    expect(forcedExitMock).toHaveBeenCalledWith(1);
    expect(safeExitMock).not.toHaveBeenCalled();
  });

  test("exposes shutdown start and rejects a late child attachment", async () => {
    const controller = makeProcessShutdownController(async () => {}, {
      deadlineMs: 1000,
    });
    expect(controller.isShutdownStarted()).toBe(false);
    const request = controller(0);
    expect(controller.isShutdownStarted()).toBe(true);
    expect(() => controller.attachChild({ kill: vi.fn(() => true) })).toThrow(
      "Cannot attach a child after shutdown has started",
    );
    await expect(request).rejects.toThrow("__safeExit__:0");
  });
});

describe("makeChildForwardHandler", () => {
  test("first signal forwards to the child and starts the shared deadline", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const child = { kill: vi.fn((_signal: NodeJS.Signals) => true) };
    const shutdown = vi.fn(async () => {});
    const controller = makeProcessShutdownController(shutdown, {
      deadlineMs: 20,
    });
    const handle = makeChildForwardHandler(child, controller);
    handle("SIGINT");
    const pending = controller(130);
    const exit = expect(pending).rejects.toThrow("__forcedExit__:130");
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith("SIGINT"));
    await exit;
    expect(child.kill).toHaveBeenCalledWith("SIGINT");
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(safeExitMock).not.toHaveBeenCalled();
  });

  test("second signal SIGKILLs once and waits for the child to be reaped", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const child = { kill: vi.fn((_signal: NodeJS.Signals) => true) };
    const controller = makeProcessShutdownController(async () => {}, {
      deadlineMs: 1000,
    });
    const handle = makeChildForwardHandler(child, controller);

    handle("SIGINT");
    const pending = controller(130);

    handle("SIGINT");
    expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual([
      "SIGINT",
      "SIGKILL",
    ]);
    expect(safeExitMock).not.toHaveBeenCalled();
    expect(forcedExitMock).not.toHaveBeenCalled();
    handle("SIGTERM");
    expect(child.kill).toHaveBeenCalledTimes(2);
    expect(controller.childExited(0)).toBe(pending);
    await expect(pending).rejects.toThrow("__safeExit__:130");
    expect(child.kill).toHaveBeenCalledTimes(2);
    expect(forcedExitMock).not.toHaveBeenCalled();
    expect(safeExitMock).toHaveBeenCalledWith(130);
  });

  test("registers child escalation before the absolute outer deadline", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const child = { kill: vi.fn((_signal: NodeJS.Signals) => true) };
    const controller = makeProcessShutdownController(async () => {}, {
      deadlineMs: parseShutdownDeadline("1"),
    });
    controller.attachChild(child);

    const request = controller(0);
    const exit = expect(request).rejects.toThrow("__forcedExit__:1");
    await vi.advanceTimersByTimeAsync(5);
    expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual([
      "SIGTERM",
      "SIGKILL",
    ]);
    expect(forcedExitMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5);
    await exit;
    expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual([
      "SIGTERM",
      "SIGKILL",
    ]);
    expect(forcedExitMock).toHaveBeenCalledWith(1);
  });

  test("authenticated shutdown signals a live child and waits for it", async () => {
    const child = { kill: vi.fn(() => true) };
    const shutdown = vi.fn(async () => {});
    const controller = makeProcessShutdownController(shutdown, {
      deadlineMs: 1000,
    });
    controller.attachChild(child);

    const request = controller(0);
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith("SIGTERM"));
    await Promise.resolve();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(safeExitMock).not.toHaveBeenCalled();

    const reaped = controller.childExited(0);
    expect(reaped).toBe(request);
    await expect(request).rejects.toThrow("__safeExit__:0");
    expect(safeExitMock).toHaveBeenCalledWith(0);
  });

  test("does not escalate an obedient child after it is reaped", async () => {
    vi.useFakeTimers();
    const child = { kill: vi.fn(() => true) };
    const controller = makeProcessShutdownController(async () => {}, {
      deadlineMs: 100,
    });
    controller.attachChild(child);

    const request = controller(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    expect(controller.childExited(0)).toBe(request);
    await expect(request).rejects.toThrow("__safeExit__:0");
    await vi.advanceTimersByTimeAsync(100);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  test("escalates an ignoring child once and waits for it to be reaped", async () => {
    vi.useFakeTimers();
    const child = { kill: vi.fn((_signal: NodeJS.Signals) => true) };
    const controller = makeProcessShutdownController(async () => {}, {
      deadlineMs: 100,
    });
    controller.attachChild(child);

    const request = controller(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual([
      "SIGTERM",
      "SIGKILL",
    ]);
    expect(safeExitMock).not.toHaveBeenCalled();

    expect(controller.childExited(137)).toBe(request);
    await expect(request).rejects.toThrow("__safeExit__:137");
    expect(forcedExitMock).not.toHaveBeenCalled();
  });

  test("force-exits nonzero when escalation fails and the child stays live", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const child = {
      kill: vi.fn((signal: NodeJS.Signals) => signal !== "SIGKILL"),
    };
    const controller = makeProcessShutdownController(async () => {}, {
      deadlineMs: 100,
    });
    controller.attachChild(child);

    const request = controller(0);
    const exit = expect(request).rejects.toThrow("__forcedExit__:1");
    await vi.advanceTimersByTimeAsync(100);
    await exit;
    expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual([
      "SIGTERM",
      "SIGKILL",
    ]);
    expect(forcedExitMock).toHaveBeenCalledWith(1);
    expect(safeExitMock).not.toHaveBeenCalled();
  });

  test("child nonzero racing authenticated zero upgrades the outcome", async () => {
    const child = { kill: vi.fn((_signal: NodeJS.Signals) => true) };
    const controller = makeProcessShutdownController(async () => {}, {
      deadlineMs: 1000,
    });
    controller.attachChild(child);

    const request = controller(0);
    expect(controller.childExited(7)).toBe(request);
    await expect(request).rejects.toThrow("__safeExit__:7");
    expect(safeExitMock).toHaveBeenCalledWith(7);
  });

  test("duplicate triggers signal the child and tear down the gateway once", async () => {
    vi.useFakeTimers();
    const child = { kill: vi.fn((_signal: NodeJS.Signals) => true) };
    const shutdown = vi.fn(async () => {});
    const controller = makeProcessShutdownController(shutdown, {
      deadlineMs: 100,
    });
    controller.attachChild(child);

    const control = controller(0);
    const signal = controller(143, "SIGTERM");
    expect(signal).toBe(control);
    await vi.advanceTimersByTimeAsync(50);
    expect(child.kill.mock.calls.map(([childSignal]) => childSignal)).toEqual([
      "SIGTERM",
      "SIGKILL",
    ]);
    expect(controller(0)).toBe(control);
    expect(controller.childExited(0)).toBe(control);
    await expect(control).rejects.toThrow("__safeExit__:143");
    await vi.advanceTimersByTimeAsync(100);
    expect(child.kill).toHaveBeenCalledTimes(2);
    expect(shutdown).toHaveBeenCalledTimes(1);
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
    installChildSignalForwarding(
      { kill: vi.fn(() => true) },
      makeProcessShutdownController(async () => {}),
    );
    const signals = onSpy.mock.calls.map((c) => c[0]);
    expect(signals).toContain("SIGINT");
    expect(signals).toContain("SIGTERM");
  });
});
