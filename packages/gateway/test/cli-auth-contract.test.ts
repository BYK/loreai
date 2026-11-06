/**
 * Phase 3D.2 — typed `lore login` / `lore logout` contract.
 *
 * Pins both typed auth commands. Interactive login writes directly, while
 * logout uses `runLegacyAndCollect`. Mock their legacy handlers so these
 * contract tests never authenticate or prompt for real input.
 *
 * What's verified:
 *   - Routing wiring: login/logout in STRICLI_ROUTES, NOT in
 *     LEGACY_ROUTES (per-slice removal rule).
 *   - Flag schema: login declares --email and --no-browser; logout
 *     declares nothing.
 *   - Login instructions reach stdout before the pending input completes;
 *     JSON mode refuses before starting authentication or prompting.
 *   - Logout's captured stdout reaches Stricli's stdout.write output path.
 *   - Flag forwarding: typed --email is forwarded as `values.email`
 *     to the legacy handler.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

interface FakeArgs {
  positionals: string[];
  values: Record<string, unknown>;
}

const realLog = console.log;
const realError = console.error;
const realExit = process.exit;
const origNoUpdateCheck = process.env.LORE_NO_UPDATE_CHECK;

beforeEach(() => {
  process.env.LORE_NO_UPDATE_CHECK = "1";
});

afterEach(() => {
  console.log = realLog;
  console.error = realError;
  process.exit = realExit;
});

afterAll(() => {
  if (origNoUpdateCheck === undefined) delete process.env.LORE_NO_UPDATE_CHECK;
  else process.env.LORE_NO_UPDATE_CHECK = origNoUpdateCheck;
});

function setupLegacyMocks(): {
  loginCalls: FakeArgs[];
  logoutCalls: { n: number };
  loginImpl: ReturnType<
    typeof vi.fn<
      (positionals: string[], values: Record<string, unknown>) => Promise<void>
    >
  >;
  logoutImpl: ReturnType<typeof vi.fn>;
} {
  const loginCalls: FakeArgs[] = [];
  const logoutCalls = { n: 0 };

  const loginImpl = vi.fn(
    async (positionals: string[], values: Record<string, unknown>) => {
      loginCalls.push({ positionals: [...positionals], values: { ...values } });
      console.log("Already logged in.");
    },
  );
  const logoutImpl = vi.fn(async () => {
    logoutCalls.n += 1;
    console.log("Logged out.");
  });

  vi.doMock("../src/cli/login", () => ({
    commandLogin: loginImpl,
    commandLogout: logoutImpl,
  }));

  return {
    loginCalls,
    logoutCalls: { n: 0 },
    loginImpl,
    logoutImpl,
  };
}

describe("Phase 3D.2 — typed lore login", () => {
  test("login is registered in STRICLI_ROUTES", async () => {
    const { STRICLI_ROUTES } = await import("../src/cli/lib/argv");
    expect(STRICLI_ROUTES.has("login")).toBe(true);
  });

  test("login is NOT in LEGACY_ROUTES", async () => {
    const { LEGACY_ROUTES } = await import("../src/cli/app");
    expect(LEGACY_ROUTES.has("login")).toBe(false);
  });

  test("login declares --email and --no-browser flags", async () => {
    const { buildApplication, buildRouteMap, run } =
      await import("@stricli/core");
    const { loginCommand } = await import("../src/cli/commands/auth");
    const { buildContext } = await import("../src/cli/context");

    const app = buildApplication(
      buildRouteMap({
        routes: { login: loginCommand },
        docs: { brief: "lore" },
      }),
      { name: "lore" },
    );
    const seen = new Set<string>();
    const origWrite = process.stdout.write;
    const writeSpy = ((chunk: string | Buffer) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      for (const m of text.matchAll(/--[a-z][a-zA-Z0-9-]*/g)) seen.add(m[0]);
      return true;
    }) as never;
    process.stdout.write = writeSpy;
    try {
      await run(app, ["login", "--help"], buildContext(process));
    } finally {
      process.stdout.write = origWrite;
    }
    expect(seen.has("--email")).toBe(true);
    expect(seen.has("--no-browser")).toBe(true);
  });

  test("login forwards --email as values.email to the legacy handler", async () => {
    vi.resetModules();
    const mocks = setupLegacyMocks();
    const { runCli } = await import("../src/cli/cli");

    process.argv = ["node", "lore", "login", "--email", "test@example.com"];
    const stdoutChunks: Buffer[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      for (const a of args) {
        stdoutChunks.push(Buffer.isBuffer(a) ? a : Buffer.from(String(a)));
      }
    });
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        stdoutChunks.push(
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)),
        );
        return true;
      });
    const priorExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      await runCli();
    } finally {
      logSpy.mockRestore();
      stdoutSpy.mockRestore();
      process.exitCode = priorExitCode;
    }
    expect(mocks.loginImpl).toHaveBeenCalledTimes(1);
    const lastCall = mocks.loginCalls[mocks.loginCalls.length - 1];
    expect(lastCall?.values.email).toBe("test@example.com");
    expect(Buffer.concat(stdoutChunks).toString("utf8")).toContain(
      "Already logged in.",
    );
    vi.resetModules();
  });

  test("login forwards --no-browser as values['no-browser'] (truthy)", async () => {
    vi.resetModules();
    const mocks = setupLegacyMocks();
    const { runCli } = await import("../src/cli/cli");

    process.argv = ["node", "lore", "login", "--no-browser"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const priorExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      await runCli();
    } finally {
      logSpy.mockRestore();
      stdoutSpy.mockRestore();
      process.exitCode = priorExitCode;
    }
    expect(mocks.loginImpl).toHaveBeenCalledTimes(1);
    const lastCall = mocks.loginCalls[mocks.loginCalls.length - 1];
    expect(lastCall?.values["no-browser"]).toBe(true);
    vi.resetModules();
  });

  test("interactive instructions reach stdout before login input resolves and are never duplicated", async () => {
    vi.resetModules();
    const mocks = setupLegacyMocks();
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const pendingInput = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.loginImpl.mockImplementation(async () => {
      console.log("Open the fixture sign-in URL, then enter its code.");
      enter();
      await pendingInput;
      console.log("Fixture login complete.");
    });
    const { runCli } = await import("../src/cli/cli");
    const argv = process.argv;
    const exitCode = process.exitCode;
    const stdout: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      stdout.push(`${args.map(String).join(" ")}\n`);
    });
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        stdout.push(String(chunk));
        return true;
      });
    process.argv = ["node", "lore", "login", "--no-browser"];
    process.exitCode = 0;
    const run = runCli();
    try {
      await entered;
      expect(stdout.join("")).toContain(
        "Open the fixture sign-in URL, then enter its code.",
      );
      expect(stdout.join("")).not.toContain("Fixture login complete.");
    } finally {
      release();
      await run;
      logSpy.mockRestore();
      stdoutSpy.mockRestore();
      process.argv = argv;
      process.exitCode = exitCode;
      vi.resetModules();
    }
    expect(mocks.loginImpl).toHaveBeenCalledTimes(1);
    expect(stdout.join("").match(/Open the fixture sign-in URL/g)).toHaveLength(
      1,
    );
    expect(stdout.join("").match(/Fixture login complete/g)).toHaveLength(1);
  });

  test("login --json refuses before authentication or prompting", async () => {
    vi.resetModules();
    const mocks = setupLegacyMocks();
    const { runCli } = await import("../src/cli/cli");
    const argv = process.argv;
    const exitCode = process.exitCode;
    const stdout: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      stdout.push(`${args.map(String).join(" ")}\n`);
    });
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        stdout.push(String(chunk));
        return true;
      });
    process.argv = [
      "node",
      "lore",
      "login",
      "--json",
      "--email",
      "fixture@example.test",
    ];
    process.exitCode = 0;
    try {
      await runCli();
      expect(mocks.loginImpl).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(JSON.parse(stdout.join(""))).toEqual({
        output: "Login requires an interactive terminal; run without --json.",
      });
    } finally {
      logSpy.mockRestore();
      stdoutSpy.mockRestore();
      process.argv = argv;
      process.exitCode = exitCode;
      vi.resetModules();
    }
  });
});

