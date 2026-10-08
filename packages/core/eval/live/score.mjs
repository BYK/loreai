// Deterministic scorer for the live counterfactual benchmark.
//
// Scores are computed from the FINAL repo state + the driver's result.json.
// NO LLM judge is used (per #961's no-justifier-inflation rule): every probe is
// a mechanical check on the produced code. Retrieval/behavioral metrics are kept
// separate from the pass/fail probes.
//
// Usage: bun score.mjs <arm-out-dir> [<arm-out-dir> ...]
//   Each dir must contain project/ (final repo) and result.json (metrics).

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Lore's TRUE cost includes background work the answering model never sees:
// distillation / curation / meta-distill LLM calls (worker model) + cache
// warmup. The no-Lore arm has none of this. We read Lore's own accounting:
//   - data/lore.db `daily_costs` (bucket -> USD): conversation + worker + warmup
//   - gateway.log "distill segment: N msgs, A→B tokens" -> background token spend
// so the comparison counts Lore's full spend, not just the foreground answer.
function loreCost(dir) {
  const out = {
    conversationUsd: 0,
    workerUsd: 0,
    warmupUsd: 0,
    totalUsd: 0,
    distillCalls: 0,
    distillInTok: 0,
    distillOutTok: 0,
    embeddingsOk: null,
  };
  const db = path.join(dir, "data/lore.db");
  if (fs.existsSync(db)) {
    try {
      const raw = execFileSync(
        "python3",
        [
          "-c",
          "import sqlite3,json,sys;c=sqlite3.connect(sys.argv[1]);print(json.dumps(c.execute('SELECT bucket,SUM(cost) FROM daily_costs GROUP BY bucket').fetchall()))",
          db,
        ],
        { encoding: "utf8" },
      );
      for (const [bucket, cost] of JSON.parse(raw)) {
        if (bucket === "conversation") out.conversationUsd = cost;
        else if (bucket === "worker") out.workerUsd = cost;
        else if (bucket === "warmup") out.warmupUsd = cost;
        out.totalUsd += cost;
      }
    } catch {}
  }
  const log = path.join(dir, "gateway.log");
  if (fs.existsSync(log)) {
    const txt = fs.readFileSync(log, "utf8");
    for (const m of txt.matchAll(
      /distill segment:\s*\d+\s*msgs,\s*(\d+)\D+?(\d+)\s*tokens/g,
    )) {
      out.distillCalls++;
      out.distillInTok += +m[1];
      out.distillOutTok += +m[2];
    }
    out.embeddingsOk =
      !/embedding worker init failed|local embedding init failed/.test(txt);
  }
  return out;
}

// The code-invisible facts stated once in session turn 1. Each is checked
// mechanically against the file the final probe turn was asked to create.
// A fact "held" iff the agent applied it despite it being out of context after
// compaction (no-Lore) — Lore should retain it via distillation/recall.
// The final probe turn is asked to create orders_v2.py. Facts may be applied
// there directly OR via helpers the agent created earlier (e.g. a shared
// MAX_LINE_ITEMS constant). So checks scan the final probe file for
// file-local facts (header, status) and ALL session-created files for
// cross-file facts (money type, the cap value).
const PROBE_FILE = "src/orders_v2.py";

function scoreGeneratedRetention(dir, result) {
  const facts = result.factMap;
  if (!facts || typeof facts !== "object") return null;
  const project = path.join(dir, "project");
  const oracle = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "verify-retention-orders.py",
  );
  if (!fs.existsSync(oracle))
    throw new Error(`retention oracle is missing: ${oracle}`);
  const fields = ["status", "channel", "region", "warehouse"];
  const probes = fields.map((field) => {
    let held = false;
    try {
      execFileSync("python3", [oracle, project, field], {
        env: { ...process.env, LORE_EVAL_FACTS: JSON.stringify(facts) },
        stdio: "pipe",
        timeout: 30000,
      });
      held = true;
    } catch {}
    return {
      id: `behavior-${field}`,
      axis: "incidental fact recall",
      held,
      leaked: false,
    };
  });
  const changed = allPyFiles(project).filter((p) => {
    const rel = path.relative(project, p);
    return rel !== PROBE_FILE && p !== path.join(project, ".lore.json");
  });
  const leakedFacts = [];
  for (const [field, value] of Object.entries(facts)) {
    if (
      changed.some((p) => fs.readFileSync(p, "utf8").includes(String(value)))
    ) {
      leakedFacts.push(field);
    }
  }
  for (const probe of probes)
    probe.leaked = leakedFacts.includes(probe.id.slice("behavior-".length));
  return { probes, leakedFacts };
}

