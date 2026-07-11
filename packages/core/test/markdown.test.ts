import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { remark } from "remark";
import {
  normalize,
  iterateToFixpoint,
  unescapeMarkdown,
  sanitizeSurrogates,
  inline,
  renderMarkdown,
} from "../src/markdown";
import {
  formatDistillations,
  formatKnowledge,
  isEstablishedFact,
  ESTABLISHED_FACT_MAX_CHARS,
} from "../src/prompt";

const proc = remark();

// Count listItem nodes recursively in a remark AST
function countListItems(md: string): number {
  let items = 0;
  function walk(node: { type: string; children?: unknown[] }) {
    if (node.type === "listItem") items++;
    for (const child of node.children ?? [])
      walk(child as { type: string; children?: unknown[] });
  }
  walk(proc.parse(md) as { type: string; children?: unknown[] });
  return items;
}

// Generates markdown-hostile strings — embedded syntax that could break structure
const hostile = fc
  .array(
    fc.oneof(
      fc.constant("`"),
      fc.constant("```"),
      fc.constant("````"),
      fc.constant("#"),
      fc.constant("## "),
      fc.constant("### "),
      fc.constant("---"),
      fc.constant("***"),
      fc.constant("___"),
      fc.constant("\n"),
      fc.constant("- "),
      fc.constant("1. "),
      fc.constant("* "),
      fc.constant("> "),
      fc.string({ minLength: 1, maxLength: 20 }),
    ),
    { minLength: 1, maxLength: 10 },
  )
  .map((parts) => parts.join(""));

describe("normalize", () => {
  test("is idempotent on its own output", () => {
    fc.assert(
      fc.property(
        hostile.map((s) => normalize(s)),
        (normalized) => {
          expect(normalize(normalized)).toBe(normalized);
        },
      ),
      // No pinned seed: this property previously flaked (#959) because the old
      // two-pass normalize() was not a fixpoint for rare hostile inputs needing
      // 3+ stabilization passes. The fixpoint iteration makes idempotency hold
      // for ALL inputs (verified across 300k samples), so a random seed no
      // longer flakes — keeping it unpinned preserves broad coverage as a wide
      // net, and fast-check prints the failing seed if a regression ever breaks
      // it. The deterministic case below guards the specific #959 input class.
      { numRuns: 1000 },
    );
  });

  test("regression: idempotent for escape-growth inputs needing 3+ passes (#959)", () => {
    // remark escapes `**` adjacent to already-escaped asterisks only on a
    // later pass, so the old fixed two-pass normalize() was not a fixpoint
    // here: normalize(normalize(R)) !== normalize(R). The fixpoint iteration
    // makes normalize(R) itself already-normalized.
    const R = "***___## ***---***_{u|___## ";
    const normalized = normalize(R);
    expect(normalize(normalized)).toBe(normalized);
  });

  test("handles empty string", () => {
    expect(normalize("")).toBe("");
  });

  test("preserves already-normalized markdown", () => {
    const input = "## Heading\n\n* item 1\n* item 2\n";
    expect(normalize(input)).toBe(input);
  });
});

