import { describe, expect, it } from "vitest";

import type { TemporalMessage } from "~/contracts";
import {
  ANCHOR_MAPPING_VERSION,
  MAX_ANCHOR_OFFSET,
  TEXT_FRAGMENT_BUDGET,
  TEXT_FRAGMENT_MAX_WORD,
  anchorFor,
  blockAnchor,
  blockHash,
  decodeAnchor,
  encodeAnchor,
  resolutionLabel,
  resolveAnchor,
  textFragmentFor,
} from "~/reader/anchors";
import {
  CHUNK_SEPARATOR,
  distillationBlock,
  messageBlock,
} from "~/reader/blocks";
import { clearRenderCache, displayedText } from "~/reader/render";

function msg(over: Partial<TemporalMessage> = {}): TemporalMessage {
  return {
    id: "01J",
    source_id: null,
    project_id: "p",
    session_id: "s",
    role: "assistant",
    content: "Refactor the **parser** around stable block IDs.",
    tokens: 1,
    distilled: 0,
    created_at: 1_700_000_000_000,
    metadata: "{}",
    ...over,
  };
}

const block = messageBlock(msg());
const part = block.parts[0]!;

describe("encode/decode", () => {
  it("round-trips part and whole-block anchors", () => {
    const a = anchorFor(block, part, 13, 19);
    const wire = encodeAnchor(a);
    expect(wire).toBe(`${ANCHOR_MAPPING_VERSION}~m.01J~0~13~19~${part.hash}`);
    expect(decodeAnchor(wire)).toEqual({
      anchor: a,
      mapping: ANCHOR_MAPPING_VERSION,
    });

    const whole = blockAnchor(block);
    expect(decodeAnchor(encodeAnchor(whole))?.anchor).toEqual(whole);
    expect(whole.partIndex).toBeUndefined();
  });

  it("is URL-safe without percent-encoding for realistic ids", () => {
    const wire = encodeAnchor(anchorFor(block, part, 0, 3));
    expect(encodeURIComponent(wire)).toBe(wire);
    const url = new URL(`http://x/ui/s?a=${wire}`);
    expect(decodeAnchor(url.searchParams.get("a"))?.anchor.blockId).toBe(
      "m.01J",
    );
  });

  it("normalises a reversed selection", () => {
    expect(anchorFor(block, part, 19, 13)).toMatchObject({
      start: 13,
      end: 19,
    });
  });

  it("tolerates a tilde inside a server id", () => {
    const odd = messageBlock(msg({ id: "a~b~c" }));
    const wire = encodeAnchor(anchorFor(odd, odd.parts[0]!, 1, 2));
    expect(decodeAnchor(wire)?.anchor.blockId).toBe("m.a~b~c");
  });

  it("rejects malformed and hostile input", () => {
    const h = part.hash;
    const bad = [
      null,
      undefined,
      "",
      "1~m.01J~0~13",
      "1~m.01J~0~19~13~" + h, // start > end
      "1~m.01J~0~-1~3~" + h,
      "1~m.01J~0~1.5~3~" + h,
      "1~m.01J~0~1~3~", // no hash
      "1~m.01J~0~1~3~ZZZ", // hash alphabet
      "1~m.01J~0~1~3~<script>",
      "x~m.01J~0~1~3~" + h,
      "1~~0~1~3~" + h, // empty block id
      "1~m.a b~0~1~3~" + h, // whitespace in id
      "1~k.01J~0~1~3~" + h, // unknown block namespace
      `1~m.01J~0~0~${MAX_ANCHOR_OFFSET + 1}~${h}`,
      "1~m.01J~0~1~3~" + h + "~",
      "1".repeat(5000),
      "1~m.01J~0~99999999999~99999999999~" + h,
    ];
    for (const raw of bad) expect(decodeAnchor(raw), String(raw)).toBeNull();
  });
});

describe("textFragmentFor", () => {
  it("emits a whole-quote directive for short quotes, whitespace normalised", () => {
    expect(textFragmentFor("  keep\n\tSQLite  as the engine ")).toBe(
      ":~:text=keep%20SQLite%20as%20the%20engine",
    );
  });

  it("percent-encodes the directive's own delimiters and URL syntax", () => {
    const directive = textFragmentFor("a-b, c&d #e ~f")!;
    expect(directive).toBe(":~:text=a%2Db%2C%20c%26d%20%23e%20~f");
    // The only unescaped `-` / `,` are the directive's own, so a browser cannot
    // misread quote text as a prefix-, textEnd or -suffix term.
    const terms = directive.slice(":~:text=".length).split(",");
    expect(terms).toHaveLength(1);
    expect(terms[0]).not.toContain("-");
  });

  it("turns a long quote into a textStart,textEnd range of whole words", () => {
    const words = Array.from({ length: 80 }, (_, i) => `word${i}`);
    const directive = textFragmentFor(words.join(" "))!;
    const [start, end, ...rest] = directive
      .slice(":~:text=".length)
      .split(",")
      .map(decodeURIComponent);
    expect(rest).toEqual([]);
    expect(start!.length).toBeLessThanOrEqual(TEXT_FRAGMENT_BUDGET);
    expect(end!.length).toBeLessThanOrEqual(TEXT_FRAGMENT_BUDGET);
    expect(start!.startsWith("word0 word1 ")).toBe(true);
    expect(end!.endsWith(" word78 word79")).toBe(true);
    // Ends are whole words: the range is a prefix and a suffix of the quote.
    const quote = words.join(" ");
    expect(quote.startsWith(start!)).toBe(true);
    expect(quote.endsWith(end!)).toBe(true);
    expect(quote.charAt(start!.length)).toBe(" ");
    expect(quote.charAt(quote.length - end!.length - 1)).toBe(" ");
  });

  it("keeps a single oversized word whole rather than truncating it", () => {
    const long = "x".repeat(TEXT_FRAGMENT_BUDGET + 40);
    expect(textFragmentFor(`${long} tail`)).toBe(`:~:text=${long}%20tail`);
  });

  it("yields no directive for empty quotes or unmatchable boundary words", () => {
    expect(textFragmentFor("")).toBeNull();
    expect(textFragmentFor(" \n\t ")).toBeNull();
    const huge = "y".repeat(TEXT_FRAGMENT_MAX_WORD + 1);
    expect(textFragmentFor(`${huge} short`)).toBeNull();
    expect(textFragmentFor(`short ${huge}`)).toBeNull();
    expect(textFragmentFor("y".repeat(TEXT_FRAGMENT_MAX_WORD))).not.toBeNull();
  });
});

