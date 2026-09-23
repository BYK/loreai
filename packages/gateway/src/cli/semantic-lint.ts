import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  config as loreConfig,
  embedding,
  importLoreFile,
  semanticLint,
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
  /** Optional PR metadata; action callers pass it through env safely. */
  prTitle?: string;
  prDescription?: string;
  model?: string;
  project: string;
  effort?: ReasoningEffort;
  gate: boolean;
  importLoreMd: boolean;
  /** Import and embed .lore.md even when the diff contains no code hunks. */
  primeLoreDb?: boolean;
  deadlineMs: number;
  candidateTimeoutMs: number;
  /** Approximate total input-token budget for one holistic small-PR lint. */
  holisticInputTokens?: number;
  /** Allow commit trailers to override soft findings (trusted local use only). */
  allowAuthorOverrides?: boolean;
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

export function parseLegacyHolisticInputTokens(value: unknown): number {
  if (value === undefined || value === null || value === "") return 16_000;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError("holistic-input-tokens must be a positive integer");
  }
  return parsed;
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
    holisticInputTokenBudget: input.options.holisticInputTokens,
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
    range = semanticLint.resolveRange(projectPath, {
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

    /** Env vars: LORE_PR_TITLE and LORE_PR_DESCRIPTION provide bounded, untrusted pull-request metadata for semantic lint prompts. */
    // PR metadata is author-controlled input. Gate mode deliberately omits it
    // instead of allowing prompt-injected context to affect a blocking result.
    const prContext = options.gate
      ? undefined
      : semanticLint.normalizeSemanticLintContext?.({
          title: options.prTitle ?? process.env.LORE_PR_TITLE,
          description: options.prDescription ?? process.env.LORE_PR_DESCRIPTION,
          base: range.base,
          head: range.head,
        });

    phase = "diff";
    throwIfDeadlineExceeded();
    options.onDiagnostic?.(
      `semantic-lint: ${range.base.slice(0, 12)}..${range.head.slice(0, 12)} (${range.source})`,
    );

    const diff = semanticLint.parseDiffResult(
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

    const invariantSource: LintPhaseHealth = { status: "healthy" };
    if (diff.hunks.length === 0 && !options.primeLoreDb) {
      // No changed code can violate an invariant. Preserve core's zero-work
      // contract without starting the gateway, importing .lore.md, or requiring
      // an embedding provider merely because the action requested import. Cache
      // priming opts in to the import path explicitly so a .lore.md-only commit
      // can populate the derived DB.
      phase = "invariantVectors";
      const result = await semanticLint.checkInvariants({
        projectPath,
        diff,
        range,
        prContext,
        model,
        effort,
        sessionID: `semantic-lint-${Date.now()}`,
        signal: deadlineController.signal,
        deadlineMs: Math.max(0, deadlineAt - Date.now()),
        holisticInputTokenBudget: options.holisticInputTokens,
      });
      throwIfDeadlineExceeded();
      const gate = semanticLint.gateDecision(
        result.findings,
        [],
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
      throwIfDeadlineExceeded();
      await options.publishReport?.(report);
      return report;
    }

    phase = "invariantSource";
    throwIfDeadlineExceeded();
    if (options.importLoreMd && !existsSync(join(projectPath, ".lore.md"))) {
      report = failedReport({
        options,
        startedAt,
        model,
        effort,
        range,
        phase,
        code: "invariant-source-import-failed",
        error: "Requested invariant source .lore.md does not exist",
      });
      await options.publishReport?.(report);
      return report;
    }
    const startOpts: StartOptions = { quiet: true, local: true };
    const gateway = await startGateway(startOpts);
    owned = gateway.owned;
    shutdown = gateway.shutdown;
    throwIfDeadlineExceeded();
    if (options.importLoreMd) {
      try {
        await embedding.ensureEmbeddingReady({
          signal: deadlineController.signal,
          deadlineMs: Math.max(1, deadlineAt - Date.now()),
        });
        throwIfDeadlineExceeded();
      } catch (error) {
        throwIfDeadlineExceeded();
        report = failedReport({
          options,
          startedAt,
          model,
          effort,
          range,
          phase,
          code: "embedding-provider-readiness-failed",
          error,
        });
        await options.publishReport?.(report);
        return report;
      }
      try {
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
    const judgeUpstreams = gateway.config.workerUpstream
      ? {
          anthropic: gateway.config.workerUpstream,
          openai: gateway.config.workerUpstream,
        }
      : {
          anthropic: gateway.config.upstreamAnthropic,
          openai: gateway.config.upstreamOpenAI,
        };
    const client = createGatewayLLMClient(judgeUpstreams, judgeAuth, model, {
      dedicatedWorkerKey: !!workerKey,
      disableModelFallbacks: workerKey === "copilot-sdk-bridge",
      hostedMode: gateway.config.hostedMode,
    });
    const judge = createGatewayInvariantJudge({
      client,
      model,
      upstreamUrl: gateway.config.workerUpstream,
      effort,
      sessionID: `semantic-lint-${Date.now()}`,
      candidateTimeoutMs: options.candidateTimeoutMs,
      signal: deadlineController.signal,
    });
    // Keep every production capability explicit at the orchestration boundary.
    const holisticJudge: semanticLint.HolisticLintJudge = judge;
    const verifier: semanticLint.CounterevidenceVerifier = judge;

    // Core returns typed health for expected vector/judge failures. If it throws,
    // the exact internal phase is unknown, so fail at the first uncompleted
    // mandatory phase rather than claiming later phases were healthy.
    phase = "invariantVectors";
    throwIfDeadlineExceeded();
    const result = await semanticLint.checkInvariants({
      projectPath,
      diff,
      range,
      prContext,
      judge,
      holisticJudge,
      verifier,
      holisticInputTokenBudget: options.holisticInputTokens,
      model,
      effort,
      sessionID: `semantic-lint-${Date.now()}`,
      signal: deadlineController.signal,
      deadlineMs: Math.max(0, deadlineAt - Date.now()),
      onJudge: options.onJudge,
    });
    // Preserve a typed core failure returned at the cancellation boundary.
    // Successful/partial work still must not cross the overall deadline.
    const preserveFailedAtDeadline =
      result.status === "failed" &&
      (deadlineController.signal.aborted || Date.now() >= deadlineAt);
    if (!preserveFailedAtDeadline) throwIfDeadlineExceeded();
    const overrides =
      preserveFailedAtDeadline || !options.allowAuthorOverrides
        ? []
        : semanticLint.parseOverrides(
            semanticLint.collectCommitMessages(
              projectPath,
              range.base,
              range.head,
            ),
          );
    if (!preserveFailedAtDeadline) throwIfDeadlineExceeded();
    const gate = semanticLint.gateDecision(
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
export async function commandSemanticLint(
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
    prTitle: values["pr-title"] as string | undefined,
    prDescription: values["pr-description"] as string | undefined,
    model: values.model as string | undefined,
    project: resolve((values.project as string | undefined) ?? process.cwd()),
    effort: effort ?? undefined,
    gate: values.gate === true,
    importLoreMd: values["import-lore-md"] === true,
    primeLoreDb: values["prime-lore-db"] === true,
    deadlineMs: Number(values["deadline-ms"] ?? 1_200_000),
    candidateTimeoutMs: Number(values["candidate-timeout-ms"] ?? 90_000),
    holisticInputTokens: parseLegacyHolisticInputTokens(
      values["holistic-input-tokens"],
    ),
    allowAuthorOverrides: values["allow-author-overrides"] === true,
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