describe("iterateToFixpoint (#970)", () => {
  // The real markdown roundtrip is monotone and always converges, so its cycle
  // and cap branches are unreachable with real inputs. These synthetic steps
  // drive each of the three exit branches deterministically.

  test("returns the fixpoint and stops detecting it via the seen-set", () => {
    // step appends "!" until length 3, then is the identity (a fixpoint).
    const calls: string[] = [];
    const step = (s: string) => {
      calls.push(s);
      return s.length < 3 ? `${s}!` : s;
    };
    // seed "a" → "a!" → "a!!" → "a!!" (fixpoint after 2 transitions). The
    // fixpoint is several passes from the seed, so it can only be detected by
    // remembering intermediate outputs (the seen-set) — NOT by comparing to
    // the seed. Exactly 3 step calls: "a", "a!", "a!!" (the last re-emits
    // "a!!", which is already in the set, so we stop). A missing seen.add
    // would loop all the way to the cap instead.
    expect(iterateToFixpoint("a", step)).toBe("a!!");
    expect(calls).toEqual(["a", "a!", "a!!"]);
  });

  test("preserves single-roundtrip behavior when already at a fixpoint", () => {
    let count = 0;
    const step = (s: string) => {
      count++;
      return s; // identity: seed is already a fixpoint
    };
    expect(iterateToFixpoint("stable", step)).toBe("stable");
    // exactly one comparison call, then immediate return
    expect(count).toBe(1);
  });

  test("detects an oscillation (cycle) and stops early instead of hitting the cap", () => {
    // step oscillates A→B→A→B…; it never reaches a fixpoint.
    let count = 0;
    const step = (s: string) => {
      count++;
      return s === "A" ? "B" : "A";
    };
    // seed "A": next "B" (new), next "A" (already seen) → cycle, return "A".
    expect(iterateToFixpoint("A", step, 8)).toBe("A");
    // stopped after detecting the repeat, well before the 8-pass cap.
    expect(count).toBe(2);
  });

  test("returns the last result after exhausting the cap without converging", () => {
    // step strictly grows forever, so it never converges and never repeats.
    let count = 0;
    const step = (s: string) => {
      count++;
      return `${s}x`;
    };
    // seed "" with cap 3 → "x" → "xx" → "xxx"; cap reached, return last.
    expect(iterateToFixpoint("", step, 3)).toBe("xxx");
    expect(count).toBe(3);
  });

  test("respects a custom maxPasses bound", () => {
    const step = (s: string) => `${s}x`;
    expect(iterateToFixpoint("", step, 1)).toBe("x");
    expect(iterateToFixpoint("", step, 5)).toBe("xxxxx");
  });

  test("normalize delegates to the fixpoint iterator (real roundtrip converges)", () => {
    // A genuine escape-growth input still converges to a true fixpoint via the
    // shared iterator — neither the cycle nor cap branch fires.
    const R = "***___## ***---***_{u|___## ";
    const out = normalize(R);
    expect(normalize(out)).toBe(out);
  });
});

describe("formatDistillations", () => {
  test("output contains all observation text", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            observations: hostile.filter((s) => s.trim().length > 0),
            generation: fc.oneof(fc.constant(0), fc.constant(1)),
          }),
          { minLength: 1, maxLength: 3 },
        ),
        (distillations) => {
          const result = formatDistillations(distillations);
          for (const d of distillations) {
            expect(result).toContain(d.observations.trim());
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  test("separates gen-0 and gen-1 under correct headers", () => {
    const result = formatDistillations([
      { observations: "Early work summary", generation: 1 },
      { observations: "Recent observation", generation: 0 },
    ]);
    expect(result).toContain("### Earlier Work (summarized)");
    expect(result).toContain("### Recent Work (distilled)");
    expect(result).toContain("Early work summary");
    expect(result).toContain("Recent observation");
  });

  test("gen-0 only shows Recent Work header", () => {
    const result = formatDistillations([
      { observations: "Some observation", generation: 0 },
    ]);
    expect(result).toContain("### Recent Work (distilled)");
    expect(result).not.toContain("Earlier Work");
  });

  test("gen-1 only shows Earlier Work header", () => {
    const result = formatDistillations([
      { observations: "Summarized work", generation: 1 },
    ]);
    expect(result).toContain("### Earlier Work (summarized)");
    expect(result).not.toContain("Recent Work");
  });

  test("handles empty input", () => {
    expect(formatDistillations([])).toBe("");
  });
});

