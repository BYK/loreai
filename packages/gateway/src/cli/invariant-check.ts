/**
 * `lore invariant-check` — the "semantic linter" PoC.
 *
 * Surfaces changes that violate a documented team invariant, at change time.
 * This is a MEASUREMENT TOOL: it NEVER exits non-zero on findings — the whole
 * idea hinges on the false-positive rate, so the job is to print per-candidate
 * verdicts + cost so we can point it at real merged PRs and get an honest TP/FP
 * number before anyone gates a build on it.
 *
 * Base/head are auto-detected (Craft-style) from git + CI env, or overridden
 * with --base/--head. --model sweeps a specific worker model for the eval.
 *
 * Usage:
 *   lore invariant-check [--base <sha>] [--head <sha>] [--model <provider/id>]
 *                        [--project <path>] [--json]
 */
import { resolve } from "node:path";
import {
  config as loreConfig,
  embedding,
  importLoreFile,
  invariantCheck,
} from "@loreai/core";
import { createGatewayLLMClient } from "../llm-adapter";
import { type AuthCredential, resolveAuth, workerKeyScheme } from "../auth";
import { startGateway, type StartOptions } from "./start";

type CheckResult = invariantCheck.CheckResult;

/** Parse a `provider/modelID` (or bare `modelID`) into the model shape. */
function parseModel(
  spec: string | undefined,
): { providerID: string; modelID: string } | undefined {
  if (!spec) return undefined;
  const slash = spec.indexOf("/");
  if (slash === -1) {
    // Bare model id — default provider to anthropic (worker routing still
    // applies its guardrails downstream).
    return { providerID: "anthropic", modelID: spec };
  }
  return { providerID: spec.slice(0, slash), modelID: spec.slice(slash + 1) };
}

export async function commandInvariantCheck(
  _positionals: string[],
  values: Record<string, unknown>,
): Promise<void> {
  const projectPath = resolve((values.project as string) ?? process.cwd());
  const asJson = !!values.json;
  const modelOverride = parseModel(values.model as string | undefined);
  // CI flow: no local lore.db exists, so seed the active DB (LORE_DB_PATH,
  // typically an actions/cache path) from the repo's `.lore.md`. Deriving
  // embeddings is fire-and-forget, so we drain them below before the funnel —
  // otherwise the cosine prefilter runs against a DB with no vectors.
  const importLoreMd =
    values["import-lore-md"] === true || values.importLoreMd === true;
  // Enforcement mode. Default `advisory` — nothing ever blocks (exit 0). `--gate`
  // opts into blocking: strict findings and un-overridden soft findings fail
  // (exit 2). Even in gate mode, an invariant only reaches strict/soft via
  // explicit `enforce:` metadata, so a repo with no opt-ins gates on nothing.
  const gateMode: invariantCheck.GateMode =
    values.gate === true ? "gate" : "advisory";

  const range = invariantCheck.resolveRange(projectPath, {
    base: values.base as string | undefined,
    head: values.head as string | undefined,
  });

  if (!range) {
    console.error(
      "[lore] Could not resolve a commit range to check. Pass --base <sha> --head <sha>.",
    );
    // A tooling failure (can't find a range) is a real error — exit 1. Findings
    // never do; this isn't a finding.
    process.exit(1);
  }

  console.error(
    `[lore] invariant-check: ${range.base.slice(0, 12)}..${range.head.slice(0, 12)} (${range.source})`,
  );

  // Local gateway for LLM access (mirrors `lore import`).
  const startOpts: StartOptions = { quiet: true, local: true };
  const { config, owned, shutdown } = await startGateway(startOpts);
  const cfg = loreConfig();

  // Seed invariants from `.lore.md` when asked (CI). importLoreFile upserts
  // entries into the active DB. The create-path embeds are fire-and-forget AND
  // can silently fail during an unstable ONNX worker init (errors swallowed) —
  // so we do NOT trust them. Instead, after import we run backfillEmbeddings(),
  // which SYNCHRONOUSLY embeds every current+live entry still missing a vector,
  // in token-budget batches. It is idempotent (only fills gaps), so a partial
  // failure on one run is fully recovered on the next — no silent recall rot.
  // On a cache HIT the DB already matches `.lore.md` (mtime/hash fast-path) and
  // every vector is present, so both calls are cheap no-ops.
  // NOTE: `.lore.md` omits cross_project=1 entries (~16 global invariants), so a
  // `.lore.md`-sourced check has slightly narrower coverage than a full local
  // DB — acceptable for the advisory tier.
  if (importLoreMd) {
    const before = Date.now();
    importLoreFile(projectPath);
    await embedding.settleDocumentEmbeds();
    const embedded = await embedding.backfillEmbeddings();
    console.error(
      `[lore] invariant-check: seeded invariants from .lore.md (backfilled ${embedded} embeddings) in ${((Date.now() - before) / 1000).toFixed(1)}s`,
    );
  }
  const defaultModel = modelOverride ??
    cfg.model ?? { providerID: "anthropic", modelID: "claude-sonnet-4-6" };

  // Judge auth. In CI there is no client session, so bare resolveAuth() returns
  // null and every judge call is skipped as "no-auth". Honor LORE_WORKER_API_KEY
  // (the GHA sets it to the judge credential) the same way the pipeline's
  // getWorkerAuth does. Scheme is provider-aware via the shared workerKeyScheme:
  // GitHub Models needs the key as `Authorization: Bearer`; every other provider
  // uses api-key (x-api-key). Resolve per call on the worker model's provider,
  // falling back to the judge's default provider.
  const workerKey = config.workerApiKey;
  const judgeAuth: (
    sessionID?: string,
    providerID?: string,
  ) => AuthCredential | null = workerKey
    ? (_sessionID, providerID) => ({
        scheme: workerKeyScheme(providerID ?? defaultModel.providerID),
        value: workerKey,
      })
    : resolveAuth;

  const llm = createGatewayLLMClient(
    { anthropic: config.upstreamAnthropic, openai: config.upstreamOpenAI },
    judgeAuth,
    defaultModel,
    { dedicatedWorkerKey: !!workerKey },
  );

  const startedAt = Date.now();
  let result: CheckResult;
  try {
    const hunks = invariantCheck.parseDiff(projectPath, range.base, range.head);
    result = await invariantCheck.checkInvariants({
      projectPath,
      hunks,
      range,
      llm,
      model: defaultModel,
      sessionID: `invariant-check-${Date.now()}`,
      onJudge: (n, total) => {
        process.stderr.write(`\r[lore]   judging ${n}/${total}...`);
      },
    });
    process.stderr.write("\n");
  } finally {
    if (owned) await shutdown();
  }

  const elapsedMs = Date.now() - startedAt;

  // Gate decision. Overrides come from `lore-override:` trailers in the commit
  // messages of the range under review — always available from git, no API/token
  // and works on forks. In advisory mode the exitCode is always 0; we still
  // compute the classification so the report can show what WOULD block under
  // --gate (lets a team tune the FP rate before flipping the switch).
  const overrides = invariantCheck.parseOverrides(
    invariantCheck.collectCommitMessages(projectPath, range.base, range.head),
  );
  const gate = invariantCheck.gateDecision(
    result.findings,
    overrides,
    gateMode,
  );

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          model: `${defaultModel.providerID}/${defaultModel.modelID}`,
          elapsedMs,
          gate,
          ...result,
        },
        null,
        2,
      ),
    );
    // Set exitCode and RETURN — never process.exit() here. A synchronous
    // process.exit() right after a buffered stdout write can truncate the JSON
    // when stdout is redirected (the GHA does `... > lore-ic.json`), dropping
    // the very payload the reporter parses to explain a blocked build. Letting
    // the process drain naturally guarantees the write completes.
    process.exitCode = gate.exitCode;
    return;
  }

  printReport(result, defaultModel, elapsedMs, gate);
  process.exitCode = gate.exitCode;
}

