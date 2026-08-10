import { parseReasoningEffort, type ReasoningEffort } from "@loreai/core";
import { buildOutputCommand } from "../lib/command";
import { runSemanticLint } from "../invariant-check";
import {
  renderSemanticLintReport,
  semanticLintExitCode,
  writeSemanticLintReport,
  type SemanticLintReport,
} from "../lint-report";

type LintFlags = {
  base?: string;
  head?: string;
  model?: string;
  project?: string;
  effort?: ReasoningEffort;
  gate: boolean;
  "import-lore-md": boolean;
  "report-file"?: string;
  "deadline-ms": number;
  "candidate-timeout-ms": number;
};

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError("must be a positive integer");
  }
  return parsed;
}

function reasoningEffort(value: string): ReasoningEffort {
  const parsed = parseReasoningEffort(value);
  if (!parsed)
    throw new TypeError("must be one of: off, low, medium, high, xhigh");
  return parsed;
}

export const lintCommand = buildOutputCommand<SemanticLintReport, LintFlags>({
  brief: "Check changes against documented semantic invariants",
  fullDescription:
    "Writes a versioned health report and exits 3 when the run is inconclusive. " +
    "Findings are advisory by default; --gate exits 2 for blocking findings.",
  parameters: {
    flags: {
      base: {
        kind: "parsed",
        parse: String,
        brief: "Base commit SHA (default: auto-detect)",
        optional: true,
      },
      head: {
        kind: "parsed",
        parse: String,
        brief: "Head commit SHA (default: auto-detect)",
        optional: true,
      },
      model: {
        kind: "parsed",
        parse: String,
        brief: "Judge model (provider/modelID or bare modelID)",
        optional: true,
      },
      project: {
        kind: "parsed",
        parse: String,
        brief: "Project directory (default: cwd)",
        optional: true,
      },
      effort: {
        kind: "parsed",
        parse: reasoningEffort,
        brief: "Reasoning effort: off, low, medium, high, xhigh",
        optional: true,
      },
      gate: {
        kind: "boolean",
        brief: "Fail complete runs with blocking strict/soft findings",
        default: false,
      },
      "import-lore-md": {
        kind: "boolean",
        brief: "Import repository lore before linting",
        default: false,
      },
      "report-file": {
        kind: "parsed",
        parse: String,
        brief: "Atomically write the versioned JSON report to this path",
        optional: true,
      },
      "deadline-ms": {
        kind: "parsed",
        parse: positiveInteger,
        brief: "Overall lint deadline in milliseconds",
        default: "1200000",
      },
      "candidate-timeout-ms": {
        kind: "parsed",
        parse: positiveInteger,
        brief: "Per-candidate judge timeout in milliseconds",
        default: "90000",
      },
    },
  },
  config: {
    renderHuman: renderSemanticLintReport,
  },
  async handler(flags) {
    const reportFile = flags["report-file"];
    const report = await runSemanticLint({
      base: flags.base,
      head: flags.head,
      model: flags.model,
      project: flags.project ?? this.cwd,
      effort: flags.effort,
      gate: flags.gate,
      importLoreMd: flags["import-lore-md"],
      deadlineMs: flags["deadline-ms"],
      candidateTimeoutMs: flags["candidate-timeout-ms"],
      onDiagnostic: (message) =>
        this.process.stderr.write(`[lore] ${message}\n`),
      onJudge: (current, total) =>
        this.process.stderr.write(`\r[lore]   judging ${current}/${total}...`),
      publishReport: reportFile
        ? (value) => writeSemanticLintReport(reportFile, value)
        : undefined,
    });
    const exitCode = semanticLintExitCode(report);
    (this.process as NodeJS.Process).exitCode = exitCode;
    return { kind: "value", data: report };
  },
});
