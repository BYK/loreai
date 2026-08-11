import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  config as loreConfig,
  embedding,
  importLoreFile,
  invariantCheck,
  parseReasoningEffort,
  type ReasoningEffort,
} from "@loreai/core";
import {
  createGatewayInvariantJudge,
  createGatewayLLMClient,
} from "../llm-adapter";
import { type AuthCredential, resolveAuth, workerKeyScheme } from "../auth";
import { startGateway, type StartOptions } from "./start";
import {
  buildSemanticLintReport,
  failedSemanticLintReport,
  renderSemanticLintReport,
  semanticLintExitCode,
  type LintPhaseHealth,
  type SemanticLintReport,
} from "./lint-report";

export interface SemanticLintOptions {
  base?: string;
  head?: string;
  model?: string;
  project: string;
  effort?: ReasoningEffort;
  gate: boolean;
  importLoreMd: boolean;
  deadlineMs: number;
  candidateTimeoutMs: number;
  onDiagnostic?: (message: string) => void;
  onJudge?: (current: number, total: number) => void;
  /** Called after validation and before gateway cleanup. */
  publishReport?: (report: SemanticLintReport) => void | Promise<void>;
}

type Model = { providerID: string; modelID: string };

function parseModel(spec: string | undefined): Model | undefined {
  if (!spec) return undefined;
  const slash = spec.indexOf("/");
  return slash === -1
    ? { providerID: "anthropic", modelID: spec }
    : { providerID: spec.slice(0, slash), modelID: spec.slice(slash + 1) };
}

function boundedMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.replace(/[\r\n\t]+/g, " ").trim() || fallback).slice(0, 400);
}

function failedReport(input: {
  options: SemanticLintOptions;
  startedAt: number;
  model: Model;
  effort: ReasoningEffort;
  range?: SemanticLintReport["range"];
  phase: Parameters<typeof failedSemanticLintReport>[0]["failedPhase"];
  code: string;
  error: unknown;
}): SemanticLintReport {
  return failedSemanticLintReport({
    model: `${input.model.providerID}/${input.model.modelID}`,
    effort: input.effort,
    elapsedMs: Date.now() - input.startedAt,
    range: input.range,
    failedPhase: input.phase,
    failure: {
      code: input.code,
      message: boundedMessage(input.error, "Semantic lint failed"),
    },
    gateMode: input.options.gate ? "gate" : "advisory",
  });
}

