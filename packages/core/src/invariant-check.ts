/**
 * invariant-check.ts — the "semantic linter" PoC (#TBD).
 *
 * Answers Armin Ronacher's "the tower keeps rising" problem at CI time: agents
 * remove the friction that used to force humans to re-synchronize their shared
 * model of a system, so changes can land that silently violate a documented
 * invariant. This module surfaces those violations at change time — the one
 * moment construction would otherwise continue without anyone noticing.
 *
 * It is a MEASUREMENT TOOL first: it never fails a build (the CLI never exits
 * non-zero on findings). The whole idea lives or dies on false-positive rate, so
 * the job here is to produce per-candidate verdicts + cost so we can point it at
 * real merged PRs and get an honest TP/FP number before anyone gates on it.
 *
 * Cost funnel (spend deterministic compute to avoid LLM calls; the judge is the
 * ONLY LLM cost):
 *   Stage 0 — changed-files gate (free): an invariant enters the funnel only if
 *             one of its `file:line`/symbol refs (via references.ts) points into
 *             a changed file, OR it has no refs at all (fall through to Stage 1).
 *   Stage 1 — embedding cosine prefilter (free w/ local ONNX): match diff hunks
 *             against invariant embeddings using contradiction.ts's
 *             CANDIDATE_SIMILARITY. Only near pairs survive.
 *   Stage 2 — judge (LLM): one cheap-worker-model call per surviving pair,
 *             most-similar-first, hard-capped. Diff-only context, temp 0.
 *
 * Reuses: ltm.forProject (invariant set), embeddingByIdSource (invariant
 * vectors, same helper contradiction.ts uses), references.extractReferences
 * (Stage 0 scoping), embedding.embed + cosineSimilarity (Stage 1),
 * INVARIANT_JUDGE_SYSTEM (Stage 2 — cloned from CONTRADICTION_JUDGE_SYSTEM).
 */

import { execFileSync } from "node:child_process";
import { db } from "./db";
import { embeddingByIdSource, readStorageMode } from "./db/vec-store";
import { anthropicThinkingBudget, type ReasoningEffort } from "./effort";
import * as embedding from "./embedding";
import * as ltm from "./ltm";
import type { KnowledgeEntry } from "./ltm";
import {
  INVARIANT_JUDGE_SYSTEM,
  invariantJudgeRepairUser,
  invariantJudgeUser,
} from "./prompt";
import { extractReferences } from "./references";
import type { LLMClient } from "./types";

// ---------------------------------------------------------------------------
// Constants (mirror contradiction.ts bounds so cost stays capped)
// ---------------------------------------------------------------------------

/** Minimum cosine similarity for a (hunk, invariant) pair to be a candidate.
 *  The diff-vs-invariant embedding space is much FLATTER than the
 *  entry-vs-entry space contradiction.ts tuned 0.6 for — at 0.6 nearly every
 *  pair qualifies (the first eval saw ~4800 candidates from 29 hunks), so the
 *  budget got spent on noise. Empirically the diff space needs a higher bar; a
 *  ref-hit (Stage 0) always bypasses this floor since it is exact evidence. */
export const CANDIDATE_SIMILARITY = 0.72;

/** Two hunks with cosine ≥ this are treated as near-duplicates: only ONE is
 *  judged and the rest inherit its verdicts for free (no LLM call). This is the
 *  "mark the similar ones with cheaper checks" lever — a rename repeated across
 *  10 files costs one judge call, not ten. */
export const HUNK_DUP_SIMILARITY = 0.92;

/** Per distinct hunk, how many of its most-relevant invariants to judge. Kept
 *  small so the budget spreads ACROSS the PR's distinct changes (coverage)
 *  rather than piling onto one hunk. Ref-hits are always included on top. */
export const PER_HUNK_INVARIANTS = 3;

/** Only consider invariants above this confidence — a barely-reinforced entry
 *  hasn't earned an enforcement judge call (mirrors DEAD_CONFIDENCE_FLOOR). */
export const MIN_CONFIDENCE = 0.2;

/** Cap the invariant set scanned (forProject is confidence DESC) so a huge
 *  knowledge base can't blow up the O(hunks×invariants) prefilter. */
const MAX_INVARIANTS_SCAN = 300;

// Output budget for the judge's verdict JSON. Tiny without reasoning; with effort
// ON, reasoning tokens are billed against the output budget.
//
// Provider behavior at the gateway (packages/gateway/src/llm-adapter.ts):
//   - Anthropic: the gateway independently raises max_tokens above the thinking
//     budget. We still send a generous value here so the two paths agree.
//   - OpenAI / Gemini reasoning models WITH populated reasoning_options in
//     models.dev: the gateway applies `workerReasoningHeadroomFloor`
//     (DEFAULT_REASONING_MODEL_BUDGET + THINKING_OUTPUT_HEADROOM = 24576) on top
//     of any caller maxTokens, so this value is just the floor and the gateway
//     bumps it for reasoning-capable models. This is the path `github-copilot/
//     gpt-5-mini` (the default judge) takes once the CLI awaits fetchModelData
//     before the first judge call (cli/invariant-check.ts:97).
//   - OpenAI / Gemini models WITHOUT reasoning_options (or models absent from
//     models.dev): the gateway falls back to the caller maxTokens. The 256
//     below is the budget in that empty-cache fallback — small because the
//     verdict is one line and the model has no reasoning to burn it on.
//
// Headroom matches the gateway's THINKING_OUTPUT_HEADROOM (8192) so the numbers
// don't diverge confusingly.
const JUDGE_VERDICT_TOKENS = 256;
const JUDGE_VERDICT_HEADROOM = 8192;
// Self-contained minimum — survives an empty models.dev cache (or any CI where
// the fetchModelData pre-warm times out before the first judge call). Matches
// the gateway's workerReasoningHeadroomFloor (16384 + 8192 = 24576) rounded up
// to 25600 so the linter never produces empty-content / length-truncated judge
// responses regardless of models.dev availability. The gateway's
// `Math.max(callerMax, floor)` honors caller values, so passing this explicitly
// is a floor-on-the-caller-side that doesn't depend on `workerModelReasons`.
// Cheap for non-reasoning models (a floor, never a charge — they bill only
// what they emit), strict for reasoning ones.
const JUDGE_VERDICT_MIN_BUDGET = 25_600;
export function judgeMaxTokens(effort: ReasoningEffort | undefined): number {
  const budget = anthropicThinkingBudget(effort) ?? 0;
  const thinking =
    budget > 0 ? budget + JUDGE_VERDICT_HEADROOM : JUDGE_VERDICT_TOKENS;
  return Math.max(thinking, JUDGE_VERDICT_MIN_BUDGET);
}

export {
  INVARIANT_JUDGE_SYSTEM,
  invariantJudgeRepairUser,
  invariantJudgeUser,
} from "./prompt";

// Legacy reporter compatibility. New callers must use `health.judge` and the
// typed candidate outcomes instead of treating unresolved checks as clean.
// Remove this once the gateway's report renderer consumes the health result.
export const UNPARSEABLE_WARN_RATIO = 0.5;

/** Never send more than this many pairs to the judge in one run. Surviving
 *  pairs are judged most-similar-first; the cap is the cost ceiling per PR. */
export const MAX_JUDGE_CALLS = 20;

// ---------------------------------------------------------------------------
// Enforceable-invariant filter
// ---------------------------------------------------------------------------

/**
 * PRESCRIPTIVE language: the entry states a rule the code must obey, not a
 * description of how something behaves. This is necessary but NOT sufficient —
 * "Always a remote gateway" is descriptive prose that happens to contain
 * "always". Pair it with a code signal (see {@link isEnforceableInvariant}).
 */
