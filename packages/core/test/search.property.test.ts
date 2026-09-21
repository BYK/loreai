import { describe, test, expect, beforeAll, afterAll } from "vitest";
import fc from "fast-check";
import { DatabaseSync } from "node:sqlite";
import {
  EMPTY_QUERY,
  filterTerms,
  ftsQuery,
  ftsQueryOr,
  ftsQueryRelaxed,
} from "../src/search";

/**
 * Property battery for the FTS5 query builders.
 *
 * The bug class guarded here is FTS5 syntax injection: user text that FTS5
 * would parse as operators (`AND`, `OR`, `NOT`, `NEAR`, quotes, parens,
 * `*`, `:` column filters, `^`, `+`, `-`) reaching MATCH unquoted and raising
 * `fts5: syntax error`. Every builder output is executed against a real FTS5
 * table, so the oracle is SQLite itself rather than a re-implementation of
 * its grammar.
 */

// Biased toward FTS5-hostile input: operators, keywords, quoting, unicode.
const hostileToken = fc.constantFrom(
  "AND",
  "OR",
  "NOT",
  "NEAR",
  "near",
  '"',
  '""',
  "*",
  "(",
  ")",
  ":",
  "^",
  "+",
  "-",
  "--",
  "content:",
  "rowid",
  "{",
  "}",
  "\\",
  "\u001f",
  "\u0000",
  "café",
  "naïve",
  "日本語",
  "😀",
  "snake_case",
  "a",
  "or",
  "not",
);

const rawQuery = fc.oneof(
  { arbitrary: fc.string({ unit: "grapheme" }), weight: 2 },
  { arbitrary: fc.string({ unit: "binary" }), weight: 1 },
  {
    arbitrary: fc
      .array(fc.oneof(hostileToken, fc.string({ unit: "grapheme" })), {
        maxLength: 12,
      })
      .map((parts) => parts.join(" ")),
    weight: 4,
  },
);

// Extract the quoted term of each `"term"*` token, undoing the `""` escape.
function tokensOf(query: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"]|"")*)"\*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) !== null) out.push(m[1].replace(/""/g, '"'));
  return out;
}

describe("FTS5 query builders (property)", () => {
  let db: DatabaseSync;
  let match: ReturnType<DatabaseSync["prepare"]>;

  beforeAll(() => {
    db = new DatabaseSync(":memory:");
    db.exec("CREATE VIRTUAL TABLE t USING fts5(content)");
    db.exec(
      "INSERT INTO t(content) VALUES ('and or not near'), ('snake_case café 日本語'), ('rowid content')",
    );
    match = db.prepare("SELECT count(*) AS n FROM t WHERE t MATCH ?");
  });

  afterAll(() => {
    db.close();
  });

  const acceptedByFts5 = (q: string): boolean => {
    match.get(q);
    return true;
  };

  test("ftsQuery / ftsQueryOr / ftsQueryRelaxed never produce a query FTS5 rejects", () => {
    fc.assert(
      fc.property(rawQuery, (raw) => {
        expect(acceptedByFts5(ftsQuery(raw))).toBe(true);
        expect(acceptedByFts5(ftsQueryOr(raw))).toBe(true);
        for (const q of ftsQueryRelaxed(raw)) {
          expect(acceptedByFts5(q)).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });

  test("every emitted term is a filtered term, quoted and prefix-starred — nothing else reaches MATCH", () => {
    fc.assert(
      fc.property(rawQuery, (raw) => {
        const terms = filterTerms(raw);
        const andQ = ftsQuery(raw);
        const orQ = ftsQueryOr(raw);
        if (terms.length === 0) {
          expect(andQ).toBe(EMPTY_QUERY);
          expect(orQ).toBe(EMPTY_QUERY);
          expect(ftsQueryRelaxed(raw)).toEqual([EMPTY_QUERY]);
          return;
        }
        expect(tokensOf(andQ)).toEqual(terms);
        expect(tokensOf(orQ)).toEqual(terms);
        // Reconstructing from the tokens must reproduce the query byte-for-byte:
        // proves there is no unquoted residue between tokens.
        const quoted = terms.map((t) => `"${t.replace(/"/g, '""')}"*`);
        expect(andQ).toBe(quoted.join(" "));
        expect(orQ).toBe(quoted.join(" OR "));
        for (const t of terms) {
          expect(t).toMatch(/^[\p{L}\p{N}_]+$/u);
          expect(t.length).toBeGreaterThan(1);
        }
      }),
      { numRuns: 500 },
    );
  });

  test("ftsQueryRelaxed cascade: strictly shrinking AND steps, subset of the terms, OR query last", () => {
    fc.assert(
      fc.property(
        rawQuery,
        fc.integer({ min: 1, max: 6 }),
        fc.option(
          fc.dictionary(
            fc.string({ unit: "grapheme", minLength: 1, maxLength: 6 }),
            fc.double({ min: 0, max: 10, noNaN: true }),
          ),
          { nil: undefined },
        ),
        (raw, minTerms, weightsObj) => {
          const weights = weightsObj
            ? new Map(
                Object.entries(weightsObj).map(([k, v]) => [
                  k.toLowerCase(),
                  v,
                ]),
              )
            : undefined;
          const terms = filterTerms(raw);
          const cascade = ftsQueryRelaxed(raw, minTerms, weights);

          expect(cascade.length).toBeGreaterThan(0);
          expect(cascade[cascade.length - 1]).toBe(ftsQueryOr(raw));

          if (terms.length <= minTerms) {
            expect(cascade).toHaveLength(1);
            return;
          }
          expect(cascade).toHaveLength(terms.length - minTerms + 1);

          const weightOf = (t: string): number | undefined =>
            weights?.get(t.toLowerCase());
          let prev = terms.length;
          for (const q of cascade.slice(0, -1)) {
            expect(q).not.toContain(" OR ");
            const kept = tokensOf(q);
            expect(kept.length).toBe(prev - 1);
            expect(kept.length).toBeGreaterThanOrEqual(minTerms);

            // kept ⊆ terms as a multiset; dropped = terms − kept.
            const pool = [...terms];
            for (const t of kept) {
              const i = pool.indexOf(t);
              expect(i).toBeGreaterThanOrEqual(0);
              pool.splice(i, 1);
            }
            const dropped = pool;

            // Drop order contract: with IDF weights, a term is never dropped
            // while a *less* important term survives — unknown-weight terms go
            // first, then ascending weight (ties broken by length ascending).
            // Without weights, shorter terms go first.
            for (const d of dropped) {
              for (const k of kept) {
                const wd = weightOf(d);
                const wk = weightOf(k);
                if (weights && wd !== undefined && wk !== undefined) {
                  expect(wd).toBeLessThanOrEqual(wk);
                  if (wd === wk) expect(d.length).toBeLessThanOrEqual(k.length);
                } else if (weights && wd === undefined && wk !== undefined) {
                  // unknown dropped before known: fine
                } else if (weights && wd !== undefined && wk === undefined) {
                  throw new Error(
                    `known-weight term "${d}" dropped before unknown "${k}"`,
                  );
                } else {
                  expect(d.length).toBeLessThanOrEqual(k.length);
                }
              }
            }
            prev = kept.length;
          }
        },
      ),
      { numRuns: 400 },
    );
  });
});
