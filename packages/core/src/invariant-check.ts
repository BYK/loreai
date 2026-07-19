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
import * as embedding from "./embedding";
import * as ltm from "./ltm";
import type { KnowledgeEntry } from "./ltm";
import * as log from "./log";
import { INVARIANT_JUDGE_SYSTEM, invariantJudgeUser } from "./prompt";
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

// If more than this fraction of judge calls come back unparseable, warn: the
// judge model is likely failing the JSON output contract, so a "clean" result is
// untrustworthy. High on purpose — a single stray malformed response on an
// otherwise-healthy run must not cry wolf. Exported so the CLI report and the
// GHA reporter share one threshold (the reporter mirrors it as a literal).
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
  // `-U3`: 3 lines of context per hunk (enough for the judge to see scope).
  // `--no-color`, `--no-ext-diff`: deterministic machine-readable output.
  const raw = gitOrNull(
    ["diff", "--no-color", "--no-ext-diff", "-U3", `${base}..${head}`],
    cwd,
  );
  if (!raw) return [];
  return splitDiff(raw);
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
    } else if (line.startsWith("--- a/")) {
      oldFile = line.slice("--- a/".length).trim();
    } else if (line.startsWith("+++ b/")) {
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

export interface InvariantVerdict {
  violates: boolean;
  reason: string | null;
}

/**
 * Extract the first balanced top-level `{...}` object from a string, or null.
 *
 * Cheap/instruction-light models sometimes wrap the required JSON in prose
 * ("Sure! Here's my analysis: {\"violates\": false}") — see the GLM 5.2 finding
 * in Warden's benchmark where clean chunks returned prose instead of the
 * required JSON and were mis-counted as parser failures. Rather than drop those
 * (which is indistinguishable from a genuine no-finding), we pull the embedded
 * object out. String-aware brace matching so braces inside string literals do
 * not throw off the balance.
 */
export function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // unbalanced — no complete object
}

export function parseInvariantVerdict(
  text: string | null,
): InvariantVerdict | null {
  if (!text) return null;
  const cleaned = text
    .trim()
    .replace(/^```json?\s*/i, "")
    .replace(/\s*```$/i, "");
  // Try the whole (fenced-stripped) payload first — the common clean-JSON path.
  // Fall back to the first embedded {...} object for chatty models that wrap the
  // verdict in prose. Both feed the same shape validation.
  for (const candidate of [cleaned, extractFirstJsonObject(cleaned)]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.violates === "boolean"
      ) {
        const reason =
          typeof parsed.reason === "string"
            ? parsed.reason.slice(0, 400)
            : null;
        return { violates: parsed.violates, reason };
      }
    } catch {
      // not valid JSON — try the next candidate
    }
  }
  return null;
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