describe("Phase 3D.2 — typed lore logout", () => {
  test("logout is registered in STRICLI_ROUTES", async () => {
    const { STRICLI_ROUTES } = await import("../src/cli/lib/argv");
    expect(STRICLI_ROUTES.has("logout")).toBe(true);
  });

  test("logout is NOT in LEGACY_ROUTES", async () => {
    const { LEGACY_ROUTES } = await import("../src/cli/app");
    expect(LEGACY_ROUTES.has("logout")).toBe(false);
  });

  test("logout forwards to commandLogout and surfaces its stdout", async () => {
    vi.resetModules();
    const mocks = setupLegacyMocks();
    const { runCli } = await import("../src/cli/cli");

    process.argv = ["node", "lore", "logout"];
    const stdoutChunks: Buffer[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      for (const a of args) {
        stdoutChunks.push(Buffer.isBuffer(a) ? a : Buffer.from(String(a)));
      }
    });
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        stdoutChunks.push(
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)),
        );
        return true;
      });
    const priorExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      await runCli();
    } finally {
      logSpy.mockRestore();
      stdoutSpy.mockRestore();
      process.exitCode = priorExitCode;
    }
    expect(mocks.logoutImpl).toHaveBeenCalledTimes(1);
    expect(Buffer.concat(stdoutChunks).toString("utf8")).toContain(
      "Logged out.",
    );
    vi.resetModules();
  });
});
