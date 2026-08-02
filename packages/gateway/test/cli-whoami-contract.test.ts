/**
 * Phase 3A — typed `lore whoami` contract.
 *
 * Verifies the Stricli adapter:
 *   - Renders the logged-in identity in human mode (just `@login` / email).
 *   - Emits structured JSON when `--json` is set.
 *   - Returns AuthError(10) with a `Try: lore login` recovery command when
 *     no session exists.
 *   - Honors `--verify` and includes `verified: true|false` in the JSON.
 *
 * Supabase helpers are mocked so the test never opens a network connection
 * and never reads the real local session store.
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

vi.mock("../src/cli/lib/version-check", () => ({
  shouldSuppressNotification: () => true,
  maybeCheckForUpdateInBackground: () => {},
  getUpdateNotification: () => null,
  abortPendingVersionCheck: () => {},
}));

let mockSession: { user_id: string; github_login: string; email: string } | null = null;
let mockVerify: boolean = false;

vi.mock("../src/supabase", () => ({
  isLoggedIn: () => mockSession !== null,
  clearSession: () => {
    mockSession = null;
  },
  getCurrentUser: async (opts: { verify?: boolean }) => {
    mockVerify = Boolean(opts?.verify);
    return mockSession;
  },
  createSupabaseClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: mockSession } }),
    },
  }),
}));

import { runCli } from "../src/cli/cli";

async function runWith(argv: string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
}> {
  process.argv = ["node", "lore", ...argv];
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
    for (const a of args) {
      stdoutChunks.push(
        Buffer.isBuffer(a) ? a : Buffer.from(String(a)),
      );
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
  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk) => {
      stderrChunks.push(
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
    stderrSpy.mockRestore();
  }
  const exitCode = process.exitCode;
  process.exitCode = priorExitCode;
  return {
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    exitCode,
  };
}

describe("Phase 3A — typed lore whoami", () => {
  const origArgv = process.argv;
  const origNoUpdateCheck = process.env.LORE_NO_UPDATE_CHECK;

  beforeEach(() => {
    mockSession = null;
    mockVerify = false;
    process.env.LORE_NO_UPDATE_CHECK = "1";
  });

  afterEach(() => {
    process.argv = origArgv;
  });

  afterAll(() => {
    if (origNoUpdateCheck === undefined) delete process.env.LORE_NO_UPDATE_CHECK;
    else process.env.LORE_NO_UPDATE_CHECK = origNoUpdateCheck;
  });

  test("human mode prints just the identity when logged in", async () => {
    mockSession = {
      user_id: "user-abc",
      github_login: "byk",
      email: "ben@byk.im",
    };
    const { stdout, exitCode } = await runWith(["whoami"]);
    expect(stdout.trim()).toBe("@byk");
    expect(exitCode).toBe(0);
  });

  test("--json emits structured account fields", async () => {
    mockSession = {
      user_id: "user-abc",
      github_login: "byk",
      email: "ben@byk.im",
    };
    const { stdout, exitCode } = await runWith(["whoami", "--json"]);
    expect(exitCode).toBe(0);
    // Extract just the JSON object — `--json` may also emit hints on stderr.
    const trimmed = stdout.trim();
    const parsed = JSON.parse(trimmed);
    expect(parsed).toEqual({
      user_id: "user-abc",
      email: "ben@byk.im",
      github_login: "byk",
      display_name: null,
      verified: false,
    });
  });

  test("--verify sets verified: true in JSON output", async () => {
    mockSession = {
      user_id: "user-abc",
      github_login: "byk",
      email: "ben@byk.im",
    };
    const { stdout } = await runWith(["whoami", "--json", "--verify"]);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.verified).toBe(true);
    expect(mockVerify).toBe(true);
  });

  test("falls back to email when github_login is missing", async () => {
    mockSession = {
      user_id: "user-abc",
      github_login: "",
      email: "ben@byk.im",
    };
    const { stdout } = await runWith(["whoami"]);
    expect(stdout.trim()).toBe("ben@byk.im");
  });

  test("not logged in → AuthError with try: lore login and exitCode 10", async () => {
    mockSession = null;
    const { stderr, exitCode } = await runWith(["whoami"]);
    expect(exitCode).toBe(10);
    expect(stderr).toContain("Not logged in");
    expect(stderr).toContain("Try: lore login");
  });
});