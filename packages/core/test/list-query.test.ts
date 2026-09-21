import { describe, expect, test } from "vitest";
import { uuidv7 } from "uuidv7";
import { db } from "../src/db";
import * as ltm from "../src/ltm";
import * as temporal from "../src/temporal";
import { listSessions } from "../src/data";
import {
  KNOWLEDGE_SORTS,
  knowledgeSortKey,
  knowledgeVersionHistory,
  listKnowledgePage,
  listSessionsPage,
  searchSessionMessagesPage,
  sessionSearchTerms,
  type KnowledgeKeyset,
  type KnowledgeSort,
} from "../src/list-query";
import type { KnowledgeEntry, KnowledgeVersion } from "../src/ltm";
import type { LoreMessage, LorePart } from "../src/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let seq = 0;
function freshProject(tag: string): string {
  return `/test/list-query/${tag}/${++seq}`;
}

/** Pin the base row's timestamps so ordering does not depend on wall-clock
 *  resolution. `updated_at` / `created_at` on the version row are the sort
 *  columns; confidence lives on knowledge_meta. */
function pin(
  id: string,
  ts: { created?: number; updated?: number; confidence?: number },
) {
  if (ts.created !== undefined)
    db()
      .query("UPDATE knowledge SET created_at = ? WHERE id = ?")
      .run(ts.created, id);
  if (ts.updated !== undefined)
    db()
      .query("UPDATE knowledge SET updated_at = ? WHERE id = ?")
      .run(ts.updated, id);
  if (ts.confidence !== undefined)
    db()
      .query(
        "UPDATE knowledge_meta SET confidence = ?, base_confidence = ? WHERE logical_id = ?",
      )
      .run(ts.confidence, ts.confidence, ltm.logicalIdOf(id));
}

/** Insert in deliberately scrambled order (REVIEW.md adversarial-order): the
 *  dataset has equal sort keys on every column so a naive single-key ORDER BY
 *  would page nondeterministically. */
function seedKnowledge(projectPath: string): string[] {
  const rows = [
    { title: "Delta", created: 1000, updated: 5000, confidence: 0.9 },
    { title: "Alpha", created: 3000, updated: 5000, confidence: 0.9 },
    { title: "Echo", created: 3000, updated: 7000, confidence: 0.5 },
    { title: "Bravo", created: 1000, updated: 7000, confidence: 0.5 },
    { title: "Charlie", created: 2000, updated: 6000, confidence: 0.9 },
    { title: "Alpha", created: 2000, updated: 6000, confidence: 0.5 }, // duplicate title
    { title: "Foxtrot", created: 4000, updated: 5000, confidence: 0.7 },
  ];
  const ids: string[] = [];
  for (const r of rows) {
    const id = ltm.create({
      id: uuidv7(),
      projectPath,
      scope: "project",
      category: "decision",
      title: r.title,
      content: `content for ${r.title}`,
      confidence: r.confidence,
    });
    pin(id, r);
    ids.push(id);
  }
  return ids;
}

/** Reference ordering computed in JS: (key, id) with the sort's direction. */
function expectedOrder(
  entries: KnowledgeEntry[],
  sort: KnowledgeSort,
): string[] {
  const dir = sort === "title_asc" ? 1 : -1;
  return [...entries]
    .sort((a, b) => {
      const ka = knowledgeSortKey(a, sort);
      const kb = knowledgeSortKey(b, sort);
      if (ka < kb) return -1 * dir;
      if (ka > kb) return 1 * dir;
      if (a.id < b.id) return -1 * dir;
      if (a.id > b.id) return 1 * dir;
      return 0;
    })
    .map((e) => e.id);
}

