/**
 * Tests for the safe/fast exit helpers (cli/exit.ts).
 *
 * The bug being defended against: a native NAPI addon (e.g. onnxruntime-node in
 * the embedding worker thread) is mid-inference when the gateway decides to
 * exit. A normal `process.exit()` walks NAPI env destructors under it, which
 * throws an uncatchable `Napi::Error` → SIGABRT.
 *
 * Two helpers exist:
 *   - `safeExit()`:  clean exit. Tries libc `_exit` via FFI under Bun (where
 *     the NAPI teardown bug was first reported); falls back to
 *     `process.exit()` under Node when the worker is already gone.
 *   - `forcedExit()`: forced exit (deadline timeout, second signal, child
 *     error). Always skips teardown — via `_exit` under Bun, via
 *     `process.kill(pid, 'SIGKILL')` under Node (the only portable Node
 *     mechanism that matches `_exit` semantics).
 *
 * These tests cover both helpers under both runtimes. `process.exit`,
 * `process.kill`, and the `bun:ffi` CJS require are mocked so we can observe
 * "would exit here" without actually exiting the test worker.
 *
 * Why no `vi.mock("bun:ffi")` for the FFI path: the helper uses a bare
 * `require("bun:ffi")` (CJS), which vi.mock does not intercept — vi.mock
 * only hooks the ESM import resolver. Instead we override the loader's
 * output by stubbing `Module._load` (the underlying CJS hook) just for the
 * `"bun:ffi"` specifier.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import Module from "node:module";

const { processExitMock, processKillMock, ffiDlopen, ffiSymbols } = vi.hoisted(
  () => {
    const processExitMock = vi.fn();
    const processKillMock = vi.fn();
    const ffiSymbols = { _exit: vi.fn() };
    const ffiDlopen = vi.fn(() => ({ symbols: ffiSymbols }));
    return { processExitMock, processKillMock, ffiDlopen, ffiSymbols };
  },
);

beforeEach(() => {
  processExitMock.mockReset();
  processKillMock.mockReset();
  ffiDlopen.mockReset();
  ffiSymbols._exit.mockReset();
  // Default: FFI "succeeds" — dlopen returns the stub, _exit is a no-op.
  ffiDlopen.mockImplementation(() => ({ symbols: ffiSymbols }));

  // Enable the test-only sentinel throw in forcedExit. Without this the
  // helper would enter an unreachable tight loop (the prod-only fallback) and
  // the test worker would hang. See cli/exit.ts and Sentry review on PR #1520.
  process.env.LORE_FORCED_EXIT_SENTINEL = "1";

  vi.spyOn(process, "exit").mockImplementation(processExitMock as never);
  vi.spyOn(process, "kill").mockImplementation(processKillMock as never);

  // Intercept the CJS `require("bun:ffi")` so the helper's FFI branch can
  // actually run under Node (where the real bun:ffi module doesn't exist).
  type ModuleWithLoad = {
    _load: (request: string, ...rest: unknown[]) => unknown;
  };
  const moduleObj = Module as unknown as ModuleWithLoad;
  const originalLoad = moduleObj._load;
  vi.spyOn(moduleObj, "_load").mockImplementation(function (
    this: unknown,
    request: string,
    ...rest: unknown[]
  ) {
    if (request === "bun:ffi") {
      return { dlopen: ffiDlopen, FFIType: { int: 0, void: 0 } };
    }
    return originalLoad.call(this, request, ...rest);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as { Bun?: unknown }).Bun;
  delete process.env.LORE_FORCED_EXIT_SENTINEL;
  vi.resetModules();
});

type ExitModule = typeof import("../src/cli/exit");

async function loadExit(bunFfi: unknown): Promise<ExitModule> {
  if (bunFfi === undefined) {
    delete (globalThis as { Bun?: unknown }).Bun;
  } else {
    (globalThis as { Bun?: unknown }).Bun = bunFfi;
  }
  vi.resetModules();
  return import("../src/cli/exit");
}

describe("safeExit", () => {
  test("under Node: calls process.exit and never touches process.kill", async () => {
    const { safeExit } = await loadExit(undefined);
    safeExit(0);
    expect(processExitMock).toHaveBeenCalledWith(0);
    expect(processKillMock).not.toHaveBeenCalled();
    expect(ffiDlopen).not.toHaveBeenCalled();
  });

  test("under Node: passes the code through to process.exit", async () => {
    const { safeExit } = await loadExit(undefined);
    safeExit(137);
    expect(processExitMock).toHaveBeenCalledWith(137);
  });

  test("under Bun: calls FFI _exit first (process.exit is unreachable in prod)", async () => {
    const { safeExit } = await loadExit({});
    safeExit(0);
    // In production the FFI `_exit` actually terminates the process; the
    // subsequent `process.exit(code)` is unreachable. Our mock `_exit` is a
    // void-returning stub so the helper reaches the `process.exit` line —
    // assert the FFI ran FIRST, ordering matters more than absence.
    expect(ffiDlopen).toHaveBeenCalled();
    expect(ffiSymbols._exit).toHaveBeenCalledWith(0);
    expect(ffiSymbols._exit.mock.invocationCallOrder[0]).toBeLessThan(
      processExitMock.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  test("under Bun when FFI dlopen throws: falls back to process.exit", async () => {
    ffiDlopen.mockImplementation(() => {
      throw new Error("dlopen failed");
    });
    const { safeExit } = await loadExit({});
    safeExit(2);
    expect(processExitMock).toHaveBeenCalledWith(2);
    expect(ffiSymbols._exit).not.toHaveBeenCalled();
  });
});

describe("forcedExit", () => {
  test("under Node: calls process.kill(self, SIGKILL) and SKIPS process.exit", async () => {
    const { forcedExit } = await loadExit(undefined);
    expect(() => forcedExit(0)).toThrow("__forcedExit__:0");
    expect(processKillMock).toHaveBeenCalledTimes(1);
    const [pid, sig] = processKillMock.mock.calls[0] as [
      number,
      NodeJS.Signals,
    ];
    expect(pid).toBe(process.pid);
    expect(sig).toBe("SIGKILL");
    expect(processExitMock).not.toHaveBeenCalled();
    expect(ffiDlopen).not.toHaveBeenCalled();
  });

  test("under Node: sets process.exitCode before SIGKILL", async () => {
    // Seer review (PR #1520): SIGKILL doesn't carry the exit code, so the
    // helper must set process.exitCode first so shells (and waitpid) see the
    // code after the forced termination.
    const savedExitCode = process.exitCode;
    try {
      const { forcedExit } = await loadExit(undefined);
      expect(() => forcedExit(130)).toThrow("__forcedExit__:130");
      expect(process.exitCode).toBe(130);
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  test("under Bun: calls FFI _exit first (process.kill/exit unreachable in prod)", async () => {
    const { forcedExit } = await loadExit({});
    expect(() => forcedExit(0)).toThrow("__forcedExit__:0");
    expect(ffiDlopen).toHaveBeenCalled();
    expect(ffiSymbols._exit).toHaveBeenCalledWith(0);
    expect(processKillMock).not.toHaveBeenCalled();
  });

  test("under Bun when FFI dlopen fails: falls back to process.kill self SIGKILL", async () => {
    ffiDlopen.mockImplementation(() => {
      throw new Error("dlopen failed");
    });
    const { forcedExit } = await loadExit({});
    expect(() => forcedExit(0)).toThrow("__forcedExit__:0");
    expect(processKillMock).toHaveBeenCalledWith(process.pid, "SIGKILL");
    expect(processExitMock).not.toHaveBeenCalled();
    expect(ffiSymbols._exit).not.toHaveBeenCalled();
  });
});
