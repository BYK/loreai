// Measurement core for the #2030 convergence benchmarks. Copy verbatim; do not edit.
// Timing source: every participant runs on the same host and stamps times with
// performance.timeOrigin + performance.now() (ms, float).

/** Nearest-rank percentile over an ascending-sorted array. */
export function percentile(sorted, p) {
  if (sorted.length === 0) return Number.NaN;
  const i = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[i];
}

export function summarize(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
    max: s[s.length - 1],
    mean: s.length ? sum / s.length : Number.NaN,
  };
}

/**
 * edits:        [{ author, text, at }]  one per local edit; `at` stamped immediately before the mutation.
 * observations: [{ observer, text, seen }] first time `observer` sees reply `text` (stamped in its change handler).
 * participants: list of participant names.
 * Returns one sample (seen - at) per (edit, remote observer) pair; throws on any missing,
 * duplicate or unknown observation so a partial run can never be reported as complete.
 */
export function latencySamples(edits, observations, participants) {
  const byText = new Map(edits.map((e) => [e.text, e]));
  if (byText.size !== edits.length) throw new Error("duplicate edit text");
  const seenPairs = new Set();
  const samples = [];
  for (const o of observations) {
    const e = byText.get(o.text);
    if (!e) throw new Error(`observation of unknown edit ${o.text}`);
    if (o.observer === e.author) continue;
    const key = `${o.observer}\u0000${o.text}`;
    if (seenPairs.has(key)) throw new Error(`duplicate observation ${key}`);
    seenPairs.add(key);
    samples.push(o.seen - e.at);
  }
  const expected = edits.length * (participants.length - 1);
  if (samples.length !== expected) {
    throw new Error(
      `incomplete run: ${samples.length}/${expected} remote observations`,
    );
  }
  return samples;
}

/** Every participant must end with the identical ordered reply list containing every edit. */
export function assertConverged(finalStates, edits) {
  const names = Object.keys(finalStates);
  const ref = JSON.stringify(finalStates[names[0]]);
  for (const n of names) {
    if (JSON.stringify(finalStates[n]) !== ref)
      throw new Error(`diverged: ${n}`);
  }
  const texts = new Set(finalStates[names[0]].map((r) => r.text));
  for (const e of edits)
    if (!texts.has(e.text)) throw new Error(`missing ${e.text}`);
  return true;
}