function pageAll(
  projectPath: string,
  sort: KnowledgeSort,
  limit: number,
  between?: (pageNo: number) => void,
): string[] {
  const out: string[] = [];
  let after: KnowledgeKeyset | undefined;
  let pages = 0;
  for (;;) {
    const page = listKnowledgePage(projectPath, { sort, limit, after });
    expect(page.items.length).toBeLessThanOrEqual(limit);
    out.push(...page.items.map((e) => e.id));
    pages++;
    if (!page.next) break;
    after = page.next;
    between?.(pages);
    expect(pages).toBeLessThan(100);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Knowledge: sort + keyset
// ---------------------------------------------------------------------------

describe("listKnowledgePage — deterministic keyset pagination", () => {
  test.each([...KNOWLEDGE_SORTS])(
    "sort=%s pages across ≥3 pages with equal sort keys and no gaps/dupes",
    (sort) => {
      const project = freshProject("sort");
      seedKnowledge(project);
      const all = listKnowledgePage(project, { sort, limit: 100 }).items;
      expect(all).toHaveLength(7);
      const expected = expectedOrder(all, sort);
      expect(all.map((e) => e.id)).toEqual(expected);

      // limit=2 over 7 rows → 4 pages, boundaries land inside equal-key runs.
      const paged = pageAll(project, sort, 2);
      expect(paged).toEqual(expected);
      expect(new Set(paged).size).toBe(7);
    },
  );

  test("default sort is updated_desc", () => {
    const project = freshProject("default-sort");
    seedKnowledge(project);
    const a = listKnowledgePage(project, { limit: 10 }).items.map((e) => e.id);
    const b = listKnowledgePage(project, {
      sort: "updated_desc",
      limit: 10,
    }).items.map((e) => e.id);
    expect(a).toEqual(b);
  });

  test("next is null on the final page and absent when the set fits one page", () => {
    const project = freshProject("last-page");
    seedKnowledge(project);
    const one = listKnowledgePage(project, { limit: 7 });
    expect(one.items).toHaveLength(7);
    expect(one.next).toBeNull();
    const first = listKnowledgePage(project, { limit: 3 });
    expect(first.next).not.toBeNull();
  });

  test("a row inserted between pages that sorts BEFORE the cursor is not surfaced; one AFTER is", () => {
    const project = freshProject("mutate-insert");
    seedKnowledge(project);
    const sort = "updated_desc";
    const p1 = listKnowledgePage(project, { sort, limit: 3 });
    expect(p1.next).not.toBeNull();
    // Newest row (updated_at way in the future) lands before the cursor.
    const newer = ltm.create({
      id: uuidv7(),
      projectPath: project,
      scope: "project",
      category: "decision",
      title: "Zulu newer",
      content: "inserted mid-pagination",
    });
    pin(newer, { updated: 99_000 });
    // Oldest row lands after the cursor and must appear in a later page.
    const older = ltm.create({
      id: uuidv7(),
      projectPath: project,
      scope: "project",
      category: "decision",
      title: "Yankee older",
      content: "inserted mid-pagination",
    });
    pin(older, { updated: 1 });
    const rest: string[] = [];
    let after = p1.next ?? undefined;
    while (after) {
      const p = listKnowledgePage(project, { sort, limit: 3, after });
      rest.push(...p.items.map((e) => e.id));
      after = p.next ?? undefined;
    }
    const seen = [...p1.items.map((e) => e.id), ...rest];
    expect(seen).not.toContain(newer);
    expect(seen).toContain(older);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(8);
  });

  test("a row deleted between pages disappears without shifting the others (no offset drift)", () => {
    const project = freshProject("mutate-delete");
    const ids = seedKnowledge(project);
    const sort = "title_asc";
    const p1 = listKnowledgePage(project, { sort, limit: 2 });
    const remaining = new Set(ids);
    // Delete one row from page 1 (already served) and one row not yet served.
    ltm.remove(p1.items[0].id);
    remaining.delete(p1.items[0].id);
    const unserved = ids.find((id) => !p1.items.some((e) => e.id === id))!;
    ltm.remove(unserved);
    remaining.delete(unserved);
    const rest: string[] = [];
    let after = p1.next ?? undefined;
    while (after) {
      const p = listKnowledgePage(project, { sort, limit: 2, after });
      rest.push(...p.items.map((e) => e.id));
      after = p.next ?? undefined;
    }
    const all = [...p1.items.map((e) => e.id), ...rest];
    expect(new Set(all).size).toBe(all.length);
    expect(rest).not.toContain(unserved);
    // Everything still live and not on page 1 shows up exactly once.
    for (const id of remaining) {
      if (!p1.items.some((e) => e.id === id)) expect(rest).toContain(id);
    }
  });

  test("an update between pages moves the row to its new sort position (may be re-served)", () => {
    const project = freshProject("mutate-update");
    seedKnowledge(project);
    const sort = "updated_desc";
    const p1 = listKnowledgePage(project, { sort, limit: 2 });
    const victim = p1.items[1];
    // Bump updated_at far into the past: the (now superseded) entry's new
    // version sorts after the cursor and is served again under its new id.
    const newId = ltm.appendVersion(victim.logical_id, { title: "moved" })!;
    pin(newId, { updated: 1 });
    const p2 = listKnowledgePage(project, {
      sort,
      limit: 100,
      after: p1.next!,
    });
    const ids = p2.items.map((e) => e.id);
    expect(ids).not.toContain(victim.id);
    expect(ids[ids.length - 1]).toBe(newId);
  });

  test("respects the legacy confidence > 0.2 gate", () => {
    const project = freshProject("confidence-gate");
    const id = ltm.create({
      id: uuidv7(),
      projectPath: project,
      scope: "project",
      category: "gotcha",
      title: "hidden",
      content: "low confidence",
      confidence: 0.1,
    });
    pin(id, { confidence: 0.1 });
    expect(listKnowledgePage(project, { limit: 10 }).items).toHaveLength(0);
    expect(ltm.forProject(project, false)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Knowledge: filters
// ---------------------------------------------------------------------------

describe("listKnowledgePage — filters", () => {
  function seedFilters(project: string) {
    const other = `${project}-other`;
    const own = ltm.create({
      id: uuidv7(),
      projectPath: project,
      scope: "project",
      category: "decision",
      title: "Use PostgreSQL for billing",
      content: "billing database choice",
    });
    const gotcha = ltm.create({
      id: uuidv7(),
      projectPath: project,
      scope: "project",
      category: "gotcha",
      title: "SQLite WAL needs checkpoint",
      content: "wal checkpoints for postgresql migration parity",
    });
    const global = ltm.create({
      id: uuidv7(),
      scope: "global",
      category: "preference",
      title: "Prefer tabs",
      content: "global preference",
    });
    const cross = ltm.create({
      id: uuidv7(),
      projectPath: other,
      scope: "project",
      crossProject: true,
      category: "pattern",
      title: "Shared retry pattern",
      content: "cross project pattern",
    });
    const foreign = ltm.create({
      id: uuidv7(),
      projectPath: other,
      scope: "project",
      category: "decision",
      title: "Foreign decision",
      content: "belongs to another project",
    });
    return { own, gotcha, global, cross, foreign };
  }

  test("category narrows to exactly that category", () => {
    const project = freshProject("category");
    const s = seedFilters(project);
    const ids = listKnowledgePage(project, {
      category: "gotcha",
      limit: 10,
    }).items.map((e) => e.id);
    expect(ids).toEqual([s.gotcha]);
    expect(
      listKnowledgePage(project, { category: "architecture", limit: 10 }).items,
    ).toHaveLength(0);
  });

  test("scope=project (default) excludes global/cross/foreign; global and all widen", () => {
    const project = freshProject("scope");
    const s = seedFilters(project);
    const project_ = new Set(
      listKnowledgePage(project, { limit: 10 }).items.map((e) => e.id),
    );
    expect(project_).toEqual(new Set([s.own, s.gotcha]));

    const global = listKnowledgePage(project, {
      scope: "global",
      limit: 100,
    }).items.map((e) => e.id);
    expect(global).toContain(s.global);
    expect(global).not.toContain(s.own);
    expect(global).not.toContain(s.cross);

    const all = new Set(
      listKnowledgePage(project, { scope: "all", limit: 1000 }).items.map(
        (e) => e.id,
      ),
    );
    expect(all.has(s.own)).toBe(true);
    expect(all.has(s.gotcha)).toBe(true);
    expect(all.has(s.global)).toBe(true);
    expect(all.has(s.cross)).toBe(true);
    expect(all.has(s.foreign)).toBe(false);
  });

  test("q matches title and content via FTS (prefix, AND) and never leaks other projects", () => {
    const project = freshProject("q");
    const s = seedFilters(project);
    const byTitle = listKnowledgePage(project, {
      q: "billing",
      limit: 10,
    }).items.map((e) => e.id);
    expect(byTitle).toEqual([s.own]);
    // Term appears in both entries' title/content → both, AND across terms narrows.
    const both = new Set(
      listKnowledgePage(project, { q: "postgresql", limit: 10 }).items.map(
        (e) => e.id,
      ),
    );
    expect(both).toEqual(new Set([s.own, s.gotcha]));
    const narrowed = listKnowledgePage(project, {
      q: "postgresql checkpoint",
      limit: 10,
    }).items.map((e) => e.id);
    expect(narrowed).toEqual([s.gotcha]);
    // Foreign project content is invisible even when it matches.
    expect(
      listKnowledgePage(project, { q: "foreign", limit: 10 }).items,
    ).toHaveLength(0);
    // Blank / whitespace q is a no-op filter.
    expect(
      listKnowledgePage(project, { q: "  ", limit: 10 }).items,
    ).toHaveLength(2);
  });

  test("q with only short tokens matches nothing, like ltm.search()'s LIKE fallback", () => {
    const project = freshProject("q-like");
    ltm.create({
      id: uuidv7(),
      projectPath: project,
      scope: "project",
      category: "decision",
      title: "X",
      content: "single-letter title",
    });
    ltm.create({
      id: uuidv7(),
      projectPath: project,
      scope: "project",
      category: "decision",
      title: "Y",
      content: "other",
    });
    // "x" / "is a" have no FTS-indexable and no LIKE-able (>2 chars) term:
    // searchLike() returns [] for these, so the list filter must too rather
    // than broad-matching the raw string.
    for (const q of ["x", "is a", "to"]) {
      expect(listKnowledgePage(project, { q, limit: 10 }).items).toEqual([]);
      expect(ltm.search({ query: q, projectPath: project, limit: 10 })).toEqual(
        [],
      );
    }
    // A 3+ char token that FTS can't index still hits the LIKE path.
    expect(
      listKnowledgePage(project, { q: "single-letter", limit: 10 }).items.map(
        (e) => e.title,
      ),
    ).toEqual(["X"]);
  });

  test("q + sort + keyset compose: filtered set pages deterministically", () => {
    const project = freshProject("q-paged");
    for (let i = 0; i < 5; i++) {
      const id = ltm.create({
        id: uuidv7(),
        projectPath: project,
        scope: "project",
        category: "pattern",
        title: `needle ${i}`,
        content: "haystack",
      });
      pin(id, { updated: 1000 }); // all equal → id tiebreak
    }
    ltm.create({
      id: uuidv7(),
      projectPath: project,
      scope: "project",
      category: "pattern",
      title: "unrelated",
      content: "nothing here",
    });
    const out: string[] = [];
    let after: KnowledgeKeyset | undefined;
    for (;;) {
      const p = listKnowledgePage(project, {
        q: "needle",
        sort: "updated_desc",
        limit: 2,
        after,
      });
      out.push(...p.items.map((e) => e.title));
      if (!p.next) break;
      after = p.next;
    }
    expect(out).toHaveLength(5);
    expect(new Set(out).size).toBe(5);
    expect(out.every((t) => t.startsWith("needle"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function msg(sessionID: string, id: string, created: number): LoreMessage {
  return {
    id,
    sessionID,
    role: "user",
    time: { created },
    agent: "build",
    model: { providerID: "anthropic", modelID: "m" },
  };
}
function parts(sessionID: string, messageID: string): LorePart[] {
  return [
    {
      id: `part-${messageID}`,
      sessionID,
      messageID,
      type: "text",
      text: `text ${messageID}`,
      time: { start: 0, end: 0 },
    },
  ];
}

describe("listSessionsPage", () => {
  test("pages by (last_message_at DESC, session_id DESC) across ≥3 pages with ties", () => {
    const project = freshProject("sessions");
    // Scrambled insert order; sessions b/d/f share last_message_at=5000.
    const plan: Array<[string, number[]]> = [
      ["s-d", [100, 5000]],
      ["s-a", [7000]],
      ["s-f", [5000]],
      ["s-c", [200, 6000]],
      ["s-b", [5000, 50]],
      ["s-e", [4000]],
      ["s-g", [3000, 1000]],
    ];
    for (const [sid, times] of plan) {
      times.forEach((t, i) =>
        temporal.store({
          projectPath: project,
          info: msg(sid, `${sid}-m${i}`, t),
          parts: parts(sid, `${sid}-m${i}`),
        }),
      );
    }
    const expected = ["s-a", "s-c", "s-f", "s-d", "s-b", "s-e", "s-g"];
    const all = listSessionsPage(project, { limit: 100 });
    expect(all.items.map((s) => s.session_id)).toEqual(expected);
    expect(all.next).toBeNull();

    const paged: string[] = [];
    let after: ReturnType<typeof listSessionsPage>["next"] = null;
    let pages = 0;
    for (;;) {
      const p = listSessionsPage(project, {
        limit: 2,
        after: after ?? undefined,
      });
      paged.push(...p.items.map((s) => s.session_id));
      pages++;
      if (!p.next) break;
      after = p.next;
    }
    expect(pages).toBe(4);
    expect(paged).toEqual(expected);

    // Same aggregates as the legacy reader (which has no tiebreaker, so
    // compare order-insensitively).
    const bySid = (rows: { session_id: string }[]) =>
      [...rows].sort((a, b) => a.session_id.localeCompare(b.session_id));
    expect(bySid(all.items)).toEqual(bySid(listSessions(project, 100)));
  });

  test("a message appended to an already-served session between pages does not duplicate it", () => {
    const project = freshProject("sessions-mutate");
    for (const [sid, t] of [
      ["x1", 1000],
      ["x2", 2000],
      ["x3", 3000],
      ["x4", 4000],
    ] as Array<[string, number]>) {
      temporal.store({
        projectPath: project,
        info: msg(sid, `${sid}-m`, t),
        parts: parts(sid, `${sid}-m`),
      });
    }
    const p1 = listSessionsPage(project, { limit: 2 });
    expect(p1.items.map((s) => s.session_id)).toEqual(["x4", "x3"]);
    // x4 gets a new message → its key moves to the front, before the cursor.
    temporal.store({
      projectPath: project,
      info: msg("x4", "x4-late", 9000),
      parts: parts("x4", "x4-late"),
    });
    const p2 = listSessionsPage(project, { limit: 2, after: p1.next! });
    expect(p2.items.map((s) => s.session_id)).toEqual(["x2", "x1"]);
    expect(p2.next).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Session search
// ---------------------------------------------------------------------------

describe("sessionSearchTerms", () => {
  test("tokenises like unicode61: letters/digits only, lower-cased, keeps short tokens and stop words", () => {
    expect(sessionSearchTerms("Needle-5")).toEqual(["needle", "5"]);
    expect(sessionSearchTerms("the store")).toEqual(["the", "store"]);
    expect(sessionSearchTerms('a "quoted" NEAR(x) term* -not')).toEqual([
      "a",
      "quoted",
      "near",
      "x",
      "term",
      "not",
    ]);
    expect(sessionSearchTerms("  \t\n")).toEqual([]);
    expect(sessionSearchTerms('*** "" ---')).toEqual([]);
    expect(sessionSearchTerms("café Ünïcode 日本語")).toEqual([
      "café",
      "ünïcode",
      "日本語",
    ]);
    expect(sessionSearchTerms("snake_case")).toEqual(["snake", "case"]);
  });

  test("caps the number of terms", () => {
    const many = Array.from({ length: 50 }, (_, i) => `t${i}`).join(" ");
    expect(sessionSearchTerms(many)).toHaveLength(32);
  });
});

describe("searchSessionMessagesPage", () => {
  function seedSearch(tag: string) {
    const project = freshProject(`search-${tag}`);
    const other = freshProject(`search-other-${tag}`);
    const texts: Array<[string, number, string]> = [
      ["k3", 3000, "the third message mentions needle-3 and SQLite stays"],
      ["k1", 1000, "first: needle-1 lives here"],
      ["k5", 3000, "a tie at 3000 with needle-5 and the store"],
      ["k2", 2000, "second, needle-2; portability is a requirement"],
      ["k4", 3000, "another tie at 3000: needle-4, sqlite stays the store"],
      ["k6", 6000, "needle-6 has \u001fmultiple\u001f parts and the store"],
      ["k7", 7000, "fifty is 50; the shop closes"],
    ];
    for (const [id, t, text] of texts) {
      temporal.store({
        projectPath: project,
        info: msg("s", id, t),
        parts: [
          {
            id: `part-${id}`,
            sessionID: "s",
            messageID: id,
            type: "text",
            text,
            time: { start: 0, end: 0 },
          },
        ],
      });
    }
    // Same words in another session of the project and in another project.
    temporal.store({
      projectPath: project,
      info: msg("s2", "z1", 5000),
      parts: [
        {
          id: "part-z1",
          sessionID: "s2",
          messageID: "z1",
          type: "text",
          text: "needle-3 in a different session, sqlite stays",
          time: { start: 0, end: 0 },
        },
      ],
    });
    temporal.store({
      projectPath: other,
      info: msg("s", "o1", 5000),
      parts: [
        {
          id: "part-o1",
          sessionID: "s",
          messageID: "o1",
          type: "text",
          text: "needle-3 in a different project, sqlite stays",
          time: { start: 0, end: 0 },
        },
      ],
    });
    // stored row id → the source message id the seed used above.
    const stored = new Map<string, string>();
    for (const m of temporal.bySession(project, "s")) {
      if (m.source_id) stored.set(m.id, m.source_id);
    }
    return { project, stored };
  }
  const sources = (items: { id: string }[], stored: Map<string, string>) =>
    items.map((h) => stored.get(h.id));
  const sorted = (xs: (string | undefined)[]) =>
    [...xs].sort((a, b) => (a ?? "").localeCompare(b ?? ""));

  test("a literal phrase with a short token and a stop word finds exactly its message, scoped to the session", () => {
    const { project, stored } = seedSearch("phrase");
    const page = searchSessionMessagesPage(project, "s", {
      query: "Needle-3",
      limit: 10,
    });
    expect(page.terms).toEqual(["needle", "3"]);
    expect(page.mode).toBe("phrase");
    expect(page.total).toBe(1);
    expect(sources(page.items, stored)).toEqual(["k3"]);
    expect(page.items[0].role).toBe("user");
    expect(page.items[0].created_at).toBe(3000);
    expect(page.items[0].snippet).toContain("needle-3");
    expect(typeof page.items[0].rank).toBe("number");
    expect(page.next).toBeNull();

    const stop = searchSessionMessagesPage(project, "s", {
      query: "the store",
      limit: 10,
    });
    expect(stop.mode).toBe("phrase");
    expect(sorted(sources(stop.items, stored))).toEqual(["k4", "k5", "k6"]);
  });

  test("phrase order, prefix on the last term only, case/separator-insensitive", () => {
    const { project, stored } = seedSearch("prefix");
    // "sqlite stays" is a phrase in k3, k4; "stays sqlite" is not.
    expect(
      sorted(
        sources(
          searchSessionMessagesPage(project, "s", {
            query: "SQLITE  stays",
            limit: 10,
          }).items,
          stored,
        ),
      ),
    ).toEqual(["k3", "k4"]);
    // Last term is a prefix: "sqlite sta" → same two; "sql stays" is not.
    expect(
      searchSessionMessagesPage(project, "s", {
        query: "sqlite sta",
        limit: 10,
      }).total,
    ).toBe(2);
    const notPrefix = searchSessionMessagesPage(project, "s", {
      query: "stays sql",
      limit: 10,
    });
    // No phrase → falls back to every term anywhere, still with only the
    // last term a prefix ("sql"* matches sqlite).
    expect(notPrefix.mode).toBe("terms");
    expect(sorted(sources(notPrefix.items, stored))).toEqual(["k3", "k4"]);
    const innerNotPrefix = searchSessionMessagesPage(project, "s", {
      query: "sql stays",
      limit: 10,
    });
    expect(innerNotPrefix.mode).toBe("terms");
    expect(innerNotPrefix.total).toBe(0);
  });

  test("a short token is a whole token unless it is the last term (`5` is not every `50`)", () => {
    const { project, stored } = seedSearch("short");
    // As the last term `5`* is a prefix, like a finder matching what was
    // typed so far: k7 ("50").
    const trailing = searchSessionMessagesPage(project, "s", {
      query: "shop 5",
      limit: 10,
    });
    expect(trailing.mode).toBe("terms");
    expect(sources(trailing.items, stored)).toEqual(["k7"]);
    // As an inner term `5` must be the token `5`; `50` does not count.
    const inner = searchSessionMessagesPage(project, "s", {
      query: "5 shop",
      limit: 10,
    });
    expect(inner.mode).toBe("terms");
    expect(inner.total).toBe(0);
    // In a phrase it is adjacency that bounds it: only needle-5, never
    // needle-1 … needle-6 or the 50.
    const phrase = searchSessionMessagesPage(project, "s", {
      query: "needle-5",
      limit: 10,
    });
    expect(phrase.mode).toBe("phrase");
    expect(sources(phrase.items, stored)).toEqual(["k5"]);
  });

  test("falls back to all-terms-anywhere only for multi-term queries, and says so", () => {
    const { project, stored } = seedSearch("terms");
    const p = searchSessionMessagesPage(project, "s", {
      query: "store needle",
      limit: 10,
    });
    expect(p.mode).toBe("terms");
    expect(p.total).toBe(3);
    expect(sorted(sources(p.items, stored))).toEqual(["k4", "k5", "k6"]);

    const none = searchSessionMessagesPage(project, "s", {
      query: "zzzz",
      limit: 10,
    });
    expect(none).toEqual({
      terms: ["zzzz"],
      mode: "phrase",
      items: [],
      next: null,
      total: 0,
    });
    const noneMulti = searchSessionMessagesPage(project, "s", {
      query: "needle zzzz",
      limit: 10,
    });
    expect(noneMulti.mode).toBe("terms");
    expect(noneMulti.total).toBe(0);
  });

  test("FTS5 syntax in the query is literal, never an operator, and never throws", () => {
    const { project } = seedSearch("syntax");
    for (const q of [
      'needle-3 OR "needle-1"',
      "needle NEAR(3)",
      "needle* -3",
      "needle:3",
      '""""',
      "(needle) AND {3}",
      "^needle",
    ]) {
      expect(() =>
        searchSessionMessagesPage(project, "s", { query: q, limit: 10 }),
      ).not.toThrow();
    }
    // `OR` is just another word: as a phrase it matches nothing, as terms
    // "or" is absent from every message → 0, not a boolean union.
    const or = searchSessionMessagesPage(project, "s", {
      query: "needle-3 OR needle-1",
      limit: 10,
    });
    expect(or.mode).toBe("terms");
    expect(or.total).toBe(0);
    // Operator-only input is unsearchable, not an error.
    expect(
      searchSessionMessagesPage(project, "s", {
        query: '* " ( ) -',
        limit: 10,
      }),
    ).toEqual({ terms: [], mode: "phrase", items: [], next: null, total: 0 });
    // "near" as a word.
    expect(
      searchSessionMessagesPage(project, "s", { query: "NEAR", limit: 10 })
        .total,
    ).toBe(0);
  });

  test("pages newest-first with (created_at, id) keyset through a tie, chronological within a page, and pins the mode", () => {
    const { project, stored } = seedSearch("paging");
    // "needle" alone matches all six; ties k3/k4/k5 at 3000.
    const walk = (mode?: "phrase" | "terms") => {
      const out: string[][] = [];
      let before: { created_at: number; id: string } | undefined;
      for (;;) {
        const p = searchSessionMessagesPage(project, "s", {
          query: "needle",
          limit: 2,
          before,
          mode,
        });
        expect(p.total).toBe(6);
        out.push(sources(p.items, stored).map((src) => src ?? "?"));
        if (!p.next) break;
        before = p.next;
      }
      return out;
    };
    const pages = walk();
    expect(pages.flat()).toHaveLength(6);
    expect(new Set(pages.flat()).size).toBe(6);
    expect(pages[0]).toHaveLength(2);
    expect(pages[0][1]).toBe("k6");
    // Chronological within each page: created_at never decreases.
    for (const page of pages) {
      const ts = page.map(
        (src) =>
          temporal.bySession(project, "s").find((m) => m.source_id === src)!
            .created_at,
      );
      expect(ts).toEqual([...ts].sort((a, b) => a - b));
    }
    // The oldest is served last.
    expect(pages.at(-1)?.[0]).toBe("k1");
    // A pinned mode is honoured even where the first page would pick phrase.
    const pinned = searchSessionMessagesPage(project, "s", {
      query: "needle 6",
      limit: 10,
      mode: "terms",
    });
    expect(pinned.mode).toBe("terms");
    expect(pinned.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Version history
// ---------------------------------------------------------------------------

describe("knowledgeVersionHistory", () => {
  test("orders versions, marks the head, computes superseded_at, includes a historical delete", () => {
    const project = freshProject("versions");
    const v1 = ltm.create({
      id: uuidv7(),
      projectPath: project,
      scope: "project",
      category: "decision",
      title: "v1 title",
      content: "v1 content",
      session: "sess-origin",
    });
    const v2 = ltm.appendVersion(v1, { title: "v2 title" })!;
    const v3 = ltm.appendVersion(v1, { isDeleted: true })!; // death cert
    // Deleted head is invisible, same as GET /knowledge/:id.
    expect(knowledgeVersionHistory(v1)).toBeNull();
    expect(knowledgeVersionHistory(v1, { includeDeleted: false })).toBeNull();
    expect(ltm.getByLogical(v1)).toBeNull();
    // ...unless the caller opts in: the tombstone is then the current version.
    const tomb = knowledgeVersionHistory(v3, { includeDeleted: true })!;
    expect(tomb.id).toBe(v1);
    expect(tomb.current_version_id).toBe(v3);
    expect(
      tomb.versions.map((v) => [v.version_id, v.is_deleted, v.is_current]),
    ).toEqual([
      [v1, false, false],
      [v2, false, false],
      [v3, true, true],
    ]);
    expect(tomb.versions[2].superseded_at).toBeNull();
    expect(
      knowledgeVersionHistory("00000000-0000-0000-0000-000000000000", {
        includeDeleted: true,
      }),
    ).toBeNull();
    // Re-append resurrects; the death cert stays in the history.
    const v4 = ltm.appendVersion(v1, {
      content: "v4 content",
      category: "gotcha",
    })!;
    db().query("UPDATE knowledge SET updated_at = ? WHERE id = ?").run(10, v1);
    db().query("UPDATE knowledge SET updated_at = ? WHERE id = ?").run(20, v2);
    db().query("UPDATE knowledge SET updated_at = ? WHERE id = ?").run(30, v3);
    db().query("UPDATE knowledge SET updated_at = ? WHERE id = ?").run(40, v4);

    for (const lookup of [v1, v2, v3, v4]) {
      const h = knowledgeVersionHistory(lookup)!;
      expect(h).not.toBeNull();
      expect(h.id).toBe(v1);
      expect(h.current_version_id).toBe(v4);
      expect(h.versions.map((v) => v.version_id)).toEqual([v1, v2, v3, v4]);
      expect(h.versions.map((v) => v.version)).toEqual([1, 2, 3, 4]);
      expect(h.versions.map((v) => v.created_at)).toEqual([10, 20, 30, 40]);
      expect(h.versions.map((v) => v.superseded_at)).toEqual([
        20,
        30,
        40,
        null,
      ]);
      expect(h.versions.map((v) => v.is_current)).toEqual([
        false,
        false,
        false,
        true,
      ]);
      expect(h.versions.map((v) => v.is_deleted)).toEqual([
        false,
        false,
        true,
        false,
      ]);
      expect(h.versions.map((v) => v.title)).toEqual([
        "v1 title",
        "v2 title",
        "v2 title",
        "v2 title",
      ]);
      expect(h.versions[3].content).toBe("v4 content");
      expect(h.versions[3].category).toBe("gotcha");
      expect(h.versions[0].category).toBe("decision");
      expect(h.versions.every((v) => v.scope === "project")).toBe(true);
      expect(
        h.versions.every((v) => v.source_refs.session_id === "sess-origin"),
      ).toBe(true);
      expect(h.versions.every((v) => v.confidence === 1)).toBe(true);
    }
    // Same underlying rows as ltm.versionHistory().
    const raw: KnowledgeVersion[] = ltm.versionHistory(v1);
    expect(raw.map((r) => r.id)).toEqual([v1, v2, v3, v4]);
  });

  test("unknown id → null; global entry reports scope=global", () => {
    expect(
      knowledgeVersionHistory("00000000-0000-0000-0000-000000000000"),
    ).toBeNull();
    const g = ltm.create({
      id: uuidv7(),
      scope: "global",
      category: "preference",
      title: "global pref",
      content: "c",
    });
    const h = knowledgeVersionHistory(g)!;
    expect(h.versions).toHaveLength(1);
    expect(h.versions[0].scope).toBe("global");
    expect(h.versions[0].superseded_at).toBeNull();
    expect(h.versions[0].is_current).toBe(true);
  });

  test("lookup by a version id returns only that logical entry's history", () => {
    const project = freshProject("versions-isolated");
    const a = ltm.create({
      id: uuidv7(),
      projectPath: project,
      scope: "project",
      category: "decision",
      title: "A",
      content: "a",
    });
    const b = ltm.create({
      id: uuidv7(),
      projectPath: project,
      scope: "project",
      category: "decision",
      title: "B",
      content: "b",
    });
    const a2 = ltm.appendVersion(a, { content: "a2" })!;
    expect(
      knowledgeVersionHistory(a2)!.versions.map((v) => v.version_id),
    ).toEqual([a, a2]);
    expect(
      knowledgeVersionHistory(b)!.versions.map((v) => v.version_id),
    ).toEqual([b]);
  });
});