describe("formatKnowledge", () => {
  test("output === normalize(output) — AST serializer produces already-normalized markdown", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            category: fc.oneof(
              fc.constant("decision"),
              fc.constant("pattern"),
              fc.constant("gotcha"),
            ),
            title: hostile.filter((s) => s.trim().length > 0),
            content: hostile.filter((s) => s.trim().length > 0),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        (entries) => {
          const result = formatKnowledge(entries);
          if (!result) return;
          expect(normalize(result)).toBe(result);
        },
      ),
      { numRuns: 100 },
    );
  }, 30_000);

  test("listItem count matches entry count per category", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            category: fc.oneof(fc.constant("decision"), fc.constant("pattern")),
            title: hostile.filter((s) => s.trim().length > 0),
            content: hostile.filter((s) => s.trim().length > 0),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        (entries) => {
          const result = formatKnowledge(entries);
          if (!result) return;
          expect(countListItems(result)).toBe(entries.length);
        },
      ),
      { numRuns: 100 },
    );
  }, 30_000);

  test("regression: code fence in content stays in list", () => {
    const result = formatKnowledge([
      {
        category: "pattern",
        title: "Code pattern",
        content: "Use:\n```ts\nconst x = 1\n```\ninstead of let",
      },
    ]);
    expect(countListItems(result)).toBe(1);
  });

  test("regression: triple backticks in title are escaped", () => {
    const result = formatKnowledge([
      {
        category: "gotcha",
        title: "```ts broke things",
        content: "Some content",
      },
    ]);
    // Should not contain an unescaped code block
    const tree = proc.parse(result);
    const codes = tree.children.filter((n) => n.type === "code");
    expect(codes.length).toBe(0);
  });

  test("handles empty input", () => {
    expect(formatKnowledge([])).toBe("");
  });

  test("token budget — only includes entries that fit within maxTokens", () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      category: "pattern",
      title: `Entry ${i}`,
      content: "A".repeat(400), // ~133 tokens each at chars/3
    }));
    // Budget of 500 tokens — should fit only a few
    const result = formatKnowledge(entries, 500);
    const items = countListItems(result);
    expect(items).toBeGreaterThan(0);
    expect(items).toBeLessThan(20);
    // Total size should be roughly within budget (use /3 to match estimateTokens)
    expect(Math.ceil(result.length / 3)).toBeLessThanOrEqual(600); // some slack for headers
  });

  test("token budget — returns empty string when no entries fit", () => {
    const result = formatKnowledge(
      [{ category: "pattern", title: "Huge", content: "X".repeat(10_000) }],
      10, // budget of 10 tokens — nothing fits
    );
    expect(result).toBe("");
  });

  test("token budget — undefined budget includes all entries", () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      category: "decision",
      title: `D${i}`,
      content: "Content",
    }));
    const all = formatKnowledge(entries);
    const budgeted = formatKnowledge(entries, 1_000_000);
    // Both should produce the same number of items
    expect(countListItems(all)).toBe(countListItems(budgeted));
  });

  test("canonical layout — output is byte-stable regardless of input order", () => {
    const entries = [
      { category: "gotcha", title: "Zeta gotcha", content: "z" },
      { category: "decision", title: "Bravo decision", content: "b" },
      { category: "decision", title: "Alpha decision", content: "a" },
      { category: "pattern", title: "Mid pattern", content: "m" },
    ];
    const reversed = [...entries].reverse();
    const shuffled = [entries[2], entries[0], entries[3], entries[1]];
    const out = formatKnowledge(entries);
    expect(formatKnowledge(reversed)).toBe(out);
    expect(formatKnowledge(shuffled)).toBe(out);
  });

  test("canonical layout — categories alphabetical, titles alphabetical within", () => {
    const out = formatKnowledge([
      { category: "pattern", title: "Bravo", content: "b" },
      { category: "decision", title: "Zeta", content: "z" },
      { category: "decision", title: "Alpha", content: "a" },
    ]);
    // "Decision" section before "Pattern" section
    expect(out.indexOf("### Decision")).toBeLessThan(
      out.indexOf("### Pattern"),
    );
    // Within Decision: Alpha before Zeta
    expect(out.indexOf("Alpha")).toBeLessThan(out.indexOf("Zeta"));
  });

  test("outIncludedIds reports rendered entry ids after budget packing", () => {
    const included: string[] = [];
    formatKnowledge(
      [
        { category: "pattern", title: "Small", content: "x", id: "s" },
        {
          category: "pattern",
          title: "Huge",
          content: "Y".repeat(10_000),
          id: "h",
        },
      ],
      200,
      included,
    );
    expect(included).toContain("s");
    expect(included).not.toContain("h");
  });
});

describe("isEstablishedFact", () => {
  const fact = (
    over: Partial<{ category: string; title: string; content: string }>,
  ) => ({
    category: "decision",
    title: "t",
    content: "x",
    ...over,
  });

  test("short entries with a concrete value signal are facts", () => {
    expect(
      isEstablishedFact(fact({ content: "the region is eu-west-1" })),
    ).toBe(true); // digit
    expect(isEstablishedFact(fact({ content: "primary color #3a7bd5" }))).toBe(
      true,
    ); // hex/quote via digit
    expect(isEstablishedFact(fact({ content: "order status: shipped" }))).toBe(
      true,
    ); // connector
    expect(isEstablishedFact(fact({ content: 'name = "acme"' }))).toBe(true); // connector + quote
  });

  test("vague prose with no concrete value is NOT a fact", () => {
    expect(
      isEstablishedFact(fact({ content: "prefer explicit over implicit" })),
    ).toBe(false);
  });

  test("long-form entries are never facts, even with a value", () => {
    expect(
      isEstablishedFact(
        fact({
          content: `region eu-west-1. ${"x".repeat(ESTABLISHED_FACT_MAX_CHARS)}`,
        }),
      ),
    ).toBe(false);
  });

  test("recalled (passive context) entries are never facts", () => {
    expect(
      isEstablishedFact(fact({ category: "recalled", content: "value = 42" })),
    ).toBe(false);
  });
});

