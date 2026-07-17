#!/usr/bin/env node
/**
 * Lore invariant-check GHA reporter. Reads the `lore invariant-check --json`
 * output and emits GitHub annotations + a job summary. ADVISORY ONLY: it emits
 * `::warning::` workflow commands (never `::error::`) and ALWAYS exits 0 — the
 * whole point is that this never fails a build. Humans decide.
 */
import { readFileSync, appendFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.log("::notice title=Lore invariant-check::no result file");
  process.exit(0);
}

/** @type {{findings: Array<{invariantTitle:string,invariantContent:string,file:string,reason:string|null,severity:string,refHit:boolean,similarity:number}>, hunks:number, invariants:number, candidates:number, judgeCalls:number, model?:string}} */
let result;
try {
  result = JSON.parse(readFileSync(path, "utf8"));
} catch (e) {
  console.log(`::notice title=Lore invariant-check::unreadable result (${e})`);
  process.exit(0);
}

const findings = result.findings ?? [];
const summaryFile = process.env.GITHUB_STEP_SUMMARY;

const funnel =
  `${result.hunks} hunks × ${result.invariants} invariants → ` +
  `${result.candidates} candidates → ${result.judgeCalls} judge calls` +
  (result.model ? ` · ${result.model}` : "");

function esc(s) {
  // Escape for workflow-command message data.
  return String(s ?? "").replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

if (findings.length === 0) {
  console.log(`::notice title=Lore invariant-check::✓ no suspected invariant violations (${funnel})`);
  if (summaryFile) {
    appendFileSync(
      summaryFile,
      `## 🧭 Lore semantic linter\n\n✓ No suspected invariant violations.\n\n<sub>${funnel}</sub>\n`,
    );
  }
  process.exit(0);
}

// Gate classification (present when the CLI computed it). In gate mode a
// blocking finding is an `::error::`; everything else is a `::warning::`. In
// advisory mode everything is a warning (the job never fails).
const gate = result.gate ?? null;
const gated = gate?.mode === "gate";
const blockingIds = new Set(
  (gate?.blocking ?? []).map((f) => `${f.invariantId}\x1f${f.file}`),
);
const overriddenIds = new Set(
  (gate?.overridden ?? []).map(
    (o) => `${o.finding.invariantId}\x1f${o.finding.file}`,
  ),
);

function findingKey(f) {
  return `${f.invariantId}\x1f${f.file}`;
}

// Annotations. Blocking (gate mode) → error; overridden → notice; else warning.
for (const f of findings) {
  const key = findingKey(f);
  const isBlocking = gated && blockingIds.has(key);
  const isOverridden = overriddenIds.has(key);
  const level = isBlocking ? "error" : isOverridden ? "notice" : "warning";
  const tag = isBlocking
    ? "BLOCKING"
    : isOverridden
      ? "overridden"
      : f.severity;
  const title = `Lore invariant [${tag}]: ${f.invariantTitle}`;
  const msg =
    `${f.reason ?? "possible contradiction"}\n\n` +
    `Invariant: ${f.invariantContent}`;
  console.log(`::${level} file=${f.file},title=${esc(title)}::${esc(msg)}`);
}

// Job summary — a readable table + gate status.
if (summaryFile) {
  const rows = findings
    .map((f) => {
      const key = findingKey(f);
      const state = gated && blockingIds.has(key)
        ? "🚫 blocking"
        : overriddenIds.has(key)
          ? "↪ overridden"
          : "advisory";
      return `| \`${f.severity}\` | ${state} | ${f.invariantTitle} | \`${f.file}\` | ${(f.reason ?? "").replace(/\|/g, "\\|")} |`;
    })
    .join("\n");
  const header = gated
    ? gate.blocking.length > 0
      ? `🚫 **${gate.blocking.length} blocking** + ${findings.length - gate.blocking.length} advisory — gate mode. Override a soft finding with a \`lore-override: <invariant> — <reason>\` commit trailer; strict cannot be overridden.`
      : `✓ Gate passed — ${findings.length} advisory finding${findings.length === 1 ? "" : "s"}, none blocking.`
    : `⚠ **${findings.length} suspected invariant contradiction${findings.length === 1 ? "" : "s"}** — advisory, review; this check never fails the build.`;
  appendFileSync(
    summaryFile,
    `## 🧭 Lore semantic linter\n\n${header}\n\n` +
      `| severity | state | invariant | file | why |\n|---|---|---|---|---|\n${rows}\n\n` +
      `<sub>${funnel}</sub>\n`,
  );
}

// The reporter itself always exits 0 — the gate fail is a separate action step.

// ADVISORY: always succeed.
process.exit(0);