/** Process-I/O-free semantic lint orchestration boundary. */
export async function runSemanticLint(
  options: SemanticLintOptions,
): Promise<SemanticLintReport> {
  const startedAt = Date.now();
  const deadlineAt = startedAt + options.deadlineMs;
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(
    () =>
      deadlineController.abort(
        new DOMException("Semantic lint deadline exceeded", "TimeoutError"),
      ),
    options.deadlineMs,
  );
  deadlineTimer.unref?.();
  const projectPath = resolve(options.project);
  const modelOverride = parseModel(options.model);
  let model = modelOverride ?? {
    providerID: "anthropic",
    modelID: "claude-sonnet-4-6",
  };
  let effort: ReasoningEffort = options.effort ?? "off";
  let phase: Parameters<typeof failedSemanticLintReport>[0]["failedPhase"] =
    "range";
  let range: SemanticLintReport["range"] | undefined;
  let owned = false;
  let shutdown: (() => Promise<void>) | undefined;
  let report: SemanticLintReport;

  const throwIfDeadlineExceeded = (): void => {
    deadlineController.signal.throwIfAborted();
    if (Date.now() < deadlineAt) return;
    const reason = new DOMException(
      "Semantic lint deadline exceeded",
      "TimeoutError",
    );
    deadlineController.abort(reason);
    throw reason;
  };

  try {
    const cfg = loreConfig();
    model = modelOverride ?? cfg.model ?? model;
    effort = options.effort ?? cfg.invariantCheck.effort;
    throwIfDeadlineExceeded();
    range = invariantCheck.resolveRange(projectPath, {
      base: options.base,
      head: options.head,
    });
    if (!range) {
      throwIfDeadlineExceeded();
      report = failedReport({
        options,
        startedAt,
        model,
        effort,
        phase: "range",
        code: "range-resolution-failed",
        error:
          "Could not resolve a commit range. Pass --base <sha> --head <sha>.",
      });
      await options.publishReport?.(report);
      return report;
    }
    phase = "diff";
    throwIfDeadlineExceeded();
    options.onDiagnostic?.(
      `invariant-check: ${range.base.slice(0, 12)}..${range.head.slice(0, 12)} (${range.source})`,
    );

    const diff = invariantCheck.parseDiffResult(
      projectPath,
      range.base,
      range.head,
    );
    throwIfDeadlineExceeded();
    if (diff.kind === "failure") {
      report = failedReport({
        options,
        startedAt,
        model,
        effort,
        range,
        phase,
        code: diff.failure.code,
        error: diff.failure.message,
      });
      await options.publishReport?.(report);
      return report;
    }

    phase = "invariantSource";
    throwIfDeadlineExceeded();
    const startOpts: StartOptions = { quiet: true, local: true };
    const gateway = await startGateway(startOpts);
    owned = gateway.owned;
    shutdown = gateway.shutdown;
    throwIfDeadlineExceeded();
    const invariantSource: LintPhaseHealth = { status: "healthy" };
    if (options.importLoreMd) {
      try {
        if (!existsSync(join(projectPath, ".lore.md"))) {
          throw new Error("Requested invariant source .lore.md does not exist");
        }
        importLoreFile(projectPath);
        const remainingMs = Math.max(1, deadlineAt - Date.now());
        await embedding.settleDocumentEmbeds({
          signal: deadlineController.signal,
          deadlineMs: remainingMs,
        });
        const embedded = await embedding.backfillEmbeddings({
          signal: deadlineController.signal,
          deadlineMs: Math.max(1, deadlineAt - Date.now()),
        });
        options.onDiagnostic?.(
          `seeded invariants from .lore.md (backfilled ${embedded} embeddings)`,
        );
      } catch (error) {
        // Overall cancellation outranks an import-specific failure so callers
        // retain the typed deadline-exceeded outcome.
        throwIfDeadlineExceeded();
        report = failedReport({
          options,
          startedAt,
          model,
          effort,
          range,
          phase,
          code: "invariant-source-import-failed",
          error,
        });
        await options.publishReport?.(report);
        return report;
      }
    }
    throwIfDeadlineExceeded();

    const workerKey = gateway.config.workerApiKey;
    const judgeAuth: (
      sessionID?: string,
      providerID?: string,
    ) => AuthCredential | null = workerKey
      ? (_sessionID, providerID) => ({
          scheme: workerKeyScheme(providerID ?? model.providerID),
          value: workerKey,
        })
      : resolveAuth;
    const client = createGatewayLLMClient(
      {
        anthropic: gateway.config.upstreamAnthropic,
        openai: gateway.config.upstreamOpenAI,
      },
      judgeAuth,
      model,
      { dedicatedWorkerKey: !!workerKey },
    );
    const judge = createGatewayInvariantJudge({
      client,
      model,
      effort,
      sessionID: `invariant-check-${Date.now()}`,
      candidateTimeoutMs: options.candidateTimeoutMs,
      signal: deadlineController.signal,
    });

    // Core returns typed health for expected vector/judge failures. If it throws,
    // the exact internal phase is unknown, so fail at the first uncompleted
    // mandatory phase rather than claiming later phases were healthy.
    phase = "invariantVectors";
    throwIfDeadlineExceeded();
    const result = await invariantCheck.checkInvariants({
      projectPath,
      diff,
      range,
      judge,
      model,
      effort,
      sessionID: `invariant-check-${Date.now()}`,
      signal: deadlineController.signal,
      deadlineMs: Math.max(0, deadlineAt - Date.now()),
      onJudge: options.onJudge,
    });
    // Do not accept even a complete zero-work core result after the overall
    // orchestration deadline has elapsed.
    throwIfDeadlineExceeded();
    const overrides = invariantCheck.parseOverrides(
      invariantCheck.collectCommitMessages(projectPath, range.base, range.head),
    );
    throwIfDeadlineExceeded();
    const gate = invariantCheck.gateDecision(
      result.findings,
      overrides,
      options.gate ? "gate" : "advisory",
    );
    report = buildSemanticLintReport({
      result,
      gate,
      model: `${model.providerID}/${model.modelID}`,
      effort,
      elapsedMs: Date.now() - startedAt,
      invariantSource,
    });
    // Publication is the externally visible clean-result boundary. Re-check
    // immediately before it so no expired run can publish as complete.
    if (report.status === "complete") throwIfDeadlineExceeded();
    await options.publishReport?.(report);
    return report;
  } catch (error) {
    report = failedReport({
      options,
      startedAt,
      model,
      effort,
      range,
      phase,
      code:
        deadlineController.signal.aborted || Date.now() >= deadlineAt
          ? "deadline-exceeded"
          : "runtime-error",
      error,
    });
    await options.publishReport?.(report);
    return report;
  } finally {
    clearTimeout(deadlineTimer);
    if (owned && shutdown) {
      try {
        await shutdown();
      } catch (error) {
        options.onDiagnostic?.(
          `gateway cleanup failed after report publication: ${boundedMessage(error, "unknown cleanup error")}`,
        );
      }
    }
  }
}

/** Legacy programmatic dispatcher entry; the Stricli route does not use it. */
export async function commandInvariantCheck(
  _positionals: string[],
  values: Record<string, unknown>,
): Promise<void> {
  const effortRaw = values.effort as string | undefined;
  const effort = parseReasoningEffort(effortRaw);
  if (effortRaw && !effort)
    throw new TypeError(`Invalid reasoning effort: ${effortRaw}`);
  const report = await runSemanticLint({
    base: values.base as string | undefined,
    head: values.head as string | undefined,
    model: values.model as string | undefined,
    project: resolve((values.project as string | undefined) ?? process.cwd()),
    effort: effort ?? undefined,
    gate: values.gate === true,
    importLoreMd: values["import-lore-md"] === true,
    deadlineMs: Number(values["deadline-ms"] ?? 1_200_000),
    candidateTimeoutMs: Number(values["candidate-timeout-ms"] ?? 90_000),
    onDiagnostic: (message) => console.error(`[lore] ${message}`),
    onJudge: (current, total) =>
      process.stderr.write(`\r[lore]   judging ${current}/${total}...`),
  });
  const output = values.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${renderSemanticLintReport(report)}\n`;
  process.stdout.write(output);
  process.exitCode = semanticLintExitCode(report);
}
