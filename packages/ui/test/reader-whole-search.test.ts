/**
 * Whole-session search (#1857): the server names matching messages; the
 * reader pages until one is loaded and only then highlights displayed text.
 * These are the pure parts — page walking, which hit to reach next, and the
 * words shown for every outcome.
 */
import { describe, expect, it } from "vitest";

import type { SessionSearchHit, SessionSearchPage } from "~/contracts";
import { messageBlockId } from "~/reader/blocks";
import {
  WHOLE_LOAD_PAGES,
  WHOLE_SEARCH_MAX_PAGES,
  compareHitsNewestFirst,
  nextOlderHit,
  olderServerHits,
  reachLabel,
  remainingOlderHits,
  searchWholeSession,
  wholeSearchSummary,
} from "~/reader/whole-search";

function hit(id: string, created_at: number): SessionSearchHit {
  return { message_id: id, created_at, role: "user", snippet: id, rank: -1 };
}

function page(
  hits: SessionSearchHit[],
  over: Partial<SessionSearchPage> = {},
): SessionSearchPage {
  return {
    hits,
    terms: ["needle"],
    mode: "phrase",
    total: hits.length,
    next_cursor: null,
    ...over,
  };
}

const loaded = (...ids: string[]) => {
  const set = new Set(ids.map(messageBlockId));
  return (blockId: string) => set.has(blockId);
};

describe("whole-session search: ordering", () => {
  it("orders newest first, breaking ties on id descending like the server keyset", () => {
    const hits = [hit("a", 1), hit("c", 2), hit("b", 2), hit("d", 3)];
    expect(
      [...hits].sort(compareHitsNewestFirst).map((h) => h.message_id),
    ).toEqual(["d", "c", "b", "a"]);
  });

  it("keeps only hits whose message is not loaded", () => {
    const hits = [hit("a", 1), hit("b", 2), hit("c", 3)];
    expect(
      olderServerHits(hits, loaded("b", "c")).map((h) => h.message_id),
    ).toEqual(["a"]);
    expect(olderServerHits(hits, loaded("a", "b", "c"))).toEqual([]);
  });
});

describe("whole-session search: page walk", () => {
  it("stops at the first page that names an unloaded message and reports what it examined", async () => {
    const calls: Array<string | null> = [];
    const result = await searchWholeSession(
      "needle",
      async (cursor) => {
        calls.push(cursor);
        if (cursor === null) {
          return page([hit("new-1", 10), hit("new-2", 11)], {
            total: 5,
            next_cursor: "c1",
          });
        }
        return page([hit("old-1", 1), hit("old-2", 2)], {
          total: 5,
          next_cursor: "c2",
        });
      },
      loaded("new-1", "new-2"),
    );
    expect(calls).toEqual([null, "c1"]);
    expect(result.total).toBe(5);
    expect(result.examined).toBe(4);
    expect(result.complete).toBe(false);
    expect(result.older.map((h) => h.message_id)).toEqual(["old-2", "old-1"]);
  });

  it("is complete when the server runs out of pages, even with no older hit", async () => {
    const result = await searchWholeSession(
      "needle",
      async () => page([hit("new-1", 10)], { total: 1 }),
      loaded("new-1"),
    );
    expect(result.complete).toBe(true);
    expect(result.older).toEqual([]);
    expect(remainingOlderHits(result, loaded("new-1"))).toBe(0);
  });

  it("stops after the page bound and says so through `complete: false`", async () => {
    let calls = 0;
    const result = await searchWholeSession(
      "needle",
      async () => {
        calls++;
        return page([hit(`new-${calls}`, calls)], {
          total: 1000,
          next_cursor: `c${calls}`,
        });
      },
      () => true,
    );
    expect(calls).toBe(WHOLE_SEARCH_MAX_PAGES);
    expect(result.complete).toBe(false);
    expect(result.examined).toBe(WHOLE_SEARCH_MAX_PAGES);
  });

  it("treats an empty page with a cursor as the end rather than looping", async () => {
    let calls = 0;
    const result = await searchWholeSession(
      "needle",
      async () => {
        calls++;
        return page([], { total: 0, next_cursor: "stale" });
      },
      () => true,
    );
    expect(calls).toBe(1);
    expect(result.complete).toBe(true);
  });

  it("propagates a failing page so the reader can say the search is unavailable", async () => {
    await expect(
      searchWholeSession(
        "needle",
        async () => {
          throw new Error("fts unavailable");
        },
        () => true,
      ),
    ).rejects.toThrow("fts unavailable");
  });
});

describe("whole-session search: next hit and words", () => {
  const result = {
    query: "needle",
    total: 4,
    mode: "phrase" as const,
    terms: ["needle"],
    older: [hit("old-2", 2), hit("old-1", 1)],
    examined: 4,
    complete: true,
  };

  it("picks the newest unloaded hit and moves on as pages arrive", () => {
    expect(nextOlderHit(result, loaded())?.message_id).toBe("old-2");
    expect(nextOlderHit(result, loaded("old-2"))?.message_id).toBe("old-1");
    expect(nextOlderHit(result, loaded("old-1", "old-2"))).toBeNull();
    expect(remainingOlderHits(result, loaded("old-2"))).toBe(1);
  });

  it("summarises the count, how it matched and what is still older", () => {
    expect(wholeSearchSummary(result, loaded())).toBe(
      "4 matching messages in the whole session · 2 in older history",
    );
    expect(wholeSearchSummary(result, loaded("old-1", "old-2"))).toBe(
      "4 matching messages in the whole session · nothing more in older history",
    );
    expect(
      wholeSearchSummary(
        { ...result, complete: false },
        loaded("old-1", "old-2"),
      ),
    ).toBe(
      "4 matching messages in the whole session · the newest 4 checked, none in older history yet",
    );
    expect(wholeSearchSummary({ ...result, complete: false }, loaded())).toBe(
      "4 matching messages in the whole session · 2 in older history so far",
    );
    expect(
      wholeSearchSummary({ ...result, total: 0, older: [] }, loaded()),
    ).toBe("No matches in the whole session");
    expect(
      wholeSearchSummary({ ...result, total: 1, mode: "terms" }, loaded()),
    ).toContain("(all words, any order)");
  });

  it("names every way reaching a hit can end", () => {
    expect(reachLabel({ kind: "loading", messageId: "x", pages: 2 })).toBe(
      `Loading older history to reach the match · page 2 of ${WHOLE_LOAD_PAGES}`,
    );
    expect(
      reachLabel({
        kind: "exhausted",
        messageId: "x",
        pages: WHOLE_LOAD_PAGES,
      }),
    ).toContain(`further back than ${WHOLE_LOAD_PAGES} pages`);
    expect(reachLabel({ kind: "unreachable", messageId: "x" })).toContain(
      "cannot reach",
    );
    expect(
      reachLabel({ kind: "inexact", messageId: "x", mode: "terms" }),
    ).toContain("words appear separately");
    expect(
      reachLabel({ kind: "inexact", messageId: "x", mode: "phrase" }),
    ).toContain("does not contain it literally");
  });
});