describe("formatKnowledge — established facts section", () => {
  const mixed = [
    {
      id: "f1",
      category: "decision",
      title: "Region",
      content: "region is eu-west-1",
    },
    {
      id: "f2",
      category: "gotcha",
      title: "Color",
      content: "brand color #3a7bd5",
    },
    {
      id: "k1",
      category: "architecture",
      title: "Overview",
      content:
        "The system uses a layered pipeline with distinct stages for parsing and planning.",
    },
  ];

  test("off (default): no facts section, byte-identical to omitting the flag", () => {
    const off = formatKnowledge(mixed, undefined, undefined);
    expect(off).not.toContain("Established facts");
    expect(
      formatKnowledge(mixed, undefined, undefined, { establishedFacts: false }),
    ).toBe(off);
  });

  test("on: concrete values render under a leading 'Established facts' section with an imperative directive", () => {
    const out = formatKnowledge(mixed, undefined, undefined, {
      establishedFacts: true,
    });
    expect(out).toContain("## Established facts");
    expect(out).toContain("Use them exactly");
    // Facts section comes before the main knowledge list.
    expect(out.indexOf("Established facts")).toBeLessThan(
      out.indexOf("Long-term Knowledge"),
    );
    // The two short values are elevated; the long-form entry stays in LTK.
    expect(out.indexOf("Region")).toBeLessThan(
      out.indexOf("## Long-term Knowledge"),
    );
    expect(out.indexOf("Overview")).toBeGreaterThan(
      out.indexOf("## Long-term Knowledge"),
    );
  });

  test("on: a fact-less set is byte-identical to the flag off (safe fallback)", () => {
    const proseOnly = [
      { id: "a", category: "pattern", title: "A", content: "prefer clarity" },
      { id: "b", category: "decision", title: "B", content: "keep it simple" },
    ];
    expect(
      formatKnowledge(proseOnly, undefined, undefined, {
        establishedFacts: true,
      }),
    ).toBe(formatKnowledge(proseOnly, undefined, undefined));
  });

  test("on: output is byte-stable regardless of input order", () => {
    const out = formatKnowledge(mixed, undefined, undefined, {
      establishedFacts: true,
    });
    expect(
      formatKnowledge([...mixed].reverse(), undefined, undefined, {
        establishedFacts: true,
      }),
    ).toBe(out);
  });

  test("on: outIncludedIds still covers every rendered entry (facts + rest) for the pin key set", () => {
    const ids: string[] = [];
    formatKnowledge(mixed, undefined, ids, { establishedFacts: true });
    expect(ids.sort()).toEqual(["f1", "f2", "k1"]);
  });

  test("on: an all-facts set renders no 'Long-term Knowledge' section", () => {
    const allFacts = [
      {
        id: "f1",
        category: "decision",
        title: "Region",
        content: "region is eu-west-1",
      },
      { id: "f2", category: "gotcha", title: "Port", content: "port = 3207" },
    ];
    const out = formatKnowledge(allFacts, undefined, undefined, {
      establishedFacts: true,
    });
    expect(out).toContain("## Established facts");
    expect(out).not.toContain("## Long-term Knowledge");
  });
});

// ---------------------------------------------------------------------------
// unescapeMarkdown
// ---------------------------------------------------------------------------

describe("unescapeMarkdown", () => {
  test("unescapes angle brackets escaped by remark", () => {
    // remark serializes `<T>` as `\<T>` in text nodes
    expect(unescapeMarkdown("Use Extract\\<T> for narrowing")).toBe(
      "Use Extract<T> for narrowing",
    );
  });

  test("unescapes backslashes", () => {
    expect(unescapeMarkdown("path\\\\to\\\\file")).toBe("path\\to\\file");
  });

  test("round-trips through formatKnowledge without escaping expansion", () => {
    // Simulates the AGENTS.md export → parse → re-import → re-export cycle.
    // The content should be stable after multiple round-trips.
    const original = "Use Extract<T, {type: 'foo'}> for type narrowing";

    // First export: serialize to markdown
    const exported1 = formatKnowledge([
      { category: "pattern", title: "T", content: original },
    ]);

    // Parse the bullet back out (as agents-file.ts does), unescaping on read
    const bulletMatch = exported1.match(/^\*\s+\*\*(.+?)\*\*:\s*(.+)$/m);
    expect(bulletMatch).not.toBeNull();
    if (!bulletMatch) throw new Error("expected bullet match");
    const parsedContent = unescapeMarkdown(bulletMatch[2].trim());

    // Content after parse+unescape should equal original
    expect(parsedContent).toBe(original);

    // Second export from unescaped content should be identical to first
    const exported2 = formatKnowledge([
      { category: "pattern", title: "T", content: parsedContent },
    ]);
    expect(exported2).toBe(exported1);
  });

  test("handles plain text without escapes unchanged", () => {
    const plain = "No special characters here";
    expect(unescapeMarkdown(plain)).toBe(plain);
  });
});

