import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import type { ReadOffloadCheck } from "@loreai/core";

// Mutable state driving the @loreai/core mock so each test can steer the
// `--check-read-offload` handler down a specific branch (ok / failure statuses
// / db throw) without a real DB or a real worker thread. Hoisted alongside
// vi.mock (lifted to the top of the file) so both the state and the safeExit
// spy exist when the mock factories run.
const { state, safeExit } = vi.hoisted(() => ({
  state: {
    dbThrows: false,
    result: { status: "ok" } as ReadOffloadCheck,
  },
  safeExit: vi.fn(),
}));

// Partial mock: keep every real export (main.ts → start.ts → config.ts pulls
// several at module load) and override only the two the handler calls.
vi.mock("@loreai/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@loreai/core")>();
  return {
    ...actual,
    db: () => {
      if (state.dbThrows) throw new Error("db boom");
      return { query: () => ({ get: () => ({}), all: () => [] }) };
    },
    checkReadOffload: async () => state.result,
  };
});

// `safeExit` normally terminates the process; here it's a no-op so the handler
// returns and the test runner survives. Resolves to the same module file that
// main.ts imports via `./exit`.
vi.mock("../src/cli/exit", () => ({ safeExit }));

import { _cli } from "../src/cli/main";

describe("--check-read-offload CLI diagnostic", () => {
  const origArgv = process.argv;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    state.dbThrows = false;
    state.result = { status: "ok" };
    safeExit.mockClear();
    process.argv = ["node", "lore", "--check-read-offload"];
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit:${code}`);
    }) as never);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  afterAll(() => {
    process.argv = origArgv;
  });

  test("worker round-trip ok: prints the worker line and exits 0", async () => {
    state.result = { status: "ok" };

    await _cli();

    expect(logSpy).toHaveBeenCalledWith("ok read-offload via worker");
    expect(safeExit).toHaveBeenCalledWith(0);
    expect(errSpy).not.toHaveBeenCalled();
  });

  test("worker init-error: prints the failing status on stdout and exits 1", async () => {
    state.result = { status: "init-error", error: "open boom" };

    await _cli();

    expect(logSpy).toHaveBeenCalledWith(
      "read-offload failed: init-error (open boom)",
    );
    expect(logSpy).not.toHaveBeenCalledWith("ok read-offload via worker");
    expect(safeExit).toHaveBeenCalledWith(1);
  });

  test("worker read-error: exits 1", async () => {
    state.result = { status: "read-error", error: "scan boom" };

    await _cli();

    expect(logSpy).toHaveBeenCalledWith(
      "read-offload failed: read-error (scan boom)",
    );
    expect(safeExit).toHaveBeenCalledWith(1);
  });

  test("worker timeout (no error detail): exits 1 without a trailing paren", async () => {
    state.result = { status: "timeout" };

    await _cli();

    expect(logSpy).toHaveBeenCalledWith("read-offload failed: timeout");
    expect(safeExit).toHaveBeenCalledWith(1);
  });

  test("spawn-error: exits 1", async () => {
    state.result = { status: "spawn-error", error: "no worker" };

    await _cli();

    expect(logSpy).toHaveBeenCalledWith(
      "read-offload failed: spawn-error (no worker)",
    );
    expect(safeExit).toHaveBeenCalledWith(1);
  });

  test("db error: prints failure via console.error and exits 1", async () => {
    state.dbThrows = true;

    await _cli();

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("✗ check-read-offload failed: db boom"),
    );
    expect(safeExit).toHaveBeenCalledWith(1);
  });
});
