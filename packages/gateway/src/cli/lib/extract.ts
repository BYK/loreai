/**
 * Extract the trailing JSON object from a string containing mixed
 * stderr/stdout captures. Walks candidate `{` positions from the end
 * (since the legacy handler emits its `JSON.stringify(..., null, 2)`
 * result LAST via `console.log`) and returns the first successfully
 * parsed object that ALSO CLOSES AT THE END OF THE STRING (modulo
 * trailing whitespace).
 *
 * Returns `null` when no parseable top-level object is found — the
 * caller should fall back to the wrapped-shape envelope so the failure
 * is loud (an unreadable JSON result printed by report.mjs is easier
 * to diagnose than a silent undefined-field render that the previous
 * default produced, where every funnel number rendered as "undefined").
 *
 * Brace matching is JSON-string-aware (handles escapes, distinguishes
 * `{` / `}` inside string literals from structural braces) so a `{` or
 * `}` embedded in a "reason" field, log message, or invariant content
 * doesn't shift the depth tracker.
 *
 * Anchoring on the end of the string matters: a naive walk from the
 * right would happily return the inner `"range": { ... }` object of a
 * `CheckResult` (or any other inner object) the moment its closing `}`
 * happens to be the LAST depth-0 close in the buffer. Report.mjs in
 * CI expects the OUTER `CheckResult` — flat `hunks`, `invariants`,
 * `candidates`, `judgeCalls` at the top level — so we restrict to
 * candidates whose matching `}` is at (or just before) the end of
 * the captured buffer, which is the unambiguous trailing object.
 */
export function extractTrailingJsonObject(s: string): unknown {
  // Trailing whitespace (`\n`, `\r`, ` `, `\t`) is allowed after the
  // closing `}` of the JSON envelope; the legacy `console.log` shim
  // appends a `\n` and we don't want to fail on that. Find the
  // last non-whitespace character of the string — the closing `}` of
  // the trailing JSON must sit there (modulo the strip below).
  let end = s.length;
  while (end > 0 && /\s/.test(s[end - 1] ?? "")) end--;
  if (end === 0 || s[end - 1] !== "}") return null;

  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] !== "{") continue;
    let depth = 0;
    let inStr = false;
    let escape = false;
    let j = i;
    for (; j < s.length; j++) {
      const c = s[j];
      if (escape) {
        escape = false;
        continue;
      }
      if (inStr) {
        if (c === "\\") {
          escape = true;
        } else if (c === '"') {
          inStr = false;
        }
        continue;
      }
      if (c === '"') {
        inStr = true;
      } else if (c === "{") {
        depth++;
      } else if (c === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) continue; // unbalanced brace — not a complete object
    // Anchor on the END of the buffer (modulo trailing whitespace): the
    // matching `}` must be at `end - 1`. Inner objects close earlier and
    // would otherwise mislead the caller — see header comment.
    if (j !== end - 1) continue;
    try {
      return JSON.parse(s.slice(i, j + 1));
    } catch {
      // Try the next candidate `{`.
    }
  }
  return null;
}
