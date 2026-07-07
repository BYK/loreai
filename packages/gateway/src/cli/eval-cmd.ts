// `lore eval` — run the packaged memory benchmark (issue #961).
//
// Reproduces the CORE comparison from the blog post: Lore-on vs Lore-off (bare
// native compaction) driving a real OpenCode agent, turn by turn, against a real
// model, then scores the code-invisible fact probes and prints a scorecard.
//
// The full protocol, all arms (including the mem0/mnemonic competitors, which need
// external API keys), and the raw scripts live next to this benchmark in
// packages/core/eval/live/ (see METHODOLOGY.md). This command is the auditable
// entry point: run it from a Lore checkout to reproduce our numbers.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface ScoredArm {
  arm: string;
  model: string;
  probesHeld: string;
  compactions: number;
  metrics: {
    turns: number;
    answeringTokens: number;
    peakContext: number;
    toolCalls: number;
    wallSec: number;
  };
  cost: {
    answeringUsd: number;
    loreWorkerUsd: number;
    grandUsd: number;
    grandTokens: number;
    embeddingsOk: boolean | null;
  };
}

const SCENARIOS: Record<
  string,
  { task: string; label: string; sessionTimeout: number }
> = {
  "cross-session": {
    task: "task-pref-combined.json",
    label: "cross-session (two separate sessions)",
    sessionTimeout: 900,
  },
  "single-long": {
    task: "task-pref-long.json",
    label: "single long session (within-session compaction)",
    sessionTimeout: 1600,
  },
};

// Blob size (KB) inferred from the fixture name; generated on demand if absent.
const BLOB_KB: Record<string, number> = {
  "blob-xs.md": 156,
  "blob-sm.md": 250,
  "blob-mid.md": 360,
};

function whichBin(bin: string): string | null {
  // An explicit relative/absolute path (e.g. `--opencode ./bin/opencode` or
  // `/usr/local/bin/opencode`) is validated directly — PATH is only searched for
  // a bare binary name.
  if (bin.includes("/")) {
    return existsSync(bin) ? bin : null;
  }
  for (const dir of (process.env.PATH || "").split(":")) {
    if (dir && existsSync(join(dir, bin))) return join(dir, bin);
  }
  return null;
}

function findUp(rel: string): string | null {
  let base = resolve(process.cwd());
  for (;;) {
    const cand = join(base, rel);
    if (existsSync(cand)) return cand;
    const parent = resolve(base, "..");
    if (parent === base) return null;
    base = parent;
  }
}

// Pure: parse the JSON array score.mjs prints before its "=== SUMMARY ===" block.
export function parseScoreJson(stdout: string): ScoredArm[] {
  const marker = stdout.indexOf("\n=== SUMMARY ===");
  const jsonText = marker >= 0 ? stdout.slice(0, marker) : stdout;
  return JSON.parse(jsonText) as ScoredArm[];
}

// Pure: render one scenario's scorecard so it can be unit-tested without a run.
export function formatScorecard(
  _scenario: string,
  label: string,
  model: string,
  rows: ScoredArm[],
): string {
  const lines: string[] = [];
  lines.push(`\nScenario: ${label}`);
  lines.push(`Model:    ${model}`);
  lines.push("");
  const head = [
    "arm",
    "retention",
    "compactions",
    "turns",
    "answer$",
    "grand$",
    "grandTokens",
    "peakCtx",
  ];
  const widths = [8, 10, 12, 6, 9, 9, 13, 10];
  const fmt = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i])).join(" ");
  lines.push(`  ${fmt(head)}`);
  for (const r of rows) {
    lines.push(
      "  " +
        fmt([
          r.arm,
          r.probesHeld,
          String(r.compactions),
          String(r.metrics.turns),
          `$${r.cost.answeringUsd.toFixed(2)}`,
          `$${r.cost.grandUsd.toFixed(2)}`,
          r.cost.grandTokens.toLocaleString(),
          r.metrics.peakContext.toLocaleString(),
        ]),
    );
  }
  const lore = rows.find((r) => r.arm === "lore");
  const nolore = rows.find((r) => r.arm === "nolore");
  if (lore && nolore) {
    const held = (s: string) => Number(s.split("/")[0]);
    lines.push("");
    lines.push(
      `  Lore retained ${lore.probesHeld} vs no-memory ${nolore.probesHeld}` +
        ` (${lore.compactions} vs ${nolore.compactions} compactions).` +
        (held(lore.probesHeld) > held(nolore.probesHeld)
          ? " Lore held more of the facts."
          : ""),
    );
  }
  return lines.join("\n");
}

