/**
 * Shared fuzzy-ranking helper (#1948). The fixture table below is duplicated
 * verbatim in packages/ui/test/fuzzy.test.ts — both sides must assert the
 * same expectations so client and server filters stay consistent.
 */
import { describe, expect, it } from "vitest";
import {
  fuzzyRank,
  normalizeFuzzy,
  FUZZY_MIN_QUERY,
  FUZZY_THRESHOLD,
} from "../src/fuzzy";

type Row = { id: string; title: string };
const row = (id: string, title: string): Row => ({ id, title });

const ITEMS: Row[] = [
  row("knowledge", "Knowledge table sorting"),
  row("session", "Session title search"),
  row("resume", "Résumé upload rules"),
  row("nav", "nav-projects component"),
  row("foobar", "foo_bar/baz helper"),
  row("junk-target", "Unrelated operational note"),
];

const rank = (query: string, items: readonly Row[] = ITEMS, limit?: number) =>
  fuzzyRank(query, items, (item) => [item.title], { limit });

const ids = <T extends { id: string }>(hits: { item: T }[]) =>
  hits.map((hit) => hit.item.id);

describe("normalizeFuzzy", () => {
  it("equates case, diacritics and separators", () => {
    expect(normalizeFuzzy("Résumé")).toBe("resume");
    expect(normalizeFuzzy("RESUME")).toBe("resume");
    expect(normalizeFuzzy("nav-projects")).toBe("nav projects");
    expect(normalizeFuzzy("nav_projects")).toBe("nav projects");
    expect(normalizeFuzzy("foo_bar/baz")).toBe("foo bar baz");
    expect(normalizeFuzzy("foo\\bar:baz")).toBe("foo bar baz");
    expect(normalizeFuzzy("  foo   bar ")).toBe("foo bar");
  });
});

describe("fuzzyRank", () => {
  it("finds titles through typos", () => {
    const hits = rank("knwoledge");
    expect(ids(hits)).toContain("knowledge");
    expect(ids(hits)).not.toContain("junk-target");
  });

  it("finds multi-word titles through typos", () => {
    const hits = rank("sesion titl");
    expect(ids(hits)).toEqual(["session"]);
  });

  it("ranks an exact substring hit above a fuzzy hit", () => {
    const items = [
      row("fuzzy", "Sessoin title drift"),
      row("exact", "Session title search"),
    ];
    const hits = rank("session", items);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0]?.item.id).toBe("exact");
    expect(hits[0]?.exact).toBe(true);
    expect(hits[0]?.score).toBe(1);
    const fuzzy = hits.find((hit) => hit.item.id === "fuzzy");
    expect(fuzzy?.exact).toBe(false);
    expect(fuzzy?.score).toBeLessThan(1);
  });

  it("matches through diacritics both directions", () => {
    expect(ids(rank("resume"))).toContain("resume");
    const other = [row("plain", "Resume guide")];
    const hits = rank("Résumé", other);
    expect(hits[0]?.item.id).toBe("plain");
    expect(hits[0]?.exact).toBe(true);
  });

  it("matches through separator differences as exact", () => {
    const nav = rank("nav projects");
    expect(nav[0]?.item.id).toBe("nav");
    expect(nav[0]?.exact).toBe(true);
    const foobar = rank("foo_bar/baz");
    expect(foobar[0]?.item.id).toBe("foobar");
    expect(foobar[0]?.exact).toBe(true);
  });

  it("returns nothing for unrelated junk", () => {
    expect(rank("zzzqqq")).toEqual([]);
  });

  it(`returns nothing below FUZZY_MIN_QUERY (${FUZZY_MIN_QUERY})`, () => {
    const items = [row("ab", "ab"), row("abc", "abc")];
    expect(rank("ab", items)).toEqual([]);
    expect(rank("a", items)).toEqual([]);
  });

  it("honours the limit", () => {
    const items = [
      row("k1", "Knowledge one"),
      row("k2", "Knowledge two"),
      row("k3", "Knowledge three"),
    ];
    const hits = rank("knowledge", items, 2);
    expect(hits).toHaveLength(2);
  });

  it("is stable: input order breaks score ties", () => {
    const a = row("a", "Nav Projects");
    const b = row("b", "nav-projects");
    expect(ids(rank("nav projects", [a, b]))).toEqual(["a", "b"]);
    expect(ids(rank("nav projects", [b, a]))).toEqual(["b", "a"]);
  });

  it("searches every key returned by keys()", () => {
    const items = [
      { id: "p1", name: "alpha", path: "/home/me/alpha" },
      { id: "p2", name: "beta", path: "/home/me/alpha-tools" },
      { id: "p3", name: "gamma", path: "/home/me/gamma" },
    ];
    const hits = fuzzyRank("alpha", items, (item) => [item.name, item.path]);
    expect(ids(hits)).toEqual(["p1", "p2"]);
  });

  it("drops non-exact hits below the threshold", () => {
    const hits = fuzzyRank(
      "knowledge",
      [row("far", "Knodweldge tangentially related")],
      (item) => [item.title],
      { threshold: FUZZY_THRESHOLD },
    );
    for (const hit of hits) {
      expect(hit.exact || hit.score >= FUZZY_THRESHOLD).toBe(true);
    }
  });
});
