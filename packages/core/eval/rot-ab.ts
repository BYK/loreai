/**
 * Offline, no-spend context-rot A/B from recorded eval results.
 *
 * This is the *no-spend approximation* of the controlled Lore-on/off rot-curve
 * A/B. Instead of running fresh agent sessions (which costs LLM tokens), it
 * re-analyzes the answers already recorded in `results/*.jsonl` — where the
 * same recall scenario was answered under multiple context strategies (`lore`
 * vs `tail-window` vs `compaction`) at a range of context sizes.
 *
 * It reuses the merged, tested rot-curve engine (`src/degradation-signals.ts`,
 * Wilson intervals + knee detection) on the ABSOLUTE-TOKEN axis. The one
 * modelling choice: because recorded results carry a judge composite (1–5) per
 * answer but no per-step tool-call trace, "degraded" here means the judge
 * composite fell below a threshold — an ANSWER-QUALITY degradation proxy, not
 * the behavioral tool-error/retry/reread signals the engine uses on real
 * transcripts. That distinction is the reason this is an approximation:
 *
 *   - What this measures (no spend): does answer quality decay with context
 *     size, and does Lore's curve stay flatter than the non-Lore baselines'?
 *   - What a real run would add (PR4a, costs spend): the behavioral rot curve
 *     over freshly recorded Lore-on vs Lore-off transcripts, both arms scored
 *     with the actual five signals.
 *
 * All statistics are observational — association between context size and
 * degradation may partly reflect task difficulty, not causation.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  buildRotCurve,
  type RotCurve,
  type RotCurveOptions,
  type StepSignals,
  wilsonInterval,
} from "../src/degradation-signals";
import type { BaselineMode, EvalResult } from "./types";

/** Judge composite (1–5) strictly below this counts an answer as degraded. */
export const DEFAULT_DEGRADED_COMPOSITE_MAX = 3.0;

/** The Lore arm every contrast is measured against. */
export const LORE_ARM: BaselineMode = "lore";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RotABOptions {
  /** Composite below this ⇒ degraded. Default {@link DEFAULT_DEGRADED_COMPOSITE_MAX}. */
  degradedThreshold?: number;
  /**
   * Override the auto-derived rot-curve options. By default fresh/deep zones
   * and bucket width are derived per scenario from the pooled token spread, so
   * the analysis works whether a scenario tops out at 65K or 250K tokens (the
   * engine's fixed token defaults assume real 100K+ agent sessions and would
   * leave a small eval's deep zone empty).
   */
  curve?: RotCurveOptions;
}

export interface ArmCurve {
  mode: BaselineMode;
  /** Recorded answers with a usable cumulative-token position. */
  n: number;
  curve: RotCurve;
}

export interface RotABContrast {
  /** The non-Lore comparator (e.g. "tail-window", "compaction"). */
  arm: BaselineMode;
  loreFreshRate: number | null;
  loreDeepRate: number | null;
  loreDegradationRatio: number | null;
  loreKnee: number | null;
  armFreshRate: number | null;
  armDeepRate: number | null;
  armDegradationRatio: number | null;
  armKnee: number | null;
  /**
   * True only when Lore's deep-zone degraded rate is strictly lower than the
   * comparator's AND their Wilson 95% intervals do not overlap — i.e. Lore is
   * significantly better deep in context, not just numerically.
   */
  loreDeepAdvantageSignificant: boolean;
}

export interface RotABReport {
  scenario: string;
  axis: "tokens";
  degradedThreshold: number;
  /** Fresh/deep zone edges (tokens) actually used, for transparency. */
  freshMax: number;
  deepMin: number;
  arms: ArmCurve[];
  /** Lore vs each present non-Lore arm. Empty when no comparator is present. */
  contrasts: RotABContrast[];
  /**
   * False when the arms' sample sizes differ by more than 20% — recorded
   * results accumulate unmatched samples across many dev runs (Lore is usually
   * over-represented), so an unbalanced scenario is a confounded diagnostic,
   * not a fair A/B. A controlled run (equal, paired samples) is the fix.
   */
  armsBalanced: boolean;
}

// ---------------------------------------------------------------------------
// Pure analysis
// ---------------------------------------------------------------------------

function cumulativeTokensOf(r: EvalResult): number | null {
  const ct = (r.metadata as { cumulativeTokens?: unknown } | undefined)
    ?.cumulativeTokens;
  return typeof ct === "number" && Number.isFinite(ct) && ct >= 0 ? ct : null;
}

/** Any `lore*` mode is a Lore arm; the rest are comparators. */
function isLoreArm(mode: BaselineMode): boolean {
  return mode.startsWith("lore");
}

