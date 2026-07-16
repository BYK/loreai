// Embedding-based relevance selection for oversized user message blobs (#1343).
//
// The segment distiller feeds user-message content verbatim to the worker LLM —
// "user text is always signal". That holds for prose/directives but NOT for large
// pasted blobs (logs, dumped files, data exports, base64, minified JSON). Those
// are bulk, not signal: the observer reads 85K tokens to emit ~500. This module
// reduces such blobs BEFORE they reach the worker, keeping only the portions that
// are relevant to what the distiller actually cares about.
//
// The design is a TWO-STAGE filter (validated against real production blobs in
// #1343 — see .opencode/plans):
//
//   Stage 1 — cheap lexical pre-filter (FREE, no embeddings). Drops non-prose
//     "paste junk" (base64, repeated garbage bytes, minified dumps) with pure
//     string arithmetic. This is the biggest cost lever: a hostile blob never
//     reaches the embedder. Script-aware so it never drops non-Latin prose.
//
//   Stage 2 — embedding relevance. Embeds the surviving prose/code segments and
//     the caller's relevance query, keeps the top-scoring segments up to a char
//     budget. Elided runs are annotated so the observer knows content was removed.
//
// Fail-open: the CALLER decides what to do when embeddings are unavailable — this
// module only runs Stage 2 when given an `embed`. `reduceBlob` throwing/rejecting
// must be caught by the caller, which leaves the body verbatim (never blunt-
// truncated: dropping user signal is worse than paying for it once).
//
// Dependency-free leaf (like embedding-units.ts): takes `embed`/`cosine` as
// injected functions so it can be unit-tested without the ONNX worker.

/** ASCII Unit Separator — mirrors CHUNK_TERMINATOR in temporal.ts. */
const CHUNK_TERMINATOR = "\x1f";
const CHUNK_SEPARATOR = `\n${CHUNK_TERMINATOR}`;

/** Target segment size in chars. Paragraphs larger than 2× this are windowed. */
const SEGMENT_CHARS = 800;

/**
 * Segments shorter than this are never judged as junk (too little to classify —
 * keep, the safe direction). Also the floor below which a whole blob isn't worth
 * reducing.
 */
const MIN_JUDGE_CHARS = 40;

/**
 * Non-Latin linguistic scripts. Presence in bulk signals human prose. Space-
 * optional scripts (Han/Kana/Hangul/Thai) are here too — they legitimately lack
 * word spaces, so the Latin space/word structural test must NOT be applied to
 * them. `u` flag required for `\p{Script=…}` (used elsewhere: search.ts,
 * instruction-detect.ts; works on Node + Bun).
 */
const NON_LATIN_LINGUISTIC =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Devanagari}]/gu;

/** Latin letters carrying diacritics (Turkish ç ş ğ ı ö ü, accented Latin). */
const LATIN_DIACRITICS = /[\u00C0-\u024F\u1E00-\u1EFF]/gu;

/** Any Unicode letter. */
const ANY_LETTER = /\p{L}/gu;

/**
 * Fraction of a segment that must be a non-Latin linguistic script before it
 * takes the language-script branch (skip space/word test, apply entropy test).
 * 30% (not a mere sprinkle) so a 10%-CJK / 90%-junk mix can't whitewash garbage.
 */
const NON_LATIN_DOMINANT = 0.3;

/** More than this many Latin diacritics → treat as accented-Latin prose. */
const DIACRITIC_MIN = 3;

/**
 * Distinct-character ratio ceiling for the language-script branch. Real
 * CJK/JP/KR prose reuses common characters (dcr ≈ 0.6–0.73); random CJK/binary
 * noise spans its block uniformly (dcr ≈ 0.99). Above this → noise, drop.
 * Alphabetic scripts sit far below (Cyrillic ≈ 0.23, Arabic ≈ 0.28).
 */
const LANG_DCR_MAX = 0.85;

/**
 * For ASCII-dominant segments: average token length above this (with few
 * letters) marks a base64/minified dump — enormous unbroken tokens.
 */
const ASCII_AVG_TOKEN_MAX = 40;
const ASCII_LETTER_RATIO_MAX = 0.5;

/**
 * Trigram distinct ratio floor for ASCII-dominant segments. Repeated garbage
 * bytes produce very few distinct trigrams. Below this → drop.
 */
const ASCII_TRIGRAM_RATIO_MIN = 0.15;

/** Distinct-character ratio over a string. */
function distinctCharRatio(t: string): number {
  return new Set(t).size / t.length;
}