describe("sanitizeSurrogates", () => {
  test("passes through normal text unchanged", () => {
    expect(sanitizeSurrogates("hello world")).toBe("hello world");
  });

  test("passes through valid surrogate pairs (emoji)", () => {
    // 😀 is U+1F600 = surrogate pair \uD83D\uDE00
    expect(sanitizeSurrogates("hello 😀 world")).toBe("hello 😀 world");
  });

  test("replaces lone high surrogate with U+FFFD", () => {
    const bad = "before\uD800after";
    expect(sanitizeSurrogates(bad)).toBe("before\uFFFDafter");
  });

  test("replaces lone low surrogate with U+FFFD", () => {
    const bad = "before\uDC00after";
    expect(sanitizeSurrogates(bad)).toBe("before\uFFFDafter");
  });

  test("replaces high surrogate at end of string", () => {
    const bad = "trailing\uD800";
    expect(sanitizeSurrogates(bad)).toBe("trailing\uFFFD");
  });

  test("replaces multiple unpaired surrogates", () => {
    const bad = "\uD800x\uDBFF\uDC00y\uDC00";
    // \uD800 = lone high → replaced
    // \uDBFF\uDC00 = valid pair → preserved
    // \uDC00 = lone low → replaced
    expect(sanitizeSurrogates(bad)).toBe("\uFFFDx\uDBFF\uDC00y\uFFFD");
  });

  test("result is always valid for JSON.stringify", () => {
    // Construct string with various surrogate scenarios
    const nasty = "ok\uD800\uDBFFpair\uDBFF\uDC00tail\uDC00";
    const sanitized = sanitizeSurrogates(nasty);
    // Must not throw when serialized to JSON
    const json = JSON.stringify(sanitized);
    expect(JSON.parse(json)).toBe(sanitized);
  });
});

describe("inline sanitizes surrogates", () => {
  test("inline strips unpaired surrogates from text", () => {
    const bad = "line one\n  \uD800middle\n  end";
    const result = inline(bad);
    expect(result).toBe("line one \uFFFDmiddle end");
    // Must be JSON-safe
    expect(() => JSON.stringify(result)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// renderMarkdown
// ---------------------------------------------------------------------------

describe("renderMarkdown", () => {
  test("renders headings", () => {
    expect(renderMarkdown("# Hello")).toContain("<h1>Hello</h1>");
  });

  test("renders bold and italic", () => {
    const result = renderMarkdown("**bold** and *italic*");
    expect(result).toContain("<strong>bold</strong>");
    expect(result).toContain("<em>italic</em>");
  });

  test("renders unordered lists", () => {
    const result = renderMarkdown("- item 1\n- item 2");
    expect(result).toContain("<li>item 1</li>");
    expect(result).toContain("<li>item 2</li>");
  });

  test("renders code blocks", () => {
    const result = renderMarkdown("```\nconst x = 1;\n```");
    expect(result).toContain("<code>");
    expect(result).toContain("const x = 1;");
  });

  test("renders inline code", () => {
    const result = renderMarkdown("use `foo()` here");
    expect(result).toContain("<code>foo()</code>");
  });

  test("renders links", () => {
    const result = renderMarkdown("[click](https://example.com)");
    expect(result).toContain('<a href="https://example.com">click</a>');
  });

  test("escapes raw HTML in input (XSS safety)", () => {
    const result = renderMarkdown('<script>alert("xss")</script>');
    expect(result).not.toContain("<script>");
    expect(result).toContain("&lt;script&gt;");
  });

  test("escapes img onerror XSS", () => {
    const result = renderMarkdown('<img onerror="alert(1)" src="x">');
    expect(result).not.toContain("<img");
    expect(result).toContain("&lt;img");
  });

  test("sanitizes javascript: protocol in links", () => {
    const result = renderMarkdown("[click](javascript:alert(1))");
    expect(result).not.toContain("javascript:");
  });

  test("handles empty string", () => {
    expect(renderMarkdown("")).toBe("");
  });

  test("renders blockquotes", () => {
    const result = renderMarkdown("> quoted text");
    expect(result).toContain("<blockquote>");
    expect(result).toContain("quoted text");
  });
});
