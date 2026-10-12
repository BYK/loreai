// Behavioral rot-curve A/B for the live counterfactual eval (#1402).
//
// Unlike `rot-ab.ts` (which approximates "degraded" from the LLM judge composite
// of recorded answers — a quality proxy), this runs the REAL 5 behavioral
// signals (tool_error, edit_failure, retry, reread, self_correction) extracted
// from the driver's per-turn `sessions/*.json` streams (`trace-extract.mjs`),
// then builds a rot curve per arm on the ABSOLUTE-prompt-token axis and
// contrasts lore vs each comparator arm with Wilson-interval significance.
//
// Absolute tokens (not fill %) is deliberate: dividing by the window confounds
// the A/B — with Lore on, per-step fill stays low, so Lore would "win" on the
// fill axis trivially by never reaching high fill. On the absolute-token axis
// the claim is falsifiable: "at the same real context size, does the arm
// degrade less?" (plan: "The X-axis decision").
//
// Usage:
//   bun rot-behavioral.mjs --root <MATRIX_DIR> [--json] [--out <file>]
// Groups run dirs by cell name minus the -run{N} suffix; the arm (lore / nolore
// / mcp-*) is parsed from the cell name. All runs of the same (scenario, arm)
// are pooled into one arm curve.

import fs from "node:fs";
import path from "node:path";

import {
  extractSignals,
  buildRotCurve,
  signalTotals,
  wilsonInterval,
} from "../../src/degradation-signals.ts";
import { stepsFromRun } from "./trace-extract.mjs";

// A run dir is `<cell>-run<N>`; cell is `<scenario>-<arm>[-<model>][-<cap>]`.
// The arm token is the first of the known arm names present in the cell.
const ARMS = [
  "nolore",
  "lore",
  "mcp-mem0",
  "mcp-mnemonic",
  "mcp-kg",
  "mcp-basicmem",
  "vanilla",
];

function parseCell(runDirName) {
  const m = /^(.*)-run\d+$/.exec(runDirName);
  const cell = m ? m[1] : runDirName;
  const arm =
    ARMS.find((a) => cell.split(/[-]/).includes(a) || cell.includes(a)) ??
    "unknown";
  // scenario = cell with the arm segment removed (keeps model+cap for grouping).
  const scenario = cell
    .replace(new RegExp(`-?${arm}-?`), "-")
    .replace(/^-|-$/g, "");
  return { cell, arm, scenario };
}

function isLoreArm(arm) {
  return arm === "lore" || arm.startsWith("lore");
}

/**
 * Pooled-token zone derivation (mirrors rot-ab.ts::deriveZones) so both arms
 * share the same fresh/deep edges regardless of the scenario's absolute scale.
 */
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(p * (sorted.length - 1))),
  );
  return sorted[idx];
}
function deriveZones(tokens) {
  const sorted = [...tokens].sort((a, b) => a - b);
  const lo = sorted[0] ?? 0;
  const hi = sorted[sorted.length - 1] ?? 0;
  const p33 = percentile(sorted, 1 / 3);
  const p66 = percentile(sorted, 2 / 3);
  const freshMax = p33 > lo ? p33 : lo + 1;
  const deepMin = p66 > freshMax ? p66 : freshMax + 1;
  const bucketWidth = Math.max(1, Math.round((hi - lo) / 8) || 1);
  return { freshMax, deepMin, bucketWidth };
}

function zoneDegraded(rate, n) {
  return rate === null ? 0 : Math.round(rate * n);
}

