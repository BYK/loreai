import { describe, test, expect, beforeEach } from "vitest";
import {
  ftsQuery,
  ftsQueryOr,
  ftsQueryRelaxed,
  filterTerms,
  STOPWORDS,
  EMPTY_QUERY,
  normalizeRank,
  reciprocalRankFusion,
  extractTopTerms,
  exactTermMatchRank,
  termIDF,
} from "../src/search";
import { db, ensureProject } from "../src/db";

describe("search", () => {
  describe("ftsQuery (AND semantics)", () => {
    test("plain words get prefix wildcard with implicit AND", () => {
      expect(ftsQuery("OAuth PKCE flow")).toBe('"OAuth"* "PKCE"* "flow"*');
    });

    test("hyphenated terms: dash stripped, not treated as NOT operator", () => {
      expect(ftsQuery("opencode-test")).toBe('"opencode"* "test"*');
      expect(ftsQuery("three-tier")).toBe('"three"* "tier"*');
    });

    test("dot in domain name: dot stripped, tokens preserved", () => {
      expect(ftsQuery("sanity.io")).toBe('"sanity"* "io"*');
    });

    test("other punctuation stripped", () => {
      // "what's the fix?" → "what" is stopword, "s" is single char, "the" is stopword → only "fix"
      expect(ftsQuery("what's the fix?")).toBe('"fix"*');
    });

    test("empty string returns empty sentinel", () => {
      expect(ftsQuery("")).toBe(EMPTY_QUERY);
    });

    test("punctuation-only returns empty sentinel", () => {
      expect(ftsQuery("!@#$%^&*()")).toBe(EMPTY_QUERY);
    });

    test("single-character tokens are dropped", () => {
      // "I" is single char, "a" is single char
      expect(ftsQuery("I found a bug")).toBe('"found"* "bug"*');
    });

    test("2-char tokens are preserved (DB, CI, IO, PR)", () => {
      expect(ftsQuery("DB migration")).toBe('"DB"* "migration"*');
      expect(ftsQuery("CI pipeline")).toBe('"CI"* "pipeline"*');
      expect(ftsQuery("IO error")).toBe('"IO"* "error"*');
      expect(ftsQuery("PR review")).toBe('"PR"* "review"*');
    });

    test("stopwords are removed", () => {
      // "the" and "with" are stopwords
      expect(ftsQuery("the database with indexes")).toBe(
        '"database"* "indexes"*',
      );
    });

    test("all-stopword query returns empty sentinel", () => {
      expect(ftsQuery("what is this")).toBe(EMPTY_QUERY);
      expect(ftsQuery("the from with")).toBe(EMPTY_QUERY);
    });

    test("all single-char tokens returns empty sentinel", () => {
      expect(ftsQuery("I a")).toBe(EMPTY_QUERY);
    });

    test("mixed stopwords and single chars returns empty sentinel", () => {
      expect(ftsQuery("I have the")).toBe(EMPTY_QUERY);
    });

    test("preserves case of original tokens", () => {
      // FTS5 handles case-insensitive matching internally via unicode61 tokenizer
      expect(ftsQuery("SQLite FTS5")).toBe('"SQLite"* "FTS5"*');
    });

    test("underscores preserved as word chars", () => {
      expect(ftsQuery("my_variable")).toBe('"my_variable"*');
    });
  });

  describe("Unicode-aware tokenization (non-English)", () => {
    test("filterTerms keeps Turkish words intact (no split at ç/ğ/ı/ö/ş/ü)", () => {
      // With ASCII \w, "değişiklik" split into de/i/iklik (and single chars
      // were dropped). With \p{L}, it stays one token.
      expect(filterTerms("değişiklik yap")).toEqual(["değişiklik", "yap"]);
    });

    test("filterTerms preserves a variety of Turkish letters", () => {
      expect(filterTerms("şöğüçı İçin")).toEqual(["şöğüçı", "İçin"]);
    });

    test("ftsQuery builds a valid prefix query from Turkish terms", () => {
      expect(ftsQuery("değişiklik yap")).toBe('"değişiklik"* "yap"*');
    });

    test("punctuation around Turkish words is still stripped", () => {
      expect(filterTerms("değişiklik, yap!")).toEqual(["değişiklik", "yap"]);
    });

    test("extractTopTerms keeps Turkish tokens intact", () => {
      expect(extractTopTerms("değişiklik değişiklik yap")).toEqual([
        "değişiklik",
        "yap",
      ]);
    });
  });

  describe("ftsQueryOr (OR semantics)", () => {
    test("plain words joined with OR", () => {
      expect(ftsQueryOr("OAuth PKCE flow")).toBe(
        '"OAuth"* OR "PKCE"* OR "flow"*',
      );
    });

    test("same filtering as ftsQuery", () => {
      expect(ftsQueryOr("what's the fix?")).toBe('"fix"*');
    });

    test("empty string returns empty sentinel", () => {
      expect(ftsQueryOr("")).toBe(EMPTY_QUERY);
    });

    test("all-stopword query returns empty sentinel", () => {
      expect(ftsQueryOr("what is this")).toBe(EMPTY_QUERY);
    });

    test("stopwords removed, remaining terms OR'd", () => {
      expect(ftsQueryOr("the database with indexes")).toBe(
        '"database"* OR "indexes"*',
      );
    });

    test("single term produces no OR", () => {
      expect(ftsQueryOr("database")).toBe('"database"*');
    });
  });

  describe("FTS5 keyword injection (regression)", () => {
    test("quotes keyword tokens so they are not parsed as operators", () => {
      // "and"/"near" are not stopwords, so an uppercase AND would otherwise
      // become an FTS5 operator → `fts5: syntax error near "AND"`. Regression
      // for the instruction-detect FTS failure. Quoting each term as "term"*
      // neutralizes the entire keyword-injection class.
      expect(ftsQueryOr("rebase AND merge")).toBe(
        '"rebase"* OR "AND"* OR "merge"*',
      );
      expect(ftsQuery("rebase AND merge")).toBe('"rebase"* "AND"* "merge"*');
    });

    test("keyword-bearing queries execute against fts5 without syntax error", () => {
      // Proves the quoted expression actually parses against the fts5 engine.
      // Uses a connection-local `temp.` table so the shared test DB schema is
      // untouched; the pre-DROP + try/finally DROP keep it leak-safe even if a
      // prior run aborted before its finally.
      const d = db();
      d.exec("DROP TABLE IF EXISTS temp._kw_fts");
      d.exec("CREATE VIRTUAL TABLE temp._kw_fts USING fts5(body)");
      try {
        d.query("INSERT INTO temp._kw_fts(body) VALUES (?)").run(
          "always rebase and merge then run lint and commit",
        );
        // `AND` survives filterTerms ("and" is not a stopword) and would,
        // unquoted, be parsed as an FTS5 operator. Exercise BOTH builders:
        // the OR-join (bareword raises `syntax error near "AND"`) and the
        // implicit-AND join (bareword raises `syntax error near "*"`). Each
        // throws on revert to bareword tokens, so both are discriminating.
        // (`NOT`/`OR` lowercase to stopwords and are dropped before the
        // builder; `NEAR` is only an operator before `(`, which filterTerms
        // strips — neither would discriminate here.)
        const exprs = [
          ftsQueryOr("rebase AND merge"),
          ftsQuery("rebase AND merge"),
        ];
        for (const expr of exprs) {
          // FTS5 MATCH requires the bare (unqualified) table name as its left
          // operand — `temp._kw_fts MATCH ?` raises "no such column".
          expect(() =>
            d
              .query("SELECT rowid FROM temp._kw_fts WHERE _kw_fts MATCH ?")
              .all(expr),
          ).not.toThrow();
        }
      } finally {
        d.exec("DROP TABLE temp._kw_fts");
      }
    });
  });

  describe("STOPWORDS", () => {
    test("contains expected categories", () => {
      // Articles
      expect(STOPWORDS.has("the")).toBe(true);
      expect(STOPWORDS.has("this")).toBe(true);
      // Pronouns
      expect(STOPWORDS.has("they")).toBe(true);
      expect(STOPWORDS.has("what")).toBe(true);
      // Common verbs
      expect(STOPWORDS.has("have")).toBe(true);
      expect(STOPWORDS.has("been")).toBe(true);
      // Prepositions
      expect(STOPWORDS.has("with")).toBe(true);
      expect(STOPWORDS.has("from")).toBe(true);
      // Adverbs
      expect(STOPWORDS.has("just")).toBe(true);
      expect(STOPWORDS.has("very")).toBe(true);
    });

    test("does NOT contain domain terms", () => {
      expect(STOPWORDS.has("handle")).toBe(false);
      expect(STOPWORDS.has("state")).toBe(false);
      expect(STOPWORDS.has("type")).toBe(false);
      expect(STOPWORDS.has("error")).toBe(false);
      expect(STOPWORDS.has("function")).toBe(false);
      expect(STOPWORDS.has("database")).toBe(false);
    });
  });

  describe("EMPTY_QUERY sentinel", () => {
    test("is double-quoted empty string", () => {
      expect(EMPTY_QUERY).toBe('""');
    });
  });

  describe("normalizeRank", () => {
    test("best rank (most negative) normalizes to 1.0", () => {
      // minRank=-10 is best, maxRank=-1 is worst
      expect(normalizeRank(-10, -10, -1)).toBe(1);
    });

    test("worst rank normalizes to 0.0", () => {
      expect(normalizeRank(-1, -10, -1)).toBe(0);
    });

    test("mid-range rank normalizes proportionally", () => {
      const score = normalizeRank(-5.5, -10, -1);
      expect(score).toBeCloseTo(0.5, 1);
    });

    test("all same rank returns 1.0", () => {
      expect(normalizeRank(-5, -5, -5)).toBe(1);
    });

    test("single result returns 1.0", () => {
      expect(normalizeRank(-3, -3, -3)).toBe(1);
    });
  });

  describe("reciprocalRankFusion", () => {
    test("merges two lists by RRF score", () => {
      const fused = reciprocalRankFusion([
        {
          items: [{ id: "a" }, { id: "b" }, { id: "c" }],
          key: (x) => x.id,
        },
        {
          items: [{ id: "b" }, { id: "a" }, { id: "d" }],
          key: (x) => x.id,
        },
      ]);

      const ids = fused.map((r) => r.item.id);
      // "a" appears at rank 0 in list 1 and rank 1 in list 2 → highest combined RRF
      // "b" appears at rank 1 in list 1 and rank 0 in list 2 → same as "a"
      expect(ids.slice(0, 2).sort()).toEqual(["a", "b"]);
      // "c" and "d" only appear in one list each
      expect(ids).toContain("c");
      expect(ids).toContain("d");
      expect(ids.length).toBe(4);
    });

    test("items in multiple lists score higher than single-list items", () => {
      const fused = reciprocalRankFusion([
        {
          items: [{ id: "shared" }, { id: "only-in-1" }],
          key: (x) => x.id,
        },
        {
          items: [{ id: "shared" }, { id: "only-in-2" }],
          key: (x) => x.id,
        },
      ]);

      // "shared" appears in both lists → highest score
      expect(fused[0].item.id).toBe("shared");
      // Its score should be roughly 2 * 1/(60+0) ≈ 0.0333
      expect(fused[0].score).toBeCloseTo(2 / 60, 4);
    });

    test("preserves first occurrence when item appears in multiple lists", () => {
      const fused = reciprocalRankFusion([
        {
          items: [{ id: "x", source: "list1" }],
          key: (x) => x.id,
        },
        {
          items: [{ id: "x", source: "list2" }],
          key: (x) => x.id,
        },
      ]);

      // First occurrence (list1) should be kept
      expect((fused[0].item as { source: string }).source).toBe("list1");
    });

    test("empty lists produce empty result", () => {
      const fused = reciprocalRankFusion<{ id: string }>([
        { items: [], key: (x) => x.id },
        { items: [], key: (x) => x.id },
      ]);
      expect(fused.length).toBe(0);
    });

    test("single list returns items in order", () => {
      const fused = reciprocalRankFusion([
        {
          items: [{ id: "first" }, { id: "second" }, { id: "third" }],
          key: (x) => x.id,
        },
      ]);

      expect(fused.map((r) => r.item.id)).toEqual(["first", "second", "third"]);
    });

    test("custom k parameter changes scores", () => {
      const fused = reciprocalRankFusion(
        [
          {
            items: [{ id: "a" }],
            key: (x) => x.id,
          },
        ],
        10, // smaller k → higher scores
      );

      // With k=10, rank 0 → 1/(10+0) = 0.1
      expect(fused[0].score).toBeCloseTo(0.1, 4);
    });

    test("weight defaults to 1 — identical to unweighted", () => {
      const lists = [
        {
          items: [{ id: "a" }, { id: "b" }],
          key: (x: { id: string }) => x.id,
        },
      ];
      const withoutWeight = reciprocalRankFusion(lists);
      const withWeight = reciprocalRankFusion(
        lists.map((l) => ({ ...l, weight: 1 })),
      );

      expect(withWeight.map((r) => r.score)).toEqual(
        withoutWeight.map((r) => r.score),
      );
    });

    test("weight multiplies RRF score contribution", () => {
      const fused = reciprocalRankFusion([
        {
          items: [{ id: "a" }],
          key: (x) => x.id,
          weight: 2,
        },
      ]);

      // rank 0, weight 2: 2 / (60 + 0) = 1/30
      expect(fused[0].score).toBeCloseTo(2 / 60, 6);
    });

    test("weight can change ranking order", () => {
      // Without weight: "shared" (in both lists) beats "boosted" (in one list)
      const unweighted = reciprocalRankFusion([
        {
          items: [{ id: "shared" }, { id: "only-1" }],
          key: (x) => x.id,
        },
        {
          items: [{ id: "shared" }, { id: "boosted" }],
          key: (x) => x.id,
        },
      ]);
      expect(unweighted[0].item.id).toBe("shared");

      // With high weight on second list: "boosted" at rank 1 with weight 5
      // scores 5/(60+1) = 0.0820; "shared" at rank 0 in both = 1/60 + 5/60
      // = 0.1 — shared still wins at rank 0, but "boosted" beats "only-1"
      const weighted = reciprocalRankFusion([
        {
          items: [{ id: "shared" }, { id: "only-1" }],
          key: (x) => x.id,
        },
        {
          items: [{ id: "shared" }, { id: "boosted" }],
          key: (x) => x.id,
          weight: 5,
        },
      ]);
      const ids = weighted.map((r) => r.item.id);
      // "boosted" should rank above "only-1" due to higher weighted score
      expect(ids.indexOf("boosted")).toBeLessThan(ids.indexOf("only-1"));
    });

    test("mixed weighted and unweighted lists accumulate correctly", () => {
      const fused = reciprocalRankFusion([
        {
          items: [{ id: "a" }],
          key: (x) => x.id,
          // no weight → defaults to 1
        },
        {
          items: [{ id: "a" }],
          key: (x) => x.id,
          weight: 1.5,
        },
      ]);

      // "a" at rank 0 in both: 1/60 + 1.5/60 = 2.5/60
      expect(fused[0].score).toBeCloseTo(2.5 / 60, 6);
    });
  });

  describe("exactTermMatchRank", () => {
    const items = [
      { id: "a", text: "Decided to use PostgreSQL for the main database" },
      {
        id: "b",
        text: "CI pipeline runs on GitHub Actions with matrix builds",
      },
      {
        id: "c",
        text: "PostgreSQL JSONB support enables flexible schema design",
      },
      { id: "d", text: "React frontend uses server components" },
    ];
    const getText = (item: (typeof items)[number]) => item.text;

    test("ranks items by number of exact term matches descending", () => {
      const ranked = exactTermMatchRank(items, getText, "PostgreSQL database");
      // "a" has both "PostgreSQL" and "database" → 2 matches
      // "c" has "PostgreSQL" but not "database" → 1 match
      expect(ranked.length).toBe(2);
      expect(ranked[0].id).toBe("a");
      expect(ranked[1].id).toBe("c");
    });

    test("excludes items with zero matches", () => {
      const ranked = exactTermMatchRank(
        items,
        getText,
        "Kubernetes deployment",
      );
      expect(ranked.length).toBe(0);
    });

    test("case-insensitive matching", () => {
      const ranked = exactTermMatchRank(items, getText, "postgresql jsonb");
      expect(ranked.length).toBe(2);
      // "c" has both "PostgreSQL" and "JSONB" → 2 matches
      // "a" has "PostgreSQL" only → 1 match
      expect(ranked[0].id).toBe("c");
      expect(ranked[1].id).toBe("a");
    });

    test("filters stopwords from query", () => {
      // "the" and "with" are stopwords — only "React" should match
      const ranked = exactTermMatchRank(
        items,
        getText,
        "the React with components",
      );
      expect(ranked.length).toBe(1);
      expect(ranked[0].id).toBe("d");
    });

    test("returns empty for all-stopword query", () => {
      const ranked = exactTermMatchRank(items, getText, "the with from");
      expect(ranked.length).toBe(0);
    });

    test("returns empty for empty items array", () => {
      const ranked = exactTermMatchRank([], getText, "PostgreSQL");
      expect(ranked.length).toBe(0);
    });

    test("preserves original item references", () => {
      const ranked = exactTermMatchRank(items, getText, "React");
      expect(ranked[0]).toBe(items[3]); // same object reference
    });

    test("handles single-item match", () => {
      const ranked = exactTermMatchRank(items, getText, "GitHub Actions");
      expect(ranked.length).toBe(1);
      expect(ranked[0].id).toBe("b");
    });

    test("works with generic types", () => {
      const tuples: Array<[string, string]> = [
        ["k:1", "PostgreSQL migration script"],
        ["k:2", "Redis cache layer"],
      ];
      const ranked = exactTermMatchRank(
        tuples,
        ([, text]) => text,
        "PostgreSQL migration",
      );
      expect(ranked.length).toBe(1);
      expect(ranked[0][0]).toBe("k:1");
    });
  });

  describe("extractTopTerms", () => {
    test("extracts terms sorted by frequency", () => {
      const terms = extractTopTerms("database database database config config");
      expect(terms[0]).toBe("database");
      expect(terms[1]).toBe("config");
    });

    test("filters stopwords", () => {
      const terms = extractTopTerms(
        "the database with the indexes from the table",
      );
      expect(terms).toContain("database");
      expect(terms).toContain("indexes");
      expect(terms).toContain("table");
      expect(terms).not.toContain("the");
      expect(terms).not.toContain("with");
      expect(terms).not.toContain("from");
    });

    test("filters single chars", () => {
      const terms = extractTopTerms("I found a bug in x module");
      expect(terms).toContain("found");
      expect(terms).toContain("bug");
      expect(terms).toContain("module");
      expect(terms).not.toContain("I");
      expect(terms).not.toContain("a");
      expect(terms).not.toContain("x");
    });

    test("preserves 2-char tokens like DB, CI, IO", () => {
      const terms = extractTopTerms("check DB and CI pipeline for IO errors");
      expect(terms).toContain("db"); // lowercased
      expect(terms).toContain("ci");
      expect(terms).toContain("io");
    });

    test("respects limit parameter", () => {
      const text =
        "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
      const terms = extractTopTerms(text, 3);
      expect(terms.length).toBe(3);
    });

    test("default limit is 40", () => {
      // Generate 50 unique words
      const words = Array.from({ length: 50 }, (_, i) => `word${i}`);
      const text = words.join(" ");
      const terms = extractTopTerms(text);
      expect(terms.length).toBe(40);
    });

    test("returns empty for all-stopword text", () => {
      const terms = extractTopTerms("the with from is at by in");
      expect(terms.length).toBe(0);
    });

    test("strips punctuation before processing", () => {
      const terms = extractTopTerms("what's happening? database-migration!");
      expect(terms).toContain("happening");
      expect(terms).toContain("database");
      expect(terms).toContain("migration");
      expect(terms).not.toContain("what"); // stopword
    });
  });

  describe("ftsQueryRelaxed", () => {
    test("produces cascade of progressively relaxed AND queries ending with OR", () => {
      const cascade = ftsQueryRelaxed("alpha beta gamma delta");
      // 4 terms, minTerms=3: drop 1 term → 3-of-4 AND, then full OR
      expect(cascade.length).toBe(2);
      // Last entry is always the full OR
      expect(cascade[cascade.length - 1]).toContain(" OR ");
    });

    test("returns just OR for terms <= minTerms", () => {
      const cascade = ftsQueryRelaxed("alpha beta gamma");
      expect(cascade.length).toBe(1);
      expect(cascade[0]).toBe('"alpha"* OR "beta"* OR "gamma"*');
    });

    test("empty query returns EMPTY_QUERY", () => {
      const cascade = ftsQueryRelaxed("");
      expect(cascade).toEqual([EMPTY_QUERY]);
    });

    test("without weights, drops shortest terms first", () => {
      // Terms by length: "V8" (2), "CLI" (3), "Node" (4), "Sentry" (6), "snapshot" (8)
      const cascade = ftsQueryRelaxed("V8 CLI Node Sentry snapshot");
      // First step drops "V8" (shortest); second drops "V8","CLI"; etc.
      // cascade[0] = 4-of-5 AND (dropped V8)
      expect(cascade[0]).not.toContain('"V8"*');
      expect(cascade[0]).toContain('"CLI"*');
      expect(cascade[0]).toContain('"snapshot"*');
    });

    test("with weights, drops lowest-weight (most common) terms first", () => {
      // Simulate IDF: "code" is very common (low IDF=0.5), "V8" is rare (high IDF=5.0)
      const weights = new Map([
        ["code", 0.5],
        ["build", 1.0],
        ["node", 2.0],
        ["v8", 5.0],
        ["sea", 4.5],
      ]);
      const cascade = ftsQueryRelaxed("code build Node V8 SEA", 3, weights);
      // First step drops "code" (lowest IDF=0.5), NOT "V8" (shortest but highest IDF)
      expect(cascade[0]).not.toContain('"code"*');
      expect(cascade[0]).toContain('"V8"*');
      expect(cascade[0]).toContain('"SEA"*');
      expect(cascade[0]).toContain('"Node"*');
      // Second step also drops "build" (next lowest IDF=1.0)
      expect(cascade[1]).not.toContain('"build"*');
      expect(cascade[1]).toContain('"V8"*');
      expect(cascade[1]).toContain('"SEA"*');
    });

    test("with weights, unknown terms are dropped before known terms", () => {
      // Only "code" and "v8" have IDF weights; "deploy" and "engine" are unknown
      // (simulates LLM-expanded query with terms not in original IDF map)
      const weights = new Map([
        ["code", 0.5],
        ["v8", 5.0],
      ]);
      // 4 terms, minTerms=2 → 2 AND steps + OR = 3 entries
      const cascade = ftsQueryRelaxed("code V8 deploy engine", 2, weights);
      expect(cascade.length).toBe(3);

      // Drop order should be: unknowns first (by length), then knowns (by IDF).
      // "deploy"(6) and "engine"(6) are unknown, same length — either can be first.
      // "code"(IDF=0.5) is known but common — dropped after unknowns.
      // "V8"(IDF=5.0) is known and rare — kept longest.
      //
      // Step 0: drop 1 unknown → 3 terms remain, must include V8 and code
      expect(cascade[0]).toContain('"V8"*');
      expect(cascade[0]).toContain('"code"*');
      // Step 1: drop both unknowns → only known terms remain
      expect(cascade[1]).toContain('"V8"*');
      expect(cascade[1]).toContain('"code"*');
      expect(cascade[1]).not.toContain('"deploy"*');
      expect(cascade[1]).not.toContain('"engine"*');
      // Step 2: full OR (all terms)
      expect(cascade[2]).toContain(" OR ");
    });

    test("with weights, full drop order: unknowns by length, then knowns by IDF", () => {
      // 6 terms: 3 known (code=0.5, build=1.0, v8=5.0), 3 unknown (ax, deploy, zz)
      const weights = new Map([
        ["code", 0.5],
        ["build", 1.0],
        ["v8", 5.0],
      ]);
      // minTerms=2 → 4 AND steps + OR = 5 entries
      const cascade = ftsQueryRelaxed("code build V8 ax deploy zz", 2, weights);
      expect(cascade.length).toBe(5);

      // Expected drop order (sorted to front → dropped first):
      // 1. "ax" (unknown, length 2) — shortest unknown
      // 2. "zz" (unknown, length 2) — same length, stable-sort preserves input order
      // 3. "deploy" (unknown, length 6) — longest unknown
      // 4. "code" (known, IDF=0.5) — lowest IDF
      // Then kept: "build" (IDF=1.0), "V8" (IDF=5.0)

      // After all 4 drops, only "build" and "V8" should remain (last AND step)
      const lastAnd = cascade[cascade.length - 2]; // second-to-last is last AND
      expect(lastAnd).toContain('"V8"*');
      expect(lastAnd).toContain('"build"*');
      expect(lastAnd).not.toContain('"code"*');
      expect(lastAnd).not.toContain('"ax"*');
      expect(lastAnd).not.toContain('"deploy"*');
      expect(lastAnd).not.toContain('"zz"*');

      // V8 should survive in ALL AND steps (it's highest IDF, never dropped)
      for (let i = 0; i < cascade.length - 1; i++) {
        expect(cascade[i]).toContain('"V8"*');
      }
    });

    test("with weights, all-unknown terms fall back to length heuristic", () => {
      // Provide weights map but none of the terms are in it
      const weights = new Map([["unrelated", 3.0]]);
      const cascade = ftsQueryRelaxed("alpha beta gamma delta", 3, weights);
      // Should behave like no-weights: drop shortest first
      expect(cascade.length).toBe(2); // 1 AND step + OR
      // "beta" (4 chars) is shortest, dropped first
      expect(cascade[0]).not.toContain('"beta"*');
      expect(cascade[0]).toContain('"alpha"*');
      expect(cascade[0]).toContain('"gamma"*');
      expect(cascade[0]).toContain('"delta"*');
    });

    test("with weights, tie-breaks by length when IDF is equal", () => {
      const weights = new Map([
        ["ab", 2.0],
        ["abcdef", 2.0],
        ["xyz", 3.0],
      ]);
      const cascade = ftsQueryRelaxed("ab abcdef xyz", 2, weights);
      // "ab" and "abcdef" have same IDF — "ab" is shorter, dropped first
      expect(cascade[0]).not.toContain('"ab"*');
      // But it should contain the longer one
      expect(cascade[0]).toContain('"abcdef"*');
      expect(cascade[0]).toContain('"xyz"*');
    });
  });

  describe("termIDF", () => {
    const IDF_PROJECT = "/test/search/idf";

    beforeEach(() => {
      // Seed knowledge entries with varying term frequency.
      // "database" appears in 3 entries (common), "PKCE" in 1 (rare).
      const pid = ensureProject(IDF_PROJECT);
      const now = Date.now();

      // Clean up any prior test data
      db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);

      for (const [id, title, content] of [
        [
          "idf-1",
          "Database setup",
          "Configure the PostgreSQL database for production",
        ],
        [
          "idf-2",
          "Database migration",
          "Run database migration scripts before deploy",
        ],
        ["idf-3", "Auth flow", "Use database-backed sessions with OAuth PKCE"],
        [
          "idf-4",
          "Build pipeline",
          "V8 snapshot for Node SEA binary distribution",
        ],
      ] as const) {
        db()
          .query(
            `INSERT OR REPLACE INTO knowledge (id, project_id, category, title, content, created_at, updated_at, logical_id)
             VALUES (?, ?, 'decision', ?, ?, ?, ?, ?)`,
          )
          .run(id, pid, title, content, now, now, id);
        // confidence lives on the knowledge_meta register now (A2 3b).
        db()
          .query(
            "INSERT OR REPLACE INTO knowledge_meta (logical_id, confidence, last_reinforced_at, updated_at) VALUES (?, ?, ?, ?)",
          )
          .run(id, 1.0, now, now);
      }
    });

    test("returns Map with IDF scores for each term", () => {
      const weights = termIDF("database PKCE V8");
      expect(weights).toBeInstanceOf(Map);
      expect(weights.has("database")).toBe(true);
      expect(weights.has("pkce")).toBe(true);
      expect(weights.has("v8")).toBe(true);
    });

    test("rare terms get higher IDF than common terms", () => {
      const weights = termIDF("database PKCE");
      const dbWeight = weights.get("database") ?? 0;
      const pkceWeight = weights.get("pkce") ?? 0;
      // "PKCE" appears in fewer docs than "database" → higher IDF
      expect(pkceWeight).toBeGreaterThan(dbWeight);
    });

    test("very rare terms get higher IDF than somewhat rare terms", () => {
      const weights = termIDF("database V8 PKCE");
      const v8Weight = weights.get("v8") ?? 0;
      const dbWeight = weights.get("database") ?? 0;
      // "V8" appears in 1 entry, "database" in 3 → V8 has higher IDF
      expect(v8Weight).toBeGreaterThan(dbWeight);
    });

    test("returns empty Map for empty query", () => {
      const weights = termIDF("");
      expect(weights.size).toBe(0);
    });

    test("returns empty Map for all-stopword query", () => {
      const weights = termIDF("the with from");
      expect(weights.size).toBe(0);
    });

    test("deduplicates terms case-insensitively", () => {
      const weights = termIDF("Database database DATABASE");
      // Should have only one entry for "database"
      expect(weights.size).toBe(1);
      expect(weights.has("database")).toBe(true);
    });

    test("all IDF values are positive", () => {
      const weights = termIDF("database PKCE V8 build");
      for (const [, idf] of weights) {
        expect(idf).toBeGreaterThan(0);
      }
    });

    test("produces positive values even with empty corpus (no seeded data)", () => {
      // Query terms that don't exist in any FTS table — totalDocs may be
      // near-zero but floored to 1. Formula: log(1 + 1/(1+0)) = log(2) ≈ 0.693
      const weights = termIDF("xyznonexistent qqqqnotfound");
      expect(weights.size).toBe(2);
      for (const [, idf] of weights) {
        expect(idf).toBeGreaterThan(0);
        expect(Number.isFinite(idf)).toBe(true);
      }
    });
  });
});
