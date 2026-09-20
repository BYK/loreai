/**
 * DOM ↔ anchor mapping for the reader (UI-06b).
 *
 * The reader's blocks render through `RichText`, whose container carries
 * `data-block` / `data-part` and whose `textContent` is the part's displayed
 * text (`RenderedHtml.text`). A browser selection inside one such container
 * maps to a logical {@link SourceAnchor} by measuring text offsets with a
 * Range, and an anchor maps back to the DOM by wrapping the text nodes of
 * `[start, end)` in `<mark>` elements — plain elements around existing text
 * nodes, never markup parsed from a string.
 *
 * A selection that spans two parts, or reaches outside the rendered text of
 * a part, has no single-part anchor: `readSelection` reports it as
 * `ambiguous` so the UI can say so instead of guessing which part was meant.
 */
import {
  anchorFor,
  encodeAnchor,
  textFragmentFor,
  type SourceAnchor,
} from "./anchors";
import { type MessageBlock, originLabel } from "./blocks";

export const PART_SELECTOR = "[data-block][data-part]";
export const HIGHLIGHT_ATTR = "data-passage-mark";

export interface PartElement {
  element: HTMLElement;
  blockId: string;
  partIndex: number;
}

/** The `RichText` container enclosing `node`, or null when outside any. */
export function partElementOf(node: Node | null): PartElement | null {
  const start = node
    ? node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.parentElement
    : null;
  const element = start?.closest<HTMLElement>(PART_SELECTOR) ?? null;
  if (!element) return null;
  const blockId = element.dataset.block;
  const partIndex = Number(element.dataset.part);
  if (!blockId || !Number.isInteger(partIndex) || partIndex < 0) return null;
  return { element, blockId, partIndex };
}

/** UTF-16 offset of (`node`, `offset`) within `root`'s text content. */
export function textOffset(root: Node, node: Node, offset: number): number {
  const range = (root.ownerDocument ?? document).createRange();
  range.setStart(root, 0);
  range.setEnd(node, offset);
  return range.toString().length;
}

export type SelectionReading =
  /** No selection, or a collapsed one, or one outside the reader. */
  | { kind: "none" }
  /** Both ends are inside the same part: an anchor can be minted. */
  | {
      kind: "part";
      blockId: string;
      partIndex: number;
      start: number;
      end: number;
      quote: string;
    }
  /** Selection touches the reader but not a single part. */
  | { kind: "ambiguous"; reason: "parts" | "outside" };

/**
 * Read the document selection relative to `root` (the reader's scroll area).
 * Selections entirely outside `root` are `none`; selections that overlap the
 * reader without both ends in one part are `ambiguous`.
 */
export function readSelection(
  root: HTMLElement,
  selection: Selection | null,
): SelectionReading {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return { kind: "none" };
  }
  const range = selection.getRangeAt(0);
  const touches =
    root.contains(range.startContainer) || root.contains(range.endContainer);
  if (!touches) return { kind: "none" };
  const a = partElementOf(range.startContainer);
  const b = partElementOf(range.endContainer);
  if (!a || !b) return { kind: "ambiguous", reason: "outside" };
  if (a.element !== b.element) return { kind: "ambiguous", reason: "parts" };
  const start = textOffset(a.element, range.startContainer, range.startOffset);
  const end = textOffset(a.element, range.endContainer, range.endOffset);
  if (start === end) return { kind: "none" };
  return {
    kind: "part",
    blockId: a.blockId,
    partIndex: a.partIndex,
    start: Math.min(start, end),
    end: Math.max(start, end),
    quote: range.toString(),
  };
}

/** Anchor for a `part` reading against the block it came from (or null). */
export function anchorForReading(
  reading: SelectionReading,
  block: MessageBlock | undefined,
): SourceAnchor | null {
  if (reading.kind !== "part" || !block) return null;
  const part = block.parts[reading.partIndex];
  if (!part) return null;
  return anchorFor(block, part, reading.start, reading.end);
}

/** Remove every highlight mark under `root`, merging the text back. */
export function clearHighlight(root: HTMLElement): void {
  const marks = root.querySelectorAll<HTMLElement>(`[${HIGHLIGHT_ATTR}]`);
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  }
}

/**
 * Wrap the displayed text `[start, end)` of `root` in `<mark>` elements —
 * one per text node the span crosses, so element boundaries (links, code)
 * stay intact. Returns the first mark (for scrolling/focus) or null when the
 * span is empty or out of range. Existing highlights are cleared first.
 */
export function applyHighlight(
  root: HTMLElement,
  start: number,
  end: number,
  className = "passage-target",
): HTMLElement | null {
  clearHighlight(root);
  if (end <= start || start < 0) return null;
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
  );
  const pieces: { node: Text; from: number; to: number }[] = [];
  let offset = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n as Text;
    const len = text.data.length;
    const nodeStart = offset;
    const nodeEnd = offset + len;
    offset = nodeEnd;
    if (nodeEnd <= start || nodeStart >= end) continue;
    pieces.push({
      node: text,
      from: Math.max(0, start - nodeStart),
      to: Math.min(len, end - nodeStart),
    });
  }
  if (end > offset || pieces.length === 0) return null;
  let first: HTMLElement | null = null;
  for (const { node, from, to } of pieces) {
    let target = node;
    if (from > 0) target = target.splitText(from);
    if (to - from < target.data.length) target.splitText(to - from);
    const mark = root.ownerDocument.createElement("mark");
    mark.setAttribute(HIGHLIGHT_ATTR, "");
    mark.className = className;
    target.parentNode?.insertBefore(mark, target);
    mark.appendChild(target);
    first ??= mark;
  }
  return first;
}

/**
 * The reader URL for an anchor, relative to `base`: `?a=` carries the
 * verified anchor; with a `quote`, the fragment carries the standard
 * `:~:text=` directive as a best-effort hint for browsers (never read back —
 * browsers hide it from scripts, and it has no identity or revision).
 */
export function deepLinkFor(
  base: URL | string,
  anchor: SourceAnchor,
  quote?: string,
): string {
  const url = new URL(String(base));
  url.searchParams.set("a", encodeAnchor(anchor));
  url.hash = (quote === undefined ? null : textFragmentFor(quote)) ?? "";
  return url.toString();
}

/** Metadata the copied reference cites, kept deliberately small. */
export interface SourceReference {
  quote: string;
  block: MessageBlock;
  sessionId: string;
  /** Absolute deep link to the passage. */
  link: string;
}

/**
 * Plain-text "copy with source" payload: the quote, who said it and when
 * (honestly `time unknown`), the session, and the deep link. No Markdown or
 * HTML: it must paste cleanly into a terminal, an issue or a chat box.
 */
export function sourceReferenceText(ref: SourceReference): string {
  const when =
    ref.block.createdAt === null
      ? "time unknown"
      : new Date(ref.block.createdAt).toISOString();
  const quote = ref.quote.replace(/\s+/g, " ").trim();
  return [
    `"${quote}"`,
    `— ${originLabel(ref.block)}, ${when} · session ${ref.sessionId} (captured history)`,
    ref.link,
  ].join("\n");
}
