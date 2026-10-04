/**
 * Coverage declarations (UI-06c): what the view holds is stated from what
 * was reported, never inferred as complete. In-session search: scans the
 * logical rows (mounted or not), in slices, skipping compressed context.
 */
import { describe, expect, it } from "vitest";

import { generateBusySession } from "~/fixture/busy-session";
import { buildBlocks, messageBlock } from "~/reader/blocks";
import { CAPTURE_HELP, coverageDeclaration } from "~/reader/coverage";
import { displayedText } from "~/reader/render";
import { buildRows } from "~/reader/rows";
import {
  MIN_QUERY_LENGTH,
  SEARCH_SLICE_ROWS,
  escapeRegExp,
  findInBlock,
  findInText,
  queryMatcher,
  searchRows,
} from "~/reader/search";
import { READER_SPECIMEN } from "~/reader/specimen";

describe("coverage declaration", () => {
  const base = {
    loaded: 100,
    total: 100,
    hasOlder: false,
    cachedWindow: false,
  };

  it("is captured only when the total is known, every message is loaded and nothing is older", () => {
    const c = coverageDeclaration(base);
    expect(c).toMatchObject({
      kind: "captured",
      label: "Captured history",
      reason: null,
    });
    expect(c.detail).toBe("100 messages, complete as captured");
  });

  it("never reports complete when completeness is unknown", () => {
    expect(coverageDeclaration({ ...base, total: null })).toMatchObject({
      kind: "partial",
      reason: "unknown-total",
    });
    expect(coverageDeclaration({ ...base, hasOlder: null })).toMatchObject({
      kind: "partial",
      reason: "unknown-total",
    });
    expect(
      coverageDeclaration({ ...base, total: null, hasOlder: null }).detail,
    ).toBe("100 messages loaded; completeness unknown");
  });

  it("is partial while older pages exist, even if the count looks complete", () => {
    // Adversarial: a stale total that equals the loaded count must not win.
    const c = coverageDeclaration({ ...base, hasOlder: true });
    expect(c).toMatchObject({ kind: "partial", reason: "older" });
    expect(c.detail).toBe("100 of 100 captured messages loaded");
    expect(
      coverageDeclaration({ ...base, hasOlder: true, total: null }).detail,
    ).toBe("100 messages loaded; older history not loaded");
  });

  it("a cached window is partial regardless of what else is known", () => {
    expect(coverageDeclaration({ ...base, cachedWindow: true })).toMatchObject({
      kind: "partial",
      reason: "cached-window",
    });
    expect(
      coverageDeclaration({ ...base, cachedWindow: true, total: null }).detail,
    ).toBe("100 messages from the cached window; completeness unknown");
    expect(
      coverageDeclaration({
        loaded: 40,
        total: 312,
        hasOlder: false,
        cachedWindow: true,
      }).detail,
    ).toBe("40 of 312 captured messages, from the cached window");
  });

  it("a loaded count below the total is partial even when the server says nothing is older", () => {
    const c = coverageDeclaration({ ...base, loaded: 99 });
    expect(c).toMatchObject({ kind: "partial", reason: "count" });
    expect(c.detail).toBe("99 of 100 captured messages loaded");
  });

  it("handles zero and one message without claiming plurals or completeness it lacks", () => {
    expect(
      coverageDeclaration({
        loaded: 1,
        total: 1,
        hasOlder: false,
        cachedWindow: false,
      }).detail,
    ).toBe("1 message, complete as captured");
    expect(
      coverageDeclaration({
        loaded: 0,
        total: null,
        hasOlder: null,
        cachedWindow: false,
      }),
    ).toMatchObject({
      kind: "partial",
      detail: "0 messages loaded; completeness unknown",
    });
    expect(
      coverageDeclaration({
        loaded: 0,
        total: 0,
        hasOlder: false,
        cachedWindow: false,
      }),
    ).toMatchObject({
      kind: "captured",
      detail: "0 messages, complete as captured",
    });
  });

  it("carries no native-transcript field; the help tooltip explains capture", () => {
    for (const decl of [
      coverageDeclaration(base),
      coverageDeclaration({ ...base, total: null }),
    ]) {
      expect("native" in decl).toBe(false);
    }
    expect(CAPTURE_HELP).toContain("Lore-captured history");
  });
});

