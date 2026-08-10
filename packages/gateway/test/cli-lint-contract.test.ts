import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type {
  CoreLintResultLike,
  SemanticLintReport,
} from "../src/cli/lint-report";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function completeReport(
  overrides: Partial<SemanticLintReport> = {},
): SemanticLintReport {
  return {
    schemaVersion: 1,
    status: "complete",
    model: "github-copilot/gpt-5.6-luna",
    effort: "off",
    elapsedMs: 25,
    range: { base: "base", head: "head", source: "test" },
    health: {
      range: { status: "healthy" },
      diff: { status: "healthy" },
      invariantSource: { status: "healthy" },
      invariantVectors: {
        status: "healthy",
        expected: 0,
        available: 0,
        missing: 0,
      },
      hunkVectors: {
        status: "healthy",
        expected: 0,
        available: 0,
        missing: 0,
      },
      judge: {
        status: "healthy",
        selected: 0,
        resolved: 0,
        unresolved: 0,
        notAttempted: 0,
      },
    },
    counters: {
      hunks: 0,
      invariants: 0,
      candidates: 0,
      attempted: 0,
      resolved: 0,
      unresolved: 0,
      notAttempted: 0,
      semanticCalls: 0,
      transportAttempts: 0,
    },
    candidates: [],
    findings: [],
    gate: {
      mode: "advisory",
      blockingFindingIds: [],
      overridden: [],
      advisoryFindingIds: [],
      wouldBlockFindingIds: [],
    },
    ...overrides,
  };
}