/** Distinct-trigram ratio (sequence-level repetition signal). */
function trigramRatio(t: string): number {
  const distinct = new Set<string>();
  for (let i = 0; i + 3 <= t.length; i += 3) distinct.add(t.slice(i, i + 3));
  return distinct.size / Math.max(1, Math.floor(t.length / 3));
}

/**
 * Stage 1: is this segment non-prose "paste junk" that should be dropped before
 * spending an embed? Pure string arithmetic — no model, no I/O.
 *
 * 🔴 Tuning invariant: a false POSITIVE (dropping real prose) violates "user
 * text is signal" and is unacceptable; a false NEGATIVE (keeping junk) only
 * costs a few embeds that Stage 2 ranks low. Tuned conservatively — when in
 * doubt, keep.
 */
export function looksLikePasteJunk(segment: string): boolean {
  const t = segment.trim();
  if (t.length < MIN_JUDGE_CHARS) return false; // too short to judge → keep

  const nonLatin = (t.match(NON_LATIN_LINGUISTIC) ?? []).length;
  const diacritics = (t.match(LATIN_DIACRITICS) ?? []).length;

  // Language-script branch: dominant non-Latin script OR accented Latin. Skip the
  // space/word test (non-space scripts lack word spaces) but STILL require
  // language-like character statistics — this is what stops binary garbage whose
  // bytes happen to decode into CJK/other linguistic code points.
  if (nonLatin / t.length > NON_LATIN_DOMINANT || diacritics > DIACRITIC_MIN) {
    return distinctCharRatio(t) > LANG_DCR_MAX; // too many unique chars = noise
  }

  // ASCII / Latin-dominant branch: structural dump signals.
  const letters = (t.match(ANY_LETTER) ?? []).length;
  const letterRatio = letters / t.length;
  const words = t.split(/\s+/);
  const avgToken = t.length / words.length;

  if (words.length < 3) return true; // one giant unbroken token = dump
  if (avgToken > ASCII_AVG_TOKEN_MAX && letterRatio < ASCII_LETTER_RATIO_MAX) {
    return true; // base64 / minified: enormous tokens, few letters
  }
  if (trigramRatio(t) < ASCII_TRIGRAM_RATIO_MIN) return true; // repeated garbage
  return false;
}

/**
 * Split a body into coherent segments: on the part terminator (tool envelopes
 * stored in the message) and blank lines (paragraphs). Oversized paragraphs and
 * single-giant-line dumps (minified JSON / one-line logs) fall back to fixed
 * char windows so a pathological one-line megablob still segments.
 */
export function segmentBody(
  body: string,
  segmentChars = SEGMENT_CHARS,
): string[] {
  const parts = body.includes(CHUNK_TERMINATOR)
    ? body.split(CHUNK_SEPARATOR)
    : [body];
  const segments: string[] = [];
  for (const part of parts) {
    for (const paragraph of part.split(/\n\s*\n/)) {
      if (paragraph.length <= segmentChars * 2) {
        if (paragraph.trim()) segments.push(paragraph);
        continue;
      }
      for (let i = 0; i < paragraph.length; i += segmentChars) {
        segments.push(paragraph.slice(i, i + segmentChars));
      }
    }
  }
  return segments;
}

export interface ReduceBlobOptions {
  /** Embed a batch of texts. Injected so this leaf is testable without ONNX. */
  embed: (texts: string[]) => Promise<Float32Array[]>;
  /** Cosine similarity of two L2-normalized vectors (dot product). */
  cosine: (a: Float32Array, b: Float32Array) => number;
  /** What the kept segments are scored against (assertions + prior obs + turn). */
  query: string;
  /** Max chars of blob to keep after selection. */
  keepChars: number;
  /** Max segments to embed (bounds cost); surviving segments sampled down. */
  maxSegments: number;
  /**
   * High-priority text snippets (e.g. detected user assertions/directives) that
   * MUST survive reduction. Any segment containing one of these as a substring is
   * force-kept regardless of relevance score or budget — a directive buried in an
   * oversized blob must never be elided. Empty/whitespace entries are ignored.
   */
  pinnedLines?: string[];
}

export interface ReduceBlobResult {
  /** The reduced body, original order, with elided runs annotated. */
  output: string;
  /** Segments dropped by Stage-1 pre-filter (no embed spent). */
  junkDropped: number;
  /** Segments embedded in Stage 2. */
  embedded: number;
  /** Segments kept in the output. */
  kept: number;
}