function run(
  cmd: string,
  cmdArgs: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string }> {
  return new Promise((res) => {
    const p = spawn(cmd, cmdArgs, {
      env,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    p.stdout.on("data", (d) => {
      out += d.toString();
    });
    p.on("exit", (code) => res({ code: code ?? 1, stdout: out }));
  });
}

export async function commandEval(
  positionals: string[],
  values: Record<string, unknown>,
): Promise<void> {
  const model = (values.model as string) || positionals[0];
  if (!model) {
    console.error(`Usage: lore eval --model <provider/model> [--scenario cross-session|single-long|both]

Runs the packaged memory benchmark: Lore-on vs Lore-off (native compaction),
driving a real OpenCode agent against your model in an isolated workspace, then
prints a fact-retention + efficiency + cost scorecard.

Options:
  --model <p/m>     answering model, e.g. anthropic/claude-sonnet-4-6  (required)
  --scenario <s>    cross-session (default), single-long, or both
  --cap-context N   context window cap applied to BOTH arms (default 200000)
  --out <dir>       output dir for run artifacts (default ./.lore-eval)
  --harness <dir>   path to packages/core/eval/live (auto-detected in a checkout)
  --gw-dist <path>  gateway bundle (default <repo>/packages/gateway/dist/index.bun.js)
  --auth <path>     opencode auth.json (default from XDG/HOME)
  --json            print the raw scored JSON instead of the scorecard

Full protocol + competitor arms (mem0, mnemonic): packages/core/eval/live/METHODOLOGY.md`);
    process.exit(1);
  }

  const scenarioArg = (
    (values.scenario as string) || "cross-session"
  ).toLowerCase();
  const scenarioKeys =
    scenarioArg === "both" ? Object.keys(SCENARIOS) : [scenarioArg];
  for (const s of scenarioKeys) {
    if (!SCENARIOS[s]) {
      console.error(
        `Unknown scenario "${s}". Use: cross-session, single-long, or both.`,
      );
      process.exit(1);
    }
  }

  const harnessDir =
    (values.harness ? resolve(values.harness as string) : null) ||
    process.env.LORE_EVAL_HARNESS ||
    (() => {
      const d = findUp("packages/core/eval/live/driver.mjs");
      return d ? resolve(d, "..") : null;
    })();
  if (!harnessDir || !existsSync(join(harnessDir, "driver.mjs"))) {
    console.error(
      "Could not find the benchmark harness (packages/core/eval/live). Run from a Lore\n" +
        "checkout, or pass --harness <dir>. Protocol: packages/core/eval/live/METHODOLOGY.md",
    );
    process.exit(1);
  }
  const repoRoot = resolve(harnessDir, "../../../..");
  const gwDist =
    (values["gw-dist"] as string) ||
    join(repoRoot, "packages/gateway/dist/index.bun.js");
  if (!existsSync(gwDist)) {
    console.error(
      `Gateway bundle not found at ${gwDist}.\nBuild it first: pnpm --filter @loreai/gateway run bundle`,
    );
    process.exit(1);
  }
  const auth =
    (values.auth as string) ||
    join(
      process.env.XDG_DATA_HOME || `${process.env.HOME}/.local/share`,
      "opencode/auth.json",
    );
  if (!existsSync(auth)) {
    console.error(
      `opencode auth.json not found at ${auth} (pass --auth <path>).`,
    );
    process.exit(1);
  }
  const bun = whichBin("bun");
  if (!bun) {
    console.error(
      "`bun` is required to run the benchmark harness but was not found on PATH.",
    );
    process.exit(1);
  }
  if (!whichBin((values.opencode as string) || "opencode")) {
    console.error(
      "`opencode` (the agent under test) was not found on PATH (pass --opencode <path>).",
    );
    process.exit(1);
  }

  const outBase = resolve((values.out as string) || ".lore-eval");
  const capContext = String((values["cap-context"] as string) || 200000);
  mkdirSync(outBase, { recursive: true });

  // Ensure any blob fixtures referenced by the chosen tasks exist (git-ignored).
  const neededBlobs = new Set<string>();
  for (const s of scenarioKeys) {
    const task = JSON.parse(
      readFileSync(join(harnessDir, SCENARIOS[s].task), "utf8"),
    );
    for (const sess of task.sessions || [])
      for (const t of sess.turns || []) if (t.blob) neededBlobs.add(t.blob);
  }
  for (const blob of neededBlobs) {
    if (!existsSync(join(harnessDir, blob))) {
      console.log(`Generating fixture ${blob} ...`);
      await run(
        bun,
        [join(harnessDir, "gen-blob.mjs"), blob, String(BLOB_KB[blob] || 156)],
        process.env,
      );
    }
  }

  const allJson: ScoredArm[] = [];
  for (const s of scenarioKeys) {
    const sc = SCENARIOS[s];
    const outs: string[] = [];
    for (const arm of ["lore", "nolore"]) {
      const out = join(outBase, `${s}-${arm}`);
      outs.push(out);
      console.log(`\n▶ Running ${s} / ${arm} on ${model} ...`);
      const { code } = await run(
        bun,
        [
          join(harnessDir, "driver.mjs"),
          "--task",
          join(harnessDir, sc.task),
          "--arm",
          arm,
          "--model",
          model,
          "--out",
          out,
          "--auth",
          auth,
          "--gw-dist",
          gwDist,
          "--lore-build",
          repoRoot,
          "--cap-context",
          capContext,
          "--session-timeout",
          String(sc.sessionTimeout),
          "--keep",
        ],
        process.env,
      );
      if (code !== 0)
        console.error(
          `  (${arm} run exited ${code}; scoring whatever completed)`,
        );
    }
    const { stdout } = await run(
      bun,
      [join(harnessDir, "score.mjs"), ...outs],
      process.env,
    );
    let rows: ScoredArm[];
    try {
      rows = parseScoreJson(stdout);
    } catch {
      console.error(`Could not parse scorer output:\n${stdout}`);
      process.exitCode = 1;
      continue;
    }
    allJson.push(...rows);
    if (!values.json) console.log(formatScorecard(s, sc.label, model, rows));
  }

  if (values.json) {
    console.log(JSON.stringify(allJson, null, 2));
  } else {
    console.log(
      "\nFull protocol and competitor arms: packages/core/eval/live/METHODOLOGY.md",
    );
  }
}