/**
 * Map recorded answers into rot-curve steps: x = cumulative context tokens,
 * degraded = judge composite below `degradedMax`. The five behavioral signals
 * are left false — they aren't recorded per answer — so the curve's
 * `signalTotals` are not meaningful in this mode; only `degraded` drives it.
 */
export function resultsToSteps(
  results: readonly EvalResult[],
  degradedMax: number,
): StepSignals[] {
  const steps: StepSignals[] = [];
  for (const r of results) {
    const tokens = cumulativeTokensOf(r);
    if (tokens === null) continue;
    steps.push({
      stepIndex: steps.length,
      promptTokens: tokens,
      tool_error: false,
      edit_failure: false,
      retry: false,
      reread: false,
      self_correction: false,
      degraded: r.compositeScore < degradedMax,
    });
  }
  return steps;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(p * (sorted.length - 1))),
  );
  return sorted[idx];
}

/**
 * Derive fresh/deep zone edges and a bucket width from the pooled token spread
 * so both arms are compared over the same, populated zones regardless of the
 * scenario's absolute scale. Fresh = lowest tercile, deep = highest tercile.
 */
function deriveZones(tokens: number[]): {
  freshMax: number;
  deepMin: number;
  bucketWidth: number;
} {
  const sorted = [...tokens].sort((a, b) => a - b);
  const lo = sorted[0] ?? 0;
  const hi = sorted[sorted.length - 1] ?? 0;
  const p33 = percentile(sorted, 1 / 3);
  const p66 = percentile(sorted, 2 / 3);
  // Guard degenerate spreads (all-equal, or terciles that collapse together).
  const freshMax = p33 > lo ? p33 : lo + 1;
  const deepMin = p66 > freshMax ? p66 : freshMax + 1;
  const bucketWidth = Math.max(1, Math.round((hi - lo) / 8) || 1);
  return { freshMax, deepMin, bucketWidth };
}

/** Reconstruct a zone's degraded count from its rate and n (rate is count/n). */
function zoneDegraded(rate: number | null, n: number): number {
  return rate === null ? 0 : Math.round(rate * n);
}

function contrast(lore: ArmCurve, arm: ArmCurve): RotABContrast {
  const l = lore.curve;
  const a = arm.curve;
  let significant = false;
  if (
    l.deepN > 0 &&
    a.deepN > 0 &&
    l.deepRate !== null &&
    a.deepRate !== null &&
    l.deepRate < a.deepRate
  ) {
    const loreCi = wilsonInterval(zoneDegraded(l.deepRate, l.deepN), l.deepN);
    const armCi = wilsonInterval(zoneDegraded(a.deepRate, a.deepN), a.deepN);
    significant = loreCi[1] < armCi[0];
  }
  return {
    arm: arm.mode,
    loreFreshRate: l.freshRate,
    loreDeepRate: l.deepRate,
    loreDegradationRatio: l.degradationRatio,
    loreKnee: l.knee,
    armFreshRate: a.freshRate,
    armDeepRate: a.deepRate,
    armDegradationRatio: a.degradationRatio,
    armKnee: a.knee,
    loreDeepAdvantageSignificant: significant,
  };
}

/**
 * Build a per-scenario answer-quality rot A/B from recorded results. A scenario
 * is reported only when it has a Lore arm and at least one non-Lore comparator,
 * each with recorded token positions.
 */
