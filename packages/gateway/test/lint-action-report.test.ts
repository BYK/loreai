import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";
import {
  failedSemanticLintReport,
  MAX_LINT_REPORT_CANDIDATES,
  MAX_LINT_REPORT_RESOLVED_REASON_LENGTH,
  validateSemanticLintReport,
  type SemanticLintReport,
} from "../src/cli/lint-report";

const actionDirectory = resolve(
  import.meta.dirname,
  "../../../.github/actions/lint",
);
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function report(): SemanticLintReport {
  return {
    schemaVersion: 1,
    status: "complete",
    model: "test/model",
    effort: "off",
    elapsedMs: 1,
    range: { base: "a", head: "b", source: "test" },
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
      hunkVectors: { status: "healthy", expected: 0, available: 0, missing: 0 },
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
  };
}

function runReporter(value: unknown, gate: boolean, cliExit: number) {
  const directory = mkdtempSync(join(tmpdir(), "lore-action-report-"));
  directories.push(directory);
  const resultPath = join(directory, "report.json");
  const summaryPath = join(directory, "summary.md");
  if (value !== undefined) writeFileSync(resultPath, JSON.stringify(value));
  const result = spawnSync(
    process.execPath,
    [
      join(actionDirectory, "report.mjs"),
      resultPath,
      String(gate),
      String(cliExit),
    ],
    {
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: summaryPath },
    },
  );
  return {
    ...result,
    summary: (() => {
      try {
        return readFileSync(summaryPath, "utf8");
      } catch {
        return "";
      }
    })(),
  };
}

function resolvedReport(
  candidateCount = 1,
  reason = "The invariant is satisfied.",
): SemanticLintReport {
  const value = report();
  value.health.judge = {
    status: "healthy",
    selected: candidateCount,
    resolved: candidateCount,
    unresolved: 0,
    notAttempted: 0,
  };
  value.counters = {
    ...value.counters,
    candidates: candidateCount,
    attempted: candidateCount,
    resolved: candidateCount,
    semanticCalls: candidateCount,
    transportAttempts: candidateCount,
  };
  value.candidates = Array.from({ length: candidateCount }, (_, index) => ({
    id: `candidate-${index + 1}`,
    file: `src/file-${index + 1}.ts`,
    invariantId: `inv-${index + 1}`,
    invariantTitle: "Rule",
    state: "resolved",
    verdict: "satisfies",
    reason,
    stats: { semanticCalls: 1, transportAttempts: 1 },
  }));
  return value;
}

function unresolvedReport(): SemanticLintReport {
  const value = report();
  value.status = "failed";
  value.health.judge = {
    status: "failed",
    selected: 1,
    resolved: 0,
    unresolved: 1,
    notAttempted: 0,
  };
  value.counters = {
    ...value.counters,
    candidates: 1,
    attempted: 1,
    unresolved: 1,
    semanticCalls: 1,
  };
  value.candidates = [
    {
      id: "candidate-1",
      file: "src/file.ts",
      invariantId: "inv-1",
      invariantTitle: "Rule",
      state: "unresolved",
      failure: {
        code: "timeout",
        message: "judge timed out",
        scope: "candidate",
      },
      stats: { semanticCalls: 1, transportAttempts: 0 },
    },
  ];
  return value;
}

function actionAccepts(value: unknown, cliExit = 0): boolean {
  return !runReporter(value, false, cliExit).stdout.includes(
    "unreadable or invalid report",
  );
}

