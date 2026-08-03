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
 *
 * The test exercises the Stricli route (runCli → STRICLI_ROUTES),
 * so the legacy `version-check` shim and `LORE_NO_UPDATE_CHECK` env
 * var are not needed here (they only affect the legacy `_cli()` path).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

interface MemoryHealth {
  embeddings: { available: boolean; state: string; detail: string };
  worker: { ok: boolean; detail: string };
}

interface FakeState {
  port: number | null;
  alive: boolean;
  memory: MemoryHealth | null;
  opencodeInstalled: boolean;
  inventory: Array<{
    app: string;
    file: string;
    fileExists: boolean;
    rows: Array<{
      app: string;
      file: string;
      fileExists: boolean;
      key: string;
      routing:
        | { kind: "lore"; value: string }
        | { kind: "other"; value: string }
        | { kind: "unset" };
    }>;
    hasBackup: boolean;
  }>;
}

const fakeState = vi.hoisted<FakeState>(() => ({
  port: 3207,
  alive: true,
  memory: {
    embeddings: { available: true, state: "loaded", detail: "ok" },
    worker: { ok: true, detail: "ok" },
  },
  opencodeInstalled: true,
  inventory: [],
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
    collectInventory: () => fakeState.inventory,
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

  beforeEach(() => {
    fakeState.port = 3207;
    fakeState.alive = true;
    fakeState.memory = {
      embeddings: { available: true, state: "loaded", detail: "ok" },
      worker: { ok: true, detail: "ok" },
    };
    fakeState.opencodeInstalled = true;
    fakeState.inventory = [];
  });

  afterEach(() => {
    process.argv = origArgv;
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
    // Human mode: assert a [FAIL] finding shows up in the rendered
    // section and the summary line counts it correctly.
    expect(stdout).toContain("[FAIL]");
    expect(stdout).toMatch(/finding\(s\): 1 FAIL, 0 WARN, \d+ PASS/);
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

  // Human-mode sibling of the JSON-mode embeddings WARN test (Finding #8):
  // the rendered `[WARN] memory: embeddings: ...` line is a real user-facing
  // surface; the prior PR's Seer #1 was about exactly this rendering. Pin
  // the human-mode shape so a regression to the bracket/padding logic trips
  // the test.
  test("human mode renders [WARN] for embeddings-unavailable finding", async () => {
    fakeState.memory = {
      embeddings: { available: false, state: "retrying", detail: "broken" },
      worker: { ok: true, detail: "ok" },
    };
    const { stdout, exitCode } = await runWith(["doctor"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("[WARN]");
    expect(stdout).toContain("memory: embeddings");
    expect(stdout).not.toContain("[FAIL]");
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

  // Seer finding #1 (MEDIUM): the typed doctor command's inventory
  // printer must produce byte-for-byte identical output to the legacy
  // `commandDoctor` so consumers that grep `lore doctor` keep working.
  // The typed adapter now imports `formatInventoryRow` directly from
  // inventory.ts, so the legacy and typed paths can't drift. This test
  // pins the format by calling the same renderer on a known fixture
  // and asserting the exact line shape.
  // Finding #5: pin the inventory rendering end-to-end with a populated
  // AppInventory fixture so the typed adapter's per-row rendering is
  // exercised. Earlier tests mocked collectInventory to [] which left
  // this whole code path uncovered.
  test("renders populated inventory rows with the same format as the legacy printer", async () => {
    fakeState.inventory = [
      {
        app: "Claude Code",
        file: "~/.claude/settings.json",
        fileExists: true,
        rows: [
          {
            app: "Claude Code",
            file: "~/.claude/settings.json",
            fileExists: true,
            key: "env.ANTHROPIC_BASE_URL",
            routing: { kind: "lore", value: "http://127.0.0.1:3207" },
          },
        ],
        hasBackup: false,
      },
    ];
    const { stdout } = await runWith(["doctor"]);
    expect(stdout).toContain("[lore] Setup inventory:");
    expect(stdout).toContain("[lore] Claude Code  (~/.claude/settings.json)");
    // Per-row format pinned to the legacy shape.
    expect(stdout).toContain(
      "[lore]   Claude Code    env.ANTHROPIC_BASE_URL                 lore  http://127.0.0.1:3207   [~/.claude/settings.json]",
    );
  });

  test('missing inventory file renders a clear "file missing" line', async () => {
    fakeState.inventory = [
      {
        app: "Codex",
        file: "~/.codex/config.json",
        fileExists: false,
        rows: [],
        hasBackup: false,
      },
    ];
    const { stdout } = await runWith(["doctor"]);
    expect(stdout).toContain("[lore]   file missing — not configured.");
  });

  test("inventory row format matches legacy formatInventoryRow (Seer #1)", async () => {
    // Importing the renderer and asserting its output pins the format.
    const { formatInventoryRow } = await import("../src/cli/inventory");
    const row: import("../src/cli/inventory").InventoryRow = {
      app: "Claude Code",
      file: "~/.claude/settings.json",
      fileExists: true,
      key: "env.ANTHROPIC_BASE_URL",
      routing: { kind: "lore", value: "http://127.0.0.1:3207" },
    };
    // The doctor's renderInventory helper internally calls
    // `formatInventoryRow(row).trim()`. The legacy pads app to 14 chars
    // and key to 38 chars, then renders the routing and file part. Pin
    // the exact shape so a regression in either the legacy helper or
    // the typed adapter (which used to diverge via
    // formatInventoryRowCompat) is caught.
    expect(formatInventoryRow(row).trim()).toBe(
      "Claude Code    env.ANTHROPIC_BASE_URL                 lore  http://127.0.0.1:3207   [~/.claude/settings.json]",
    );
  });

  // Finding #3: pin the routing wiring. \`lore doctor\` must go through
  // the Stricli route (STRICLI_ROUTES), not the legacy case block in
  // main.ts. A future refactor that reverts the route to legacy would
  // otherwise fail no test that asserts it hasn't.
  test("doctor is registered in STRICLI_ROUTES (routing wiring)", async () => {
    const { STRICLI_ROUTES } = await import("../src/cli/lib/argv");
    expect(STRICLI_ROUTES.has("doctor")).toBe(true);
  });

  test("doctor is NOT in LEGACY_ROUTES (routing safety)", async () => {
    const { LEGACY_ROUTES } = await import("../src/cli/app");
    expect(LEGACY_ROUTES.has("doctor")).toBe(false);
  });
});