describe("typed lore lint contract", () => {
  test("report construction does not leak internal candidate fields", async () => {
    const { buildSemanticLintReport } = await import("../src/cli/lint-report");
    const internalCandidate = {
      id: "candidate-01",
      file: "src/file.ts",
      invariantId: "inv-01",
      invariantTitle: "Keep reports strict",
      state: "resolved",
      verdict: "satisfies",
      reason: "The report projects only public fields.",
      stats: { semanticCalls: 1, transportAttempts: 1 },
      hunkIndex: 7,
    } satisfies CoreLintResultLike["candidateOutcomes"][number] & {
      hunkIndex: number;
    };
    const report = buildSemanticLintReport({
      result: {
        status: "complete",
        range: { base: "base", head: "head", source: "test" },
        health: {
          diff: { status: "healthy" },
          invariantVectors: {
            status: "healthy",
            expected: 1,
            available: 1,
            missing: 0,
          },
          hunkVectors: {
            status: "healthy",
            expected: 1,
            available: 1,
            missing: 0,
          },
          judge: {
            status: "healthy",
            selected: 1,
            resolved: 1,
            unresolved: 0,
            notAttempted: 0,
          },
        },
        hunks: 1,
        invariants: 1,
        candidates: 1,
        attempted: 1,
        resolved: 1,
        unresolved: 0,
        notAttempted: 0,
        semanticCalls: 1,
        transportAttempts: 1,
        candidateOutcomes: [internalCandidate],
        findings: [],
      },
      gate: { mode: "advisory", blocking: [], overridden: [], advisory: [] },
      model: "test/model",
      effort: "off",
      elapsedMs: 1,
      invariantSource: { status: "healthy" },
    });

    expect(report.candidates[0]).not.toHaveProperty("hunkIndex");
  });

  test("lint is routed through Stricli, not the legacy route set", async () => {
    const { STRICLI_ROUTES } = await import("../src/cli/lib/argv");
    const { LEGACY_ROUTES } = await import("../src/cli/app");
    expect(STRICLI_ROUTES.has("lint")).toBe(true);
    expect(LEGACY_ROUTES.has("lint")).toBe(false);
  });

  test("lint command does not use runLegacyAndCollect", async () => {
    const source = await readFile(
      new URL("../src/cli/commands/lint.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("runLegacyAndCollect");
    expect(source).toContain("runSemanticLint");
  });

  test("declares report and deadline flags", async () => {
    const { buildApplication, buildRouteMap, run } =
      await import("@stricli/core");
    const { lintCommand } = await import("../src/cli/commands/lint");
    const { buildContext } = await import("../src/cli/context");
    const app = buildApplication(
      buildRouteMap({ routes: { lint: lintCommand }, docs: { brief: "lore" } }),
      { name: "lore" },
    );
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Buffer) => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      await run(app, ["lint", "--help"], buildContext(process));
    } finally {
      process.stdout.write = original;
    }
    const help = chunks.join("");
    for (const flag of [
      "--base",
      "--head",
      "--model",
      "--project",
      "--effort",
      "--gate",
      "--import-lore-md",
      "--report-file",
      "--deadline-ms",
      "--candidate-timeout-ms",
      "--json",
    ]) {
      expect(help).toContain(flag);
    }
  });

  test("direct orchestration writes the owned report file and emits flat JSON", async () => {
    const report = completeReport();
    const runSemanticLint = vi.fn(async (options) => {
      await options.publishReport?.(report);
      return report;
    });
    vi.doMock("../src/cli/invariant-check", () => ({ runSemanticLint }));

    const directory = await mkdtemp(join(tmpdir(), "lore-lint-contract-"));
    temporaryDirectories.push(directory);
    const reportPath = join(directory, "nested", "report.json");
    const { buildApplication, buildRouteMap, run } =
      await import("@stricli/core");
    const { lintCommand } = await import("../src/cli/commands/lint");
    const { buildContext } = await import("../src/cli/context");
    const app = buildApplication(
      buildRouteMap({ routes: { lint: lintCommand }, docs: { brief: "lore" } }),
      { name: "lore" },
    );
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    const priorExitCode = process.exitCode;
    process.stdout.write = (chunk: string | Buffer) => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      await run(
        app,
        [
          "lint",
          "--json",
          "--report-file",
          reportPath,
          "--deadline-ms",
          "1200",
          "--candidate-timeout-ms",
          "90",
        ],
        buildContext(process),
      );
      expect(process.exitCode).toBe(0);
    } finally {
      process.stdout.write = original;
      process.exitCode = priorExitCode;
    }

    expect(JSON.parse(chunks.join(""))).toEqual(report);
    expect(JSON.parse(await readFile(reportPath, "utf8"))).toEqual(report);
    expect(runSemanticLint).toHaveBeenCalledWith(
      expect.objectContaining({
        deadlineMs: 1200,
        candidateTimeoutMs: 90,
        publishReport: expect.any(Function),
      }),
    );
  });

  test("validator rejects counter and candidate-attempt mismatches", async () => {
    const { validateSemanticLintReport } =
      await import("../src/cli/lint-report");
    const malformed = completeReport({
      counters: {
        ...completeReport().counters,
        candidates: 1,
        attempted: 1,
        resolved: 1,
      },
    });
    expect(() => validateSemanticLintReport(malformed)).toThrow(
      /disagrees with.*counters|candidate record count disagrees/,
    );
  });

  test("validator requires judge counters and rejects false-complete health", async () => {
    const { validateSemanticLintReport } =
      await import("../src/cli/lint-report");
    const missing = completeReport();
    delete (missing.health.judge as Partial<typeof missing.health.judge>)
      .selected;
    expect(() => validateSemanticLintReport(missing)).toThrow(
      /health\.judge\.selected/,
    );

    const inconsistent = completeReport();
    inconsistent.health.judge.status = "degraded";
    expect(() => validateSemanticLintReport(inconsistent)).toThrow(
      /judge status disagrees|overall status disagrees/,
    );
  });

  test("validator enforces gate classifications by mode and severity", async () => {
    const { validateSemanticLintReport } =
      await import("../src/cli/lint-report");
    const strictFinding = {
      id: "finding-01",
      invariantId: "inv",
      invariantTitle: "Rule",
      invariantContent: "Never bypass this rule.",
      file: "src/file.ts",
      similarity: 1,
      refHit: true,
      reason: "The rule was bypassed.",
      hunk: "@@ -1,1 +1,1 @@",
      severity: "strict" as const,
    };
    const advisoryWithBlocking = completeReport({
      findings: [strictFinding],
      gate: {
        mode: "advisory",
        blockingFindingIds: [strictFinding.id],
        overridden: [],
        advisoryFindingIds: [],
        wouldBlockFindingIds: [strictFinding.id],
      },
    });
    expect(() => validateSemanticLintReport(advisoryWithBlocking)).toThrow(
      /advisory reports cannot contain blocking/,
    );

    const gateWithAdvisoryStrict = completeReport({
      findings: [strictFinding],
      gate: {
        mode: "gate",
        blockingFindingIds: [],
        overridden: [],
        advisoryFindingIds: [strictFinding.id],
        wouldBlockFindingIds: [strictFinding.id],
      },
    });
    expect(() => validateSemanticLintReport(gateWithAdvisoryStrict)).toThrow(
      /blocking findings disagree|advisory findings disagree/,
    );
  });

  test("failed reports are versioned, writable, and select exit 3", async () => {
    const {
      failedSemanticLintReport,
      semanticLintExitCode,
      writeSemanticLintReport,
    } = await import("../src/cli/lint-report");
    const failed = failedSemanticLintReport({
      model: "test/model",
      effort: "off",
      elapsedMs: 10,
      range: { base: "base", head: "head", source: "test" },
      failedPhase: "invariantSource",
      failure: {
        code: "runtime-error",
        message: "synthetic setup failure",
      },
      gateMode: "advisory",
    });
    const directory = await mkdtemp(join(tmpdir(), "lore-lint-failed-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "report.json");
    await writeSemanticLintReport(path, failed);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(failed);
    expect(failed.schemaVersion).toBe(1);
    expect(failed.status).toBe("failed");
    expect(semanticLintExitCode(failed)).toBe(3);
  });

  test("only complete reports can render a clean result", async () => {
    const { renderSemanticLintReport } = await import("../src/cli/lint-report");
    expect(renderSemanticLintReport(completeReport())).toContain(
      "No suspected invariant violations",
    );
    const failed = completeReport({
      status: "failed",
      health: {
        ...completeReport().health,
        judge: { status: "failed" },
      },
    });
    expect(renderSemanticLintReport(failed)).not.toContain(
      "No suspected invariant violations",
    );
    expect(renderSemanticLintReport(failed)).toContain("inconclusive");
  });
});