/** Lore's deep-zone rate strictly lower AND Wilson intervals disjoint. */
function contrast(lore, arm) {
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
    arm: arm.arm,
    n: arm.n,
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
 * Analyze a matrix root into per-scenario behavioral rot A/B reports.
 * @param {string} root  directory containing `<cell>-run<N>/` subdirs
 */
export function analyzeBehavioralRotAB(root) {
  const dirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /-run\d+$/.test(d.name))
    .map((d) => d.name);

  // Group steps by (scenario, arm). Pool every run's steps into one arm cohort.
  const byScenario = new Map();
  for (const name of dirs) {
    const { arm, scenario } = parseCell(name);
    const steps = stepsFromRun(path.join(root, name));
    if (steps.length === 0) continue;
    const signals = extractSignals(steps);
    let byArm = byScenario.get(scenario);
    if (!byArm) {
      byArm = new Map();
      byScenario.set(scenario, byArm);
    }
    const existing = byArm.get(arm) ?? { signals: [], runs: 0 };
    // Re-index stepIndex so the pooled cohort is monotonic (buildRotCurve keys
    // on promptTokens for bucketing, so stepIndex is presentational only).
    for (const s of signals) existing.signals.push(s);
    existing.runs += 1;
    byArm.set(arm, existing);
  }

  const reports = [];
  for (const [scenario, byArm] of byScenario) {
    // Pool tokens across all arms so both share the same fresh/deep zones.
    const allTokens = [];
    for (const { signals } of byArm.values()) {
      for (const s of signals)
        if (s.promptTokens > 0) allTokens.push(s.promptTokens);
    }
    if (allTokens.length === 0) continue;
    const { freshMax, deepMin, bucketWidth } = deriveZones(allTokens);
    const curveOpts = { axis: "tokens", freshMax, deepMin, bucketWidth };

    const arms = [];
    for (const [arm, { signals, runs }] of byArm) {
      const curve = buildRotCurve(signals, curveOpts);
      arms.push({
        arm,
        n: signals.length,
        runs,
        curve,
        totals: signalTotals(signals),
      });
    }
    arms.sort(
      (a, b) => (isLoreArm(b.arm) ? 1 : 0) - (isLoreArm(a.arm) ? 1 : 0),
    );

    const lore = arms.find((a) => isLoreArm(a.arm));
    const contrasts = lore
      ? arms.filter((a) => !isLoreArm(a.arm)).map((a) => contrast(lore, a))
      : [];

    // Balanced iff no two arms differ in step count by >20% (a controlled,
    // paired run should be roughly balanced; heavy skew = confounded A/B).
    const ns = arms.map((a) => a.n);
    const maxN = Math.max(...ns);
    const minN = Math.min(...ns);
    const armsBalanced = maxN === 0 ? true : minN / maxN >= 0.8;

    reports.push({
      scenario,
      axis: "tokens",
      freshMax,
      deepMin,
      bucketWidth,
      arms: arms.map((a) => ({
        arm: a.arm,
        n: a.n,
        runs: a.runs,
        freshRate: a.curve.freshRate,
        deepRate: a.curve.deepRate,
        degradationRatio: a.curve.degradationRatio,
        ratioSignificant: a.curve.ratioSignificant,
        knee: a.curve.knee,
        totals: a.totals,
      })),
      contrasts,
      armsBalanced,
    });
  }
  reports.sort((a, b) => a.scenario.localeCompare(b.scenario));
  return reports;
}

function fmtRate(r) {
  return r === null ? "  -  " : `${(r * 100).toFixed(1)}%`;
}
function fmtKnee(k) {
  return k === null ? "none" : `${Math.round(k / 1000)}K`;
}

export function formatBehavioralReport(reports) {
  const out = [];
  for (const r of reports) {
    out.push(
      `\n## ${r.scenario}  (axis=tokens, fresh<${Math.round(r.freshMax / 1000)}K, deep>=${Math.round(r.deepMin / 1000)}K)`,
    );
    if (!r.armsBalanced)
      out.push("  ⚠ arms unbalanced (>20% step-count skew) — confounded A/B");
    out.push(
      "  arm            runs  steps  fresh   deep    ratio   knee   sig",
    );
    for (const a of r.arms) {
      out.push(
        `  ${a.arm.padEnd(14)} ${String(a.runs).padStart(3)}  ${String(a.n).padStart(5)}  ` +
          `${fmtRate(a.freshRate).padStart(6)}  ${fmtRate(a.deepRate).padStart(6)}  ` +
          `${a.degradationRatio === null ? "  -  " : a.degradationRatio.toFixed(2) + "x"}`.padEnd(
            8,
          ) +
          `  ${fmtKnee(a.knee).padStart(5)}  ${a.ratioSignificant ? "yes" : "no"}`,
      );
    }
    for (const c of r.contrasts) {
      out.push(
        `  → lore vs ${c.arm}: deep ${fmtRate(c.loreDeepRate)} vs ${fmtRate(c.armDeepRate)} ` +
          `— lore ${c.loreDeepAdvantageSignificant ? "SIGNIFICANTLY better" : "not significantly better"} deep in context`,
      );
    }
  }
  return out.join("\n");
}

// ---- CLI -----------------------------------------------------------------
if (import.meta.main) {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = process.argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  const root = args.root;
  if (!root) {
    console.error("required: --root <matrix-dir>  [--json] [--out <file>]");
    process.exit(1);
  }
  const reports = analyzeBehavioralRotAB(root);
  const text = args.json
    ? JSON.stringify(reports, null, 2)
    : formatBehavioralReport(reports);
  if (args.out) {
    fs.writeFileSync(args.out, text + "\n");
    console.error(`wrote ${args.out}`);
  } else {
    console.log(text);
  }
}
