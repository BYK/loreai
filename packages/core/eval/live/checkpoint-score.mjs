// Aggregate the executable checkpoint results emitted by driver.mjs.
// This is intentionally separate from score.mjs, which measures the narrower
// fact-retention stress task and its cost accounting.

import fs from "node:fs";
import path from "node:path";

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error("usage: bun checkpoint-score.mjs <run-dir> [<run-dir> ...]");
  process.exit(2);
}

function wilsonInterval(successes, total, z = 1.96) {
  if (total === 0) return [0, 0];
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denom;
  const radius =
    (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) /
    denom;
  return [Math.max(0, centre - radius), Math.min(1, centre + radius)];
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  ];
}

const rows = dirs.map((dir) => {
  const result = JSON.parse(
    fs.readFileSync(path.join(dir, "result.json"), "utf8"),
  );
  const checkpoints = result.checkpoints || [];
  const strictPassed = checkpoints.filter((c) => c.strict?.passed).length;
  const isolatedPassed = checkpoints.filter((c) => c.isolated?.passed).length;
  const corePassed = checkpoints.filter((c) => c.core?.passed).length;
  return {
    dir,
    arm: result.arm,
    agent: result.agent,
    model: result.model,
    task: result.task,
    taskSha256: result.taskSha256,
    factMapId: result.factMapId,
    valid: result.valid,
    terminalOutcome: result.terminalOutcome || null,
    repetition: result.repetition,
    checkpoints: checkpoints.length,
    expectedCheckpoints: result.expectedCheckpoints || 5,
    strict: `${strictPassed}/${checkpoints.length}`,
    isolated: `${isolatedPassed}/${checkpoints.length}`,
    core: `${corePassed}/${checkpoints.length}`,
    allStrict:
      checkpoints.length === (result.expectedCheckpoints || 5) &&
      strictPassed === checkpoints.length,
    metrics: result.totals,
  };
});

for (const row of rows) {
  if (!row.valid)
    throw new Error(`invalid run must not be aggregated: ${row.dir}`);
  if (
    row.checkpoints !== row.expectedCheckpoints &&
    row.terminalOutcome !== "agent-timeout"
  ) {
    throw new Error(
      `incomplete checkpoint run (expected ${row.expectedCheckpoints} checkpoints): ${row.dir}`,
    );
  }
}

const groups = new Map();
for (const row of rows) {
  const key = `${row.task}:${row.model}:${row.agent}:${row.repetition}`;
  const group = groups.get(key) || [];
  group.push(row);
  groups.set(key, group);
}
for (const group of groups.values()) {
  const maps = new Set(group.map((row) => row.factMapId));
  const arms = new Set(group.map((row) => row.arm));
  if (
    group.length !== 2 ||
    maps.size !== 1 ||
    arms.size !== 2 ||
    !arms.has("lore") ||
    !arms.has("nolore")
  ) {
    throw new Error(
      `paired lore/nolore runs must share one fact map for ${group[0].task}/${group[0].model}/${group[0].agent}/r${group[0].repetition}`,
    );
  }
}

const aggregates = new Map();
for (const row of rows) {
  const key = `${row.task}:${row.model}:${row.agent}:${row.arm}`;
  const group = aggregates.get(key) || [];
  group.push(row);
  aggregates.set(key, group);
}
const summary = [...aggregates.values()].map((group) => {
  const first = group[0];
  const checkpoints = group.reduce((n, row) => n + row.checkpoints, 0);
  const strict = group.reduce(
    (n, row) => n + Number(row.strict.split("/")[0]),
    0,
  );
  const isolated = group.reduce(
    (n, row) => n + Number(row.isolated.split("/")[0]),
    0,
  );
  const core = group.reduce((n, row) => n + Number(row.core.split("/")[0]), 0);
  const wall = group.map((row) => row.metrics.wallSec || 0);
  return {
    task: first.task,
    model: first.model,
    agent: first.agent,
    arm: first.arm,
    runs: group.length,
    strict: {
      successes: strict,
      total: checkpoints,
      ci95: wilsonInterval(strict, checkpoints),
    },
    isolated: {
      successes: isolated,
      total: checkpoints,
      ci95: wilsonInterval(isolated, checkpoints),
    },
    core: {
      successes: core,
      total: checkpoints,
      ci95: wilsonInterval(core, checkpoints),
    },
    performance: {
      wallP50Sec: percentile(wall, 0.5),
      wallP95Sec: percentile(wall, 0.95),
      meanTokens:
        group.reduce((n, row) => n + (row.metrics.tokensTotal || 0), 0) /
        group.length,
      meanSteps:
        group.reduce((n, row) => n + (row.metrics.steps || 0), 0) /
        group.length,
    },
  };
});

console.log(JSON.stringify(rows, null, 2));
console.log("\n=== CHECKPOINT SUMMARY ===");
for (const row of rows) {
  console.log(
    `${row.agent.padEnd(8)} ${row.arm.padEnd(7)} ${row.model} | core ${row.core} | isolated ${row.isolated} | strict ${row.strict} | completion ${row.checkpoints}/${row.expectedCheckpoints} | final ${row.allStrict ? "PASS" : row.terminalOutcome ? "PARTIAL" : "FAIL"}${row.terminalOutcome ? ` | terminal ${row.terminalOutcome}` : ""}`,
  );
}
console.log("\n=== AGGREGATES (Wilson 95% CI) ===");
console.log(JSON.stringify(summary, null, 2));