describe("semantic lint action reporter", () => {
  test("accepts embedding readiness failures produced by the CLI validator", () => {
    const value = failedSemanticLintReport({
      model: "test/model",
      effort: "off",
      elapsedMs: 1,
      range: { base: "a", head: "b", source: "test" },
      failedPhase: "invariantSource",
      failure: {
        code: "embedding-provider-readiness-failed",
        message: "local provider exhausted retries",
      },
      gateMode: "advisory",
    });

    expect(validateSemanticLintReport(value)).toBe(value);
    expect(actionAccepts(value, 3)).toBe(true);
  });

  test("accepts the same boundary report as the CLI validator", () => {
    const value = resolvedReport(
      MAX_LINT_REPORT_CANDIDATES,
      "x".repeat(MAX_LINT_REPORT_RESOLVED_REASON_LENGTH),
    );

    expect(validateSemanticLintReport(value)).toBe(value);
    expect(actionAccepts(value)).toBe(true);
  });

  test.each([
    [
      "too many candidates",
      () => resolvedReport(MAX_LINT_REPORT_CANDIDATES + 1),
    ],
    [
      "an overlong resolved reason",
      () =>
        resolvedReport(
          1,
          "x".repeat(MAX_LINT_REPORT_RESOLVED_REASON_LENGTH + 1),
        ),
    ],
    [
      "an empty range identity",
      () => {
        const value = report();
        value.range = { base: "", head: "b", source: "test" };
        return value;
      },
    ],
    [
      "an empty candidate identity",
      () => {
        const value = resolvedReport();
        value.candidates[0].file = "";
        return value;
      },
    ],
    [
      "a non-string candidate ID",
      () => {
        const value = resolvedReport() as unknown as {
          candidates: Array<Record<string, unknown>>;
        };
        value.candidates[0].id = 1;
        return value;
      },
    ],
    [
      "a resolved candidate failure",
      () => {
        const value = resolvedReport();
        value.candidates[0].failure = {
          code: "timeout",
          message: "unexpected stale failure",
          scope: "candidate",
        };
        return value;
      },
    ],
    [
      "an unresolved candidate verdict",
      () => {
        const value = unresolvedReport() as unknown as {
          candidates: Array<Record<string, unknown>>;
        };
        value.candidates[0].verdict = "violates";
        return value;
      },
    ],
    [
      "a non-string finding ID",
      () => {
        const value = report() as unknown as Record<string, unknown>;
        value.findings = [
          {
            id: 1,
            invariantId: "inv",
            invariantTitle: "Rule",
            invariantContent: "Rule content",
            file: "src/file.ts",
            similarity: 1,
            refHit: true,
            reason: null,
            hunk: "@@ -1,1 +1,1 @@",
            severity: "advisory",
          },
        ];
        (value.gate as Record<string, unknown>).advisoryFindingIds = [1];
        return value;
      },
    ],
    [
      "a complete report with a not-run phase",
      () => {
        const value = report();
        value.health.diff.status = "not-run";
        return value;
      },
    ],
  ])("CLI and action both reject %s", (_, makeValue) => {
    const value = makeValue();
    expect(() => validateSemanticLintReport(value)).toThrow();
    expect(actionAccepts(value, 3)).toBe(false);
  });

  test("reports a valid complete advisory run without blocking", () => {
    const result = runReporter(report(), false, 0);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("exit 0: complete, non-blocking");
    expect(result.stdout).toContain("no suspected invariant violations");
    expect(result.summary).toContain("No suspected invariant violations");
  });

  test("makes malformed reports visible but nonblocking in advisory mode", () => {
    const malformed = { ...report(), schemaVersion: 2 };
    const result = runReporter(malformed, false, 3);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("health failure");
    expect(result.stdout).toContain("Advisory mode remains non-blocking");
    expect(result.stdout).not.toContain("no suspected invariant violations");
  });

  test("fails closed on a missing report in gate mode", () => {
    const result = runReporter(undefined, true, 1);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("exit 1: CLI usage or argument failure");
    expect(result.stdout).toContain("Gate mode fails closed");
  });

  test("fails gate mode on blocking finding exit 2", () => {
    const value = report();
    value.gate = {
      mode: "gate",
      blockingFindingIds: ["finding-01"],
      overridden: [],
      advisoryFindingIds: [],
      wouldBlockFindingIds: ["finding-01"],
    };
    value.findings = [
      {
        id: "finding-01",
        invariantId: "inv",
        invariantTitle: "Never bypass validation",
        invariantContent: "Validation must never be bypassed.",
        file: "src/file.ts",
        similarity: 1,
        refHit: true,
        reason: "The guard was removed.",
        hunk: "@@ -1,1 +1,1 @@",
        severity: "strict",
      },
    ];
    const result = runReporter(value, true, 2);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("exit 2: complete with blocking findings");
    expect(result.stdout).toContain("::error file=src/file.ts");
  });

  test("rejects gate classifications that contradict mode or severity", () => {
    const finding = {
      id: "finding-01",
      invariantId: "inv",
      invariantTitle: "Never bypass validation",
      invariantContent: "Validation must never be bypassed.",
      file: "src/file.ts",
      similarity: 1,
      refHit: true,
      reason: "The guard was removed.",
      hunk: "@@ -1,1 +1,1 @@",
      severity: "strict" as const,
    };
    const advisory = report();
    advisory.findings = [finding];
    advisory.gate = {
      mode: "advisory",
      blockingFindingIds: [finding.id],
      overridden: [],
      advisoryFindingIds: [],
      wouldBlockFindingIds: [finding.id],
    };
    const advisoryResult = runReporter(advisory, false, 0);
    expect(advisoryResult.stdout).toContain(
      "advisory reports cannot contain blocking findings",
    );
    expect(advisoryResult.summary).not.toContain(
      "No suspected invariant violations",
    );

    const gate = report();
    gate.findings = [finding];
    gate.gate = {
      mode: "gate",
      blockingFindingIds: [],
      overridden: [],
      advisoryFindingIds: [finding.id],
      wouldBlockFindingIds: [finding.id],
    };
    const gateResult = runReporter(gate, true, 3);
    expect(gateResult.status).toBe(1);
    expect(gateResult.stdout).toMatch(
      /gate (blocking|advisory) findings disagree/,
    );
    expect(gateResult.summary).not.toContain(
      "No suspected invariant violations",
    );
  });

  test("rejects internally inconsistent counters", () => {
    const value = report();
    value.counters.candidates = 1;
    value.counters.attempted = 1;
    value.counters.resolved = 1;
    const result = runReporter(value, false, 3);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/disagrees with counters/);
    expect(result.stdout).not.toContain("no suspected invariant violations");
    expect(result.summary).not.toContain("No suspected invariant violations");
  });

  test.each([
    [
      "missing judge counters",
      (value: SemanticLintReport) => {
        delete (value.health.judge as Partial<typeof value.health.judge>)
          .notAttempted;
      },
    ],
    [
      "complete unresolved work",
      (value: SemanticLintReport) => {
        value.counters.candidates = 1;
        value.counters.attempted = 1;
        value.counters.unresolved = 1;
        value.health.judge = {
          status: "healthy",
          selected: 1,
          resolved: 0,
          unresolved: 1,
          notAttempted: 0,
        };
        value.candidates = [
          {
            id: "candidate-01",
            file: "src/file.ts",
            invariantId: "inv",
            invariantTitle: "Rule",
            state: "unresolved",
            failure: {
              code: "timeout",
              message: "judge timed out",
              scope: "candidate",
            },
            stats: { semanticCalls: 0, transportAttempts: 0 },
          },
        ];
      },
    ],
  ])("does not render malformed %s reports as clean", (_, mutate) => {
    const value = report();
    mutate(value);
    const result = runReporter(value, false, 0);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("unreadable or invalid report");
    expect(result.stdout).not.toContain("no suspected invariant violations");
    expect(result.summary).not.toContain("No suspected invariant violations");
  });

  test("neutralizes and caps report-controlled Markdown summary fields", () => {
    const value = report();
    value.findings = [
      {
        id: "finding-01",
        invariantId: "inv",
        invariantTitle: "<img src=x onerror=alert(1)> [title](https://bad)",
        invariantContent: "Rule",
        file: "[file](https://bad/file)",
        similarity: 1,
        refHit: true,
        reason: `![image](https://bad/image) ${"x".repeat(1_000)}`,
        hunk: "@@ -1,1 +1,1 @@",
        severity: "advisory",
      },
    ];
    value.gate.advisoryFindingIds = ["finding-01"];

    const result = runReporter(value, false, 0);
    expect(result.status).toBe(0);
    expect(result.summary).toContain("&lt;img src=x onerror=alert\\(1\\)&gt;");
    expect(result.summary).not.toContain("<img");
    expect(result.summary).not.toContain("[title](https://bad)");
    expect(result.summary).not.toContain("![image](https://bad/image)");
    expect(result.summary).not.toContain("x".repeat(400));
  });

  test("groups unresolved causes in annotations and the job summary", () => {
    const value = report();
    value.status = "failed";
    value.health.judge = {
      status: "failed",
      selected: 1,
      resolved: 0,
      unresolved: 1,
      notAttempted: 0,
    };
    value.counters = {
      ...value.counters,
      candidates: 1,
      attempted: 1,
      unresolved: 1,
      semanticCalls: 1,
      transportAttempts: 0,
    };
    value.candidates = [
      {
        id: "candidate-01",
        file: "src/file.ts",
        invariantId: "inv",
        invariantTitle: "Rule",
        state: "unresolved",
        failure: {
          code: "no-auth",
          message: "missing credential",
          scope: "run",
        },
        stats: { semanticCalls: 1, transportAttempts: 0 },
      },
    ];

    const result = runReporter(value, false, 3);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("causes: no-auth: 1");
    expect(result.summary).toContain("Unresolved causes:** no-auth: 1");
  });

  test("action uses the report channel and reference deadlines", () => {
    const action = readFileSync(join(actionDirectory, "action.yml"), "utf8");
    expect(action).toContain('default: "1200"');
    expect(action).toContain('default: "90"');
    expect(action).toContain("--report-file");
    expect(action).toContain("if: always()");
    expect(action).not.toMatch(/>\s*\/tmp\/lore-ic\.json/);
  });

  test("reference workflow runs trusted base code and diffs exact event SHAs", () => {
    const workflow = readFileSync(
      resolve(actionDirectory, "../../workflows/semantic-linter.yml"),
      "utf8",
    );
    expect(workflow).toContain(
      "ref: ${{ github.event.pull_request.base.sha }}",
    );
    expect(workflow).toContain(
      "PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}",
    );
    expect(workflow).toContain(
      "PR_NUMBER: ${{ github.event.pull_request.number }}",
    );
    expect(workflow).toContain(
      '"+refs/pull/${PR_NUMBER}/head:refs/remotes/origin/lore-pr-head"',
    );
    expect(workflow).toContain(
      "base: ${{ github.event.pull_request.base.sha }}",
    );
    expect(workflow).toContain(
      "head: ${{ github.event.pull_request.head.sha }}",
    );
    expect(workflow).toContain("continue-on-error: true");
    expect(workflow).toContain("pull_request_target:");
    expect(workflow).toContain(
      "model: ${{ secrets.LORE_WORKER_API_KEY != '' && vars.LORE_INVARIANT_MODEL || (secrets.LORE_WORKER_API_KEY == '' && secrets.ANTHROPIC_API_KEY != '' && 'anthropic/claude-haiku-4-5' || '') }}",
    );
    expect(workflow).toContain(
      "worker-api-key: ${{ secrets.LORE_WORKER_API_KEY != '' && secrets.LORE_WORKER_API_KEY || secrets.ANTHROPIC_API_KEY }}",
    );
    expect(workflow).not.toContain("|| github.token");
    expect(workflow).not.toContain("copilot-requests: write");
    expect(workflow).not.toMatch(/^\s+pull_request:\s*$/m);
  });

  test("published workflow guide preserves trusted credential/model pairing", () => {
    const guide = readFileSync(
      resolve(
        actionDirectory,
        "../../../packages/website/src/content/docs/docs/guides/semantic-linter.md",
      ),
      "utf8",
    );
    expect(guide).toContain("pull_request_target:");
    expect(guide).toContain("ref: ${{ github.event.pull_request.base.sha }}");
    expect(guide).toContain(
      "secrets.LORE_WORKER_API_KEY != '' && vars.LORE_INVARIANT_MODEL",
    );
    expect(guide).toContain("secrets.ANTHROPIC_API_KEY");
    expect(guide).not.toContain("|| github.token");
    expect(guide).not.toContain("copilot-requests: write");
    expect(guide).not.toMatch(/^\s+pull_request:\s*$/m);
  });
});