const PRESCRIPTIVE_RE =
  /\b(must not|must never|must always|must|never|always|do not|don't|shall not|forbidden|prohibited|is required|are required|only ever)\b/i;

/**
 * A CODE signal: the entry is about source code, not workflow/prose. Two strong
 * forms only (deliberately strict — the eval showed loose camelCase matching
 * leaks workflow prefs like "call plan_exit"):
 *   1. a file path with a source extension (foo.ts, bar.sql, ...)
 *   2. a call/qualified-symbol form (foo(), Bar::baz, obj.method)
 * A `file:line`/symbol reference from references.ts also counts (checked in the
 * enforceable predicate) — that is the strongest possible code signal.
 */
const CODE_SIGNAL_RE =
  /\b[\w./-]+\.(ts|tsx|js|jsx|mjs|cjs|sql|py|rs|go|rb|java|kt|c|h|cpp)\b|\b[a-zA-Z_]\w*\([^)]*\)|::\w|\b\w+\.\w+\(/;

/** Categories that describe *code* behavior (vs. `preference`, which is usually
 *  about workflow/session/personal facts). A prescriptive entry in one of these
 *  categories is more likely a real code invariant. */
const CODE_CATEGORIES = new Set([
  "gotcha",
  "architecture",
  "pattern",
  "decision",
]);

/**
 * Decide whether a knowledge entry is an ENFORCEABLE code invariant — i.e.
 * worth spending a judge call to check a diff against. This is the fix the model
 * sweep demanded: the one false positive (gpt-4.1-mini flagging a *descriptive*
 * test-infra gotcha) came from feeding a non-enforceable entry to the judge.
 *
 * Precedence:
 *   1. Explicit opt-in/out via metadata `enforce` (future `enforce:` field) —
 *      author intent always wins. `enforce: "strict"|"soft"|true` → yes;
 *      `enforce: false|"off"` → no.
 *   2. Heuristic default: PRESCRIPTIVE language AND a code signal (a
 *      references.ts file/symbol ref, OR a code token, OR a code-ish category).
 *
 * Deliberately biased toward EXCLUSION: a missed invariant is silent (fine for
 * advisory), a spurious one wastes a call and risks the FP that gets the whole
 * check muted. Pure + exported for testing and for the eval harness.
 */
export function isEnforceableInvariant(entry: {
  title: string;
  content: string;
  category?: string;
  metadata?: Record<string, unknown> | null;
}): boolean {
  // 1. Explicit author intent (future-proofing for the `enforce:` opt-in).
  const enforce = entry.metadata?.enforce;
  if (enforce === false || enforce === "off" || enforce === "false")
    return false;
  if (enforce === true || enforce === "strict" || enforce === "soft")
    return true;

  // 2. Heuristic.
  const text = `${entry.title}: ${entry.content}`;
  if (!PRESCRIPTIVE_RE.test(text)) return false;
  const hasCodeRef = extractReferences(text).some(
    (r) => r.kind === "file" || r.kind === "symbol",
  );
  const hasCodeToken = CODE_SIGNAL_RE.test(text);
  const codeCategory = entry.category
    ? CODE_CATEGORIES.has(entry.category)
    : false;
  return hasCodeRef || hasCodeToken || codeCategory;
}

/**
 * The MAXIMUM enforcement level an invariant may reach:
 *   - `advisory`  → surface as a note; NEVER fails a build. The floor for
 *                   everything, and the ceiling for enumeration-style rules.
 *   - `soft`      → overridable gate (a `lore-override: <reason>` in the PR
 *                   turns it into a recorded decision instead of a failure).
 *   - `strict`    → hard gate; only reachable via explicit `enforce: "strict"`.
 *
 * The eval's key precision lesson: ENUMERATION invariants ("here are the N
 * error types that are silenced", "the precedence is A > B > C") flag EVERY
 * legitimate PR that adds an N+1th item or reorders — the Seer error-reporting
 * cluster (#1225–#1251) tripped this 7×, all factually-correct drift but none a
 * breakage. Such invariants are inherently advisory: correct to surface once to
 * a human, wrong to gate on. So an enumeration invariant is CAPPED at advisory
 * even if its author wrote `enforce: strict` — a hard gate on "did you add a
 * new enum member" is a false-positive machine.
 */
export type EnforcementLevel = "advisory" | "soft" | "strict";

/** Enumeration/whitelist prose: rules that assert a CLOSED SET ("the N types",
 *  "the order is A > B > C", "only these", "the exhaustive list"). Adding to or
 *  reordering the set is legitimate drift, not a violation — so cap at advisory. */
const ENUMERATION_RE =
  /\b(which\s+\w+\s+(are|types)|silenc\w*\s+rules|precedence|order is|priority|exhaustive|the following (types|errors|values)|list of|enumerat\w+|> \w+ >|whitelist|allowlist)\b/i;

/** True when the invariant asserts a closed set whose extension is legitimate
 *  drift. Pure + exported for testing. */
export function isEnumerationInvariant(entry: {
  title: string;
  content: string;
}): boolean {
  return ENUMERATION_RE.test(`${entry.title}: ${entry.content}`);
}

/**
 * Resolve an invariant's ceiling enforcement level. Author intent (`enforce:`)
 * sets the target; enumeration invariants are clamped to `advisory` regardless.
 * Everything defaults to `advisory` — a rule only escalates to a gate when its
 * author deliberately opts in AND it isn't an enumeration.
 */
export function enforcementLevel(entry: {
  title: string;
  content: string;
  metadata?: Record<string, unknown> | null;
}): EnforcementLevel {
  const requested = entry.metadata?.enforce;
  let level: EnforcementLevel = "advisory";
  if (requested === "strict" || requested === true) level = "strict";
  else if (requested === "soft") level = "soft";
  // Enumeration clamp: never gate on "you added a new enum member".
  if (level !== "advisory" && isEnumerationInvariant(entry)) return "advisory";
  return level;
}

// ---------------------------------------------------------------------------
// Git range auto-detection (Craft-style: resolve base/head automatically)
// ---------------------------------------------------------------------------

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function gitOrNull(args: string[], cwd: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

/**
 * Collect full commit messages (subject + body) for `base..head`, one string
 * per commit. Used to harvest `lore-override:` trailers. Returns `[]` on any
 * git failure — an override source that can't be read is a no-op, never an
 * error (findings simply won't be overridable, which fails safe toward
 * reporting). `%x1f` record-separates commits so multi-line bodies survive.
 */
export function collectCommitMessages(
  projectPath: string,
  base: string,
  head: string,
): string[] {
  const out = gitOrNull(
    ["log", "--format=%B%x1f", `${base}..${head}`],
    projectPath,
  );
  if (out == null) return [];
  return out
    .split("\x1f")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface ResolvedRange {
  base: string;
  head: string;
  /** How base/head were determined — for transparency in the CLI output. */
  source: string;
}

/**
 * Resolve the (base, head) commit range to check, mirroring Craft's approach of
 * deriving the range from the environment rather than requiring explicit args.
 *
 * Precedence:
 *   1. Explicit --base/--head (caller-supplied) win outright.
 *   2. CI env: GitHub Actions PR runs expose the base via
 *      GITHUB_BASE_REF (the target branch) and head via GITHUB_SHA / HEAD.
 *   3. Local: merge-base of HEAD against the default branch (origin/HEAD →
 *      origin/main → main), so a feature checkout "just works". This is the
 *      symmetric-diff base — commits reachable from HEAD but not the base,
 *      exactly the `A - B` range Craft's getChangesSince computes.
 *
 * Returns null base only when nothing resolves (caller reports and no-ops).
 */
export function resolveRange(
  cwd: string,
  opts: { base?: string; head?: string },
): ResolvedRange | null {
  const head =
    opts.head ||
    process.env.GITHUB_SHA ||
    gitOrNull(["rev-parse", "HEAD"], cwd) ||
    "HEAD";

  if (opts.base) {
    return { base: opts.base, head, source: "explicit --base" };
  }

  // GitHub Actions PR context: base branch is the merge target.
  const ghBase = process.env.GITHUB_BASE_REF;
  if (ghBase) {
    // Prefer the merge-base so we diff only the PR's own commits, not commits
    // that landed on the base after the branch forked (matches Craft's A - B).
    const mb =
      gitOrNull(["merge-base", `origin/${ghBase}`, head], cwd) ||
      gitOrNull(["merge-base", ghBase, head], cwd);
    if (mb) return { base: mb, head, source: `GITHUB_BASE_REF (${ghBase})` };
    return {
      base: `origin/${ghBase}`,
      head,
      source: `GITHUB_BASE_REF (${ghBase})`,
    };
  }

  // Local feature-branch context: merge-base against the default branch.
  const defaultBranch = resolveDefaultBranch(cwd);
  if (defaultBranch) {
    const mb = gitOrNull(["merge-base", defaultBranch, head], cwd);
    if (mb && mb !== gitOrNull(["rev-parse", head], cwd)) {
      return { base: mb, head, source: `merge-base with ${defaultBranch}` };
    }
  }

  // Fallback: previous commit (a single-commit review). Better than nothing.
  const prev = gitOrNull(["rev-parse", `${head}~1`], cwd);
  if (prev) return { base: prev, head, source: "HEAD~1 (fallback)" };

  return null;
}

/** The repo's default branch ref, mirroring Craft's getDefaultBranch: prefer
 *  origin/HEAD's target, then common names. Returns null if none resolve. */
function resolveDefaultBranch(cwd: string): string | null {
  const originHead = gitOrNull(
    ["rev-parse", "--abbrev-ref", "origin/HEAD"],
    cwd,
  );
  if (originHead && originHead !== "origin/HEAD") return originHead;
  for (const cand of ["origin/main", "origin/master", "main", "master"]) {
    if (gitOrNull(["rev-parse", "--verify", cand], cwd)) return cand;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Diff parsing
// ---------------------------------------------------------------------------

export interface DiffHunk {
  file: string;
  /** The unified-diff hunk text (the `@@ ... @@` header + its body). */
  text: string;
}

export type DiffResult =
  | { kind: "success"; hunks: DiffHunk[] }
  | {
      kind: "failure";
      failure: { code: "diff-command-failed"; message: string };
    };

/**
 * Files whose changes are NEVER judged: they are machine-authored or are lore's
 * own knowledge file — not human-written source/docs the invariants govern.
 *  - `.lore.md`: the knowledge file itself — its diff literally IS the invariant
 *    text, so a change to it looks maximally "similar" to every invariant. This
 *    is the single biggest FP source the first real run surfaced. This is the
 *    ONLY documentation file excluded — real docs (README, *.md, *.mdx, guides)
 *    ARE judged, since a docs change can contradict a documented invariant.
 *  - Lockfiles / vendored / generated / build output: machine-authored, no
 *    human-decided invariants apply.
 *
 * Matching is by basename OR path-suffix so it works regardless of monorepo
 * depth. Extend via `LORE_INVARIANT_CHECK_IGNORE` (comma-separated globs) later;
 * for the PoC this static set is enough to clean the eval signal.
 */
export const DEFAULT_IGNORE_BASENAMES = new Set<string>([
  ".lore.md",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "go.sum",
]);

/** Directory segments whose files are never judged (generated / vendored). */
const IGNORE_DIR_SEGMENTS = new Set<string>([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "vendor",
  "__snapshots__",
]);

/** True when a changed file should be excluded from judging. Pure + exported so
 *  the eval and tests can reason about it directly. */
export function isIgnoredFile(path: string): boolean {
  const parts = path.split("/");
  const base = parts[parts.length - 1] ?? path;
  if (DEFAULT_IGNORE_BASENAMES.has(base)) return true;
  for (const seg of parts) if (IGNORE_DIR_SEGMENTS.has(seg)) return true;
  // Generated type/declaration and minified bundles.
  if (base.endsWith(".d.ts") || base.endsWith(".min.js")) return true;
  return false;
}

/**
 * Parse `git diff base..head` into per-file hunks. We diff-only (never whole
 * files) so judge inputs stay tiny. Binary/rename-only entries yield no hunks.
 * Ignored files (see {@link isIgnoredFile}) are dropped here.
 */
export function parseDiff(cwd: string, base: string, head: string): DiffHunk[] {
  const result = parseDiffResult(cwd, base, head);
  return result.kind === "success" ? result.hunks : [];
}

/**
 * Typed diff loader for health-aware callers. Unlike {@link parseDiff}, a git
 * failure cannot be confused with a genuine empty diff.
 */
export function parseDiffResult(
  cwd: string,
  base: string,
  head: string,
): DiffResult {
  // `-U3`: 3 lines of context per hunk (enough for the judge to see scope).
  // `--no-color`, `--no-ext-diff`: deterministic machine-readable output.
  try {
    const raw = git(
      ["diff", "--no-color", "--no-ext-diff", "-U3", `${base}..${head}`],
      cwd,
    );
    return { kind: "success", hunks: raw ? splitDiff(raw) : [] };
  } catch (error) {
    return {
      kind: "failure",
      failure: {
        code: "diff-command-failed",
        message: boundedMessage(error, "git diff failed"),
      },
    };
  }
}

/** Pure diff splitter — extracted so it's unit-testable without a real repo.
 *  Ignored files ({@link isIgnoredFile}) are dropped so the judge never wastes a
 *  call (or manufactures a false positive) on non-code changes. */
export function splitDiff(raw: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const lines = raw.split("\n");
  let file = "";
  // Fallback path from the `--- a/` line, used for DELETED files whose `+++`
  // line is `/dev/null` (no `+++ b/` to read). A change that deletes a file can
  // still contradict an invariant (e.g. removing the only guard), so its hunks
  // must be judged, not silently dropped.
  let oldFile = "";
  let cur: string[] | null = null;
  const flush = () => {
    const f = file || oldFile;
    if (cur && f && cur.length && !isIgnoredFile(f))
      hunks.push({ file: f, text: cur.join("\n") });
    cur = null;
  };
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      file = "";
      oldFile = "";
    } else if (cur === null && line.startsWith("--- a/")) {
      oldFile = line.slice("--- a/".length).trim();
    } else if (cur === null && line.startsWith("+++ b/")) {
      file = line.slice("+++ b/".length).trim();
    } else if (line.startsWith("@@")) {
      flush();
      cur = [line];
    } else if (cur) {
      cur.push(line);
    }
  }
  flush();
  return hunks;
}

/** The set of changed file paths in the diff (Stage 0 gate). */
export function changedFiles(hunks: DiffHunk[]): Set<string> {
  return new Set(hunks.map((h) => h.file));
}

// ---------------------------------------------------------------------------
// Verdict parsing (mirrors parseContradictionVerdict)
// ---------------------------------------------------------------------------

export type Verdict = "violates" | "fixes" | "satisfies" | "unrelated";

export interface InvariantVerdict {
  /**
   * The judge's classification. One of four mutually exclusive outcomes:
   *
   * - `violates` — the diff introduces or leaves in place a direct conflict
   *   with the invariant (a finding).
   * - `fixes` — the diff removes code that violated the invariant, adds a
   *   guard/enforcement, migrates a known-bad shape to a known-good one, or
   *   adds a regression-guard test that asserts the invariant. NOT a finding.
   * - `satisfies` — the diff is consistent with the invariant: neutral, a
   *   refactor, a new feature that upholds the rule. NOT a finding.
   * - `unrelated` — the diff does not actually touch the area the invariant
   *   governs, even though the cosine prefilter surfaced the pair. Corrects
   *   funnel noise. NOT a finding.
   *
   * The four-category frame prevents the dominant false-positive class: a
   * change that REMOVES the offending code (a fix) used to be reported as
   * "violates" because the binary verdict space had no "this is the fix"
   * option. With `fixes` available the judge can return the correct answer.
   */
  verdict: Verdict;
  reason: string;
}

/**
 * Validate one complete judge response. The response must be exactly one JSON
 * object, optionally wrapped in one complete `json` fence. Arbitrary prose,
 * embedded objects, legacy boolean verdicts, extra keys, and missing/empty
 * reasons are rejected so only a validated verdict completes a check.
 */
export function parseInvariantVerdict(
  text: string | null,
): InvariantVerdict | null {
  if (!text) return null;
  let payload = text.trim();
  const fenced = /^```json[ \t]*\r?\n([\s\S]*)\r?\n```$/.exec(payload);
  if (fenced) payload = fenced[1];
  else if (payload.startsWith("```") || payload.endsWith("```")) return null;

  try {
    const parsed: unknown = JSON.parse(payload);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.length !== 2 || keys[0] !== "reason" || keys[1] !== "verdict") {
      return null;
    }
    if (!isVerdict(record.verdict)) return null;
    if (
      typeof record.reason !== "string" ||
      record.reason.trim().length === 0 ||
      record.reason.length > 400
    ) {
      return null;
    }
    return { verdict: record.verdict, reason: record.reason };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Candidate pairing
// ---------------------------------------------------------------------------

export interface InvariantVec {
  entry: KnowledgeEntry;
  vec: Float32Array | null;
  /** Changed files this invariant's refs point into (Stage 0 hits). */
  refFiles: Set<string>;
}

export interface Candidate {
  hunkIdx: number;
  invariantIdx: number;
  similarity: number;
  /** True when Stage 0 (ref points into a changed file) admitted this pair —
   *  it bypasses the cosine floor since a ref hit is strong evidence. */
  refHit: boolean;
}

/** A cluster of near-duplicate hunks: one representative is judged; the members
 *  inherit its verdicts (so a repeated change is flagged everywhere, once). */
export interface HunkCluster {
  /** Index (into the hunks array) of the representative that gets judged. */
  repIdx: number;
  /** All hunk indices in this cluster (includes repIdx). */
  memberIdxs: number[];
}

/**
 * Cluster near-identical hunks by embedding cosine. Greedy single-pass: each
 * hunk joins the first existing cluster whose representative is ≥
 * {@link HUNK_DUP_SIMILARITY}, else starts a new cluster. Hunks with no vector
 * are always their own cluster (we can't prove them duplicate). Pure + exported
 * for testing.
 *
 * This is the "diversify hunks" lever: judging one representative per cluster
 * spends the budget on DISTINCT changes across the PR, not N copies of one.
 */
export function clusterHunks(
  hunkVecs: (Float32Array | null)[],
  dupSim = HUNK_DUP_SIMILARITY,
): HunkCluster[] {
  const clusters: HunkCluster[] = [];
  for (let i = 0; i < hunkVecs.length; i++) {
    const v = hunkVecs[i];
    let placed = false;
    if (v) {
      for (const c of clusters) {
        const rv = hunkVecs[c.repIdx];
        if (rv && embedding.cosineSimilarity(v, rv) >= dupSim) {
          c.memberIdxs.push(i);
          placed = true;
          break;
        }
      }
    }
    if (!placed) clusters.push({ repIdx: i, memberIdxs: [i] });
  }
  return clusters;
}

/**
 * Select which (representative-hunk, invariant) pairs to judge, spending the
 * budget for COVERAGE across distinct hunks while keeping each pair pointed at
 * the invariant most likely to be violated (highest relevance per hunk).
 *
 * Algorithm:
 *  1. For each cluster representative, rank its invariants by relevance:
 *     ref-hits first (exact evidence), then cosine ≥ floor, descending.
 *     Keep the top {@link PER_HUNK_INVARIANTS} (plus ALL ref-hits, which are
 *     never dropped — exact evidence must always be judged).
 *  2. Round-robin across representatives so early budget exhaustion still
 *     covers many distinct hunks rather than draining one hunk's whole list.
 *
 * Pure + exported for testing. Returns candidates in judge order, capped at
 * {@link MAX_JUDGE_CALLS}.
 */
export function selectCandidates(
  clusters: HunkCluster[],
  hunkVecs: (Float32Array | null)[],
  invariants: InvariantVec[],
  hunks: DiffHunk[],
  opts?: { floor?: number; perHunk?: number; cap?: number },
): Candidate[] {
  const floor = opts?.floor ?? CANDIDATE_SIMILARITY;
  const perHunk = opts?.perHunk ?? PER_HUNK_INVARIANTS;
  const cap = opts?.cap ?? MAX_JUDGE_CALLS;

  // Per representative: its ranked, admitted invariant candidates.
  const perRep: Candidate[][] = [];
  for (const cluster of clusters) {
    const hi = cluster.repIdx;
    const hv = hunkVecs[hi];
    const admitted: Candidate[] = [];
    for (let ii = 0; ii < invariants.length; ii++) {
      const inv = invariants[ii];
      const refHit = inv.refFiles.has(hunks[hi].file);
      let sim = 0;
      if (hv && inv.vec) sim = embedding.cosineSimilarity(hv, inv.vec);
      if (refHit || sim >= floor) {
        admitted.push({
          hunkIdx: hi,
          invariantIdx: ii,
          similarity: sim,
          refHit,
        });
      }
    }
    // Rank: ref-hits first, then descending cosine.
    admitted.sort((a, b) => {
      if (a.refHit !== b.refHit) return a.refHit ? -1 : 1;
      return b.similarity - a.similarity;
    });
    // Keep all ref-hits + top-N by cosine (never drop exact evidence).
    const refHits = admitted.filter((c) => c.refHit);
    const cosine = admitted.filter((c) => !c.refHit).slice(0, perHunk);
    perRep.push([...refHits, ...cosine]);
  }

  // Round-robin across representatives for coverage under the cap.
  const selected: Candidate[] = [];
  let round = 0;
  let addedThisRound = true;
  while (selected.length < cap && addedThisRound) {
    addedThisRound = false;
    for (const list of perRep) {
      if (round < list.length) {
        selected.push(list[round]);
        addedThisRound = true;
        if (selected.length >= cap) break;
      }
    }
    round++;
  }
  return selected;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface JudgeStats {
  /** Logical semantic model calls, including an invalid-verdict repair. */
  semanticCalls: number;
  /** Actual HTTP/provider dispatches across retries and fallbacks. */
  transportAttempts: number;
}

export type JudgeFailureScope = "candidate" | "run";

export type JudgeFailureCode =
  | "no-auth"
  | "auth-rejected"
  | "route-unavailable"
  | "protocol-mismatch"
  | "model-unsupported"
  | "api-unsupported"
  | "rate-limit"
  | "timeout"
  | "network"
  | "invalid-body"
  | "response-too-large"
  | "incomplete-response"
  | "empty-response"
  | "abort"
  | "transport-error"
  | "invalid-verdict"
  | "judge-contract-error"
  | "semantic-budget-exhausted";

export interface JudgeFailure {
  code: JudgeFailureCode;
  message: string;
  scope: JudgeFailureScope;
  retryable?: boolean;
}

export type JudgeOutcome =
  | {
      kind: "verdict";
      verdict: Verdict;
      reason: string;
      stats: JudgeStats;
    }
  | {
      kind: "unresolved";
      failure: JudgeFailure;
      stats: JudgeStats;
    };

export interface InvariantJudgeInput {
  invariant: { id: string; title: string; content: string };
  file: string;
  hunk: string;
  /** Remaining budget available to this candidate (normally one or two). */
  semanticCallBudget: number;
}

/**
 * Typed semantic judge boundary. Implementations own transport retries and one
 * optional invalid-verdict repair, and must report every logical call/dispatch.
 */
export interface InvariantJudge {
  judge(input: InvariantJudgeInput): Promise<JudgeOutcome>;
}

interface CandidateOutcomeBase {
  id: string;
  file: string;
  hunkIndex: number;
  invariantId: string;
  invariantTitle: string;
  similarity: number;
  refHit: boolean;
  stats: JudgeStats;
}

export type CandidateOutcome =
  | (CandidateOutcomeBase & {
      state: "resolved";
      verdict: Verdict;
      reason: string;
    })
  | (CandidateOutcomeBase & {
      state: "unresolved";
      failure: JudgeFailure;
    })
  | (CandidateOutcomeBase & {
      state: "not-attempted";
      failure: JudgeFailure;
    });

export type HealthStatus = "healthy" | "degraded" | "failed" | "not-run";

export interface DiffHealth {
  status: Extract<HealthStatus, "healthy" | "failed">;
  hunks: number;
  failure?: { code: "diff-command-failed"; message: string };
}

export interface VectorHealth {
  status: HealthStatus;
  expected: number;
  available: number;
  missing: number;
  failure?: { code: string; message: string };
}

export interface JudgeHealth {
  status: HealthStatus;
  selected: number;
  resolved: number;
  unresolved: number;
  notAttempted: number;
}

export interface CheckHealth {
  diff: DiffHealth;
  invariantVectors: VectorHealth;
  hunkVectors: VectorHealth;
  judge: JudgeHealth;
}

export interface CheckResult {
  range: ResolvedRange;
  status: "complete" | "partial" | "failed";
  health: CheckHealth;
  hunks: number;
  invariants: number;
  candidates: number;
  attempted: number;
  resolved: number;
  unresolved: number;
  notAttempted: number;
  semanticCalls: number;
  transportAttempts: number;
  candidateOutcomes: CandidateOutcome[];
  findings: Finding[];
  /** @deprecated Use `attempted`. Kept for the current gateway renderer. */
  judged: number;
  /** @deprecated Use `semanticCalls`. Kept for the current gateway renderer. */
  judgeCalls: number;
  /** @deprecated Use `unresolved` and candidate failure codes. */
  unparseable: number;
}

export interface Finding {
  invariantId: string;
  invariantTitle: string;
  invariantContent: string;
  file: string;
  similarity: number;
  refHit: boolean;
  reason: string | null;
  hunk: string;
  /** The MOST this finding can escalate to. `advisory` never fails a build;
   *  `soft` is overridable; `strict` is a hard gate. Enumeration invariants are
   *  always `advisory` (see {@link enforcementLevel}). */
  severity: EnforcementLevel;
}

// ---------------------------------------------------------------------------
// Gate decision + author overrides
//
// The funnel PRODUCES findings; whether any of them BLOCKS is a separate,
// pure decision so the CLI/GHA can stay dumb and every rule is unit-testable.
//
// Two modes:
//   - `advisory` (default): nothing blocks — exit 0 always. This is the shipped
//     behavior; the gate machinery below is inert until a repo opts into `gate`.
//   - `gate`: `strict` findings block; `soft` findings block UNLESS the PR
//     author overrode them; `advisory` findings never block.
//
// An override is an explicit author signal ("I know this contradicts invariant
// X, here's why") carried in a commit-message trailer (see parseOverrides).
// Overriding a `strict` finding is NOT allowed — strict means non-negotiable;
// if it were overridable it would just be `soft`.
// ---------------------------------------------------------------------------

export type GateMode = "advisory" | "gate";

/** An author's `lore-override:` declaration, parsed from commit trailers. */
export interface Override {
  /** The invariant the author is overriding — a title (fuzzy, human-written) or
   *  an exact id. Matched case-insensitively against a finding. */
  target: string;
  /** Why — required. An override with no reason is ignored (a bare mute is not a
   *  decision). Recorded in the report so the rationale is visible on the PR. */
  reason: string;
}

export interface GateResult {
  mode: GateMode;
  /** 0 = pass. Non-zero ONLY in `gate` mode when something blocks. Advisory mode
   *  is always 0 — findings never fail a build there. */
  exitCode: number;
  /** Findings that block the build (strict, or un-overridden soft in gate mode). */
  blocking: Finding[];
  /** Soft findings that WOULD have blocked but were overridden by the author,
   *  paired with the override that cleared them. */
  overridden: Array<{ finding: Finding; override: Override }>;
  /** Everything else — reported, never blocks. */
  advisory: Finding[];
}

/** An override target shorter than this is only honored as an EXACT id/title
 *  match, never as a substring — a 4-char target like `rule` or `auth` would
 *  otherwise clear unrelated soft findings whose titles happen to contain it. */
const MIN_OVERRIDE_SUBSTRING_LEN = 12;

/**
 * Does an override target this finding? Precedence:
 *   1. exact id match (UUID) — always honored.
 *   2. exact title match (case-insensitive) — always honored.
 *   3. substring match — the author quoted a fragment of the title, OR the
 *      title is a fragment of a longer quoted phrase — but ONLY when the target
 *      is specific enough (>= MIN_OVERRIDE_SUBSTRING_LEN chars). Short, generic
 *      targets are rejected for substring matching so one loose trailer can't
 *      silently clear soft gates it wasn't meant for. An override is a scalpel,
 *      not a blanket mute.
 * Errs toward NOT matching: a false non-match just leaves a soft finding
 * blocking (author re-words the trailer); a false match silently clears a real
 * gate. In gate mode the latter is the dangerous direction.
 */
export function overrideMatchesFinding(o: Override, f: Finding): boolean {
  const t = o.target.trim().toLowerCase();
  if (!t) return false;
  const id = f.invariantId.toLowerCase();
  const title = f.invariantTitle.trim().toLowerCase();
  // Exact matches are always honored regardless of length.
  if (t === id || t === title) return true;
  // Substring matching in EITHER direction requires the SHORTER operand (the
  // one being searched for) to be specific enough. Guarding only the target
  // isn't enough: a long target like "oauth flow rewrite" reverse-contains a
  // short title like "auth" ("o<auth>"), clearing an unrelated finding. So each
  // direction is gated on the length of the needle it searches for.
  if (t.length >= MIN_OVERRIDE_SUBSTRING_LEN && title.includes(t)) return true;
  if (title.length >= MIN_OVERRIDE_SUBSTRING_LEN && t.includes(title)) {
    return true;
  }
  return false;
}

/**
 * Decide the build outcome from findings + author overrides. Pure + exported.
 *
 * Only a `soft` finding can be cleared by an override (with a non-empty reason).
 * `strict` always blocks; `advisory` never blocks. In `advisory` mode nothing
 * blocks and exitCode is always 0 — but we still classify overridden/advisory so
 * the report can show what WOULD happen under `gate` (useful while a team tunes
 * FP rate before flipping the switch).
 */
export function gateDecision(
  findings: Finding[],
  overrides: Override[],
  mode: GateMode,
): GateResult {
  const blocking: Finding[] = [];
  const overridden: GateResult["overridden"] = [];
  const advisory: Finding[] = [];

  for (const f of findings) {
    if (f.severity === "advisory") {
      advisory.push(f);
      continue;
    }
    if (f.severity === "soft") {
      const ov = overrides.find(
        (o) => o.reason.trim().length > 0 && overrideMatchesFinding(o, f),
      );
      if (ov) overridden.push({ finding: f, override: ov });
      else blocking.push(f);
      continue;
    }
    // strict — never overridable.
    blocking.push(f);
  }

  const exitCode = mode === "gate" && blocking.length > 0 ? 2 : 0;
  return { mode, exitCode, blocking, overridden, advisory };
}

/** Trailer form: `lore-override: <invariant title or id> <sep> <reason>`.
 *  The key (`lore-override:`) is case-insensitive. The target/reason separator
 *  is a dash form (em dash, `--`, or ` - `) PREFERRED, with a trailing `: `
 *  (colon-space) as a last-resort fallback. Dash-first matters because invariant
 *  titles routinely contain colons (`node:sqlite`, `gradient.ts:`) — a colon-
 *  first rule would split the title, not the target/reason boundary. */
const OVERRIDE_KEY_RE = /^\s*lore-override\s*:\s*(.+)$/i;
const OVERRIDE_DASH_SEP_RE = /^(.+?)\s*(?:—|--|\s-\s)\s*(.+?)\s*$/;
// Colon fallback: split at the LAST colon-space, not the first. Invariant titles
// routinely contain colon-space (`sync.ts: per-table cursor isolation`,
// `gradient.ts: l0cap governs …`); a first-colon split would truncate the title
// to `sync.ts`. Greedy `(.+):` consumes through the last `": "`, leaving the
// trailing segment as the reason — the shape a human actually writes
// (`lore-override: <full title>: <short reason>`).
const OVERRIDE_COLON_SEP_RE = /^(.+):\s+(.+?)\s*$/;

/**
 * Parse `lore-override:` trailers out of commit messages (or any text lines).
 * A target with no reason is dropped — a bare mute is not a decision. Pure +
 * exported; the CLI feeds it `git log base..head` bodies.
 */
export function parseOverrides(messages: string[]): Override[] {
  const out: Override[] = [];
  const seen = new Set<string>();
  for (const msg of messages) {
    for (const line of msg.split("\n")) {
      const key = OVERRIDE_KEY_RE.exec(line);
      if (!key) continue;
      const rest = key[1];
      // Prefer a dash separator; fall back to colon-space only if no dash.
      const m =
        OVERRIDE_DASH_SEP_RE.exec(rest) ?? OVERRIDE_COLON_SEP_RE.exec(rest);
      if (!m) continue;
      const target = m[1].trim();
      const reason = m[2].trim();
      if (!target || !reason) continue;
      const dedup = `${target.toLowerCase()}\x1f${reason.toLowerCase()}`;
      if (seen.has(dedup)) continue; // idempotent: same trailer in 2 commits = 1
      seen.add(dedup);
      out.push({ target, reason });
    }
  }
  return out;
}

export interface LLMInvariantJudgeOptions {
  llm: LLMClient;
  model?: { providerID: string; modelID: string };
  effort?: ReasoningEffort;
  sessionID: string;
}

/**
 * Compatibility judge for the existing `LLMClient` surface. New gateway code
 * should implement {@link InvariantJudge} directly from its detailed prompt
 * outcome so `transportAttempts` includes internal retries and fallbacks.
 */
export function createLLMInvariantJudge(
  options: LLMInvariantJudgeOptions,
): InvariantJudge {
  const prompt = async (user: string): Promise<string | null> =>
    options.llm.prompt(INVARIANT_JUDGE_SYSTEM, user, {
      model: options.model,
      workerID: "lore-invariant-check",
      thinking: false,
      reasoningEffort: options.effort,
      urgent: true,
      sessionID: options.sessionID,
      maxTokens: judgeMaxTokens(options.effort),
      temperature: 0,
    });

  return {
    async judge(input): Promise<JudgeOutcome> {
      let semanticCalls = 0;
      let transportAttempts = 0;
      const call = async (user: string): Promise<string | null> => {
        semanticCalls++;
        // LLMClient does not expose retries. Count the visible dispatch as one;
        // direct InvariantJudge integrations must report every hidden attempt.
        transportAttempts++;
        return prompt(user);
      };
      const stats = (): JudgeStats => ({ semanticCalls, transportAttempts });

      let response: string | null;
      try {
        response = await call(
          invariantJudgeUser({
            invariant: input.invariant,
            file: input.file,
            hunk: input.hunk,
          }),
        );
      } catch (error) {
        return judgeErrorOutcome(error, stats());
      }

      if (response === null || response.trim().length === 0) {
        return {
          kind: "unresolved",
          failure: {
            code: "empty-response",
            message: "Judge returned no response text",
            scope: "candidate",
            retryable: true,
          },
          stats: stats(),
        };
      }

      const verdict = parseInvariantVerdict(response);
      if (verdict) return { kind: "verdict", ...verdict, stats: stats() };

      if (input.semanticCallBudget < 2) {
        return invalidVerdictOutcome(stats());
      }

      try {
        response = await call(
          invariantJudgeRepairUser({
            invariant: input.invariant,
            file: input.file,
            hunk: input.hunk,
            invalidResponse: response.slice(0, 2_000),
          }),
        );
      } catch (error) {
        return judgeErrorOutcome(error, stats());
      }

      if (response === null || response.trim().length === 0) {
        return {
          kind: "unresolved",
          failure: {
            code: "empty-response",
            message: "Judge repair returned no response text",
            scope: "candidate",
            retryable: true,
          },
          stats: stats(),
        };
      }
      const repaired = parseInvariantVerdict(response);
      return repaired
        ? { kind: "verdict", ...repaired, stats: stats() }
        : invalidVerdictOutcome(stats());
    },
  };
}

export interface CheckInvariantsInput {
  projectPath: string;
  /** Preferred health-aware diff input. */
  diff?: DiffResult;
  /** Legacy pre-parsed input. Use `diff` to preserve command failures. */
  hunks?: DiffHunk[];
  range: ResolvedRange;
  /** Preferred typed judge boundary. */
  judge?: InvariantJudge;
  /** @deprecated Gateway compatibility; use `judge`. */
  llm?: LLMClient;
  model?: { providerID: string; modelID: string };
  /** Reasoning effort for the judge call. `off`/undefined leaves reasoning off
   *  (the default). Higher effort trades cost for depth on reasoning-capable
   *  models — a knob for tuning recall vs. spend. */
  effort?: ReasoningEffort;
  sessionID: string;
  /** Overall orchestration cancellation boundary, including hunk embedding. */
  signal?: AbortSignal;
  /** Remaining duration available to hunk embedding. */
  deadlineMs?: number;
  /** onProgress for CLI heartbeat. */
  onJudge?: (n: number, total: number) => void;
}

export async function checkInvariants(
  input: CheckInvariantsInput,
): Promise<CheckResult> {
  if (input.diff && input.hunks) {
    throw new TypeError(
      "checkInvariants accepts either diff or hunks, not both",
    );
  }
  // Zero-hunk and zero-invariant fast paths are valid only for a live run. An
  // already-cancelled caller must never receive an all-healthy result.
  input.signal?.throwIfAborted();
  const diff: DiffResult = input.diff ?? {
    kind: "success",
    hunks: input.hunks ?? [],
  };
  if (diff.kind === "failure") {
    return emptyCheckResult(input.range, {
      diff: { status: "failed", hunks: 0, failure: diff.failure },
      invariantVectors: notRunVectorHealth(),
      hunkVectors: notRunVectorHealth(),
      judge: notRunJudgeHealth(),
    });
  }

  const hunks = diff.hunks;
  const files = changedFiles(hunks);
  const diffHealth: DiffHealth = { status: "healthy", hunks: hunks.length };
  if (hunks.length === 0) {
    return emptyCheckResult(input.range, {
      diff: diffHealth,
      invariantVectors: healthyVectorHealth(0, 0),
      hunkVectors: healthyVectorHealth(0, 0),
      judge: healthyJudgeHealth(0),
    });
  }

  // Load invariants (confidence DESC), gate on confidence + enforceability,
  // cap the scan. The enforceability filter is the fix the model sweep
  // demanded: descriptive gotchas/prefs are not rules a diff can "violate".
  let allEntries: KnowledgeEntry[];
  try {
    allEntries = ltm
      .forProject(input.projectPath, true)
      .filter((e) => e.confidence >= MIN_CONFIDENCE)
      .filter((e) => isEnforceableInvariant(e))
      .slice(0, MAX_INVARIANTS_SCAN);
  } catch (error) {
    return emptyCheckResult(input.range, {
      diff: diffHealth,
      invariantVectors: {
        status: "failed",
        expected: 0,
        available: 0,
        missing: 0,
        failure: {
          code: "invariant-source-read-failed",
          message: boundedMessage(error, "Could not load invariants"),
        },
      },
      hunkVectors: notRunVectorHealth(),
      judge: notRunJudgeHealth(),
    });
  }
  input.signal?.throwIfAborted();
  if (allEntries.length === 0) {
    return emptyCheckResult(
      input.range,
      {
        diff: diffHealth,
        invariantVectors: healthyVectorHealth(0, 0),
        hunkVectors: healthyVectorHealth(0, 0),
        judge: healthyJudgeHealth(0),
      },
      { hunks: hunks.length },
    );
  }

  // Load invariant embeddings (same helper contradiction.ts uses).
  const invariantVecResult = loadInvariantVecs(allEntries);
  if (invariantVecResult.health.status === "failed") {
    return emptyCheckResult(
      input.range,
      {
        diff: diffHealth,
        invariantVectors: invariantVecResult.health,
        hunkVectors: notRunVectorHealth(),
        judge: notRunJudgeHealth(),
      },
      { hunks: hunks.length, invariants: allEntries.length },
    );
  }
  const vecById = invariantVecResult.vecs;

  // Stage 0: for each invariant, which changed files do its refs touch?
  const invariants: InvariantVec[] = allEntries.map((entry) => {
    const refFiles = new Set<string>();
    for (const ref of extractReferences(`${entry.title}: ${entry.content}`)) {
      if (ref.kind !== "file") continue;
      // A ref path may be repo-root-relative or a bare filename; match on
      // full-path equality or basename membership against changed files.
      for (const f of files) {
        if (
          f === ref.path ||
          f.endsWith(`/${ref.path}`) ||
          basename(f) === basename(ref.path)
        ) {
          refFiles.add(f);
        }
      }
    }
    return { entry, vec: vecById.get(entry.id) ?? null, refFiles };
  });

  // Stage 1: embed the hunks once, cosine-match against invariant vecs.
  const hunkVecResult = await embedHunks(hunks, {
    signal: input.signal,
    deadlineMs: input.deadlineMs,
  });
  if (hunkVecResult.health.status === "failed") {
    return emptyCheckResult(
      input.range,
      {
        diff: diffHealth,
        invariantVectors: invariantVecResult.health,
        hunkVectors: hunkVecResult.health,
        judge: notRunJudgeHealth(),
      },
      { hunks: hunks.length, invariants: allEntries.length },
    );
  }
  const hunkVecs = hunkVecResult.vecs;

  // Diversify: cluster near-identical hunks so the budget covers DISTINCT
  // changes. Only each cluster's representative is judged; members inherit.
  const clusters = clusterHunks(hunkVecs);

  // Select (representative-hunk, invariant) pairs to judge: coverage across
  // clusters (round-robin), relevance within each (ref-hits + top cosine).
  const selected = selectCandidates(clusters, hunkVecs, invariants, hunks);

  // Map a representative hunk index → its cluster members, for verdict fan-out.
  const membersByRep = new Map<number, number[]>();
  for (const c of clusters) membersByRep.set(c.repIdx, c.memberIdxs);

  // Stage 2: judge the selected pairs (capped, coverage-ordered).
  const findings: Finding[] = [];
  // Dedup key = `${invariantId}\x1f${file}`: one drift per (invariant, file),
  // regardless of how many hunks or judge calls surface it.
  const seenFindings = new Set<string>();
  const candidateOutcomes: CandidateOutcome[] = [];
  let semanticCalls = 0;
  let transportAttempts = 0;
  let stopFailure: JudgeFailure | null = null;
  const judge =
    input.judge ??
    (input.llm
      ? createLLMInvariantJudge({
          llm: input.llm,
          model: input.model,
          effort: input.effort,
          sessionID: input.sessionID,
        })
      : null);

  for (
    let candidateIndex = 0;
    candidateIndex < selected.length;
    candidateIndex++
  ) {
    const c = selected[candidateIndex];
    const inv = invariants[c.invariantIdx];
    const hunk = hunks[c.hunkIdx];
    const base = candidateOutcomeBase(candidateIndex, c, inv, hunk);

    if (stopFailure) {
      candidateOutcomes.push({
        ...base,
        state: "not-attempted",
        failure: stopFailure,
      });
      continue;
    }

    const remainingSemanticCalls = MAX_JUDGE_CALLS - semanticCalls;
    if (remainingSemanticCalls === 0) {
      candidateOutcomes.push({
        ...base,
        state: "not-attempted",
        failure: semanticBudgetFailure(),
      });
      continue;
    }

    input.onJudge?.(candidateIndex + 1, selected.length);
    let outcome: JudgeOutcome;
    if (!judge) {
      outcome = {
        kind: "unresolved",
        failure: {
          code: "judge-contract-error",
          message: "No InvariantJudge was provided",
          scope: "run",
        },
        stats: { semanticCalls: 0, transportAttempts: 0 },
      };
    } else {
      try {
        outcome = await judge.judge({
          invariant: {
            id: inv.entry.id,
            title: inv.entry.title,
            content: inv.entry.content,
          },
          file: hunk.file,
          hunk: hunk.text,
          semanticCallBudget: Math.min(2, remainingSemanticCalls),
        });
      } catch (error) {
        outcome = {
          kind: "unresolved",
          failure: {
            code: "judge-contract-error",
            message: boundedMessage(error, "InvariantJudge threw"),
            scope: "run",
          },
          stats: { semanticCalls: 0, transportAttempts: 0 },
        };
      }
    }

    outcome = validateJudgeOutcome(outcome, remainingSemanticCalls);
    semanticCalls += outcome.stats.semanticCalls;
    transportAttempts += outcome.stats.transportAttempts;

    if (outcome.kind === "unresolved") {
      candidateOutcomes.push({
        ...base,
        state: "unresolved",
        failure: outcome.failure,
        stats: outcome.stats,
      });
      if (outcome.failure.scope === "run") stopFailure = outcome.failure;
      continue;
    }

    candidateOutcomes.push({
      ...base,
      state: "resolved",
      verdict: outcome.verdict,
      reason: outcome.reason,
      stats: outcome.stats,
    });
    // Only "violates" produces a finding. "fixes", "satisfies", and "unrelated"
    // are all non-finding verdicts — the four-category frame exists precisely to
    // let the judge say "this is the fix" or "this hunk isn't actually related"
    // without flagging. The old binary verdict space could not express either,
    // which is what produced the dominant false-positive class (a fix being read
    // as a violation).
    if (outcome.verdict !== "violates") continue;
    // Fan out the verdict to every hunk in the representative's cluster: a
    // repeated change (e.g. one rename across N files) is flagged in all N.
    // Dedup per (invariant, file): the same invariant flagged against several
    // hunks of ONE file is ONE drift, not N findings (the #1234 error-reporting
    // case produced 4 near-identical findings). Cluster fan-out across DIFFERENT
    // files is preserved — those are genuinely distinct locations.
    const memberIdxs = membersByRep.get(c.hunkIdx) ?? [c.hunkIdx];
    const severity = enforcementLevel(inv.entry);
    for (const mi of memberIdxs) {
      const dedupKey = `${inv.entry.id}\x1f${hunks[mi].file}`;
      if (seenFindings.has(dedupKey)) continue;
      seenFindings.add(dedupKey);
      findings.push({
        invariantId: inv.entry.id,
        invariantTitle: inv.entry.title,
        invariantContent: inv.entry.content,
        file: hunks[mi].file,
        similarity: c.similarity,
        refHit: c.refHit,
        reason: outcome.reason,
        hunk: hunks[mi].text,
        severity,
      });
    }
  }

  const resolved = candidateOutcomes.filter(
    (o) => o.state === "resolved",
  ).length;
  const unresolved = candidateOutcomes.filter(
    (o) => o.state === "unresolved",
  ).length;
  const notAttempted = candidateOutcomes.filter(
    (o) => o.state === "not-attempted",
  ).length;
  const attempted = resolved + unresolved;
  const judgeHealth = calculateJudgeHealth(
    selected.length,
    resolved,
    unresolved,
    notAttempted,
  );
  const health: CheckHealth = {
    diff: diffHealth,
    invariantVectors: invariantVecResult.health,
    hunkVectors: hunkVecResult.health,
    judge: judgeHealth,
  };

  input.signal?.throwIfAborted();

  return {
    range: input.range,
    status: overallStatus(health),
    health,
    hunks: hunks.length,
    invariants: allEntries.length,
    candidates: selected.length,
    attempted,
    resolved,
    unresolved,
    notAttempted,
    semanticCalls,
    transportAttempts,
    candidateOutcomes,
    findings,
    judged: attempted,
    judgeCalls: semanticCalls,
    unparseable: unresolved,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VERDICTS = new Set<Verdict>([
  "violates",
  "fixes",
  "satisfies",
  "unrelated",
]);

const JUDGE_FAILURE_CODES = new Set<JudgeFailureCode>([
  "no-auth",
  "auth-rejected",
  "route-unavailable",
  "protocol-mismatch",
  "model-unsupported",
  "api-unsupported",
  "rate-limit",
  "timeout",
  "network",
  "invalid-body",
  "response-too-large",
  "incomplete-response",
  "empty-response",
  "abort",
  "transport-error",
  "invalid-verdict",
  "judge-contract-error",
  "semantic-budget-exhausted",
]);

function isVerdict(value: unknown): value is Verdict {
  return typeof value === "string" && VERDICTS.has(value as Verdict);
}

function boundedMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const sanitized = message.replace(/[\r\n\t]+/g, " ").trim();
  return (sanitized || fallback).slice(0, 400);
}

function judgeErrorOutcome(error: unknown, stats: JudgeStats): JudgeOutcome {
  const name = error instanceof Error ? error.name : "";
  const code: JudgeFailureCode =
    name === "AbortError"
      ? "abort"
      : name === "TimeoutError"
        ? "timeout"
        : "transport-error";
  return {
    kind: "unresolved",
    failure: {
      code,
      message: boundedMessage(error, "Judge transport failed"),
      scope: "candidate",
      retryable: code !== "abort",
    },
    stats,
  };
}

function invalidVerdictOutcome(stats: JudgeStats): JudgeOutcome {
  return {
    kind: "unresolved",
    failure: {
      code: "invalid-verdict",
      message:
        "Judge response did not match the exact {verdict, reason} schema",
      scope: "candidate",
      retryable: false,
    },
    stats,
  };
}

function semanticBudgetFailure(): JudgeFailure {
  return {
    code: "semantic-budget-exhausted",
    message: `Run-wide semantic-call budget of ${MAX_JUDGE_CALLS} was exhausted`,
    scope: "run",
    retryable: false,
  };
}

function validateJudgeOutcome(
  outcome: unknown,
  remainingSemanticCalls: number,
): JudgeOutcome {
  if (!outcome || typeof outcome !== "object") {
    return judgeContractFailure();
  }
  const record = outcome as Record<string, unknown>;
  if (!record.stats || typeof record.stats !== "object") {
    return judgeContractFailure();
  }
  const stats = record.stats as Record<string, unknown>;
  const statsValid =
    Number.isSafeInteger(stats.semanticCalls) &&
    (stats.semanticCalls as number) >= 0 &&
    (stats.semanticCalls as number) <= Math.min(2, remainingSemanticCalls) &&
    Number.isSafeInteger(stats.transportAttempts) &&
    (stats.transportAttempts as number) >= 0;
  if (!statsValid) return judgeContractFailure();

  if (record.kind === "verdict") {
    if (
      isVerdict(record.verdict) &&
      typeof record.reason === "string" &&
      record.reason.trim().length > 0 &&
      record.reason.length <= 400
    ) {
      return outcome as JudgeOutcome;
    }
    return judgeContractFailure();
  }

  if (record.kind === "unresolved") {
    if (!record.failure || typeof record.failure !== "object") {
      return judgeContractFailure();
    }
    const failure = record.failure as Record<string, unknown>;
    if (
      typeof failure.code === "string" &&
      JUDGE_FAILURE_CODES.has(failure.code as JudgeFailureCode) &&
      typeof failure.message === "string" &&
      failure.message.trim().length > 0 &&
      failure.message.length <= 400 &&
      (failure.scope === "candidate" || failure.scope === "run") &&
      (failure.retryable === undefined ||
        typeof failure.retryable === "boolean")
    ) {
      return outcome as JudgeOutcome;
    }
  }
  return judgeContractFailure();
}

function judgeContractFailure(): JudgeOutcome {
  return {
    kind: "unresolved",
    failure: {
      code: "judge-contract-error",
      message:
        "InvariantJudge returned an invalid outcome or exceeded its budget",
      scope: "run",
      retryable: false,
    },
    stats: { semanticCalls: 0, transportAttempts: 0 },
  };
}

function healthyVectorHealth(
  expected: number,
  available: number,
): VectorHealth {
  return {
    status: "healthy",
    expected,
    available,
    missing: expected - available,
  };
}

function notRunVectorHealth(): VectorHealth {
  return {
    status: "not-run",
    expected: 0,
    available: 0,
    missing: 0,
  };
}

function healthyJudgeHealth(selected: number): JudgeHealth {
  return {
    status: "healthy",
    selected,
    resolved: selected,
    unresolved: 0,
    notAttempted: 0,
  };
}

function notRunJudgeHealth(): JudgeHealth {
  return {
    status: "not-run",
    selected: 0,
    resolved: 0,
    unresolved: 0,
    notAttempted: 0,
  };
}

function calculateJudgeHealth(
  selected: number,
  resolved: number,
  unresolved: number,
  notAttempted: number,
): JudgeHealth {
  const status: JudgeHealth["status"] =
    selected === 0 || resolved === selected
      ? "healthy"
      : resolved === 0
        ? "failed"
        : "degraded";
  return { status, selected, resolved, unresolved, notAttempted };
}

function overallStatus(health: CheckHealth): CheckResult["status"] {
  const statuses: HealthStatus[] = [
    health.diff.status,
    health.invariantVectors.status,
    health.hunkVectors.status,
    health.judge.status,
  ];
  if (statuses.some((status) => status === "failed" || status === "not-run")) {
    return "failed";
  }
  if (statuses.includes("degraded")) return "partial";
  return "complete";
}

function emptyCheckResult(
  range: ResolvedRange,
  health: CheckHealth,
  counts: { hunks?: number; invariants?: number } = {},
): CheckResult {
  return {
    range,
    status: overallStatus(health),
    health,
    hunks: counts.hunks ?? health.diff.hunks,
    invariants: counts.invariants ?? 0,
    candidates: 0,
    attempted: 0,
    resolved: 0,
    unresolved: 0,
    notAttempted: 0,
    semanticCalls: 0,
    transportAttempts: 0,
    candidateOutcomes: [],
    findings: [],
    judged: 0,
    judgeCalls: 0,
    unparseable: 0,
  };
}

function candidateOutcomeBase(
  candidateIndex: number,
  candidate: Candidate,
  invariant: InvariantVec,
  hunk: DiffHunk,
): CandidateOutcomeBase {
  return {
    id: `candidate-${String(candidateIndex + 1).padStart(2, "0")}`,
    file: hunk.file,
    hunkIndex: candidate.hunkIdx,
    invariantId: invariant.entry.id,
    invariantTitle: invariant.entry.title,
    similarity: candidate.similarity,
    refHit: candidate.refHit,
    stats: { semanticCalls: 0, transportAttempts: 0 },
  };
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

/** Load invariant embeddings keyed by current-version id (contradiction.ts's
 *  exact pattern — reuse embeddingByIdSource so storage-mode differences are
 *  handled once). A corrupt/missing blob just omits that invariant from the
 *  cosine prefilter (it can still be admitted by a Stage-0 ref hit). */
function loadInvariantVecs(entries: KnowledgeEntry[]): {
  vecs: Map<string, Float32Array>;
  health: VectorHealth;
} {
  const out = new Map<string, Float32Array>();
  if (entries.length === 0) {
    return { vecs: out, health: healthyVectorHealth(0, 0) };
  }
  const ids = entries.map((e) => e.id);
  const placeholders = ids.map(() => "?").join(",");
  let rows: Array<{ id: string; embedding: Buffer }>;
  try {
    const src = embeddingByIdSource(
      "knowledge",
      readStorageMode(db()),
      "knowledge_current",
    );
    rows = db()
      .query(
        `SELECT id, embedding FROM ${src.table} WHERE id IN (${placeholders})${src.presenceFilter}`,
      )
      .all(...ids) as Array<{ id: string; embedding: Buffer }>;
  } catch (error) {
    return {
      vecs: out,
      health: {
        status: "failed",
        expected: entries.length,
        available: 0,
        missing: entries.length,
        failure: {
          code: "invariant-vector-load-failed",
          message: boundedMessage(error, "Could not load invariant vectors"),
        },
      },
    };
  }
  for (const r of rows) {
    try {
      out.set(r.id, embedding.fromBlob(r.embedding));
    } catch {
      // corrupt blob — skip (Stage-0 ref hit can still admit this invariant)
    }
  }
  const missing = entries.length - out.size;
  return {
    vecs: out,
    health: {
      status: missing === 0 ? "healthy" : "degraded",
      expected: entries.length,
      available: out.size,
      missing,
    },
  };
}

/** Max characters of a single hunk fed to the embedder. A giant hunk (e.g. a
 *  generated/docs file) posts an oversized ONNX tensor → OOM (#1072 class). We
 *  only need enough text to gauge TOPICAL similarity for the prefilter, so the
 *  embed input is capped; the JUDGE still receives the full hunk. Mirrors the
 *  worker's own truncateTexts fallback. */
export const MAX_EMBED_CHARS_PER_HUNK = 8_000;

/** Embed all hunks (local ONNX → free), OOM-safely. Each hunk's embed text is
 *  first capped ({@link MAX_EMBED_CHARS_PER_HUNK}); the whole set is then routed
 *  through {@link embedding.embedInTokenBatches}, the project-standard batcher
 *  that bounds each ONNX call by TOKEN AREA (not just count) — ONNX pads every
 *  text in a batch to the longest sequence, so area, not count, is what OOMs
 *  (#1072 class; knowledge 019f1a88). Vectors come back in input order. A
 *  partial result is degraded; an exception or zero vectors for non-empty
 *  hunks is failed so retrieval loss can never look like a clean judge run. */
async function embedHunks(
  hunks: DiffHunk[],
  options: { signal?: AbortSignal; deadlineMs?: number },
): Promise<{ vecs: (Float32Array | null)[]; health: VectorHealth }> {
  if (hunks.length === 0) {
    return { vecs: [], health: healthyVectorHealth(0, 0) };
  }
  const texts = hunks.map((h) =>
    `${h.file}\n${h.text}`.slice(0, MAX_EMBED_CHARS_PER_HUNK),
  );
  try {
    const vecs = await awaitHunkEmbedding(
      () => embedding.embedInTokenBatches(texts, "document"),
      options,
    );
    const aligned = hunks.map((_, i) => vecs[i] ?? null);
    const available = aligned.filter((vec) => vec !== null).length;
    const missing = hunks.length - available;
    return {
      vecs: aligned,
      health: {
        status:
          missing === 0 ? "healthy" : available === 0 ? "failed" : "degraded",
        expected: hunks.length,
        available,
        missing,
        ...(available === 0
          ? {
              failure: {
                code: "hunk-vectors-all-missing",
                message: "Embedding returned no vectors for non-empty hunks",
              },
            }
          : {}),
      },
    };
  } catch (error) {
    return {
      vecs: hunks.map(() => null),
      health: {
        status: "failed",
        expected: hunks.length,
        available: 0,
        missing: hunks.length,
        failure: {
          code: "hunk-vector-embedding-failed",
          message: boundedMessage(error, "Could not embed diff hunks"),
        },
      },
    };
  }
}

/** Bound hunk embedding by the lint orchestration lifetime. The embedding API
 * cannot interrupt an in-flight local ONNX batch, so on cancellation we return
 * promptly and explicitly observe that batch's eventual rejection. */
async function awaitHunkEmbedding<T>(
  start: () => Promise<T>,
  options: { signal?: AbortSignal; deadlineMs?: number },
): Promise<T> {
  const { signal, deadlineMs } = options;
  if (
    deadlineMs !== undefined &&
    (!Number.isFinite(deadlineMs) || deadlineMs < 0)
  ) {
    throw new RangeError("hunk embedding deadlineMs must be non-negative");
  }
  if (signal?.aborted) throw abortReason(signal);
  if (deadlineMs === 0) {
    throw new DOMException("Hunk embedding deadline exceeded", "TimeoutError");
  }

  const work = start();
  if (!signal && deadlineMs === undefined) return await work;
  // Promise.race observes `work`, and this explicit handler documents and
  // preserves that guarantee if orchestration returns before inference does.
  void work.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    if (signal) {
      onAbort = () => reject(abortReason(signal));
      signal.addEventListener("abort", onAbort, { once: true });
    }
    if (deadlineMs !== undefined) {
      timer = setTimeout(
        () =>
          reject(
            new DOMException(
              "Hunk embedding deadline exceeded",
              "TimeoutError",
            ),
          ),
        deadlineMs,
      );
    }
  });

  try {
    return await Promise.race([work, stopped]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new DOMException("Hunk embedding aborted", "AbortError")
  );
}
