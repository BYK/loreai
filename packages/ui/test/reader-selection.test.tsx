/**
 * Row order, DOM selection → logical anchor, anchor → DOM highlight, and the
 * copied source reference.
 */
import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";

import { RichText } from "~/components/reader/SessionBlock";
import type { DistillationSummary, TemporalMessage } from "~/contracts";
import { decodeAnchor, resolveAnchor } from "~/reader/anchors";
import {
  CHUNK_SEPARATOR,
  buildBlocks,
  messageBlock,
  type MessageBlock,
} from "~/reader/blocks";
import { displayedText, renderPart } from "~/reader/render";
import { buildRows, indexRows } from "~/reader/rows";
import {
  HIGHLIGHT_ATTR,
  anchorForReading,
  applyHighlight,
  clearHighlight,
  deepLinkFor,
  readSelection,
  sourceReferenceText,
  textOffset,
} from "~/reader/selection";

function msg(over: Partial<TemporalMessage> = {}): TemporalMessage {
  return {
    id: "m-1",
    source_id: null,
    project_id: "p",
    session_id: "s",
    role: "assistant",
    content: "Keep **SQLite** for portability.",
    tokens: 3,
    distilled: 0,
    created_at: 1_700_000_000_000,
    metadata: "{}",
    ...over,
  };
}

function distillation(
  over: Partial<DistillationSummary> = {},
): DistillationSummary {
  return {
    id: "d-1",
    session_id: "s",
    generation: 0,
    token_count: 10,
    r_compression: 2,
    c_norm: 0.5,
    archived: 0,
    created_at: 1_700_000_005_000,
    call_type: null,
    ...over,
  };
}

/** Mount a block's first part and return its container + displayed text. */
function mountPart(block: MessageBlock, index = 0) {
  const part = block.parts[index]!;
  const { container } = render(() => (
    <div data-testid="reader">
      <RichText
        rendered={renderPart(block, part)}
        block={block.id}
        part={part.index}
      />
    </div>
  ));
  const root = container.querySelector<HTMLElement>("[data-testid=reader]")!;
  const el = root.querySelector<HTMLElement>(".rich-text")!;
  return { root, el, text: displayedText(block, part), part };
}

/** Select displayed-text offsets [from, to) inside `el` via a real Range. */
function selectText(el: HTMLElement, from: number, to: number): Selection {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let start: [Text, number] | null = null;
  let end: [Text, number] | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n as Text;
    const len = text.data.length;
    if (!start && from <= offset + len) start = [text, from - offset];
    if (to <= offset + len) {
      end = [text, to - offset];
      break;
    }
    offset += len;
  }
  const range = document.createRange();
  range.setStart(...start!);
  range.setEnd(...end!);
  const sel = document.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  return sel;
}

describe("buildRows", () => {
  it("keeps message order and places a distillation after the last message it could summarise", () => {
    const t = 1_700_000_000_000;
    const blocks = buildBlocks({
      messages: [
        msg({ id: "a", created_at: t }),
        msg({ id: "b", created_at: t + 10 }),
        msg({ id: "c", created_at: t + 20 }),
      ],
      distillations: [
        distillation({ id: "late", created_at: t + 15 }),
        distillation({ id: "early", created_at: t - 5 }),
        distillation({ id: "unknown", created_at: 0 }),
        distillation({ id: "after", created_at: t + 99 }),
      ],
    });
    expect(buildRows(blocks).map((r) => r.key)).toEqual([
      "d.unknown",
      "d.early",
      "m.a",
      "m.b",
      "d.late",
      "m.c",
      "d.after",
    ]);
  });

  it("does not reorder messages whose timestamps are unknown", () => {
    const blocks = buildBlocks({
      messages: [
        msg({ id: "a", created_at: 0 }),
        msg({ id: "b", created_at: 5 }),
        msg({ id: "c", created_at: 0 }),
      ],
      distillations: [distillation({ id: "d", created_at: 3 })],
    });
    expect(buildRows(blocks).map((r) => r.key)).toEqual([
      "m.a",
      "d.d",
      "m.b",
      "m.c",
    ]);
  });

  it("indexes every row by its key", () => {
    const rows = buildRows(
      buildBlocks({
        messages: [
          msg({ id: "a", created_at: 5 }),
          msg({ id: "b", created_at: 9 }),
        ],
        distillations: [distillation({ id: "d", created_at: 7 })],
      }),
    );
    const index = indexRows(rows);
    expect([...index.entries()]).toEqual([
      ["m.a", 0],
      ["d.d", 1],
      ["m.b", 2],
    ]);
    expect(index.get("m.zzz")).toBeUndefined();
    expect(indexRows([]).size).toBe(0);
  });
});