function printReport(
  result: CheckResult,
  model: { providerID: string; modelID: string },
  elapsedMs: number,
  gate: invariantCheck.GateResult,
): void {
  const { findings } = result;
  console.log("");
  console.log("─".repeat(64));
  console.log(
    `Funnel: ${result.hunks} hunks × ${result.invariants} invariants → ` +
      `${result.candidates} candidates → ${result.judgeCalls} judge calls`,
  );
  console.log(
    `Model: ${model.providerID}/${model.modelID}   Time: ${(elapsedMs / 1000).toFixed(1)}s   Mode: ${gate.mode}`,
  );
  console.log("─".repeat(64));

  if (findings.length === 0) {
    console.log("\n✓ No suspected invariant violations.\n");
    console.log(
      "(Advisory only — this check never fails a build. It reports; humans decide.)",
    );
    return;
  }

  console.log(
    `\n⚠ ${findings.length} suspected invariant violation${findings.length === 1 ? "" : "s"} (review, do not auto-trust):\n`,
  );
  for (const [i, f] of findings.entries()) {
    console.log(
      `${i + 1}. [${f.severity}] ${f.invariantTitle}  [${f.file}]  ${f.refHit ? "ref-hit" : `sim=${f.similarity.toFixed(2)}`}`,
    );
    console.log(`   invariant: ${f.invariantContent}`);
    if (f.reason) console.log(`   why: ${f.reason}`);
    console.log("");
  }

  // Gate summary.
  if (gate.overridden.length > 0) {
    console.log(
      `↪ ${gate.overridden.length} soft finding${gate.overridden.length === 1 ? "" : "s"} overridden by the author:`,
    );
    for (const { finding, override } of gate.overridden) {
      console.log(`   • ${finding.invariantTitle} — "${override.reason}"`);
    }
    console.log("");
  }

  if (gate.mode === "gate") {
    if (gate.blocking.length > 0) {
      console.log(
        `✗ ${gate.blocking.length} blocking finding${gate.blocking.length === 1 ? "" : "s"} (--gate). Build fails (exit ${gate.exitCode}).`,
      );
      console.log(
        "  Override a SOFT finding with a commit trailer: `lore-override: <invariant title> — <reason>`.",
      );
      console.log("  STRICT findings cannot be overridden.");
    } else {
      console.log("✓ Gate passed — no blocking findings.");
    }
  } else {
    // Advisory: show what WOULD block if gated, but never fail.
    const wouldBlock = gate.blocking.length;
    console.log(
      "(Advisory — this check never fails a build. It reports; humans decide.)",
    );
    if (wouldBlock > 0) {
      console.log(
        `  Note: ${wouldBlock} finding${wouldBlock === 1 ? "" : "s"} would block under --gate.`,
      );
    }
  }
}
