/**
 * Objective, justifier-free retrieval scoring for the memory eval.
 *
 * The LLM judge (`judge.ts`) grades *end-task* answer quality. That path is
 * susceptible to the "justifier" inflation #961 warns about: a lenient grader
 * can reward a fluent answer that never actually recalled the ground-truth
 * fact. This module scores the *retrieval* dimension deterministically — no
 * LLM, no synthesis — by checking, against the question's declared ground
 * truth, whether the required fact(s) are present and whether any stale /
 * superseded fact leaked in (negative controls).
 *
 * Reported separately from the judge's composite so the two axes never blur:
 *   - retrieval quality  = did the right prior fact actually surface?  (here)
 *   - end-task quality   = was the answer well-formed / well-reasoned?  (judge)
 *
 * Matching is intentionally simple and inspectable: case-insensitive,
 * whitespace-normalized substring containment. False negatives (a paraphrased
 * fact we fail to match) are acceptable and conservative; we never award credit
 * an LLM might rationalize.
 */

import type { RetrievalScore } from "./types";

/** Lowercase + collapse all whitespace runs to single spaces + trim. */
export function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Word-char test on already-lowercased text — matches regex `\w`
 *  (`[a-z0-9_]`) so underscores are boundaries-internal, e.g. forbidden "10"
 *  must not match inside "schema_10_version". */
function isWordChar(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "_";
}

/**
 * True when `fact` appears in the already-normalized hypothesis, respecting
 * word boundaries so a short/numeric anchor cannot match inside a larger token
 * (e.g. forbidden "10 seconds" must NOT match "110 seconds" — a false leak
 * would spuriously fail a correct answer). Boundaries follow regex `\b`
 * semantics: they are only required where the needle's own edge is a word
 * character, so anchors with non-word edges (paths, "/callback") still match.
 * An empty fact never matches.
 */
export function factPresent(hypothesisNorm: string, fact: string): boolean {
  const needle = normalizeForMatch(fact);
  if (!needle) return false;
  const leftEdgeIsWord = isWordChar(needle[0]);
  const rightEdgeIsWord = isWordChar(needle[needle.length - 1]);
  let from = 0;
  for (;;) {
    const idx = hypothesisNorm.indexOf(needle, from);
    if (idx === -1) return false;
    const end = idx + needle.length;
    const leftOk =
      !leftEdgeIsWord || idx === 0 || !isWordChar(hypothesisNorm[idx - 1]);
    const rightOk =
      !rightEdgeIsWord ||
      end === hypothesisNorm.length ||
      !isWordChar(hypothesisNorm[end]);
    if (leftOk && rightOk) return true;
    from = idx + 1;
  }
}

export interface RetrievalAnchors {
  /** Facts that MUST appear in a correct answer. */
  expectedFacts?: string[];
  /** Stale/superseded facts that must NOT appear (negative controls). */
  forbiddenFacts?: string[];
}

/**
 * Score a hypothesis against a question's ground-truth anchors.
 *
 * Returns `undefined` when the question declares no anchors — such questions
 * are graded by the LLM judge alone, and callers should omit the retrieval
 * block entirely rather than emit a vacuous zero.
 *
 * `pass` is the strict negative-control-aware verdict: every expected fact
 * present AND no forbidden fact leaked. A question with only `forbiddenFacts`
 * (a pure negative control) passes iff nothing stale surfaced.
 */
export function scoreRetrieval(
  hypothesis: string,
  anchors: RetrievalAnchors,
): RetrievalScore | undefined {
  const expected = (anchors.expectedFacts ?? []).filter((f) => f.trim());
  const forbidden = (anchors.forbiddenFacts ?? []).filter((f) => f.trim());
  if (expected.length === 0 && forbidden.length === 0) return undefined;

  const norm = normalizeForMatch(hypothesis);
  const matchedFacts: string[] = [];
  const missedFacts: string[] = [];
  for (const f of expected) {
    if (factPresent(norm, f)) matchedFacts.push(f);
    else missedFacts.push(f);
  }
  const leakedStaleFacts = forbidden.filter((f) => factPresent(norm, f));

  const factRecall = expected.length
    ? matchedFacts.length / expected.length
    : null;
  const pass =
    (expected.length === 0 || matchedFacts.length === expected.length) &&
    leakedStaleFacts.length === 0;

  return {
    factRecall,
    expectedCount: expected.length,
    matchedFacts,
    missedFacts,
    leakedStaleFacts,
    pass,
  };
}
