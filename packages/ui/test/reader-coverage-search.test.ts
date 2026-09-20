/**
 * Coverage declarations (UI-06c): what the view holds is stated from what
 * was reported, never inferred as complete. In-session search: scans the
 * logical rows (mounted or not), in slices, skipping compressed context.
 */
import { describe, expect, it } from "vitest";

import { generateBusySession } from "~/fixture/busy-session";
import { buildBlocks, messageBlock } from "~/reader/blocks";
import {
  NATIVE_TRANSCRIPT_LABEL,
  coverageDeclaration,
} from "~/reader/coverage";
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
      native: "unavailable",
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

  it("always states that the native transcript is unavailable", () => {
    expect(NATIVE_TRANSCRIPT_LABEL).toBe("Native transcript not yet available");
    for (const total of [null, 5, 100]) {
      expect(coverageDeclaration({ ...base, total }).native).toBe(
        "unavailable",
      );
    }
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
    expect(findInText("a .* literal", m)).toEqual([{ start: 2, end: 4 }]);
    expect(findInText("SQLite sqlite SqLiTe", queryMatcher("sqlite")!)).toEqual(
      [
        { start: 0, end: 6 },
        { start: 7, end: 13 },
        { start: 14, end: 20 },
      ],
    );
  });

  it("reports half-open displayed-text offsets and does not loop on overlapping text", () => {
    expect(findInText("aaaa", queryMatcher("aa")!)).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
    // Astral characters count as two UTF-16 units, the same as anchors.
    expect(findInText("x😀needle", queryMatcher("needle")!)).toEqual([
      { start: 3, end: 9 },
    ]);
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
      expect(row.block.id).toBe(h.blockId);
      expect(row.block.kind).toBe("message");
      if (row.block.kind !== "message") continue;
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
    const distilled = rows.filter((r) => r.block.kind === "distillation");
    expect(distilled.length).toBeGreaterThan(0);
    const hits = searchRows(rows, queryMatcher("compressed")!);
    expect(
      hits.hits.every((h) => rows[h.rowIndex]!.block.kind === "message"),
    ).toBe(true);
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
    const whole = searchRows(busyRows, matcher, 0, busyRows.length);
    expect(whole.next).toBeNull();
    expect(whole.hits.length).toBeGreaterThan(100);

    const sliced = [];
    let from: number | null = 0;
    let slices = 0;
    while (from !== null) {
      const slice = searchRows(busyRows, matcher, from);
      sliced.push(...slice.hits);
      from = slice.next;
      slices++;
    }
    expect(slices).toBe(Math.ceil(busyRows.length / SEARCH_SLICE_ROWS));
    expect(sliced).toEqual(whole.hits);
    // The last row is scanned when the total is not a multiple of the slice.
    const lastRow = busyRows.length - 1;
    const lastBlock = busyRows[lastRow]!.block;
    if (lastBlock.kind === "message") {
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
