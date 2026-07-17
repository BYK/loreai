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

/** A segment of the original body, carrying its char offsets so callers can map
 *  positions (e.g. detected-directive spans) back to segments regardless of how
 *  the body was split. `[start, end)` are indices into the original body. */
export interface Segment {
  text: string;
  start: number;
  end: number;
}

/**
 * Split a body into coherent segments: on the part terminator (tool envelopes
 * stored in the message) and blank lines (paragraphs). Oversized paragraphs are
 * split on line boundaries first (so a directive on its own line stays intact);
 * only a genuinely unbroken giant line (minified JSON / one-line log) falls back
 * to fixed char windows. Each segment carries its `[start, end)` offset into the
 * original body.
 */
export function segmentBody(
  body: string,
  segmentChars = SEGMENT_CHARS,
): Segment[] {
  const segments: Segment[] = [];
  const push = (text: string, start: number) => {
    if (text.trim()) segments.push({ text, start, end: start + text.length });
  };

  // Walk the body span-by-span so every segment keeps a true offset. We split on
  // the part terminator, then blank lines, then (for oversized paragraphs) lines,
  // then (for oversized lines) fixed char windows.
  const emitChunk = (chunk: string, base: number) => {
    if (chunk.length <= segmentChars * 2) {
      push(chunk, base);
      return;
    }
    // Oversized: split on line boundaries, preserving offsets. A line that is
    // itself oversized is hard-windowed (the only case that can split a directive
    // — but a directive on its own line is preserved).
    let cursor = 0;
    const lines = chunk.split("\n");
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const lineBase = base + cursor;
      if (line.length <= segmentChars * 2) {
        push(line, lineBase);
      } else {
        for (let i = 0; i < line.length; i += segmentChars) {
          push(line.slice(i, i + segmentChars), lineBase + i);
        }
      }
      cursor += line.length + 1; // +1 for the consumed "\n"
    }
  };

  // Split into parts on the terminator while tracking offsets.
  let partBase = 0;
  const parts = body.includes(CHUNK_TERMINATOR)
    ? body.split(CHUNK_SEPARATOR)
    : [body];
  for (let pi = 0; pi < parts.length; pi++) {
    const part = parts[pi];
    // Paragraph split within the part (blank lines). Use a matched-offset walk so
    // paragraph offsets stay accurate through variable-width blank-line runs.
    const paraRe = /\n\s*\n/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = paraRe.exec(part)) !== null) {
      emitChunk(part.slice(last, m.index), partBase + last);
      last = m.index + m[0].length;
    }
    emitChunk(part.slice(last), partBase + last);
    // Advance past this part plus the separator that split() consumed.
    partBase += part.length + CHUNK_SEPARATOR.length;
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
   * MUST survive reduction. Located by offset in the original body; every segment
   * overlapping a match is force-kept regardless of relevance score, budget, or
   * Stage-1 classification — a directive buried in an oversized blob must never
   * be elided, even when segmentation splits it across a window boundary.
   * Empty/whitespace entries are ignored; a trailing display "…" is tolerated.
   */
  pinnedLines?: string[];
  /**
   * Chars of the leading prose prefix always kept verbatim, before any scoring.
   * A user writes their own words (instruction + casual asides / stated facts)
   * at the head of a message and pastes the bulk blob after; that prose is
   * signal even when it scores low against the current objective. Leading
   * segments are force-kept until the first paste-junk segment or this budget is
   * reached. 0 (or omitted) disables head preservation. #1343 follow-up.
   */
  headChars?: number;
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
    // trailing "…"); strip a trailing ellipsis/whitespace so matching works
    // against the verbatim body text.
    .map((p) => p.replace(/\s*…\s*$/u, "").trim())
    .filter((p) => p.length > 0);

  // Locate each pin's char span(s) in the ORIGINAL body, then mark every segment
  // whose offset range overlaps a pin span as pinned. Matching by body offset —
  // not by `segment.includes(pin)` — is what makes a directive survive even when
  // segmentation splits it across a window boundary (both overlapping windows are
  // force-kept). #1343 B1.
  const pinSpans: Array<[number, number]> = [];
  for (const p of pins) {
    let from = 0;
    for (;;) {
      const idx = body.indexOf(p, from);
      if (idx < 0) break;
      pinSpans.push([idx, idx + p.length]);
      from = idx + p.length;
    }
  }
  const overlapsPin = (seg: Segment) =>
    pinSpans.some(([s, e]) => seg.start < e && s < seg.end);
  const pinnedFlag = all.map(overlapsPin);

  // Head preservation: force-keep the leading prose prefix — the user's own
  // words (instruction + any casual asides / stated facts) that precede a pasted
  // bulk blob. Walk from the top, keeping segments until the first paste-junk
  // segment (the blob has begun) or the headChars budget is exhausted. Treated
  // identically to a pin thereafter, so head prose survives relevance scoring,
  // the segment cap, and the keepChars budget. #1343 follow-up: a low-salience
  // fact stated at the head of an oversized message must not be elided before
  // the distiller ever sees it.
  //
  // Segment-count clamp: head segments bypass the maxSegments sampling like pins,
  // but — unlike pins (bounded by MAX_PINNED_ASSERTIONS) — they're bounded only by
  // headChars, which has no relation to segment size. A misconfigured large
  // headChars could otherwise force-embed the whole body, reintroducing the
  // #1343 unbounded-embed cost. Cap the head at half the embed budget so at least
  // half of maxSegments is always reserved for relevance sampling of the body.
  const headBudget = opts.headChars ?? 0;
  const maxHeadSegments = Math.max(1, Math.floor(opts.maxSegments / 2));
  const headFlag = all.map(() => false);
  if (headBudget > 0) {
    let headUsed = 0;
    let headCount = 0;
    for (let i = 0; i < all.length; i++) {
      if (looksLikePasteJunk(all[i].text)) break; // blob started — stop
      if (headUsed >= headBudget || headCount >= maxHeadSegments) break;
      headFlag[i] = true;
      headUsed += all[i].text.length;
      headCount++;
    }
  }
  // A segment is force-kept if it is a pin OR part of the preserved head.
  const keptFlag = all.map((_, i) => pinnedFlag[i] || headFlag[i]);

  // Stage 1: drop paste-junk before spending any embed — but never drop a pinned
  // or head-preserved segment (a directive/aside can look "junky" if wrapped in a
  // noisy blob, and the head is always kept).
  const proseIdx: number[] = [];
  for (let i = 0; i < all.length; i++) {
    if (keptFlag[i] || !looksLikePasteJunk(all[i].text)) proseIdx.push(i);
  }
  const junkDropped = all.length - proseIdx.length;

  if (proseIdx.length === 0) {
    // Entire blob was non-prose (e.g. a pure base64/binary paste). Nothing worth
    // embedding — annotate the whole thing as elided.
    return { output: elision(body.length), junkDropped, embedded: 0, kept: 0 };
  }

  // Cap segment count to bound embed cost — operating on INDICES so duplicate
  // segment text can never inflate the count past maxSegments (#1343 S2; Seer
  // r3596091130). Pinned segments are always included; the remaining budget is
  // uniformly sampled across the non-pinned survivors so coverage still spans the
  // whole body.
  let cappedIdx: number[];
  if (proseIdx.length > opts.maxSegments) {
    const pinnedIdx = proseIdx.filter((i) => keptFlag[i]);
    const nonPinnedIdx = proseIdx.filter((i) => !keptFlag[i]);
    const sampleBudget = Math.max(0, opts.maxSegments - pinnedIdx.length);
    // sampleBudget === 0 (pins alone meet/exceed the cap) → keep ZERO non-pinned,
    // never all of them (#1343 S3).
    const sampled =
      sampleBudget === 0
        ? []
        : nonPinnedIdx.length > sampleBudget
          ? Array.from(
              { length: sampleBudget },
              (_, k) =>
                nonPinnedIdx[
                  Math.floor((k * nonPinnedIdx.length) / sampleBudget)
                ],
            )
          : nonPinnedIdx;
    const keep = new Set<number>([...pinnedIdx, ...sampled]);
    cappedIdx = proseIdx.filter((i) => keep.has(i));
  } else {
    cappedIdx = proseIdx;
  }

  // Stage 2: embed query + segments, score by cosine, greedily fill the budget.
  const [queryVec] = await opts.embed([opts.query]);
  const segVecs = await opts.embed(cappedIdx.map((i) => all[i].text));
  const scored = cappedIdx.map((i, k) => ({
    idx: i,
    text: all[i].text,
    score: opts.cosine(queryVec, segVecs[k]),
    pinned: keptFlag[i],
  }));

  const keepIdx = new Set<number>();
  let used = 0;
  // Force-kept segments (pins + preserved head) are kept unconditionally (bypass
  // the keepChars budget) so a directive/aside can never be elided. Both are
  // bounded: pins by the caller (MAX_PINNED_ASSERTIONS) and head segments by
  // maxHeadSegments (≤ maxSegments/2), so this cannot blow the budget unboundedly.
  for (const s of scored) {
    if (s.pinned) {
      keepIdx.add(s.idx);
      used += s.text.length;
    }
  }
  // Fill the remaining budget with the highest-scoring non-forced segments.
  const byScore = scored
    .filter((s) => !s.pinned)
    .sort((a, b) => b.score - a.score);
  for (const s of byScore) {
    if (used + s.text.length > opts.keepChars) continue;
    keepIdx.add(s.idx);
    used += s.text.length;
  }

  // Reassemble in original order, collapsing dropped runs into one annotation.
  // Iterate over ALL segments (not just embedded ones) so junk-dropped and
  // cap-dropped regions are accounted for in the elision totals. Kept segments
  // that were contiguous in the original body (adjacent hard-window pieces of one
  // line: prevEnd === start) rejoin with NO separator so a mid-word window split
  // is byte-exact; otherwise segments join with "\n".
  let output = "";
  let elided = 0;
  let prevKeptEnd = -1;
  let wroteAnything = false;
  const flushElision = () => {
    if (elided > 0) {
      if (wroteAnything) output += "\n";
      output += elision(elided);
      wroteAnything = true;
      elided = 0;
    }
  };
  for (let i = 0; i < all.length; i++) {
    const seg = all[i];
    if (keepIdx.has(i)) {
      flushElision();
      if (wroteAnything) output += prevKeptEnd === seg.start ? "" : "\n";
      output += seg.text;
      prevKeptEnd = seg.end;
      wroteAnything = true;
    } else {
      elided += seg.text.length;
      prevKeptEnd = -1;
    }
  }
  flushElision();

  return {
    output,
    junkDropped,
    embedded: cappedIdx.length,
    kept: keepIdx.size,
  };
}
