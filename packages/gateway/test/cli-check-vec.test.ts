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
    vecVersion: "v0.1.9" as string | undefined,
    dbThrows: false,
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