// Scan EVERY .py file the agent created (robust to whatever helper files a given
// task produces), so cross-file facts (money type, the cap value) are checked
// wherever they land.
function allPyFiles(root) {
  const out = [];
  const walk = (d) => {
    let ents = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== ".git" && e.name !== "__pycache__") walk(p);
      } else if (e.name.endsWith(".py")) out.push(p);
    }
  };
  walk(root);
  return out;
}
const PROBES = [
  {
    id: "convention-header",
    axis: "convention adherence",
    applies: (cfg) => cfg.header !== false,
    desc: "orders_v2.py must start with header line '# WH-CONVENTION v3'",
    check: ({ probe }) => probe.split("\n")[0].trim() === "# WH-CONVENTION v3",
  },
  {
    id: "gotcha-no-float",
    axis: "gotcha reuse",
    applies: (cfg) => cfg.cents !== false,
    desc: "money must be integer cents — no float in any session file",
    check: ({ all }) => !/\bfloat\s*\(/.test(all) && !/:\s*float\b/.test(all),
  },
  {
    id: "decision-max-cap",
    axis: "decision recall (evolving value)",
    applies: (cfg) => cfg.max !== false,
    desc: "cap is the CURRENT value; every superseded (stale) value must be absent",
    check: ({ all, probe, cfg }) => {
      const cap = cfg.cap;
      const currentDefined = new RegExp(
        `MAX_LINE_ITEMS\\s*=\\s*${cap}\\b`,
      ).test(all);
      const usedInProbe =
        /MAX_LINE_ITEMS/.test(probe) || new RegExp(`\\b${cap}\\b`).test(probe);
      // Stale-value check is PROBE-FILE-scoped: an old helper file legitimately
      // written when the value WAS 50/100 must not penalize the final artifact.
      const staleAbsent = cfg.staleCaps.every(
        (s) =>
          !new RegExp(
            `(MAX_LINE_ITEMS\\s*=\\s*${s}\\b|>\\s*${s}\\b|len\\([^)]*\\)\\s*>\\s*${s}\\b)`,
          ).test(probe),
      );
      return currentDefined && usedInProbe && staleAbsent;
    },
  },
  {
    id: "superseded-uppercase-status",
    axis: "negative control (superseded)",
    applies: (cfg) => cfg.status !== false,
    desc: "order status literals must be UPPERCASE (superseded the earlier lowercase decision)",
    check: ({ probe }) =>
      /["']SUBMITTED["']/.test(probe) && !/["']submitted["']/.test(probe),
  },
  {
    id: "passing-mention-channel",
    axis: "incidental fact recall",
    // Arbitrary, unguessable, code-invisible: stated ONCE in passing early in a
    // long session, never written to any intermediate file, required only in the
    // final probe file. Only scored for tasks whose cfg sets `channel`.
    applies: (cfg) => !!cfg.channel,
    desc: "order dict must set channel to the exact incidental value stated in passing",
    check: ({ probe, cfg }) => new RegExp(`["']${cfg.channel}["']`).test(probe),
  },
  {
    id: "passing-mention-region",
    axis: "incidental fact recall",
    // Second arbitrary, unguessable, code-invisible value stated once in passing.
    applies: (cfg) => !!cfg.region,
    desc: "order must set region to the exact incidental value stated in passing",
    check: ({ probe, cfg }) => new RegExp(`["']${cfg.region}["']`).test(probe),
  },
  {
    id: "passing-mention-warehouse",
    axis: "incidental fact recall",
    // Third arbitrary, unguessable, code-invisible value stated once in passing.
    applies: (cfg) => !!cfg.warehouse,
    desc: "order must set warehouse to the exact incidental value stated in passing",
    check: ({ probe, cfg }) =>
      new RegExp(`["']${cfg.warehouse}["']`).test(probe),
  },
  {
    id: "pref-dataclass",
    axis: "working-style preference",
    // Offhand personal preference ("I prefer dataclasses over bare dicts") — the
    // kind of thing people never put in AGENTS.md. Code-invisible: intermediate
    // helpers return scalars, so this only surfaces in the final structured type.
    applies: (cfg) => !!cfg.prefDataclass,
    desc: "structured return uses @dataclass (or NamedTuple), not a bare dict",
    check: ({ probe }) =>
      /@dataclass\b/.test(probe) || /\bNamedTuple\b/.test(probe),
  },
  {
    id: "pref-custom-exception",
    axis: "working-style preference",
    // Offhand preference ("raise a custom exception, not ValueError"). Code-
    // invisible: no intermediate task validates anything.
    applies: (cfg) => !!cfg.prefException,
    desc: "validation raises a custom exception (not a bare builtin); class may be defined or imported",
    check: ({ probe }) => {
      const BUILTINS = new Set([
        "ValueError",
        "TypeError",
        "KeyError",
        "IndexError",
        "RuntimeError",
        "Exception",
        "AttributeError",
        "NotImplementedError",
        "OSError",
        "AssertionError",
        "StopIteration",
        "LookupError",
        "ArithmeticError",
      ]);
      const raised = [...probe.matchAll(/raise\s+([A-Za-z_]\w*)/g)].map(
        (m) => m[1],
      );
      const raisesCustom = raised.some(
        (n) => /(?:Error|Exception)$/.test(n) && !BUILTINS.has(n),
      );
      const raisesBareBuiltin = raised.some(
        (n) => n === "ValueError" || n === "Exception",
      );
      return raisesCustom && !raisesBareBuiltin;
    },
  },
];

function scoreArm(dir) {
  const result = JSON.parse(
    fs.readFileSync(path.join(dir, "result.json"), "utf8"),
  );
  if (!result.valid || !result.totals)
    throw new Error(`invalid run must not be scored: ${dir}`);
  const generated = scoreGeneratedRetention(dir, result);
  const probePath = path.join(dir, "project", PROBE_FILE);
  const exists = fs.existsSync(probePath);
  const probe = exists ? fs.readFileSync(probePath, "utf8") : "";
  const all = allPyFiles(path.join(dir, "project"))
    .map((p) => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return "";
      }
    })
    .join("\n\n");
  const TASK_CFG = {
    "xsession-harder": { cap: 250, staleCaps: [50, 100] },
    "wh-compaction-hard": { cap: 100, staleCaps: [50], channel: "WHOLESALE" },
    // Preference-only probe set: offhand working-style preferences (never in
    // AGENTS.md), no code-convention header/cap probes.
    "xsession-pref": {
      header: false,
      max: false,
      channel: "WHOLESALE",
      prefDataclass: true,
      prefException: true,
    },
    // Long-session tests, SIGNAL-ONLY: score only the arbitrary, unguessable
    // VALUES stated once in passing (status/channel/region/warehouse). The
    // structural prefs (dataclass/exception/cents) are dropped because they are
    // just the model's default coding style — freebies that inflate no-memory.
    // pref-long = one long session; pref-combined = long multi-session.
    "pref-long": {
      header: false,
      max: false,
      cents: false,
      status: true,
      channel: "WHOLESALE",
      region: "EMEA",
      warehouse: "WH-07",
    },
    // pref-xlong = single long session with larger per-turn blobs (~1M peak) to
    // force multiple native compactions at higher context caps. Same signal-only
    // probe set as pref-long — only the session size / compaction pressure differs.
    "pref-xlong": {
      header: false,
      max: false,
      cents: false,
      status: true,
      channel: "WHOLESALE",
      region: "EMEA",
      warehouse: "WH-07",
    },
    "pref-combined": {
      header: false,
      max: false,
      cents: false,
      status: true,
      channel: "WHOLESALE",
      region: "EMEA",
      warehouse: "WH-07",
    },
    default: { cap: 100, staleCaps: [50] },
  };
  const cfg = TASK_CFG[result.task] || TASK_CFG.default;

  // --- Post-hoc contamination check (probe leak detection, #961) ---
  // The incidental facts MUST reach the final probe file ONLY via memory. If any
  // intermediate/session-created file (anything but the probe file itself) also
  // contains the literal value, the agent could have read it off disk instead of
  // recalling it — so that "pass" is NOT memory-attributable. We flag such probes
  // and runs so leaked passes can be excluded from the memory measurement.
  // Observed root cause: when a fact-stating turn ALSO asks the agent to create a
  // file, the agent documents the conventions in that file's docstring/constants
  // (e.g. DEFAULT_CHANNEL = "WHOLESALE"), which then persists across sessions.
  const projectRoot = path.join(dir, "project");
  const nonProbeText = allPyFiles(projectRoot)
    .filter((p) => path.relative(projectRoot, p) !== PROBE_FILE)
    .map((p) => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return "";
      }
    })
    .join("\n\n");
  const LEAK_VALUES = {
    channel: cfg.channel,
    region: cfg.region,
    warehouse: cfg.warehouse,
    status: cfg.status ? "SUBMITTED" : null,
  };
  const leakedFacts = Object.entries(LEAK_VALUES)
    .filter(
      ([, v]) => v && new RegExp(`["']${v}["']|\\b${v}\\b`).test(nonProbeText),
    )
    .map(([name]) => name);
  const contaminated = leakedFacts.length > 0;
  // Map each incidental-fact probe to the fact whose leak would taint it.
  const LEAK_FACT = {
    "passing-mention-channel": "channel",
    "passing-mention-region": "region",
    "passing-mention-warehouse": "warehouse",
    "superseded-uppercase-status": "status",
  };

  const probes =
    generated?.probes ??
    PROBES.filter((p) => !p.applies || p.applies(cfg)).map((p) => {
      const factName = LEAK_FACT[p.id];
      const leaked = factName ? leakedFacts.includes(factName) : false;
      const held = exists ? !!p.check({ probe, all, cfg }) : false;
      return { id: p.id, axis: p.axis, held, ...(factName ? { leaked } : {}) };
    });
  const held = probes.filter((p) => p.held).length;
  // A "clean" pass = held AND the fact did not leak into a readable file. This is
  // the memory-attributable count; use it (not probesHeld) for the A/B.
  const heldClean = probes.filter((p) => p.held && !p.leaked).length;
  const t = result.totals;
  return {
    arm: result.arm,
    model: result.model,
    probeFileCreated: exists,
    probesHeld: `${held}/${probes.length}`,
    probesHeldClean: `${heldClean}/${probes.length}`,
    contaminated: generated ? generated.leakedFacts.length > 0 : contaminated,
    leakedFacts: generated ? generated.leakedFacts : leakedFacts,
    probes,
    compactions: result.compactions,
    metrics: {
      turns: t.steps,
      answeringTokens: t.tokensTotal,
      peakContext: t.peakContext,
      toolCalls: t.toolCalls,
      wallSec: Math.round(t.wallSec),
    },
    cost: (() => {
      const lc = loreCost(dir);
      const bgTokens = lc.distillInTok + lc.distillOutTok;
      return {
        // foreground answer (both arms, from opencode's own usage stream)
        answeringUsd: Number((t.cost || 0).toFixed(4)),
        // Lore background (lore arm only)
        loreConversationUsd: Number(lc.conversationUsd.toFixed(4)),
        loreWorkerUsd: Number(lc.workerUsd.toFixed(4)),
        loreWarmupUsd: Number(lc.warmupUsd.toFixed(4)),
        loreTotalUsd: Number(lc.totalUsd.toFixed(4)),
        distillCalls: lc.distillCalls,
        backgroundTokens: bgTokens,
        // fair grand totals
        grandUsd: Number(
          (lc.totalUsd > 0 ? lc.totalUsd : t.cost || 0).toFixed(4),
        ),
        grandTokens: t.tokensTotal + bgTokens,
        embeddingsOk: lc.embeddingsOk,
      };
    })(),
  };
}

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error("usage: bun score.mjs <arm-out-dir> [<arm-out-dir> ...]");
  process.exit(2);
}
const rows = dirs.map(scoreArm);
const groups = new Map();
for (const row of rows) {
  const result = JSON.parse(
    fs.readFileSync(path.join(dirs[rows.indexOf(row)], "result.json"), "utf8"),
  );
  const key = `${result.task}:${result.model}:${result.agent}:${result.repetition}`;
  const group = groups.get(key) || [];
  group.push({ row, result });
  groups.set(key, group);
}
for (const group of groups.values()) {
  const maps = new Set(group.map(({ result }) => result.factMapId));
  const arms = new Set(group.map(({ result }) => result.arm));
  if (
    group.length !== 2 ||
    maps.size !== 1 ||
    arms.size !== 2 ||
    !arms.has("lore") ||
    !arms.has("nolore")
  ) {
    throw new Error(
      `retention scoring requires one paired lore/nolore run with one fact map for ${group[0].result.task}/${group[0].result.model}/${group[0].result.agent}/r${group[0].result.repetition}`,
    );
  }
}
console.log(JSON.stringify(rows, null, 2));
console.log("\n=== SUMMARY ===");
for (const r of rows) {
  const c = r.cost;
  const leakTag = r.contaminated
    ? ` | ⚠ CONTAMINATED leak=[${r.leakedFacts.join(",")}] clean ${r.probesHeldClean}`
    : "";
  console.log(
    `${r.arm.padEnd(7)} | probes ${r.probesHeld}${leakTag} | compactions ${r.compactions} | turns ${r.metrics.turns} | GRAND ${c.grandTokens.toLocaleString()} tok (answer ${r.metrics.answeringTokens.toLocaleString()} + bg ${c.backgroundTokens.toLocaleString()}) | peakCtx ${r.metrics.peakContext.toLocaleString()} | tools ${r.metrics.toolCalls}`,
  );
  const bg =
    c.loreTotalUsd > 0
      ? `Lore $: conv $${c.loreConversationUsd} + worker $${c.loreWorkerUsd} (${c.distillCalls} distill) = GRAND $${c.grandUsd} | embeddings ${c.embeddingsOk ? "on" : "OFF(FTS-only)"}`
      : `$: answer $${c.answeringUsd} (no background) — note: $0 on M3 = opencode has no M3 pricing; use tokens`;
  console.log(`         ${bg}`);
  for (const p of r.probes)
    console.log(
      `         ${p.held ? (p.leaked ? "⚠" : "✓") : "·"} ${p.id} (${p.axis})${p.leaked ? " [LEAKED to file — not memory]" : ""}`,
    );
}