describe("resolveAnchor", () => {
  it("resolves against the displayed text and returns the quote", () => {
    clearRenderCache();
    const text = displayedText(block, part);
    expect(text).toBe("Refactor the parser around stable block IDs.");
    const start = text.indexOf("parser");
    const decoded = decodeAnchor(
      encodeAnchor(anchorFor(block, part, start, start + "parser".length)),
    )!;
    expect(resolveAnchor(decoded, block, text)).toEqual({
      status: "ok",
      part,
      quote: "parser",
    });
  });

  it("reports source changed on a hash mismatch — never re-anchors", () => {
    const decoded = decodeAnchor(encodeAnchor(anchorFor(block, part, 0, 8)))!;
    const edited = messageBlock(
      msg({ content: "Refactor the parser around stable block IDs!" }),
    );
    const res = resolveAnchor(
      decoded,
      edited,
      displayedText(edited, edited.parts[0]!),
    );
    expect(res).toEqual({ status: "changed", reason: "hash" });
    expect(resolutionLabel(res)).toMatch(/source changed/i);
  });

  it("reports changed when the mapping version differs", () => {
    const wire = encodeAnchor(anchorFor(block, part, 0, 8)).replace(
      /^1~/,
      "2~",
    );
    const decoded = decodeAnchor(wire)!;
    expect(resolveAnchor(decoded, block, displayedText(block, part))).toEqual({
      status: "changed",
      reason: "mapping",
    });
  });

  it("reports changed when the span runs past the displayed text", () => {
    const forged = { ...anchorFor(block, part, 0, 8), end: 10_000 };
    const decoded = decodeAnchor(encodeAnchor(forged))!;
    expect(resolveAnchor(decoded, block, displayedText(block, part))).toEqual({
      status: "changed",
      reason: "range",
    });
  });

  it("reports missing block / part honestly", () => {
    const decoded = decodeAnchor(encodeAnchor(anchorFor(block, part, 0, 8)))!;
    expect(resolveAnchor(decoded, undefined, null)).toEqual({
      status: "missing",
      reason: "block",
    });
    const shorter = messageBlock(msg({ content: "only one part" }));
    const twoPart = messageBlock(
      msg({ content: `one${CHUNK_SEPARATOR}[tool:read] two` }),
    );
    const intoSecond = decodeAnchor(
      encodeAnchor(anchorFor(twoPart, twoPart.parts[1]!, 0, 3)),
    )!;
    expect(resolveAnchor(intoSecond, shorter, null)).toEqual({
      status: "missing",
      reason: "part",
    });
    expect(resolutionLabel(resolveAnchor(intoSecond, shorter, null))).toMatch(
      /no longer part/,
    );
  });

  it("verifies the hash even when the caller has not rendered the part", () => {
    const decoded = decodeAnchor(encodeAnchor(anchorFor(block, part, 0, 8)))!;
    expect(resolveAnchor(decoded, block, null)).toEqual({
      status: "ok",
      part,
      quote: "",
    });
  });

  it("part anchors into a distillation block are missing, not ok", () => {
    const d = distillationBlock({
      id: "d1",
      session_id: "s",
      generation: 0,
      token_count: 5,
      r_compression: null,
      c_norm: null,
      archived: 0,
      created_at: 1,
      call_type: null,
    });
    const wire = `1~d.d1~0~0~2~${blockHash(d)}`;
    expect(resolveAnchor(decodeAnchor(wire)!, d, null)).toEqual({
      status: "missing",
      reason: "part",
    });
    const whole = decodeAnchor(encodeAnchor(blockAnchor(d)))!;
    expect(resolveAnchor(whole, d, null)).toEqual({
      status: "ok",
      part: null,
      quote: "",
    });
    expect(
      resolveAnchor(
        whole,
        distillationBlock({ ...d.summary, token_count: 6 }),
        null,
      ),
    ).toEqual({ status: "changed", reason: "hash" });
  });

  it("whole-block hash changes when any part changes", () => {
    const a = messageBlock(msg({ content: `one${CHUNK_SEPARATOR}two` }));
    const b = messageBlock(msg({ content: `one${CHUNK_SEPARATOR}two!` }));
    expect(blockHash(a)).not.toBe(blockHash(b));
    expect(blockHash(a)).toBe(
      blockHash(messageBlock(msg({ content: `one${CHUNK_SEPARATOR}two` }))),
    );
  });
});