describe("in-session search: matcher", () => {
  it("requires a minimum query length after trimming", () => {
    expect(MIN_QUERY_LENGTH).toBe(2);
    expect(queryMatcher("")).toBeNull();
    expect(queryMatcher(" a ")).toBeNull();
    expect(queryMatcher("ab")).not.toBeNull();
  });

  it("matches literally and case-insensitively, never as a regular expression", () => {
    expect(escapeRegExp("a.b*(c)[d]{e}^$|?+\\")).toBe(
      "a\\.b\\*\\(c\\)\\[d\\]\\{e\\}\\^\\$\\|\\?\\+\\\\",
    );
    const m = queryMatcher(".*")!;
    expect(findInText("anything", m)).toEqual([]);
    expect(findInText("a .* literal", m)).toEqual([
      { start: 2, end: 4, exact: true },
    ]);
    expect(findInText("SQLite sqlite SqLiTe", queryMatcher("sqlite")!)).toEqual(
      [
        { start: 0, end: 6, exact: true },
        { start: 7, end: 13, exact: true },
        { start: 14, end: 20, exact: true },
      ],
    );
  });

  it("reports half-open displayed-text offsets and does not loop on overlapping text", () => {
    expect(findInText("aaaa", queryMatcher("aa")!)).toEqual([
      { start: 0, end: 2, exact: true },
      { start: 2, end: 4, exact: true },
    ]);
    // Astral characters count as two UTF-16 units, the same as anchors.
    expect(findInText("x😀needle", queryMatcher("needle")!)).toEqual([
      { start: 3, end: 9, exact: true },
    ]);
  });

  it("emits one approximate span for a typo when nothing matches literally (#1948)", () => {
    const text = "the knowledge table sorts by updated_at";
    const spans = findInText(text, queryMatcher("knwoledge")!, "knwoledge");
    expect(spans).toHaveLength(1);
    const [span] = spans;
    expect(span!.exact).toBe(false);
    expect(span!.start).toBeGreaterThanOrEqual(0);
    expect(span!.end).toBeLessThanOrEqual(text.length);
    expect(span!.end).toBeGreaterThan(span!.start);
    expect(text.slice(span!.start, span!.end)).toBe("knowledge");
  });

  it("fuzzy span offsets count original characters, so a leading diacritic does not shift them", () => {
    const text = "Résumé knowledge table sorting";
    const spans = findInText(text, queryMatcher("knwoledge")!, "knwoledge");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.exact).toBe(false);
    // Offset sits past the é — normalized-index drift would slice the wrong chars.
    expect(text.slice(spans[0]!.start, spans[0]!.end)).toBe("knowledge");
  });

  it("never adds a fuzzy span when exact spans exist", () => {
    const text = "knowledge and also knwoledge-adjacent prose";
    const spans = findInText(text, queryMatcher("knowledge")!, "knowledge");
    expect(spans).toHaveLength(1);
    expect(spans.every((s) => s.exact)).toBe(true);
  });

  it("unrelated queries get no fuzzy span", () => {
    expect(
      findInText("the knowledge table", queryMatcher("zzzqqq")!, "zzzqqq"),
    ).toEqual([]);
  });

  it("two-character queries stay regex-only — no fuzzy span below the minimum", () => {
    expect(findInText("a needle and hay", queryMatcher("nw")!, "nw")).toEqual(
      [],
    );
  });
});

