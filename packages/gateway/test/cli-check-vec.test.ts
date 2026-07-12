import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

// Mutable state driving the @loreai/core mock, so each test can steer the
// `--check-vec` handler down a specific branch (native / fallback / error)
// without a real DB or the native extension.
// Hoisted alongside vi.mock (which is lifted to the top of the file) so both
// the state and the safeExit spy exist when the mock factories run.
const { state, safeExit } = vi.hoisted(() => ({
  state: {
    vecAvailable: true,
    // `undefined` simulates `SELECT vec_version()` returning a row with no `v`.
    // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- widening for the mutable fixture; tests reassign undefined below
    vecVersion: "v0.1.9" as string | undefined,
    dbThrows: false,
    // Drives the off-thread read-pool probe (checkVecWorker). Defaults to a
    // healthy native worker so the main-thread assertions in existing tests
    // keep exiting 0.
    worker: {
      // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- widening for the mutable fixture; tests reassign other statuses below
      status: "ready" as "ready" | "init-error" | "timeout" | "spawn-error",
      vecAvailable: true,
      error: undefined as string | undefined,
    },
  },
  safeExit: vi.fn(),
}));

// Partial mock: keep every real export (main.ts → start.ts → config.ts pulls
// several at module load) and override only the two the handler calls.
vi.mock("@loreai/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@loreai/core")>();
  return {
    ...actual,
    isVecAvailable: () => state.vecAvailable,
    db: () => {
      if (state.dbThrows) throw new Error("db boom");
      return {
        query: (_sql: string) => ({
          get: () =>
            state.vecVersion === undefined ? {} : { v: state.vecVersion },
        }),
      };
    },
    checkVecWorker: async () => ({
      status: state.worker.status,
      vecAvailable: state.worker.vecAvailable,
      error: state.worker.error,
    }),
  };
});

// `safeExit` normally terminates the process; here it's a no-op so the handler
// returns and the test runner survives. Resolves to the same module file that
// main.ts imports via `./exit`.
vi.mock("../src/cli/exit", () => ({ safeExit }));

import { _cli } from "../src/cli/main";

describe("--check-vec CLI diagnostic", () => {
  const origArgv = process.argv;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    state.vecAvailable = true;
    state.vecVersion = "v0.1.9";
    state.dbThrows = false;
    state.worker = { status: "ready", vecAvailable: true, error: undefined };
    safeExit.mockClear();
    process.argv = ["node", "lore", "--check-vec"];
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

  test("native available: prints vec_version and exits 0", async () => {
    state.vecAvailable = true;
    state.vecVersion = "v0.1.9";

    await _cli();

    expect(logSpy).toHaveBeenCalledWith("ok vec_version=v0.1.9");
    expect(safeExit).toHaveBeenCalledWith(0);
    expect(errSpy).not.toHaveBeenCalled();
  });

  test("worker native available: prints the off-thread worker line", async () => {
    state.worker = { status: "ready", vecAvailable: true, error: undefined };

    await _cli();

    expect(logSpy).toHaveBeenCalledWith("ok vec_version=v0.1.9");
    expect(logSpy).toHaveBeenCalledWith("ok worker vec_available=true");
    expect(safeExit).toHaveBeenCalledWith(0);
    expect(errSpy).not.toHaveBeenCalled();
  });

  test("worker fallback: prints worker fallback, still exits 0", async () => {
    state.worker = { status: "ready", vecAvailable: false, error: undefined };

    await _cli();

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("worker fallback (native sqlite-vec not loaded"),
    );
    // A worker fallback is platform-expected (e.g. darwin dylib codesigning) —
    // exit 0, exactly like the main-thread fallback. CI's grep is the gate.
    expect(safeExit).toHaveBeenCalledWith(0);
  });

  test("worker structural failure: prints reason on stdout, still exits 0", async () => {
    state.worker = {
      status: "init-error",
      vecAvailable: false,
      error: "open boom",
    };

    await _cli();

    expect(logSpy).toHaveBeenCalledWith(
      "worker check failed: init-error (open boom)",
    );
    // Exit code is unchanged (only an unexpected throw flips it); CI's
    // `grep ^ok worker` is what fails the smoke on a real regression.
    expect(safeExit).toHaveBeenCalledWith(0);
  });

  test("native available but version row empty: prints 'unknown'", async () => {
    state.vecAvailable = true;
    state.vecVersion = undefined;

    await _cli();

    expect(logSpy).toHaveBeenCalledWith("ok vec_version=unknown");
    expect(safeExit).toHaveBeenCalledWith(0);
  });

  test("native unavailable: reports JS fallback and exits 0", async () => {
    state.vecAvailable = false;

    await _cli();

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("fallback (native sqlite-vec not loaded"),
    );
    expect(safeExit).toHaveBeenCalledWith(0);
  });

  test("db error: prints failure and exits 1", async () => {
    state.dbThrows = true;

    await _cli();

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("✗ check-vec failed: db boom"),
    );
    expect(safeExit).toHaveBeenCalledWith(1);
  });
});
