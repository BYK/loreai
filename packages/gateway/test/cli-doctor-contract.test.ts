/**
 * Phase 3A.5 — typed `lore doctor` contract.
 *
 * Pins the typed adapter:
 *   - Exit code 0 when no FAIL findings, 1 when any FAIL is present.
 *   - Human mode renders inventory + diagnostics + summary line.
 *   - JSON mode emits { inventory, findings, summary } with the
 *     right summary counts.
 *   - The handler stamps process.exitCode when a FAIL is present.
 *
 * Mocks the IO sources (portfile, probeGateway, fetchMemoryHealth,
 * isNpmPackageInstalledSafe) so the test runs hermetically without
 * touching the filesystem or the network.
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

interface MemoryHealth {
  embeddings: { available: boolean; state: string; detail: string };
  worker: { ok: boolean; detail: string };
}

interface FakeState {
  port: number | null;
  alive: boolean;
  memory: MemoryHealth | null;
  opencodeInstalled: boolean;
}

const fakeState = vi.hoisted<FakeState>(() => ({
  port: 3207,
  alive: true,
  memory: {
    embeddings: { available: true, state: "loaded", detail: "ok" },
    worker: { ok: true, detail: "ok" },
  },
  opencodeInstalled: true,
}));

vi.mock("../src/portfile", () => ({
  readPortFile: () => fakeState.port,
}));

vi.mock("../src/cli/start", () => ({
  probeGateway: async () => fakeState.alive,
}));

vi.mock("../src/cli/inventory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/inventory")>();
  return {
    ...actual,
    fetchMemoryHealth: async () => fakeState.memory,
    isNpmPackageInstalledSafe: () => fakeState.opencodeInstalled,
    collectInventory: () => [],
  };
});

import { runCli } from "../src/cli/cli";

async function runWith(
  argv: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  process.argv = ["node", "lore", ...argv];
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
    for (const a of args) {
      stdoutChunks.push(Buffer.isBuffer(a) ? a : Buffer.from(String(a)));
    }
  });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
    for (const a of args) {
      stderrChunks.push(Buffer.isBuffer(a) ? a : Buffer.from(String(a)));
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
    errorSpy.mockRestore();
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

describe("Phase 3A.5 — typed lore doctor", () => {
  const origArgv = process.argv;
  const origNoUpdateCheck = process.env.LORE_NO_UPDATE_CHECK;

  beforeEach(() => {
    fakeState.port = 3207;
    fakeState.alive = true;
    fakeState.memory = {
      embeddings: { available: true, state: "loaded", detail: "ok" },
      worker: { ok: true, detail: "ok" },
    };
    fakeState.opencodeInstalled = true;
    process.env.LORE_NO_UPDATE_CHECK = "1";
  });

  afterEach(() => {
    process.argv = origArgv;
  });

  afterAll(() => {
    if (origNoUpdateCheck === undefined)
      delete process.env.LORE_NO_UPDATE_CHECK;
    else process.env.LORE_NO_UPDATE_CHECK = origNoUpdateCheck;
  });

  test("human mode renders the three sections: inventory, diagnostics, summary", async () => {
    const { stdout, exitCode } = await runWith(["doctor"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("[lore] Setup inventory:");
    expect(stdout).toContain("[lore] Diagnostics:");
    expect(stdout).toMatch(
      /\[lore\] \d+ finding\(s\): 0 FAIL, 0 WARN, \d+ PASS\./,
    );
  });

  test("--json returns structured payload with correct summary counts", async () => {
    const { stdout, exitCode } = await runWith(["doctor", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed).toEqual({
      inventory: [],
      findings: expect.any(Array),
      summary: expect.objectContaining({
        fail: 0,
        warn: expect.any(Number),
        pass: expect.any(Number),
      }),
    });
    // summary.total equals findings.length.
    expect(parsed.summary.total).toBe(parsed.findings.length);
  });

  test("gateway not alive → FAIL finding, exit code 1", async () => {
    fakeState.alive = false;
    fakeState.memory = null;
    const { stdout, exitCode } = await runWith(["doctor"]);
    expect(exitCode).toBe(1);
    const json = stdout.match(/\{[\s\S]*\}/);
    // We can't get JSON mode here because we're in human mode by
    // default. Just assert the human output has a FAIL finding.
    expect(stdout).toContain("[FAIL]");
    expect(stdout).toMatch(/finding\(s\): 1 FAIL, 0 WARN, \d+ PASS/);
    void json;
  });

  test("embeddings unavailable → WARN finding, exit code still 0", async () => {
    fakeState.memory = {
      embeddings: { available: false, state: "retrying", detail: "broken" },
      worker: { ok: true, detail: "ok" },
    };
    const { stdout, exitCode } = await runWith(["doctor", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    const embeddingsFinding = parsed.findings.find(
      (f: { label: string }) => f.label === "memory: embeddings",
    );
    expect(embeddingsFinding).toBeTruthy();
    expect(embeddingsFinding.level).toBe("WARN");
    expect(parsed.summary.warn).toBeGreaterThanOrEqual(1);
    expect(parsed.summary.fail).toBe(0);
  });

  test("gateway probe unreachable (no portfile) → FAIL finding", async () => {
    fakeState.port = null;
    fakeState.alive = false;
    fakeState.memory = null;
    const { stdout, exitCode } = await runWith(["doctor"]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("[FAIL]");
    expect(stdout).toContain("no gateway responding");
  });
});