describe("in-session search: rows", () => {
  const blocks = buildBlocks({
    messages: READER_SPECIMEN.messages,
    distillations: READER_SPECIMEN.distillations,
  });
  const rows = buildRows(blocks);

  it("finds hits in displayed text across parts, with the row index for scrolling", () => {
    const hits = searchRows(rows, queryMatcher("the")!);
    expect(hits.next).toBeNull();
    expect(hits.hits.length).toBeGreaterThan(3);
    for (const h of hits.hits) {
      const row = rows[h.rowIndex]!;
      expect(row.block?.id).toBe(h.blockId);
      expect(row.block?.kind).toBe("message");
      if (row.block?.kind !== "message") continue;
      const part = row.block.parts[h.partIndex]!;
      expect(
        displayedText(row.block, part).slice(h.start, h.end).toLowerCase(),
      ).toBe("the");
    }
    const parts = new Set(hits.hits.map((h) => `${h.blockId}#${h.partIndex}`));
    expect(parts.size).toBeGreaterThan(1);
  });

  it("searches displayed text, not raw Markdown or the tool envelope", () => {
    const withCode = READER_SPECIMEN.messages.find((m) =>
      m.content.includes("```"),
    )!;
    const block = messageBlock(withCode);
    expect(findInBlock(block, queryMatcher("```")!, 0)).toEqual([]);
    const tool = READER_SPECIMEN.messages.find((m) =>
      m.content.includes("[tool:"),
    )!;
    expect(findInBlock(messageBlock(tool), queryMatcher("[tool:")!, 0)).toEqual(
      [],
    );
  });

  it("skips distillation rows: compressed context is not session speech", () => {
    const distilled = rows.filter((r) => r.block?.kind === "distillation");
    expect(distilled.length).toBeGreaterThan(0);
    const hits = searchRows(rows, queryMatcher("compressed")!);
    expect(
      hits.hits.every((h) => rows[h.rowIndex]!.block?.kind === "message"),
    ).toBe(true);
  });

  it("a typo query finds fuzzy hits on message rows only, flagged non-exact (#1948)", () => {
    const hits = searchRows(
      rows,
      queryMatcher("portabiliy")!,
      0,
      rows.length,
      "portabiliy",
    );
    expect(hits.next).toBeNull();
    expect(hits.hits.length).toBeGreaterThan(0);
    let onWord = 0;
    for (const h of hits.hits) {
      expect(h.exact).toBe(false);
      const row = rows[h.rowIndex]!;
      expect(row.block.kind).toBe("message");
      if (row.block.kind !== "message") continue;
      const text = displayedText(row.block, row.block.parts[h.partIndex]!);
      // Every span must be non-empty and inside its displayed text…
      expect(h.end).toBeGreaterThan(h.start);
      expect(h.end).toBeLessThanOrEqual(text.length);
      // …and at least one must land on the real word the query was a typo of.
      const word = text.search(/portabili\w*/i);
      if (word >= 0 && h.start < word + 12 && h.end > word) onWord++;
    }
    expect(onWord).toBeGreaterThan(0);
  });

  it("walks the logical rows in bounded slices and covers every row exactly once", () => {
    const busy = generateBusySession({ blocks: 1_500, seed: 9 });
    const busyRows = buildRows(
      buildBlocks({
        messages: busy.messages,
        distillations: busy.distillations,
      }),
    );
    const matcher = queryMatcher("portability")!;
    const whole = searchRows(
      busyRows,
      matcher,
      0,
      busyRows.length,
      "portability",
    );
    expect(whole.next).toBeNull();
    expect(whole.hits.length).toBeGreaterThan(100);

    const sliced = [];
    let from: number | null = 0;
    let slices = 0;
    while (from !== null) {
      const slice = searchRows(
        busyRows,
        matcher,
        from,
        SEARCH_SLICE_ROWS,
        "portability",
      );
      sliced.push(...slice.hits);
      from = slice.next;
      slices++;
    }
    expect(slices).toBe(Math.ceil(busyRows.length / SEARCH_SLICE_ROWS));
    expect(sliced).toEqual(whole.hits);
    // The last row is scanned when the total is not a multiple of the slice.
    const lastRow = busyRows.length - 1;
    const lastBlock = busyRows[lastRow]!.block;
    if (lastBlock?.kind === "message") {
      const direct = findInBlock(lastBlock, matcher, lastRow);
      expect(sliced.filter((h) => h.rowIndex === lastRow)).toEqual(direct);
    }
  });

  it("a huge single block with hundreds of thousands of hits is searched without blowing the stack", () => {
    const huge = messageBlock({
      ...READER_SPECIMEN.messages[0]!,
      id: "huge",
      content: "ab ".repeat(300_000),
    });
    const hugeRows = [...rows, { key: huge.id, block: huge }];
    const hits = searchRows(hugeRows, queryMatcher("ab")!);
    expect(hits.next).toBeNull();
    expect(hits.hits.filter((h) => h.blockId === "m.huge")).toHaveLength(
      300_000,
    );
  });

  it("a slice starting past the end scans nothing and terminates", () => {
    expect(searchRows(rows, queryMatcher("the")!, rows.length)).toEqual({
      hits: [],
      next: null,
    });
    expect(searchRows([], queryMatcher("the")!)).toEqual({
      hits: [],
      next: null,
    });
  });
});