/** Format an elided run marker. */
function elision(chars: number): string {
  return `[… ${chars} chars elided (low-relevance) …]`;
}

/**
 * Reduce an oversized user blob to its query-relevant portions.
 *
 * Two-stage: Stage-1 lexical pre-filter drops paste-junk for free; Stage-2 embeds
 * the survivors and keeps the top-scoring segments up to `keepChars`, preserving
 * original order and annotating elided runs.
 *
 * Throws if `embed` rejects — the caller must catch and leave the body verbatim
 * (fail-open; never blunt-truncate user signal).
 */
export async function reduceBlob(
  body: string,
  opts: ReduceBlobOptions,
): Promise<ReduceBlobResult> {
  const all = segmentBody(body);
  const pins = (opts.pinnedLines ?? [])
    // Callers may pass display-truncated snippets (e.g. a 200-char cap with a
    // trailing "…"); strip a trailing ellipsis/whitespace so substring matching
    // works against the verbatim segment text.
    .map((p) => p.replace(/\s*…\s*$/u, "").trim())
    .filter((p) => p.length > 0);
  // A segment is pinned if it contains any high-priority snippet verbatim. Pinned
  // segments are force-kept even if Stage-1 would drop them or they'd fall
  // outside the sampled/budgeted set — a directive must never be elided.
  const isPinned = (seg: string) => pins.some((p) => seg.includes(p));

  // Stage 1: drop paste-junk before spending any embed — but never drop a pinned
  // segment (a directive can look "junky" if wrapped in a noisy blob).
  const prose = all.filter((s) => isPinned(s) || !looksLikePasteJunk(s));
  const junkDropped = all.length - prose.length;

  if (prose.length === 0) {
    // Entire blob was non-prose (e.g. a pure base64/binary paste). Nothing worth
    // embedding — annotate the whole thing as elided.
    return {
      output: elision(body.length),
      junkDropped,
      embedded: 0,
      kept: 0,
    };
  }

  // Cap segment count to bound embed cost; uniformly sample so coverage spans the
  // whole surviving body rather than just its head. Pinned segments are always
  // included in the sample so they can never be dropped by the cap.
  let capped: string[];
  if (prose.length > opts.maxSegments) {
    const pinned = prose.filter(isPinned);
    const sampleBudget = Math.max(0, opts.maxSegments - pinned.length);
    const nonPinned = prose.filter((s) => !isPinned(s));
    const sampled =
      sampleBudget > 0 && nonPinned.length > sampleBudget
        ? Array.from(
            { length: sampleBudget },
            (_, i) =>
              nonPinned[Math.floor((i * nonPinned.length) / sampleBudget)],
          )
        : nonPinned;
    // Re-select from `prose` in original order to preserve ordering, keeping any
    // segment that is pinned or made the non-pinned sample.
    const keepSet = new Set([...pinned, ...sampled]);
    capped = prose.filter((s) => keepSet.has(s));
  } else {
    capped = prose;
  }

  // Stage 2: embed query + segments, score by cosine, greedily fill the budget.
  const [queryVec] = await opts.embed([opts.query]);
  const segVecs = await opts.embed(capped);
  const scored = capped.map((text, idx) => ({
    text,
    idx,
    score: opts.cosine(queryVec, segVecs[idx]),
    pinned: isPinned(text),
  }));

  const keepIdx = new Set<number>();
  let used = 0;
  // Pinned segments are kept unconditionally (bypass the budget) so a directive
  // can never be elided.
  for (const s of scored) {
    if (s.pinned) {
      keepIdx.add(s.idx);
      used += s.text.length;
    }
  }
  // Fill the remaining budget with the highest-scoring non-pinned segments.
  const byScore = scored
    .filter((s) => !s.pinned)
    .sort((a, b) => b.score - a.score);
  for (const s of byScore) {
    if (used + s.text.length > opts.keepChars) continue;
    keepIdx.add(s.idx);
    used += s.text.length;
  }

  // Reassemble in original order, collapsing dropped runs into one annotation.
  const outParts: string[] = [];
  let elided = 0;
  for (const s of scored) {
    if (keepIdx.has(s.idx)) {
      if (elided > 0) {
        outParts.push(elision(elided));
        elided = 0;
      }
      outParts.push(s.text);
    } else {
      elided += s.text.length;
    }
  }
  if (elided > 0) outParts.push(elision(elided));

  return {
    output: outParts.join("\n"),
    junkDropped,
    embedded: capped.length,
    kept: keepIdx.size,
  };
}