export interface CheckResult {
  range: ResolvedRange;
  hunks: number;
  invariants: number;
  candidates: number;
  judged: number;
  findings: Finding[];
  /** Judge calls actually made (== cost units). */
  judgeCalls: number;
  /** Judge calls whose response could not be parsed into a verdict (prose
   *  instead of JSON, etc.). These degrade safely to "no finding", but a HIGH
   *  rate means the judge model is systemically failing the output contract and
   *  the clean result is not trustworthy — surfaced so it is not silent
   *  recall-rot (cf. the GLM 5.2 prose-not-JSON failure in Warden's benchmark). */
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

export async function checkInvariants(input: {
  projectPath: string;
  /** Pre-parsed diff hunks. The CLI produces these via {@link parseDiff}; tests
   *  pass them directly. Kept separate from parsing so the funnel is unit-
   *  testable without a real git repo. */
  hunks: DiffHunk[];
  range: ResolvedRange;
  llm: LLMClient;
  model?: { providerID: string; modelID: string };
  sessionID: string;
  /** onProgress for CLI heartbeat. */
  onJudge?: (n: number, total: number) => void;
}): Promise<CheckResult> {
  const hunks = input.hunks;
  const files = changedFiles(hunks);

  const empty: CheckResult = {
    range: input.range,
    hunks: hunks.length,
    invariants: 0,
    candidates: 0,
    judged: 0,
    findings: [],
    judgeCalls: 0,
    unparseable: 0,
  };
  if (hunks.length === 0) return empty;

  // Load invariants (confidence DESC), gate on confidence + enforceability,
  // cap the scan. The enforceability filter is the fix the model sweep
  // demanded: descriptive gotchas/prefs are not rules a diff can "violate".
  const allEntries = ltm
    .forProject(input.projectPath, true)
    .filter((e) => e.confidence >= MIN_CONFIDENCE)
    .filter((e) => isEnforceableInvariant(e))
    .slice(0, MAX_INVARIANTS_SCAN);
  if (allEntries.length === 0) return empty;

  // Load invariant embeddings (same helper contradiction.ts uses).
  const vecById = loadInvariantVecs(allEntries);

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
  const hunkVecs = await embedHunks(hunks);

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
  let judged = 0;
  let judgeCalls = 0;
  let unparseable = 0;
  const toJudge = selected;
  for (const c of toJudge) {
    const inv = invariants[c.invariantIdx];
    const hunk = hunks[c.hunkIdx];
    judged++;
    input.onJudge?.(judged, toJudge.length);
    let responseText: string | null;
    try {
      responseText = await input.llm.prompt(
        INVARIANT_JUDGE_SYSTEM,
        invariantJudgeUser({
          invariant: { title: inv.entry.title, content: inv.entry.content },
          file: hunk.file,
          hunk: hunk.text,
        }),
        {
          model: input.model,
          workerID: "lore-invariant-check",
          thinking: false,
          // Interactive CLI: must return this turn, not defer to the batch queue.
          urgent: true,
          sessionID: input.sessionID,
          maxTokens: 256,
          temperature: 0,
        },
      );
    } catch (err) {
      log.info(
        `invariant-check: judge call failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    judgeCalls++;
    const verdict = parseInvariantVerdict(responseText);
    if (!verdict) {
      // Response was not parseable into a verdict (prose instead of JSON, a
      // truncated object, etc.). Degrade safely to "no finding" — but COUNT it,
      // so a systemically-broken judge is visible rather than silently
      // indistinguishable from a genuine clean run.
      unparseable++;
      continue;
    }
    if (!verdict.violates) continue;
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
        reason: verdict.reason,
        hunk: hunks[mi].text,
        severity,
      });
    }
  }

  // Visibility for the GLM-style failure mode: if a large share of judge calls
  // came back unparseable, the "clean" result is not trustworthy — the model is
  // failing the output contract, not finding nothing. Warn loudly (still never
  // fails the build; the caller decides). Threshold is deliberately high so a
  // stray malformed response on an otherwise-healthy run stays quiet.
  if (judgeCalls > 0 && unparseable / judgeCalls > UNPARSEABLE_WARN_RATIO) {
    log.warn(
      `invariant-check: ${unparseable}/${judgeCalls} judge responses were unparseable ` +
        `(model=${input.model?.providerID ?? "?"}/${input.model?.modelID ?? "?"}). ` +
        `The "no violation" result may be unreliable — the judge model is likely ` +
        `returning prose instead of the required JSON verdict.`,
    );
  }

  return {
    range: input.range,
    hunks: hunks.length,
    invariants: allEntries.length,
    candidates: selected.length,
    judged,
    findings,
    judgeCalls,
    unparseable,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

/** Load invariant embeddings keyed by current-version id (contradiction.ts's
 *  exact pattern — reuse embeddingByIdSource so storage-mode differences are
 *  handled once). A corrupt/missing blob just omits that invariant from the
 *  cosine prefilter (it can still be admitted by a Stage-0 ref hit). */
function loadInvariantVecs(
  entries: KnowledgeEntry[],
): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>();
  if (entries.length === 0) return out;
  const ids = entries.map((e) => e.id);
  const placeholders = ids.map(() => "?").join(",");
  const src = embeddingByIdSource(
    "knowledge",
    readStorageMode(db()),
    "knowledge_current",
  );
  const rows = db()
    .query(
      `SELECT id, embedding FROM ${src.table} WHERE id IN (${placeholders})${src.presenceFilter}`,
    )
    .all(...ids) as Array<{ id: string; embedding: Buffer }>;
  for (const r of rows) {
    try {
      out.set(r.id, embedding.fromBlob(r.embedding));
    } catch {
      // corrupt blob — skip (Stage-0 ref hit can still admit this invariant)
    }
  }
  return out;
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
 *  (#1072 class; knowledge 019f1a88). Vectors come back in input order. On any
 *  embed failure the whole set degrades to nulls; those hunks can still be
 *  admitted by Stage-0 ref hits, so the funnel stays correct (just less recall
 *  on the cosine stage for that run). */
async function embedHunks(hunks: DiffHunk[]): Promise<(Float32Array | null)[]> {
  if (hunks.length === 0) return [];
  const texts = hunks.map((h) =>
    `${h.file}\n${h.text}`.slice(0, MAX_EMBED_CHARS_PER_HUNK),
  );
  try {
    const vecs = await embedding.embedInTokenBatches(texts, "document");
    return hunks.map((_, i) => vecs[i] ?? null);
  } catch {
    return hunks.map(() => null);
  }
}
