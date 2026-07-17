import { micromark } from "micromark";
import { remark } from "remark";
import type {
  Root,
  Nodes,
  Heading,
  List,
  ListItem,
  Paragraph,
  Text,
  Strong,
  BlockContent,
  PhrasingContent,
} from "mdast";

// Reuse a single processor — remark freezes on first use anyway
const processor = remark();

// Serialize an mdast tree to a markdown string.
// The serializer automatically escapes any characters in text nodes
// that would be structurally ambiguous (code fences, headings, list
// markers, thematic breaks, etc.), so callers never need to pre-escape.
export function serialize(tree: Root): string {
  return processor.stringify(tree);
}

/**
 * Replace unpaired Unicode surrogates with U+FFFD (replacement character).
 *
 * Unpaired surrogates (a high surrogate U+D800-U+DBFF without a following low
 * surrogate U+DC00-U+DFFF, or a lone low surrogate) are technically invalid in
 * UTF-8/JSON. They can appear in tool outputs (binary file contents, command
 * output) and survive through SQLite storage into recall results. When the
 * resulting string is serialized to JSON for the LLM API, the API rejects it
 * with "no low surrogate in string".
 */
export function sanitizeSurrogates(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "\uFFFD",
  );
}

// Collapse newlines in LLM-generated text before inserting into a text node.
// Embedded blank lines (\n\n) cause list items to become "spread" (loose),
// which then breaks the surrounding markdown structure on re-parse.
// Newlines within a single fact/narrative are replaced with a space.
// Also sanitizes unpaired surrogates to prevent JSON serialization failures.
export function inline(value: string): string {
  return sanitizeSurrogates(value)
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

// Upper bound on parse→stringify passes in `normalize`. remark's escaping is
// monotone (each pass can only add backslash escapes for newly-ambiguous
// sequences) and converges once the html-node trailing-whitespace pump in
// `roundtrip` is neutralized (see below). Across a 200k-sample fast-check
// search — with HTML-block triggers (`<?`, `<!`) added to the generator, the
// class that regressed as #1357 — the worst observed input reached a fixpoint
// in 4 passes with zero oscillations, so 8 is a generous safety bound.
const MAX_NORMALIZE_PASSES = 8;

// Strip trailing newlines from every `html` node's value, in place.
//
// An HTML block absorbs the blank line(s) that separate it from the next
// block into its own `value` on parse; `stringify` then re-supplies that
// separator, so a plain parse→stringify roundtrip *grows* the trailing
// newline run by a fixed amount every pass and never reaches a fixpoint
// (issue #1357: `* <?\n\n1.\n` — a list item whose content is an HTML block,
// followed by another list). Trimming the trailing newline run breaks the
// pump, making the roundtrip convergent.
//
// We trim newlines only (`/\n+$/`), not all whitespace: trailing spaces/tabs
// are never part of the blank-line separator, so leaving them keeps the trim
// as narrow as possible. This is lossless for the common case (the separator
// remark re-supplies). The one construction where it is *not* purely a
// separator — an HTML block split across a list boundary, so that content
// belonging inside the block (e.g. `<pre>` internal blank lines) lands at the
// node's trailing edge — is a rare, already-lossy input; `normalize` is only
// applied to untrusted text in Layer-4 emergency compression, so collapsing a
// runaway newline run there is acceptable.
function stripHtmlTrailingWhitespace(node: Nodes): void {
  if (node.type === "html") {
    node.value = node.value.replace(/\n+$/, "");
    return;
  }
  if ("children" in node) {
    for (const child of node.children) stripHtmlTrailingWhitespace(child);
  }
}

// One markdown parse → stringify roundtrip.
function roundtrip(md: string): string {
  const tree = processor.parse(md);
  stripHtmlTrailingWhitespace(tree);
  return processor.stringify(tree);
}

/**
 * Iterate `step` from `seed` until the sequence stabilizes, bounded by
 * `maxPasses`. Returns a fixpoint (`step(x) === x`) when one is reached.
 *
 * A fixpoint is just a self-cycle (`step(x) === x`, and `x` is already in the
 * seen-set), so a single repeat check covers both convergence and the
 * defensive cases, making this provably terminating for *any* `step`:
 *  - **fixpoint / cycle**: if an output repeats a value we've already seen,
 *    the sequence has stabilized (`x → x`) or `step` is oscillating
 *    (`A → B → A → …`); either way we stop and return that value.
 *  - **cap exhaustion**: a strictly non-repeating sequence is bounded by
 *    `maxPasses`, after which we return the last result rather than looping
 *    forever.
 *
 * For the real markdown roundtrip the cap and oscillation cases never fire —
 * remark's escaping is monotone and, with the html-node trailing-whitespace
 * pump neutralized (see `roundtrip`), the sequence strictly grows until it
 * stabilizes — but they guard against a future serializer regression that
 * could oscillate or diverge (as #1357 did before the pump was fixed).
 * Exported so tests can drive the convergence / cycle / cap branches with
 * synthetic steps (real markdown only ever hits convergence).
 */
export function iterateToFixpoint(
  seed: string,
  step: (value: string) => string,
  maxPasses: number = MAX_NORMALIZE_PASSES,
): string {
  let prev = seed;
  const seen = new Set<string>([prev]);
  for (let i = 0; i < maxPasses; i++) {
    const next = step(prev);
    if (seen.has(next)) return next; // fixpoint (self-cycle) or oscillation
    seen.add(next);
    prev = next;
  }
  return prev; // cap exhausted without convergence
}

// Normalize arbitrary markdown via parse → stringify roundtrip.
// Used for content we don't control (e.g. existing text parts in Layer 4
// after tool parts are stripped out), where we can't build from AST.
//
// A single roundtrip is not idempotent: remark's asterisk/underscore escaping
// can introduce new ambiguous sequences (e.g. `**` adjacent to already-escaped
// asterisks becomes `\*\*`) that only stabilize on a *later* pass. A fixed two
// passes was not enough for some hostile inputs (issue #959), so we iterate to
// a fixpoint (bounded by MAX_NORMALIZE_PASSES). A separate hazard — an HTML
// block that keeps swallowing and re-emitting its trailing blank-line
// separator, growing without bound (issue #1357) — is neutralized inside
// `roundtrip`. Together these make the transform converge, so the result is
// itself already-normalized: normalize(normalize(x)) === normalize(x).
export function normalize(md: string): string {
  return iterateToFixpoint(roundtrip(md), roundtrip);
}

/**
 * Unescape a markdown-serialized inline string back to plain text.
 *
 * remark's serializer escapes special characters with backslashes
 * (e.g. `<` → `\<`, `*` → `\*`, `\` → `\\`). When we read content
 * back from an AGENTS.md file we must unescape it so it round-trips
 * cleanly — otherwise each export/import cycle doubles the escapes.
 *
 * Uses remark's own parser to extract the text value, which handles
 * all escape sequences correctly.
 */
export function unescapeMarkdown(md: string): string {
  const tree = processor.parse(md);
  // Collect all text node values from the first paragraph
  const texts: string[] = [];
  const para = tree.children[0];
  if (para && para.type === "paragraph") {
    for (const child of para.children) {
      if (child.type === "text") texts.push(child.value);
      else if (child.type === "strong" || child.type === "emphasis") {
        for (const gc of child.children) {
          if (gc.type === "text") texts.push(gc.value);
        }
      }
    }
  }
  return texts.join("") || md;
}

// --- Node builders ---

export function h(depth: 1 | 2 | 3 | 4 | 5 | 6, value: string): Heading {
  return { type: "heading", depth, children: [t(value)] };
}

export function p(value: string): Paragraph {
  return { type: "paragraph", children: [t(value)] };
}

export function ul(items: ListItem[]): List {
  return { type: "list", ordered: false, spread: false, children: items };
}

export function li(...children: BlockContent[]): ListItem {
  return { type: "listItem", spread: false, children };
}

// List item containing a single paragraph (the common case for facts/entries)
export function lip(value: string): ListItem {
  return li(p(value));
}

// List item with inline phrasing content — e.g. **bold**: text
export function liph(...children: PhrasingContent[]): ListItem {
  return li({ type: "paragraph", children });
}

export function t(value: string): Text {
  return { type: "text", value };
}

export function strong(value: string): Strong {
  return { type: "strong", children: [t(value)] };
}

export function root(...children: Root["children"]): Root {
  return { type: "root", children };
}

/**
 * Render a markdown string to sanitized HTML.
 *
 * Uses micromark with default options:
 * - Raw HTML in input is escaped (no allowDangerousHtml)
 * - Only safe URL protocols are permitted (no allowDangerousProtocol)
 *
 * The output is safe to embed directly in an HTML page without
 * additional escaping.
 */
export function renderMarkdown(md: string): string {
  return micromark(md);
}
