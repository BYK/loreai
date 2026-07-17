#!/usr/bin/env node
/**
 * Lore invariant-check GHA reporter. Reads the `lore invariant-check --json`
 * output and emits GitHub **file annotations** (so findings render in-context on
 * the PR diff, at the changed line) plus a job summary. The reporter itself
 * ALWAYS exits 0 — failing a blocked build is a separate action step, never this
 * script. Annotation level: `::error::` for a gate-blocking finding, `::notice::`
 * for an overridden one, `::warning::` otherwise (advisory).
 */
import { readFileSync, appendFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.log("::notice title=Lore invariant-check::no result file");
  process.exit(0);
}

/** @type {{findings: Array<{invariantId:string,invariantTitle:string,invariantContent:string,file:string,reason:string|null,severity:string,refHit:boolean,similarity:number,hunk:string}>, hunks:number, invariants:number, candidates:number, judgeCalls:number, model?:string, gate?:object}} */
let result;
try {
  result = JSON.parse(readFileSync(path, "utf8"));
} catch (e) {
  console.log(
    `::notice title=Lore invariant-check::unreadable result (${String(e)})`,
  );
  process.exit(0);
}

const findings = result.findings ?? [];
const summaryFile = process.env.GITHUB_STEP_SUMMARY;

const funnel =
  `${result.hunks} hunks × ${result.invariants} invariants → ` +
  `${result.candidates} candidates → ${result.judgeCalls} judge calls` +
  (result.model ? ` · ${result.model}` : "");

function esc(s) {
  // Escape workflow-command MESSAGE data (the part after `::`). Only %, CR, LF
  // are special here.
  return String(s ?? "")
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

function escProp(s) {
  // Escape a workflow-command PROPERTY value (e.g. file=…, title=…). Properties
  // are comma-separated and key:value, so `,` and `:` must be escaped too or a
  // value containing them shifts/splits the annotation's parameters.
  return esc(s).replace(/,/g, "%2C").replace(/:/g, "%3A");
}

/** Escape a markdown table cell: neutralize `|` and collapse newlines so a
 *  finding with a pipe in its title or a multi-line judge reason can't corrupt
 *  the rendered table. */
function cell(s) {
  return String(s ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

/** Extract the new-file line span from a unified-diff hunk header so the
 *  annotation lands on the actual changed lines in the PR diff. Header shape:
 *  `@@ -a,b +c,d @@ ...` → { line: c, endLine: c + d - 1 }. Returns null when the
 *  header is absent/unparseable (annotation then falls back to file-level). */
function hunkRange(hunkText) {
  const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(hunkText ?? "");
  if (!m) return null;
  const start = Number(m[1]);
  const count = m[2] === undefined ? 1 : Number(m[2]);
  if (!Number.isFinite(start) || start < 1) return null;
  // count 0 (pure deletion hunk) → annotate the single anchor line.
  const endLine = count > 0 ? start + count - 1 : start;
  return { line: start, endLine };
}

if (findings.length === 0) {
  console.log(
    `::notice title=Lore invariant-check::✓ no suspected invariant violations (${funnel})`,
  );
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

// File annotations. Blocking (gate mode) → error; overridden → notice; else
// warning. A `line`/`endLine` derived from the hunk header makes each annotation
// render at the changed lines in the PR diff (in-context), falling back to a
// file-level annotation when the header can't be parsed. EVERY interpolated
// field (including file) is escaped — an unescaped value can inject a second
// workflow command.
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
  const range = hunkRange(f.hunk);
  const loc = range
    ? `file=${escProp(f.file)},line=${range.line},endLine=${range.endLine}`
    : `file=${escProp(f.file)}`;
  console.log(`::${level} ${loc},title=${escProp(title)}::${esc(msg)}`);
}

// Job summary — a readable table + gate status.
if (summaryFile) {
  const rows = findings
    .map((f) => {
      const key = findingKey(f);
      const state =
        gated && blockingIds.has(key)
          ? "🚫 blocking"
          : overriddenIds.has(key)
            ? "↪ overridden"
            : "advisory";
      return `| \`${cell(f.severity)}\` | ${state} | ${cell(f.invariantTitle)} | \`${cell(f.file)}\` | ${cell(f.reason)} |`;
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