describe("readSelection", () => {
  it("maps a selection inside one part to displayed-text offsets", () => {
    const block = messageBlock(msg());
    const { root, el, text } = mountPart(block);
    const from = text.indexOf("SQLite");
    const sel = selectText(el, from, from + 6);
    const reading = readSelection(root, sel);
    expect(reading).toEqual({
      kind: "part",
      blockId: "m.m-1",
      partIndex: 0,
      start: from,
      end: from + 6,
      quote: "SQLite",
    });
    const anchor = anchorForReading(reading, block);
    expect(anchor).toMatchObject({
      blockId: "m.m-1",
      partIndex: 0,
      start: from,
      end: from + 6,
      contentHash: block.parts[0]!.hash,
    });
    // Round trip through the URL form resolves to the same quote.
    const decoded = decodeAnchor(
      new URL(deepLinkFor("http://x/ui/p", anchor!)).searchParams.get("a"),
    );
    expect(decoded).not.toBeNull();
    expect(resolveAnchor(decoded!, block, text)).toMatchObject({
      status: "ok",
      quote: "SQLite",
    });
  });

  it("offsets are counted in displayed text, across inline element boundaries", () => {
    const block = messageBlock(msg({ content: "a **b** c `d` e" }));
    const { el, text } = mountPart(block);
    expect(text).toBe("a b c d e");
    const last = el.lastChild!;
    const inner = (n: Node): Node => (n.firstChild ? inner(n.firstChild) : n);
    // The final text node " e" ends at the displayed-text length.
    const tail = (() => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n: Node | null = null;
      for (let x = walker.nextNode(); x; x = walker.nextNode()) n = x;
      return n as Text;
    })();
    expect(textOffset(el, tail, tail.data.length)).toBe(text.length);
    void last;
    void inner;
  });

  it("reports a selection spanning two parts as ambiguous, not as a guess", () => {
    const block = messageBlock(
      msg({ content: ["first part", "second part"].join(CHUNK_SEPARATOR) }),
    );
    const { container } = render(() => (
      <div data-testid="reader">
        <RichText
          rendered={renderPart(block, block.parts[0]!)}
          block={block.id}
          part={0}
        />
        <RichText
          rendered={renderPart(block, block.parts[1]!)}
          block={block.id}
          part={1}
        />
      </div>
    ));
    const root = container.querySelector<HTMLElement>("[data-testid=reader]")!;
    const [a, b] = Array.from(root.querySelectorAll(".rich-text"));
    const range = document.createRange();
    range.setStart(a!.firstChild!.firstChild ?? a!.firstChild!, 2);
    range.setEnd(b!.firstChild!.firstChild ?? b!.firstChild!, 3);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    expect(readSelection(root, sel)).toEqual({
      kind: "ambiguous",
      reason: "parts",
    });
  });

  it("ignores selections outside the reader and collapsed selections", () => {
    const block = messageBlock(msg());
    const { root } = mountPart(block);
    const outside = document.createElement("p");
    outside.textContent = "elsewhere";
    document.body.appendChild(outside);
    const range = document.createRange();
    range.selectNodeContents(outside);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    expect(readSelection(root, sel)).toEqual({ kind: "none" });
    sel.removeAllRanges();
    expect(readSelection(root, sel)).toEqual({ kind: "none" });
    expect(readSelection(root, null)).toEqual({ kind: "none" });
    outside.remove();
  });
});