export function analyzeRotAB(
  results: readonly EvalResult[],
  options: RotABOptions = {},
): RotABReport[] {
  const degradedThreshold =
    options.degradedThreshold ?? DEFAULT_DEGRADED_COMPOSITE_MAX;

  const byScenario = new Map<string, Map<BaselineMode, EvalResult[]>>();
  for (const r of results) {
    if (!r || typeof r.scenario !== "string" || typeof r.mode !== "string") {
      continue;
    }
    let byMode = byScenario.get(r.scenario);
    if (!byMode) {
      byMode = new Map();
      byScenario.set(r.scenario, byMode);
    }
    const list = byMode.get(r.mode) ?? [];
    list.push(r);
    byMode.set(r.mode, list);
  }

  const reports: RotABReport[] = [];
  for (const [scenario, byMode] of byScenario) {
    // Pool token positions across all arms so zones are shared & comparable.
    const pooled: number[] = [];
    const stepsByMode = new Map<BaselineMode, StepSignals[]>();
    for (const [mode, rs] of byMode) {
      const steps = resultsToSteps(rs, degradedThreshold);
      if (steps.length === 0) continue;
      stepsByMode.set(mode, steps);
      for (const s of steps) pooled.push(s.promptTokens);
    }
    if (!stepsByMode.has(LORE_ARM) || pooled.length === 0) continue;

    const derived = deriveZones(pooled);
    const curveOpts: RotCurveOptions = {
      axis: "tokens",
      freshMax: derived.freshMax,
      deepMin: derived.deepMin,
      bucketWidth: derived.bucketWidth,
      ...options.curve,
    };

    const arms: ArmCurve[] = [];
    for (const [mode, steps] of stepsByMode) {
      arms.push({
        mode,
        n: steps.length,
        curve: buildRotCurve(steps, curveOpts),
      });
    }
    const lore = arms.find((x) => x.mode === LORE_ARM);
    if (!lore) continue;
    const contrasts = arms
      .filter((x) => !isLoreArm(x.mode))
      .map((x) => contrast(lore, x));
    if (contrasts.length === 0) continue;

    // Balance is only meaningful across the arms that actually participate in a
    // contrast: the primary Lore arm and the non-Lore comparators. Secondary
    // Lore variants (lore-context-only / lore-memory-only) are shown for
    // reference but must not skew the balance verdict.
    const counts = arms
      .filter((x) => x.mode === LORE_ARM || !isLoreArm(x.mode))
      .map((x) => x.n);
    const armsBalanced = Math.min(...counts) / Math.max(...counts) >= 0.8;

    reports.push({
      scenario,
      axis: "tokens",
      degradedThreshold,
      freshMax: curveOpts.freshMax ?? derived.freshMax,
      deepMin: curveOpts.deepMin ?? derived.deepMin,
      arms,
      contrasts,
      armsBalanced,
    });
  }

  reports.sort((a, b) => a.scenario.localeCompare(b.scenario));
  return reports;
}

// ---------------------------------------------------------------------------
// IO + reporting (CLI)
// ---------------------------------------------------------------------------

/** Load every `*.jsonl` in a directory into a flat list of results. */
export function loadResults(dir: string): EvalResult[] {
  const out: EvalResult[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".jsonl")) continue;
    const text = readFileSync(join(dir, file), "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as EvalResult);
      } catch {
        // Skip malformed lines — a partial read beats a crash.
      }
    }
  }
  return out;
}

function pct(rate: number | null): string {
  return rate === null ? "  –" : `${(rate * 100).toFixed(0)}%`;
}

function ratio(r: number | null): string {
  if (r === null) return "–";
  if (!Number.isFinite(r)) return "∞";
  return `${r.toFixed(1)}×`;
}

export function formatReport(reports: readonly RotABReport[]): string {
  if (reports.length === 0) {
    return "No paired scenarios with recorded token positions found.";
  }
  const lines: string[] = [];
  lines.push("Context-rot A/B (answer-quality proxy, absolute-token axis)");
  lines.push(
    "  degraded = judge composite < threshold; observational, no-spend approximation",
  );
  for (const rep of reports) {
    lines.push("");
    lines.push(
      `▸ ${rep.scenario}  (threshold ${rep.degradedThreshold}, fresh<${rep.freshMax} deep≥${rep.deepMin} tok)`,
    );
    if (!rep.armsBalanced) {
      lines.push(
        "    ⚠ unbalanced arms (unmatched recorded samples) — diagnostic only, not a verdict",
      );
    }
    lines.push(
      `    ${"arm".padEnd(14)} ${"n".padStart(4)}  ${"fresh".padStart(6)}  ${"deep".padStart(6)}  ${"ratio".padStart(6)}  knee`,
    );
    for (const arm of rep.arms) {
      const c = arm.curve;
      lines.push(
        `    ${arm.mode.padEnd(14)} ${String(arm.n).padStart(4)}  ${pct(c.freshRate).padStart(6)}  ${pct(c.deepRate).padStart(6)}  ${ratio(c.degradationRatio).padStart(6)}  ${c.knee === null ? "none" : `${c.knee}`}`,
      );
    }
    for (const con of rep.contrasts) {
      const verdict = con.loreDeepAdvantageSignificant
        ? "Lore significantly flatter deep in context"
        : "no significant deep-zone difference";
      lines.push(
        `    lore vs ${con.arm}: deep ${pct(con.loreDeepRate)} vs ${pct(con.armDeepRate)} — ${verdict}`,
      );
    }
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let dir = join(import.meta.dir, "results");
  let threshold = DEFAULT_DEGRADED_COMPOSITE_MAX;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--results" && args[i + 1]) dir = args[++i];
    else if (args[i] === "--threshold" && args[i + 1])
      threshold = Number(args[++i]);
  }
  const results = loadResults(dir);
  const reports = analyzeRotAB(results, { degradedThreshold: threshold });
  console.log(formatReport(reports));
}

// Bun sets import.meta.main on the entry module only; falsy under vitest, so
// importing this module from tests never triggers the CLI.
if (import.meta.main) {
  await main();
}