describe("applyHighlight", () => {
  it("wraps the span in <mark> without changing the displayed text, and clears cleanly", () => {
    const block = messageBlock(msg());
    const { el, text } = mountPart(block);
    const from = text.indexOf("SQLite for");
    const mark = applyHighlight(el, from, from + 10);
    expect(mark).not.toBeNull();
    const marks = el.querySelectorAll(`[${HIGHLIGHT_ATTR}]`);
    // "SQLite" lives in <strong>, " for" outside it: one mark per text node.
    expect(marks.length).toBe(2);
    expect(Array.from(marks, (m) => m.textContent).join("")).toBe("SQLite for");
    expect(el.textContent).toBe(text);
    expect(el.querySelector("strong")).not.toBeNull();
    // No markup was parsed from a string: marks contain only text nodes.
    for (const m of marks) expect(m.children.length).toBe(0);

    clearHighlight(el);
    expect(el.querySelectorAll(`[${HIGHLIGHT_ATTR}]`).length).toBe(0);
    expect(el.textContent).toBe(text);
  });

  it("refuses spans that fall outside the displayed text", () => {
    const block = messageBlock(msg());
    const { el, text } = mountPart(block);
    expect(applyHighlight(el, 0, text.length + 1)).toBeNull();
    expect(applyHighlight(el, 5, 5)).toBeNull();
    expect(applyHighlight(el, -1, 3)).toBeNull();
    expect(el.querySelectorAll(`[${HIGHLIGHT_ATTR}]`).length).toBe(0);
  });
});

describe("copy with source", () => {
  it("builds a plain-text reference with quote, origin, time, session and link", () => {
    const block = messageBlock(msg({ metadata: '{"modelID":"claude-x"}' }));
    const anchor = anchorForReading(
      {
        kind: "part",
        blockId: block.id,
        partIndex: 0,
        start: 5,
        end: 11,
        quote: "SQLite",
      },
      block,
    )!;
    const link = deepLinkFor(
      "http://gw.local/ui/projects/p/sessions/s?x=1#h",
      anchor,
    );
    const url = new URL(link);
    expect(url.hash).toBe("");
    expect(url.searchParams.get("x")).toBe("1");
    expect(decodeAnchor(url.searchParams.get("a"))).toMatchObject({
      anchor: { blockId: block.id, start: 5, end: 11 },
    });

    // With the quote, the link also carries the standard text fragment; the
    // stale `#h` is replaced, `?a=` is untouched and the URL setter does not
    // re-encode the directive's percent-escapes.
    const withQuote = new URL(
      deepLinkFor(
        "http://gw.local/ui/projects/p/sessions/s?x=1#h",
        anchor,
        "keep SQLite, as-is",
      ),
    );
    expect(withQuote.hash).toBe("#:~:text=keep%20SQLite%2C%20as%2Dis");
    expect(withQuote.searchParams.get("a")).toBe(url.searchParams.get("a"));
    // An empty quote yields no directive at all rather than `#:~:text=`.
    expect(new URL(deepLinkFor("http://x/ui/p", anchor, "  ")).hash).toBe("");

    const text = sourceReferenceText({
      quote: "SQLite",
      block,
      sessionId: "s",
      link,
    });
    expect(text).toContain('"SQLite"');
    expect(text).toContain("Agent");
    expect(text).toContain(new Date(1_700_000_000_000).toISOString());
    expect(text).toContain("session s");
    expect(text.trim().endsWith(link)).toBe(true);
  });

  it("says 'time unknown' rather than inventing a timestamp", () => {
    const block = messageBlock(msg({ created_at: 0 }));
    const text = sourceReferenceText({
      quote: "q",
      block,
      sessionId: "s",
      link: "http://x/",
    });
    expect(text).toContain("time unknown");
    expect(text).not.toMatch(/1970/);
  });
});
